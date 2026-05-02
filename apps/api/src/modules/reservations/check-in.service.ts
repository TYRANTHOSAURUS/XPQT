import {
  Injectable, Logger, NotFoundException, BadRequestException, Optional,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { TenantService } from '../tenant/tenant.service';
import { BookingNotificationsService } from './booking-notifications.service';
import {
  SLOT_WITH_BOOKING_SELECT,
  slotWithBookingToReservation,
  type SlotWithBookingEmbed,
} from './reservation-projection';

/**
 * CheckInService — handles the explicit check-in action and the
 * background auto-release scan.
 *
 * Post-canonicalisation (2026-05-02): check-in is a per-slot event
 * (00277:142-151). For v1 single-slot bookings the slot id and the
 * booking id are 1:1 — but the column we mutate is on `booking_slots`,
 * NOT `bookings`. Audit events use `entity_type='booking_slot'` per the
 * spec contract (see canonical-booking-schema.sql lines 398-402).
 *
 * autoReleaseScan: every 5 min during business hours. Selects `booking_slots`
 * rows where check_in_required = true AND status='confirmed' AND
 * checked_in_at is null AND now() > start_at + grace. Flips
 * status='released' + released_at=now() and emits self-explaining release
 * notification.
 *
 * Concurrency: scheduled via @Cron, single-instance assumed at this scale.
 * If the platform later runs multiple instances, wrap in a Postgres
 * advisory-lock acquisition before scanning.
 */
@Injectable()
export class CheckInService {
  private readonly log = new Logger(CheckInService.name);

  constructor(
    private readonly supabase: SupabaseService,
    @Optional() private readonly notifications?: BookingNotificationsService,
    @Optional() private readonly tenants?: TenantService,
  ) {}

  /**
   * Explicit check-in action. Called by the portal "My bookings" button,
   * the email check-in deep link, and the desk scheduler row action.
   *
   * The `bookingId` here is the BOOKING id (post-Slice A — what
   * BookingFlowService.create returns). For single-slot bookings we
   * resolve to the unique slot; for multi-slot bookings we check in the
   * primary slot (lowest display_order) — per-slot check-in for non-primary
   * rooms is a future endpoint.
   */
  async checkIn(bookingId: string, tenantId: string): Promise<{ id: string; checked_in_at: string }> {
    const { data: slotData, error: slotErr } = await this.supabase.admin
      .from('booking_slots')
      .select('id, status, start_at, end_at, check_in_required, checked_in_at')
      .eq('tenant_id', tenantId)
      .eq('booking_id', bookingId)
      .order('display_order', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (slotErr || !slotData) {
      throw new NotFoundException('booking_not_found');
    }

    const slot = slotData as {
      id: string; status: string; start_at: string; end_at: string;
      check_in_required: boolean; checked_in_at: string | null;
    };

    if (slot.status !== 'confirmed') {
      throw new BadRequestException(
        slot.status === 'checked_in'
          ? 'booking_already_checked_in'
          : `booking_not_confirmed:${slot.status}`,
      );
    }

    const now = new Date();
    const start = new Date(slot.start_at);
    const end = new Date(slot.end_at);
    const earliestCheckIn = new Date(start.getTime() - 15 * 60 * 1000);
    if (now < earliestCheckIn) throw new BadRequestException('booking_too_early_to_check_in');
    if (now > end) throw new BadRequestException('booking_already_ended');

    const checkedInAt = now.toISOString();
    const updated = await this.supabase.admin
      .from('booking_slots')
      .update({ status: 'checked_in', checked_in_at: checkedInAt })
      .eq('tenant_id', tenantId)
      .eq('id', slot.id)
      .select('id')
      .single();

    if (updated.error) {
      this.log.error(`checkIn failed: ${updated.error.message}`);
      throw new BadRequestException('check_in_failed');
    }

    // Mirror to booking-level status so list endpoints reflect the change.
    await this.supabase.admin
      .from('bookings')
      .update({ status: 'checked_in' })
      .eq('tenant_id', tenantId)
      .eq('id', bookingId);

    // Audit — phase K. Per-slot event per the canonical-schema contract.
    try {
      await this.supabase.admin.from('audit_events').insert({
        tenant_id: tenantId,
        event_type: 'booking_slot.checked_in',
        entity_type: 'booking_slot',
        entity_id: slot.id,
        details: { booking_id: bookingId, slot_id: slot.id, checked_in_at: checkedInAt },
      });
    } catch { /* best-effort; check-in must succeed even if audit fails */ }
    // Return the booking id (Slice A return-shape contract — callers expect
    // the booking id back, not a per-slot id) so the controller's response
    // and the magic-link email keep the same shape.
    return { id: bookingId, checked_in_at: checkedInAt };
  }

  /**
   * Cron — every 5 minutes. Scans across all tenants since this is a
   * platform-level job. The partial index `idx_slots_pending_check_in`
   * (00277:209-213) keeps the working set tiny.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async autoReleaseScan(): Promise<void> {
    const now = Date.now();
    const cutoffNow = new Date(now).toISOString();
    const cutoffEarliest = new Date(now - 24 * 60 * 60 * 1000).toISOString();

    // booking_slots holds per-slot check-in state (00277:147-151). Embed the
    // parent booking so the release notification has tenant-level info.
    const { data, error } = await this.supabase.admin
      .from('booking_slots')
      .select('id, tenant_id, booking_id, start_at, check_in_grace_minutes, space_id, bookings!inner(requester_person_id)')
      .eq('check_in_required', true)
      .eq('status', 'confirmed')
      .is('checked_in_at', null)
      .gte('start_at', cutoffEarliest)
      .lte('start_at', cutoffNow)
      .limit(500);

    if (error) {
      this.log.error(`autoReleaseScan select error: ${error.message}`);
      return;
    }

    type Row = {
      id: string;
      tenant_id: string;
      booking_id: string;
      start_at: string;
      check_in_grace_minutes: number;
      space_id: string;
      bookings?: { requester_person_id: string } | { requester_person_id: string }[] | null;
    };
    const due = ((data ?? []) as unknown as Row[]).filter((r) => {
      const startAt = new Date(r.start_at).getTime();
      return Date.now() > startAt + r.check_in_grace_minutes * 60 * 1000;
    });

    if (due.length === 0) return;

    this.log.log(`autoReleaseScan: releasing ${due.length} booking slots`);

    for (const r of due) {
      const updated = await this.supabase.admin
        .from('booking_slots')
        .update({ status: 'released', released_at: new Date().toISOString() })
        .eq('tenant_id', r.tenant_id)
        .eq('id', r.id)
        .eq('status', 'confirmed')
        .is('checked_in_at', null)
        .select('id')
        .maybeSingle();

      if (updated.error) {
        this.log.warn(`autoReleaseScan: release ${r.id} failed: ${updated.error.message}`);
        continue;
      }
      if (!updated.data) continue;           // someone checked in just before us — fine

      // Mirror booking-level status (single-slot v1 only — multi-slot
      // would need an aggregate; the v1 single-slot path always finds
      // 1:1).
      await this.supabase.admin
        .from('bookings')
        .update({ status: 'released' })
        .eq('tenant_id', r.tenant_id)
        .eq('id', r.booking_id);

      // Self-explaining release notification (spec §12 differentiator).
      // The notifications service consumes the legacy `Reservation` shape;
      // re-read with the projection so the email body has full context.
      if (this.notifications && this.tenants) {
        try {
          const tenant = await this.tenants.resolveById(r.tenant_id);
          if (tenant) {
            await TenantContext.run(tenant, async () => {
              const { data: refreshed } = await this.supabase.admin
                .from('booking_slots')
                .select(SLOT_WITH_BOOKING_SELECT)
                .eq('tenant_id', r.tenant_id)
                .eq('id', r.id)
                .maybeSingle();
              if (refreshed) {
                await this.notifications!.onReleased(
                  slotWithBookingToReservation(refreshed as unknown as SlotWithBookingEmbed),
                );
              }
            });
          }
        } catch (err) {
          this.log.warn(`onReleased ${r.id} failed: ${(err as Error).message}`);
        }
      }

      // Audit event. Per-slot entity_type per canonical-schema contract.
      try {
        const requester = Array.isArray(r.bookings) ? r.bookings[0] : r.bookings;
        await this.supabase.admin.from('audit_events').insert({
          tenant_id: r.tenant_id,
          event_type: 'booking_slot.auto_released',
          entity_type: 'booking_slot',
          entity_id: r.id,
          details: {
            booking_id: r.booking_id,
            slot_id: r.id,
            space_id: r.space_id,
            requester_person_id: requester?.requester_person_id ?? null,
          },
        });
      } catch {
        // best-effort; don't block the loop
      }
    }
  }

  /**
   * Magic-link check-in. Used by the check-in reminder email so users can
   * check in without a login round-trip. The token is HMAC over
   * (booking_id, requester_person_id, expiry); see
   * `magic-check-in.token.ts` for the wire format. 30-min expiry.
   *
   * The token's `reservationId` field name predates the rewrite but now
   * carries a BOOKING id (Slice A — the magic-link email's reservation_id
   * URL segment is the booking id). We keep the field name for token-
   * format backwards compatibility with already-issued tokens.
   */
  async checkInMagic(
    bookingId: string,
    token: string,
  ): Promise<{ id: string; checked_in_at: string }> {
    const { verifyMagicCheckInToken } = await import('./magic-check-in.token');
    const verified = verifyMagicCheckInToken(token);
    if (!verified.ok) {
      throw new BadRequestException(`magic_link_${verified.reason}`);
    }
    if (verified.payload.reservationId !== bookingId) {
      throw new BadRequestException('magic_link_booking_mismatch');
    }

    // Look up the booking + primary slot to verify the requester binding.
    // No tenant context — the token is the auth.
    const { data, error } = await this.supabase.admin
      .from('bookings')
      .select('id, tenant_id, status, requester_person_id')
      .eq('id', bookingId)
      .maybeSingle();

    if (error || !data) {
      throw new NotFoundException('booking_not_found');
    }
    const b = data as {
      id: string; tenant_id: string; status: string; requester_person_id: string;
    };
    if (b.requester_person_id !== verified.payload.requesterPersonId) {
      throw new BadRequestException('magic_link_person_mismatch');
    }
    return this.checkIn(b.id, b.tenant_id);
  }
}

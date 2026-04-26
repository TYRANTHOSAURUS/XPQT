import {
  Injectable, Logger, NotFoundException, BadRequestException, Optional,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { TenantService } from '../tenant/tenant.service';
import { BookingNotificationsService } from './booking-notifications.service';
import type { Reservation } from './dto/types';

/**
 * CheckInService — handles the explicit check-in action and the
 * background auto-release scan.
 *
 * autoReleaseScan: every 5 min during business hours. Selects rows where
 * check_in_required = true AND status='confirmed' AND checked_in_at is null
 * AND now() > start_at + grace. Flips status='released' + released_at=now()
 * and emits self-explaining release notification.
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
   */
  async checkIn(reservationId: string, tenantId: string): Promise<{ id: string; checked_in_at: string }> {
    // Eligibility: status='confirmed' AND now() between start_at - 15m AND end_at
    const reservationLookup = await this.supabase.admin
      .from('reservations')
      .select('id, status, start_at, end_at, check_in_required, checked_in_at')
      .eq('tenant_id', tenantId)
      .eq('id', reservationId)
      .maybeSingle();

    if (reservationLookup.error || !reservationLookup.data) {
      throw new NotFoundException('reservation_not_found');
    }

    const r = reservationLookup.data as {
      id: string; status: string; start_at: string; end_at: string;
      check_in_required: boolean; checked_in_at: string | null;
    };

    if (r.status !== 'confirmed') {
      throw new BadRequestException(
        r.status === 'checked_in'
          ? 'reservation_already_checked_in'
          : `reservation_not_confirmed:${r.status}`,
      );
    }

    const now = new Date();
    const start = new Date(r.start_at);
    const end = new Date(r.end_at);
    const earliestCheckIn = new Date(start.getTime() - 15 * 60 * 1000);
    if (now < earliestCheckIn) throw new BadRequestException('reservation_too_early_to_check_in');
    if (now > end) throw new BadRequestException('reservation_already_ended');

    const checkedInAt = now.toISOString();
    const updated = await this.supabase.admin
      .from('reservations')
      .update({ status: 'checked_in', checked_in_at: checkedInAt })
      .eq('tenant_id', tenantId)
      .eq('id', reservationId)
      .select('id')
      .single();

    if (updated.error) {
      this.log.error(`checkIn failed: ${updated.error.message}`);
      throw new BadRequestException('check_in_failed');
    }

    // Audit — phase K. Spec §6.4 calls for an event on every check-in.
    try {
      await this.supabase.admin.from('audit_events').insert({
        tenant_id: tenantId,
        event_type: 'reservation.checked_in',
        entity_type: 'reservation',
        entity_id: reservationId,
        details: { checked_in_at: checkedInAt },
      });
    } catch { /* best-effort; check-in must succeed even if audit fails */ }
    return { id: r.id, checked_in_at: checkedInAt };
  }

  /**
   * Cron — every 5 minutes. Scans across all tenants since this is a
   * platform-level job. The partial index `idx_reservations_pending_check_in`
   * keeps the working set tiny.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async autoReleaseScan(): Promise<void> {
    const now = Date.now();
    const cutoffNow = new Date(now).toISOString();
    // Lower bound: only consider bookings that started in the last 24h.
    // Without this the scan pulls every confirmed past-start-without-
    // check-in row across every tenant, going back forever — fine on a
    // small dataset, painful as the table grows. Anything older has
    // already been released by a previous tick (or the row is broken
    // in a way the scan can't recover from anyway).
    const cutoffEarliest = new Date(now - 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await this.supabase.admin
      .from('reservations')
      .select('id, tenant_id, start_at, check_in_grace_minutes, requester_person_id, space_id')
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

    const due = (data ?? []).filter((r) => {
      const startAt = new Date((r as { start_at: string }).start_at).getTime();
      const grace = (r as { check_in_grace_minutes: number }).check_in_grace_minutes;
      return Date.now() > startAt + grace * 60 * 1000;
    }) as Array<{ id: string; tenant_id: string; requester_person_id: string; space_id: string }>;

    if (due.length === 0) return;

    this.log.log(`autoReleaseScan: releasing ${due.length} reservations`);

    for (const r of due) {
      const updated = await this.supabase.admin
        .from('reservations')
        .update({ status: 'released', released_at: new Date().toISOString() })
        .eq('tenant_id', r.tenant_id)
        .eq('id', r.id)
        .eq('status', 'confirmed')           // optimistic: avoid races with concurrent check-in
        .is('checked_in_at', null)
        .select('*')
        .maybeSingle();

      if (updated.error) {
        this.log.warn(`autoReleaseScan: release ${r.id} failed: ${updated.error.message}`);
        continue;
      }
      if (!updated.data) continue;           // someone checked in just before us — fine

      // Self-explaining release notification (spec §12 differentiator).
      if (this.notifications && this.tenants) {
        try {
          // The notifications service uses TenantContext.current() in its
          // supabase queries — look up the real tenant + wrap the call.
          const tenant = await this.tenants.resolveById(r.tenant_id);
          if (tenant) {
            await TenantContext.run(tenant, async () => {
              await this.notifications!.onReleased(updated.data as unknown as Reservation);
            });
          }
        } catch (err) {
          this.log.warn(`onReleased ${r.id} failed: ${(err as Error).message}`);
        }
      }

      // Audit event
      try {
        await this.supabase.admin.from('audit_events').insert({
          tenant_id: r.tenant_id,
          event_type: 'reservation.auto_released',
          entity_type: 'reservation',
          entity_id: r.id,
          details: { space_id: r.space_id, requester_person_id: r.requester_person_id },
        });
      } catch {
        // best-effort; don't block the loop
      }
    }
  }

  /**
   * Magic-link check-in. Used by the check-in reminder email so users can
   * check in without a login round-trip. The token is HMAC over
   * (reservation_id, requester_person_id, expiry); see
   * `magic-check-in.token.ts` for the wire format. 30-min expiry.
   */
  async checkInMagic(
    reservationId: string,
    token: string,
  ): Promise<{ id: string; checked_in_at: string }> {
    const { verifyMagicCheckInToken } = await import('./magic-check-in.token');
    const verified = verifyMagicCheckInToken(token);
    if (!verified.ok) {
      throw new BadRequestException(`magic_link_${verified.reason}`);
    }
    if (verified.payload.reservationId !== reservationId) {
      throw new BadRequestException('magic_link_reservation_mismatch');
    }

    // Look up the reservation directly (no tenant context — the token *is*
    // the auth). We deliberately scope to the requester_person_id baked into
    // the token to avoid use across resies.
    const { data, error } = await this.supabase.admin
      .from('reservations')
      .select('id, tenant_id, status, start_at, end_at, check_in_required, checked_in_at, requester_person_id')
      .eq('id', reservationId)
      .maybeSingle();

    if (error || !data) {
      throw new NotFoundException('reservation_not_found');
    }
    const r = data as {
      id: string; tenant_id: string; status: string; start_at: string; end_at: string;
      check_in_required: boolean; checked_in_at: string | null; requester_person_id: string;
    };
    if (r.requester_person_id !== verified.payload.requesterPersonId) {
      throw new BadRequestException('magic_link_person_mismatch');
    }
    return this.checkIn(r.id, r.tenant_id);
  }
}

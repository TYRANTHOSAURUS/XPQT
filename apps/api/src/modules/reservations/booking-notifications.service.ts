import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { TenantService } from '../tenant/tenant.service';
import { NotificationService } from '../notification/notification.service';
import {
  SLOT_WITH_BOOKING_SELECT,
  slotWithBookingToReservation,
  type SlotWithBookingEmbed,
} from './reservation-projection';
import type { Reservation } from './dto/types';

/**
 * Booking lifecycle notifications.
 *
 * Wraps the existing NotificationService with reservation-flavored payloads
 * and emits audit events alongside. The differentiator (spec §12, §4.9) is
 * the *self-explaining* release email — when an auto-release fires, the user
 * receives a body that explains *why* (no check-in within grace), with a
 * deep-link to rebook the slot and an alternatives link.
 *
 * All sends are tenant-scoped. The caller is expected to have set
 * TenantContext.run(tenantId) — both the BookingFlowService and the
 * controllers do this via TenantMiddleware. The two crons in this service
 * (`checkInRemindersScan`) loop across tenants so they wrap each iteration
 * in `TenantContext.run`.
 */
@Injectable()
export class BookingNotificationsService {
  private readonly log = new Logger(BookingNotificationsService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly notifications: NotificationService,
    // Resolves the live tenant row (slug, tier) for cron-loop iterations
    // that don't run inside an HTTP request. Optional so unit tests can
    // construct the service without the tenant module.
    @Optional() private readonly tenants?: TenantService,
  ) {}

  // === Confirmation ===

  async onCreated(reservation: Reservation): Promise<void> {
    try {
      const space = await this.loadSpaceName(reservation.space_id, reservation.tenant_id);
      const start = formatLocalIso(reservation.start_at);
      const subject = `Booking confirmed: ${space} · ${start}`;
      const body = [
        `Your booking for ${space} on ${start} is confirmed.`,
        `View it: ${this.deepLink(reservation.id)}`,
      ].join('\n\n');
      await this.notifications.send({
        notification_type: 'reservation_created',
        recipient_person_id: reservation.requester_person_id,
        related_entity_type: 'reservation',
        related_entity_id: reservation.id,
        subject,
        body,
      });
      await this.audit(reservation.tenant_id, 'reservation.notification_sent', {
        reservation_id: reservation.id,
        kind: 'created',
      });
    } catch (err) {
      this.log.warn(`onCreated notification failed: ${(err as Error).message}`);
    }
  }

  // === Cancellation ===

  async onCancelled(reservation: Reservation, reason?: string): Promise<void> {
    try {
      const space = await this.loadSpaceName(reservation.space_id, reservation.tenant_id);
      const subject = `Booking cancelled: ${space}`;
      const body = [
        `Your booking for ${space} on ${formatLocalIso(reservation.start_at)} was cancelled.`,
        reason ? `Reason: ${reason}` : null,
        `Rebook: ${this.bookSimilarLink(reservation)}`,
      ].filter(Boolean).join('\n\n');
      await this.notifications.send({
        notification_type: 'reservation_cancelled',
        recipient_person_id: reservation.requester_person_id,
        related_entity_type: 'reservation',
        related_entity_id: reservation.id,
        subject,
        body,
      });
      await this.audit(reservation.tenant_id, 'reservation.notification_sent', {
        reservation_id: reservation.id, kind: 'cancelled', reason: reason ?? null,
      });
    } catch (err) {
      this.log.warn(`onCancelled notification failed: ${(err as Error).message}`);
    }
  }

  // === Auto-release (the self-explaining differentiator) ===

  async onReleased(reservation: Reservation): Promise<void> {
    try {
      const space = await this.loadSpaceName(reservation.space_id, reservation.tenant_id);
      const start = formatLocalIso(reservation.start_at);
      const subject = `Booking released: ${space}`;
      // Spec §12 differentiator: tell the user *why*, not just "released".
      const body = [
        `Your booking for ${space} on ${start} was automatically released.`,
        `Why: We require check-in within ${reservation.check_in_grace_minutes} minutes of the booking start, and we didn't see one.`,
        `Want it back? Rebook this slot: ${this.bookSimilarLink(reservation)}`,
        `Or see alternatives at the same time: ${this.alternativesLink(reservation)}`,
      ].join('\n\n');
      await this.notifications.send({
        notification_type: 'reservation_released',
        recipient_person_id: reservation.requester_person_id,
        related_entity_type: 'reservation',
        related_entity_id: reservation.id,
        subject,
        body,
      });
      await this.audit(reservation.tenant_id, 'reservation.notification_sent', {
        reservation_id: reservation.id, kind: 'released',
      });
    } catch (err) {
      this.log.warn(`onReleased notification failed: ${(err as Error).message}`);
    }
  }

  // === Approval flow ===

  async onApprovalRequested(
    reservation: Reservation,
    approvalConfig: { required_approvers?: Array<{ type: 'team' | 'person'; id: string }> },
  ): Promise<void> {
    try {
      const space = await this.loadSpaceName(reservation.space_id, reservation.tenant_id);
      const subject = `Booking needs your approval: ${space}`;
      const body = [
        `${space} on ${formatLocalIso(reservation.start_at)} is waiting on approval.`,
        `Review: ${this.deepLink(reservation.id)}`,
      ].join('\n\n');
      const approvers = approvalConfig.required_approvers ?? [];
      for (const a of approvers) {
        if (a.type === 'team') {
          await this.notifications.sendToTeam(a.id, {
            notification_type: 'reservation_approval_requested',
            related_entity_type: 'reservation',
            related_entity_id: reservation.id,
            subject,
            body,
          });
        } else {
          await this.notifications.send({
            notification_type: 'reservation_approval_requested',
            recipient_person_id: a.id,
            related_entity_type: 'reservation',
            related_entity_id: reservation.id,
            subject,
            body,
          });
        }
      }
      await this.audit(reservation.tenant_id, 'reservation.notification_sent', {
        reservation_id: reservation.id, kind: 'approval_requested',
        approver_count: approvers.length,
      });
    } catch (err) {
      this.log.warn(`onApprovalRequested notification failed: ${(err as Error).message}`);
    }
  }

  async onApprovalDecided(
    reservation: Reservation,
    decision: 'approved' | 'rejected',
    note?: string,
  ): Promise<void> {
    try {
      const space = await this.loadSpaceName(reservation.space_id, reservation.tenant_id);
      const subject = decision === 'approved'
        ? `Booking approved: ${space}`
        : `Booking rejected: ${space}`;
      const body = [
        decision === 'approved'
          ? `Your booking for ${space} on ${formatLocalIso(reservation.start_at)} was approved.`
          : `Your booking for ${space} on ${formatLocalIso(reservation.start_at)} was rejected.`,
        note ? `Note: ${note}` : null,
        decision === 'approved'
          ? `View: ${this.deepLink(reservation.id)}`
          : `Try another room: ${this.alternativesLink(reservation)}`,
      ].filter(Boolean).join('\n\n');
      await this.notifications.send({
        notification_type:
          decision === 'approved' ? 'reservation_approved' : 'reservation_rejected',
        recipient_person_id: reservation.requester_person_id,
        related_entity_type: 'reservation',
        related_entity_id: reservation.id,
        subject,
        body,
      });
      await this.audit(reservation.tenant_id, 'reservation.notification_sent', {
        reservation_id: reservation.id, kind: `approval_${decision}`,
      });
    } catch (err) {
      this.log.warn(`onApprovalDecided notification failed: ${(err as Error).message}`);
    }
  }

  // === Check-in reminder (cron) ===

  /**
   * Cron — every 5 minutes. Find bookings whose start_at is in the next 5
   * minutes with check_in_required=true and where we haven't sent the
   * reminder yet (tracked via a marker in policy_snapshot.reminder_sent_at).
   */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'checkInRemindersScan' })
  async checkInRemindersScan(): Promise<void> {
    const now = Date.now();
    const cutoff = new Date(now + 5 * 60 * 1000).toISOString();
    const earliest = new Date(now - 1 * 60 * 1000).toISOString();

    // Post-canonicalisation (2026-05-02): per-slot check-in lives on
    // booking_slots (00277:147-151). Embed the parent booking for
    // policy_snapshot + tenant info. policy_snapshot lives on bookings
    // (00277:63) — we read it through the embed and update it on the
    // bookings row.
    const { data, error } = await this.supabase.admin
      .from('booking_slots')
      .select(SLOT_WITH_BOOKING_SELECT)
      .eq('check_in_required', true)
      .eq('status', 'confirmed')
      .is('checked_in_at', null)
      .gte('start_at', earliest)
      .lte('start_at', cutoff)
      .limit(200);

    if (error) {
      this.log.error(`checkInRemindersScan select error: ${error.message}`);
      return;
    }

    for (const slotRow of (data ?? []) as unknown as SlotWithBookingEmbed[]) {
      const reservation = slotWithBookingToReservation(slotRow);
      const ps = (reservation.policy_snapshot ?? {}) as Record<string, unknown>;
      if (ps['reminder_sent_at']) continue;

      try {
        const tenant = this.tenants ? await this.tenants.resolveById(reservation.tenant_id) : null;
        if (!tenant) {
          this.log.warn(
            `checkInRemindersScan ${reservation.id}: tenant ${reservation.tenant_id} not found, skipping`,
          );
          continue;
        }
        await TenantContext.run(tenant, async () => {
          await this.sendCheckInReminder(reservation);
        });
        // Conditional read-modify-write on bookings.policy_snapshot
        // (00277:63). The conditional `is('...->>reminder_sent_at', null)`
        // prevents racing reminders from double-clobbering the field. The
        // legacy `reservation_merge_policy_snapshot` RPC was bound to the
        // dropped `reservations` table; the spec defers function rewrites,
        // so we use the conditional UPDATE pattern directly.
        await this.supabase.admin
          .from('bookings')
          .update({
            policy_snapshot: { ...ps, reminder_sent_at: new Date().toISOString() },
          })
          // Defense-in-depth per the project's #0 invariant: admin-client
          // writes filter by tenant_id explicitly even though uuid id
          // collisions are practically impossible.
          .eq('tenant_id', reservation.tenant_id)
          .eq('id', reservation.id)
          .is('policy_snapshot->>reminder_sent_at', null);
      } catch (err) {
        this.log.warn(`checkInRemindersScan ${reservation.id} failed: ${(err as Error).message}`);
      }
    }
  }

  private async sendCheckInReminder(reservation: Reservation): Promise<void> {
    const space = await this.loadSpaceName(reservation.space_id, reservation.tenant_id);
    const subject = `Check in: ${space}`;
    const magicLink = this.makeMagicCheckInLink(reservation);
    const body = [
      `Your booking for ${space} starts at ${formatLocalIso(reservation.start_at)}.`,
      `Tap to check in (no login needed): ${magicLink}`,
      `If you don't check in within ${reservation.check_in_grace_minutes} minutes of start, the room will be released.`,
    ].join('\n\n');
    await this.notifications.send({
      notification_type: 'reservation_check_in_reminder',
      recipient_person_id: reservation.requester_person_id,
      related_entity_type: 'reservation',
      related_entity_id: reservation.id,
      subject,
      body,
    });
    await this.audit(reservation.tenant_id, 'reservation.notification_sent', {
      reservation_id: reservation.id, kind: 'check_in_reminder',
    });
  }

  // === Helpers ===

  private async loadSpaceName(spaceId: string, tenantId: string): Promise<string> {
    const { data } = await this.supabase.admin
      .from('spaces')
      .select('name')
      .eq('tenant_id', tenantId)
      .eq('id', spaceId)
      .maybeSingle();
    return ((data as { name?: string } | null)?.name) ?? 'the room';
  }

  private deepLink(reservationId: string): string {
    const base = process.env.PORTAL_BASE_URL ?? 'https://app.prequest.io';
    return `${base}/portal/me/bookings/${reservationId}`;
  }

  private bookSimilarLink(r: Reservation): string {
    const base = process.env.PORTAL_BASE_URL ?? 'https://app.prequest.io';
    const params = new URLSearchParams({
      start_at: r.start_at,
      end_at: r.end_at,
      attendee_count: String(r.attendee_count ?? 1),
      space_id: r.space_id,
    });
    return `${base}/portal/book/room?${params.toString()}`;
  }

  private alternativesLink(r: Reservation): string {
    const base = process.env.PORTAL_BASE_URL ?? 'https://app.prequest.io';
    const params = new URLSearchParams({
      start_at: r.start_at,
      end_at: r.end_at,
      attendee_count: String(r.attendee_count ?? 1),
    });
    return `${base}/portal/book/room?${params.toString()}`;
  }

  private makeMagicCheckInLink(r: Reservation): string {
    // Lazy import to avoid pulling crypto into pure unit tests.
    const { createMagicCheckInToken } = require('./magic-check-in.token') as
      typeof import('./magic-check-in.token');
    const token = createMagicCheckInToken({
      reservationId: r.id,
      requesterPersonId: r.requester_person_id,
      ttlMinutes: 30,
    });
    const base = process.env.API_BASE_URL ?? 'https://api.prequest.io';
    return `${base}/api/reservations/${r.id}/check-in/magic?token=${encodeURIComponent(token)}`;
  }

  private async audit(tenantId: string, eventType: string, details: Record<string, unknown>) {
    try {
      await this.supabase.admin.from('audit_events').insert({
        tenant_id: tenantId,
        event_type: eventType,
        entity_type: 'booking',
        entity_id: (details.reservation_id as string) ?? null,
        details,
      });
    } catch (err) {
      this.log.warn(`audit insert failed for ${eventType}: ${(err as Error).message}`);
    }
  }
}

// Format an ISO timestamp into the kind of human-readable string we want in
// emails. Locale-independent (server side) but readable: "2026-05-04 09:00 UTC".
function formatLocalIso(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mn = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mn} UTC`;
}

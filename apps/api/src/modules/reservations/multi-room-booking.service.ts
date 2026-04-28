import {
  ConflictException, Injectable, Logger, BadRequestException,
} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { BookingFlowService } from './booking-flow.service';
import { BundleCascadeService } from '../booking-bundles/bundle-cascade.service';
import type { ActorContext, Reservation } from './dto/types';

/**
 * Multi-room atomic create.
 *
 * Per spec §G3: book the same time window across N rooms as one logical
 * booking. If any room fails (rule deny, conflict guard race, validation),
 * cancel any rows already created and throw 409 with the failed rooms.
 *
 * Postgres has no cross-row "all or nothing" mode that BookingFlowService
 * would naturally fit into without a stored proc. We implement
 * sequential-best-effort with rollback: create the multi_room_groups row,
 * then create reservations one-by-one through BookingFlowService (so the
 * full pipeline runs per room). On any failure, mark each successfully-
 * created row as cancelled and surface the structured error.
 *
 * The single approval row covers the group when any rule requires approval
 * (the highest-specificity approval_config wins via per-room resolution;
 * BookingFlowService creates the per-room approval row, and we point the
 * group at the primary).
 */
@Injectable()
export class MultiRoomBookingService {
  private readonly log = new Logger(MultiRoomBookingService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly bookingFlow: BookingFlowService,
    private readonly bundleCascade: BundleCascadeService,
  ) {}

  async createGroup(
    input: {
      space_ids: string[];
      requester_person_id: string;
      start_at: string;
      end_at: string;
      attendee_count?: number;
      attendee_person_ids?: string[];
      host_person_id?: string | null;
      source?: 'portal' | 'desk' | 'api' | 'calendar_sync' | 'auto';
      services?: Array<{
        catalog_item_id: string;
        menu_id?: string | null;
        quantity: number;
        service_window_start_at?: string | null;
        service_window_end_at?: string | null;
        repeats_with_series?: boolean;
        linked_asset_id?: string | null;
      }>;
      bundle?: {
        bundle_type?: 'meeting' | 'event' | 'desk_day' | 'parking' | 'hospitality' | 'other';
        cost_center_id?: string | null;
        template_id?: string | null;
      };
    },
    actor: ActorContext,
  ): Promise<{ group_id: string; reservations: Reservation[] }> {
    const tenantId = TenantContext.current().id;
    const spaceIds = Array.from(new Set(input.space_ids ?? []));
    if (spaceIds.length < 2) {
      throw new BadRequestException({
        code: 'multi_room_requires_two',
        message: 'Multi-room bookings require at least two spaces.',
      });
    }
    if (spaceIds.length > 10) {
      throw new BadRequestException({
        code: 'multi_room_too_many',
        message: 'Multi-room bookings are limited to 10 spaces.',
      });
    }

    // 1. Insert the multi_room_groups row first so each reservation can
    //    point at it. We fill `primary_reservation_id` after the first room
    //    succeeds.
    const { data: groupRow, error: groupErr } = await this.supabase.admin
      .from('multi_room_groups')
      .insert({
        tenant_id: tenantId,
        requester_person_id: input.requester_person_id,
      })
      .select('id')
      .single();
    if (groupErr || !groupRow) {
      throw new BadRequestException({
        code: 'multi_room_group_insert_failed',
        message: groupErr?.message ?? 'unknown',
      });
    }
    const groupId = (groupRow as { id: string }).id;

    const created: Reservation[] = [];
    const failures: Array<{ space_id: string; reason: string; details?: unknown }> = [];

    // 2. Create per-room reservations in sequence. Sequential keeps the
    //    same-tenant connection ordering predictable and lets us short-
    //    circuit on the first failure cheaply.
    //
    // Services bind to the PRIMARY room only (the first space_id) — a
    // multi-room event has one bundle for catering/AV regardless of how
    // many rooms the attendees spread across. The non-primary rooms are
    // booked room-only and link via multi_room_group_id.
    const resolvedSource: 'portal' | 'desk' | 'api' | 'calendar_sync' | 'auto' =
      actor.user_id.startsWith('system:')
        ? 'auto'
        : input.source ?? 'portal';

    for (const spaceId of spaceIds) {
      const isPrimary = spaceId === spaceIds[0];
      try {
        const r = await this.bookingFlow.create(
          {
            space_id: spaceId,
            requester_person_id: input.requester_person_id,
            host_person_id: input.host_person_id ?? null,
            start_at: input.start_at,
            end_at: input.end_at,
            attendee_count: input.attendee_count,
            attendee_person_ids: input.attendee_person_ids,
            multi_room_group_id: groupId,
            source: resolvedSource,
            services: isPrimary ? input.services : undefined,
            bundle: isPrimary ? input.bundle : undefined,
          },
          actor,
        );
        created.push(r);
      } catch (err) {
        const e = err as { response?: { code?: string; message?: string }; message?: string };
        failures.push({
          space_id: spaceId,
          reason: e.response?.code ?? 'unknown',
          details: e.response ?? e.message,
        });
        // Don't keep trying — the group is already broken.
        break;
      }
    }

    if (failures.length > 0) {
      // 3. Rollback. Codex flagged on the contract-widening review:
      //    the previous version (a) missed reservations that landed but
      //    failed during attachServicesToReservation (the row sits in
      //    DB but BookingFlowService.create threw before pushing into
      //    `created`), and (b) raw-updated reservations.status without
      //    cascading to bundle/orders/tickets/assets.
      //
      //    Fix: re-query by multi_room_group_id so we capture orphans,
      //    then cascade through BundleCascadeService.cancelOrdersForReservation
      //    before flipping the reservation status.
      // Union: rooms BookingFlowService.create returned cleanly + any
      // orphans we discover via group_id (e.g. the primary's attach-
      // services step threw after the reservation already landed).
      const captured = new Map<string, { id: string; status: string }>();
      for (const r of created) captured.set(r.id, { id: r.id, status: r.status });
      const { data: groupRes, error: groupQueryErr } = await this.supabase.admin
        .from('reservations')
        .select('id, status')
        .eq('tenant_id', tenantId)
        .eq('multi_room_group_id', groupId);
      // If the compensating read fails, log and proceed with `created`
      // alone. The orphan prevention loses one branch but the booking-
      // flow's own Cleanup.rollback (now also voids bundle approvals)
      // means the worst case is a stale reservation row, not a stale
      // bundle/order/ticket cluster.
      if (groupQueryErr) {
        this.log.warn(
          `multi-room rollback: compensating read failed for group ${groupId}: ${groupQueryErr.message}`,
        );
      } else {
        for (const r of (groupRes ?? []) as Array<{ id: string; status: string }>) {
          if (!captured.has(r.id)) captured.set(r.id, r);
        }
      }
      const allInGroup = [...captured.values()].filter((r) => r.status !== 'cancelled');

      // Cascade bundles/orders/tickets first; then flip the reservation
      // row. Best-effort cascade — if the bundle service throws, log and
      // continue so the reservation rollback still happens.
      for (const r of allInGroup) {
        try {
          await this.bundleCascade.cancelOrdersForReservation({
            reservation_id: r.id,
            reason: 'Multi-room booking rolled back — sibling reservation failed.',
          });
        } catch (err) {
          this.log.warn(`bundle cascade on rollback failed for ${r.id}: ${(err as Error).message}`);
        }
      }

      for (const r of allInGroup) {
        await this.supabase.admin
          .from('reservations')
          .update({ status: 'cancelled', cancellation_grace_until: null })
          .eq('tenant_id', tenantId)
          .eq('id', r.id);
      }
      // Cancel any approval rows the BookingFlow may have created for the
      // rolled-back reservations. Without this, approvers receive a
      // notification + see a pending row in /desk/approvals for a booking
      // that no longer exists. We update — not delete — so the audit
      // trail keeps a record of "this approval was opened then voided
      // because the group rolled back". Use the by-group set so an
      // attach-failure orphan also gets its approval voided.
      if (allInGroup.length > 0) {
        await this.supabase.admin
          .from('approvals')
          .update({
            status: 'cancelled',
            comments: 'Multi-room booking rolled back — sibling reservation failed.',
          })
          .eq('tenant_id', tenantId)
          .eq('target_entity_type', 'reservation')
          .in('target_entity_id', allInGroup.map((r) => r.id))
          .eq('status', 'pending');
      }
      // The group row stays — the FK in 00125 (reservations.multi_room_group_id
      // → multi_room_groups.id) lacks ON DELETE CASCADE, so a delete would
      // throw with cancelled reservations still pointing at it. Leaving the
      // row preserves the audit + analytics linkage; the rolled-back state
      // is determined from reservation.status, not from the group's
      // existence.

      // Audit — phase K. Distinct from `reservation.multi_room_created`
      // so reporting can see how often atomic groups roll back and which
      // sibling failed (typically a slot conflict on one room of N).
      try {
        await this.supabase.admin.from('audit_events').insert({
          tenant_id: tenantId,
          event_type: 'reservation.multi_room_rolled_back',
          entity_type: 'multi_room_group',
          entity_id: groupId,
          details: {
            attempted_space_ids: input.space_ids,
            cancelled_reservation_ids: allInGroup.map((r) => r.id),
            failures,
          },
        });
      } catch { /* best-effort */ }

      throw new ConflictException({
        code: 'multi_room_booking_failed',
        message: 'One or more rooms could not be booked. No partial bookings created.',
        failed: failures,
        rolled_back_count: allInGroup.length,
      });
    }

    // 4. Set the primary reservation pointer (the first room).
    if (created.length > 0) {
      await this.supabase.admin
        .from('multi_room_groups')
        .update({ primary_reservation_id: created[0].id })
        .eq('id', groupId);
    }

    // Audit — phase K. One event per group create. Per-reservation
    // create events are already emitted by BookingFlowService for each
    // child; this gives reporting a way to count "atomic group bookings"
    // independent of the per-room count.
    try {
      await this.supabase.admin.from('audit_events').insert({
        tenant_id: tenantId,
        event_type: 'reservation.multi_room_created',
        entity_type: 'multi_room_group',
        entity_id: groupId,
        details: {
          space_ids: input.space_ids,
          reservation_ids: created.map((r) => r.id),
          requester_person_id: input.requester_person_id,
          start_at: input.start_at,
          end_at: input.end_at,
        },
      });
    } catch { /* best-effort */ }

    this.log.log(`multi_room_group ${groupId}: ${created.length} rooms`);
    return { group_id: groupId, reservations: created };
  }
}

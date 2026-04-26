import {
  ConflictException, Injectable, Logger, BadRequestException,
} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { BookingFlowService } from './booking-flow.service';
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
    for (const spaceId of spaceIds) {
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
            source: actor.user_id.startsWith('system:') ? 'auto' : 'portal',
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
      // 3. Rollback: cancel everything we already created.
      for (const r of created) {
        await this.supabase.admin
          .from('reservations')
          .update({ status: 'cancelled', cancellation_grace_until: null })
          .eq('tenant_id', tenantId)
          .eq('id', r.id)
          .eq('status', r.status);
      }
      // Cancel any approval rows the BookingFlow may have created for the
      // rolled-back reservations. Without this, approvers receive a
      // notification + see a pending row in /desk/approvals for a booking
      // that no longer exists. We update — not delete — so the audit
      // trail keeps a record of "this approval was opened then voided
      // because the group rolled back".
      if (created.length > 0) {
        await this.supabase.admin
          .from('approvals')
          .update({
            status: 'cancelled',
            comments: 'Multi-room booking rolled back — sibling reservation failed.',
          })
          .eq('tenant_id', tenantId)
          .eq('target_entity_type', 'reservation')
          .in('target_entity_id', created.map((r) => r.id))
          .eq('status', 'pending');
      }
      // Drop the group row too — easier than leaving an orphan.
      await this.supabase.admin
        .from('multi_room_groups')
        .delete()
        .eq('tenant_id', tenantId)
        .eq('id', groupId);

      throw new ConflictException({
        code: 'multi_room_booking_failed',
        message: 'One or more rooms could not be booked. No partial bookings created.',
        failed: failures,
        rolled_back_count: created.length,
      });
    }

    // 4. Set the primary reservation pointer (the first room).
    if (created.length > 0) {
      await this.supabase.admin
        .from('multi_room_groups')
        .update({ primary_reservation_id: created[0].id })
        .eq('id', groupId);
    }

    this.log.log(`multi_room_group ${groupId}: ${created.length} rooms`);
    return { group_id: groupId, reservations: created };
  }
}

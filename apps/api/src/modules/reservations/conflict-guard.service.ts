import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

/**
 * Conflict guard for reservations.
 *
 * The actual no-overlap enforcement is the GiST exclusion constraint
 * `reservations_no_overlap` (migration 00123). This service provides:
 *
 * 1. preCheck — a non-binding query so callers can know about a conflict
 *    before they attempt the INSERT (used by edit, multi-room atomic create,
 *    and the recurrence dry-run).
 * 2. parseRaceError — when the INSERT does fail with SQLSTATE 23P01, this
 *    looks up the conflicting row and asks the picker (later in Phase C)
 *    for 3 alternative rooms at the requested time.
 *
 * Same-requester back-to-back buffer collapse is enforced in BookingFlowService
 * BEFORE INSERT — the constraint can't reference subqueries. We snapshot
 * setup_buffer_minutes / teardown_buffer_minutes to zero (or the actual
 * back-to-back overlap) when the prior or following booking on the same
 * room shares the requester_person_id.
 */
@Injectable()
export class ConflictGuardService {
  private readonly log = new Logger(ConflictGuardService.name);

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Returns rows that would conflict with [start_at, end_at] on space_id.
   * Considers buffers (the candidate's effective_*_at must be supplied).
   * Excludes any reservation_id in `excludeIds` — used when editing.
   */
  async preCheck(args: {
    space_id: string;
    effective_start_at: string;
    effective_end_at: string;
    exclude_ids?: string[];
  }): Promise<{ id: string; start_at: string; end_at: string; status: string; requester_person_id: string }[]> {
    const tenantId = TenantContext.current().id;

    // tstzrange overlap query against the active states the exclusion constraint covers.
    const { data, error } = await this.supabase.admin
      .from('reservations')
      .select('id, start_at, end_at, status, requester_person_id')
      .eq('tenant_id', tenantId)
      .eq('space_id', args.space_id)
      .in('status', ['confirmed', 'checked_in', 'pending_approval'])
      .lt('effective_start_at', args.effective_end_at)
      .gt('effective_end_at', args.effective_start_at);

    if (error) {
      this.log.error(`preCheck supabase error: ${error.message}`);
      return [];
    }
    const rows = (data ?? []) as Array<{
      id: string;
      start_at: string;
      end_at: string;
      status: string;
      requester_person_id: string;
    }>;
    if (args.exclude_ids?.length) {
      const exclude = new Set(args.exclude_ids);
      return rows.filter((r) => !exclude.has(r.id));
    }
    return rows;
  }

  /**
   * Determine if a Postgres error is the no-overlap exclusion violation.
   * SQLSTATE 23P01 = exclusion_violation.
   */
  isExclusionViolation(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const e = err as { code?: string; message?: string };
    if (e.code === '23P01') return true;
    return typeof e.message === 'string' && /reservations_no_overlap/.test(e.message);
  }

  /**
   * Compute snapshotted buffers for a candidate booking, applying the
   * same-requester back-to-back collapse rule (Q4d in spec).
   *
   * Returns the buffer minutes to actually persist on the new row.
   * If an immediately-prior or following booking on the same room belongs
   * to the same requester_person_id, the touching buffer is zeroed.
   */
  async snapshotBuffersForBooking(args: {
    space_id: string;
    requester_person_id: string;
    start_at: string;
    end_at: string;
    room_setup_buffer_minutes: number;
    room_teardown_buffer_minutes: number;
    exclude_ids?: string[];
  }): Promise<{ setup_buffer_minutes: number; teardown_buffer_minutes: number }> {
    const tenantId = TenantContext.current().id;

    let setup = args.room_setup_buffer_minutes;
    let teardown = args.room_teardown_buffer_minutes;
    if (setup === 0 && teardown === 0) return { setup_buffer_minutes: 0, teardown_buffer_minutes: 0 };

    // Find immediately-touching neighbours within a generous window.
    const probe = await this.supabase.admin
      .from('reservations')
      .select('id, start_at, end_at, requester_person_id')
      .eq('tenant_id', tenantId)
      .eq('space_id', args.space_id)
      .in('status', ['confirmed', 'checked_in', 'pending_approval'])
      .or(`end_at.eq.${args.start_at},start_at.eq.${args.end_at}`);

    const rows = ((probe.data ?? []) as Array<{
      id: string;
      start_at: string;
      end_at: string;
      requester_person_id: string;
    }>).filter((r) => !args.exclude_ids?.includes(r.id));

    for (const r of rows) {
      const sameRequester = r.requester_person_id === args.requester_person_id;
      if (!sameRequester) continue;
      if (r.end_at === args.start_at) {
        // prior booking ends exactly when ours starts → zero our setup buffer
        setup = 0;
      }
      if (r.start_at === args.end_at) {
        // following booking starts exactly when ours ends → zero our teardown buffer
        teardown = 0;
      }
    }
    return { setup_buffer_minutes: setup, teardown_buffer_minutes: teardown };
  }
}

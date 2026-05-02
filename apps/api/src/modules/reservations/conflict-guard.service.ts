import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

/**
 * Conflict guard for booking slots.
 *
 * The actual no-overlap enforcement is the GiST exclusion constraint
 * `booking_slots_no_overlap` (00277:211-217 — was `reservations_no_overlap`
 * pre-canonicalisation). This service provides:
 *
 * 1. preCheck — a non-binding query so callers can know about a conflict
 *    before they attempt the INSERT (used by edit, multi-room atomic create,
 *    and the recurrence dry-run).
 * 2. isExclusionViolation — when the INSERT does fail with SQLSTATE 23P01,
 *    callers use this to detect the no-overlap exclusion vs. other 23P errors.
 *
 * Same-requester back-to-back buffer collapse is enforced in BookingFlowService
 * BEFORE INSERT — the constraint can't reference subqueries. We snapshot
 * setup_buffer_minutes / teardown_buffer_minutes to zero (or the actual
 * back-to-back overlap) when the prior or following booking on the same
 * room shares the requester_person_id.
 *
 * Schema notes (post-rewrite, 2026-05-02):
 *   - Reads happen against `booking_slots` (00277:116). The slot row carries
 *     space_id, status, effective_*_at, and a booking_id back-reference but
 *     NOT requester_person_id — that lives on `bookings.requester_person_id`
 *     (00277:36). The buffer-collapse query joins via PostgREST embedding.
 *   - The slot id surfaced in `preCheck` results is now a SLOT id, not the
 *     legacy reservations.id. Callers (multi-room, edit) that previously
 *     used it to look up reservations.id directly will need to walk through
 *     the booking parent — separate slices' problem.
 */
@Injectable()
export class ConflictGuardService {
  private readonly log = new Logger(ConflictGuardService.name);

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Returns rows that would conflict with [start_at, end_at] on space_id.
   * Considers buffers (the candidate's effective_*_at must be supplied).
   * Excludes any slot id in `exclude_ids` — used when editing.
   *
   * `requester_person_id` is fetched from the parent booking via PostgREST
   * embed `bookings(requester_person_id)`; in the new schema, slots don't
   * carry the requester directly. Returned shape is preserved (flat
   * `requester_person_id`) to keep callers unchanged.
   */
  async preCheck(args: {
    space_id: string;
    effective_start_at: string;
    effective_end_at: string;
    exclude_ids?: string[];
  }): Promise<{ id: string; start_at: string; end_at: string; status: string; requester_person_id: string }[]> {
    const tenantId = TenantContext.current().id;

    // tstzrange overlap query against the active states the exclusion constraint covers.
    // PostgREST embed shape: `bookings(...)` resolves the FK booking_id -> bookings.id.
    const { data, error } = await this.supabase.admin
      .from('booking_slots')
      .select('id, start_at, end_at, status, bookings(requester_person_id)')
      .eq('tenant_id', tenantId)
      .eq('space_id', args.space_id)
      .in('status', ['confirmed', 'checked_in', 'pending_approval'])
      .lt('effective_start_at', args.effective_end_at)
      .gt('effective_end_at', args.effective_start_at);

    if (error) {
      this.log.error(`preCheck supabase error: ${error.message}`);
      return [];
    }
    // PostgREST returns a single-row FK embed as an object; in some configs
    // it can be an array. Normalise to a single object reference.
    type EmbedRow = {
      id: string;
      start_at: string;
      end_at: string;
      status: string;
      bookings:
        | { requester_person_id: string }
        | Array<{ requester_person_id: string }>
        | null;
    };
    const rows = ((data ?? []) as EmbedRow[]).map((r) => {
      const embed = Array.isArray(r.bookings) ? r.bookings[0] : r.bookings;
      return {
        id: r.id,
        start_at: r.start_at,
        end_at: r.end_at,
        status: r.status,
        requester_person_id: embed?.requester_person_id ?? '',
      };
    });
    if (args.exclude_ids?.length) {
      const exclude = new Set(args.exclude_ids);
      return rows.filter((r) => !exclude.has(r.id));
    }
    return rows;
  }

  /**
   * Determine if a Postgres error is the no-overlap exclusion violation.
   * SQLSTATE 23P01 = exclusion_violation.
   *
   * Constraint name changed from `reservations_no_overlap` (00123) to
   * `booking_slots_no_overlap` (00277:212). We match either pattern so
   * downstream callers wired before the rewrite still get a clean
   * `'reservation_slot_conflict'` 409 instead of a generic 400.
   */
  isExclusionViolation(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const e = err as { code?: string; message?: string };
    if (e.code === '23P01') return true;
    return (
      typeof e.message === 'string' &&
      /(?:reservations|booking_slots)_no_overlap/.test(e.message)
    );
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
    //
    // The DB filter widens to a small range around the candidate boundaries
    // because exact-equality on a timestamp string only matches when both
    // the writer and the reader rounded identically. Two clients that
    // round to different precisions (the portal rounds to the minute, the
    // scheduler grid resizes to 30-min cells) would store back-to-back
    // bookings with sub-second skew, miss this query entirely, and fail
    // to collapse the buffer. The JS-side TOL_MS check below was already
    // intended to cover that case but the DB filter was the gate.
    const TOL_MS = 1000;
    const newStart = new Date(args.start_at).getTime();
    const newEnd = new Date(args.end_at).getTime();
    const startLow = new Date(newStart - TOL_MS).toISOString();
    const startHigh = new Date(newStart + TOL_MS).toISOString();
    const endLow = new Date(newEnd - TOL_MS).toISOString();
    const endHigh = new Date(newEnd + TOL_MS).toISOString();
    // Same PostgREST embed pattern as preCheck — slots no longer carry
    // requester_person_id directly; pull it from the parent booking.
    const probe = await this.supabase.admin
      .from('booking_slots')
      .select('id, start_at, end_at, bookings(requester_person_id)')
      .eq('tenant_id', tenantId)
      .eq('space_id', args.space_id)
      .in('status', ['confirmed', 'checked_in', 'pending_approval'])
      .or(
        `and(end_at.gte.${startLow},end_at.lte.${startHigh}),` +
          `and(start_at.gte.${endLow},start_at.lte.${endHigh})`,
      );

    type EmbedRow = {
      id: string;
      start_at: string;
      end_at: string;
      bookings:
        | { requester_person_id: string }
        | Array<{ requester_person_id: string }>
        | null;
    };
    const rows = ((probe.data ?? []) as EmbedRow[])
      .map((r) => {
        const embed = Array.isArray(r.bookings) ? r.bookings[0] : r.bookings;
        return {
          id: r.id,
          start_at: r.start_at,
          end_at: r.end_at,
          requester_person_id: embed?.requester_person_id ?? '',
        };
      })
      .filter((r) => !args.exclude_ids?.includes(r.id));

    // The JS-side ±TOL_MS check below stays — same reason: the DB filter
    // can return a row that's 1.5s away if the client rounded into the
    // window, but only the exact-adjacency math should zero a buffer.
    for (const r of rows) {
      const sameRequester = r.requester_person_id === args.requester_person_id;
      if (!sameRequester) continue;
      const priorEnd = new Date(r.end_at).getTime();
      const followingStart = new Date(r.start_at).getTime();
      if (Math.abs(priorEnd - newStart) <= TOL_MS) {
        // prior booking ends roughly when ours starts → zero our setup buffer
        setup = 0;
      }
      if (Math.abs(followingStart - newEnd) <= TOL_MS) {
        // following booking starts roughly when ours ends → zero our teardown buffer
        teardown = 0;
      }
    }
    return { setup_buffer_minutes: setup, teardown_buffer_minutes: teardown };
  }
}

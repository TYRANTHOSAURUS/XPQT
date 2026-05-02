import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { ListBookableRoomsService } from './list-bookable-rooms.service';
import type { ActorContext, PickerCriteria, RankedRoom } from './dto/types';

/**
 * Find-time across N internal attendees.
 *
 * Algorithm:
 *   1. Load every attendee's reservations within [windowStart, windowEnd).
 *      We treat their attendance as "busy" too — both as requester and as
 *      attendee_person_ids member.
 *   2. Compute the busy-interval union (merge overlapping ranges).
 *   3. Subtract from the window to get free intervals.
 *   4. For each free interval ≥ duration, propose start times every
 *      30-minute step. For each candidate, run the picker (limited to 3
 *      rooms) to suggest top room candidates.
 *
 * Returns up to `maxSlots` (default 5) candidate slots, each annotated with
 * top-3 rooms.
 */
@Injectable()
export class MultiAttendeeFinder {
  private readonly log = new Logger(MultiAttendeeFinder.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly picker: ListBookableRoomsService,
  ) {}

  async findFreeSlots(
    args: {
      person_ids: string[];
      duration_minutes: number;
      window_start: string;
      window_end: string;
      criteria?: PickerCriteria;
      attendee_count?: number;
    },
    actor: ActorContext,
  ): Promise<{ slots: Array<{ start_at: string; end_at: string; rooms: RankedRoom[] }> }> {
    const tenantId = TenantContext.current().id;
    const personIds = Array.from(new Set(args.person_ids ?? []));
    if (personIds.length === 0) return { slots: [] };

    const windowStart = new Date(args.window_start);
    const windowEnd = new Date(args.window_end);
    if (
      !Number.isFinite(windowStart.getTime()) ||
      !Number.isFinite(windowEnd.getTime()) ||
      windowEnd <= windowStart
    ) {
      return { slots: [] };
    }

    const durationMs = args.duration_minutes * 60 * 1000;
    if (durationMs <= 0) return { slots: [] };

    // 1. Load each person's busy intervals.
    // Post-canonicalisation (2026-05-02): per-resource time + attendee
    // arrays live on `booking_slots` (00277:127-128, 139); requester is on
    // the parent `bookings` row (00277:36). Join both via the embedded
    // select so we keep one round-trip. The partial index
    // `idx_slots_space_time_active` (00277:181-184) covers the time
    // predicate; `idx_slots_attendee_persons` GIN (00277:188-190) the
    // attendee membership.
    const { data, error } = await this.supabase.admin
      .from('booking_slots')
      .select(
        'id, attendee_person_ids, effective_start_at, effective_end_at, status, ' +
          'booking:bookings!booking_id(requester_person_id)',
      )
      .eq('tenant_id', tenantId)
      .in('status', ['confirmed', 'checked_in', 'pending_approval'])
      .lt('effective_start_at', windowEnd.toISOString())
      .gt('effective_end_at', windowStart.toISOString());

    if (error) {
      this.log.warn(`findFreeSlots load conflicts error: ${error.message}`);
      return { slots: [] };
    }

    type Row = {
      id: string;
      attendee_person_ids: string[] | null;
      effective_start_at: string;
      effective_end_at: string;
      booking:
        | { requester_person_id: string }
        | { requester_person_id: string }[]
        | null;
    };

    const personSet = new Set(personIds);
    const busy: Array<[number, number]> = [];
    for (const row of (data ?? []) as unknown as Row[]) {
      const bookingRow = Array.isArray(row.booking) ? row.booking[0] ?? null : row.booking;
      const requesterId = bookingRow?.requester_person_id ?? null;
      const isAttendee =
        (requesterId !== null && personSet.has(requesterId)) ||
        (row.attendee_person_ids ?? []).some((p) => personSet.has(p));
      if (!isAttendee) continue;
      busy.push([
        new Date(row.effective_start_at).getTime(),
        new Date(row.effective_end_at).getTime(),
      ]);
    }

    // 2. Merge overlapping busy intervals (interval-tree-flatten).
    const merged = mergeIntervals(busy);

    // 3. Subtract from window → free intervals.
    const free = subtractIntervals(
      [windowStart.getTime(), windowEnd.getTime()],
      merged,
    );

    // 4. Walk each free interval and step every 30min producing candidate
    //    slots that fit `duration`. Cap total candidates so we don't blow
    //    the picker budget.
    const STEP_MS = 30 * 60 * 1000;
    const MAX_SLOTS = 5;
    const slots: Array<{ start_at: string; end_at: string; rooms: RankedRoom[] }> = [];

    for (const [from, to] of free) {
      if (slots.length >= MAX_SLOTS) break;
      let cursor = roundUpTo(from, STEP_MS);
      while (cursor + durationMs <= to && slots.length < MAX_SLOTS) {
        const startIso = new Date(cursor).toISOString();
        const endIso = new Date(cursor + durationMs).toISOString();
        try {
          const pickerResult = await this.picker.list(
            {
              start_at: startIso,
              end_at: endIso,
              attendee_count: args.attendee_count ?? Math.max(1, personIds.length),
              criteria: args.criteria,
              limit: 3,
              requester_id: actor.person_id ?? personIds[0],
            },
            actor,
          );
          if (pickerResult.rooms.length > 0) {
            slots.push({ start_at: startIso, end_at: endIso, rooms: pickerResult.rooms });
          }
        } catch (err) {
          this.log.warn(`findFreeSlots picker call failed at ${startIso}: ${(err as Error).message}`);
        }
        cursor += STEP_MS;
      }
    }

    return { slots };
  }
}

// === pure helpers (exported for tests) ===

export function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  if (intervals.length === 0) return [];
  const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [sorted[0]];
  for (let i = 1; i < sorted.length; i += 1) {
    const last = out[out.length - 1];
    const cur = sorted[i];
    if (cur[0] <= last[1]) {
      last[1] = Math.max(last[1], cur[1]);
    } else {
      out.push(cur);
    }
  }
  return out;
}

export function subtractIntervals(
  window: [number, number],
  busy: Array<[number, number]>,
): Array<[number, number]> {
  const [winStart, winEnd] = window;
  const free: Array<[number, number]> = [];
  let cursor = winStart;
  for (const [bStart, bEnd] of busy) {
    if (bEnd <= cursor) continue;
    if (bStart >= winEnd) break;
    if (bStart > cursor) free.push([cursor, Math.min(bStart, winEnd)]);
    cursor = Math.max(cursor, bEnd);
    if (cursor >= winEnd) break;
  }
  if (cursor < winEnd) free.push([cursor, winEnd]);
  return free.filter(([s, e]) => e > s);
}

function roundUpTo(ms: number, step: number): number {
  return Math.ceil(ms / step) * step;
}

import { useCallback, useEffect, useRef } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type {
  WorkOrderPlanningBlock,
  WorkOrderPlanningResponse,
} from '@prequest/shared';
import { workOrderPlanningKeys, type PlanningWindowFilters } from '@/api/work-order-planning';

/**
 * Keyboard-driven move/resize for planning blocks.
 *
 * The debouncer collapses an arrow burst into ONE PATCH — without it, every
 * keydown would fire a server round-trip, defeating the operator UX (a
 * power user holding ArrowRight to scrub a block 2 hours forward should
 * issue one mutation, not 24).
 *
 * Per-block accumulation: deltas keyed by `blockId` so two focused blocks
 * (unlikely but possible across focus changes) don't cross-contaminate.
 * The optimistic patch is written directly to the planning cache so the
 * block visually moves during the debounce window; the snapshot/restore
 * happens via the shared rollback helper at commit time.
 */

interface Accumulator {
  block: WorkOrderPlanningBlock;
  deltaStartMinutes: number;
  deltaDurationMinutes: number;
  /** Captured at the first key in the burst — restored if commit fails. */
  baselineStartIso: string;
  baselineDurationMinutes: number;
}

interface UseKeyboardNudgeOpts {
  qc: QueryClient;
  filters: PlanningWindowFilters;
  /**
   * Burst window. 300ms matches the operator's "tap-tap-tap" cadence
   * without making single nudges feel sluggish.
   */
  debounceMs?: number;
  /** Commit a finalized start/duration via the existing rollback helper. */
  onCommit: (
    block: WorkOrderPlanningBlock,
    nextStartIso: string,
    nextDurationMinutes: number | null,
  ) => void;
  /**
   * Gate — return `true` to reject the nudge (e.g. while a pointer drag is
   * active). Prevents the keyboard path from racing the drag controller's
   * ctxRef + optimistic patch.
   */
  isBlocked?: () => boolean;
}

export interface KeyboardNudgeApi {
  /** Shift the planned_start_at by `deltaMinutes` (positive = later). */
  nudgeStart: (block: WorkOrderPlanningBlock, deltaMinutes: number) => void;
  /** Shift planned_duration_minutes by `deltaMinutes` (positive = longer). */
  nudgeDuration: (block: WorkOrderPlanningBlock, deltaMinutes: number) => void;
  /** Force-commit any pending delta. Fired on Escape. */
  flush: () => void;
}

export function useKeyboardNudge(opts: UseKeyboardNudgeOpts): KeyboardNudgeApi {
  const { qc, filters, debounceMs = 300, onCommit, isBlocked } = opts;

  const accumRef = useRef<Accumulator | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable ref so the unmount cleanup can call the LATEST onCommit
  // without re-running the effect on every render. The useEffect cleanup
  // closure captures whatever onCommit was at mount time otherwise,
  // which goes stale fast across filter changes.
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  const filtersKey = workOrderPlanningKeys.window(filters);

  // Capture filters in a ref so the flush closure doesn't capture a stale
  // key when filters change mid-burst. The optimistic patch + commit MUST
  // target the filter-key that was active when the burst started; a filter
  // change mid-burst is rare but would leak the patch into an unrelated
  // cache slot.
  const burstKeyRef = useRef(filtersKey);

  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const acc = accumRef.current;
    accumRef.current = null;
    if (!acc) return;
    if (acc.deltaStartMinutes === 0 && acc.deltaDurationMinutes === 0) return;

    const nextStartIso = shiftIsoByMinutes(acc.baselineStartIso, acc.deltaStartMinutes);
    const nextDuration =
      acc.deltaDurationMinutes !== 0
        ? Math.max(15, acc.baselineDurationMinutes + acc.deltaDurationMinutes)
        : null;

    onCommit(acc.block, nextStartIso, nextDuration);
  }, [onCommit]);

  const scheduleCommit = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      flush();
    }, debounceMs);
  }, [debounceMs, flush]);

  const patchOptimistic = useCallback(
    (block: WorkOrderPlanningBlock, nextStartIso: string, nextDurationMinutes: number) => {
      qc.setQueryData<WorkOrderPlanningResponse>(burstKeyRef.current, (prev) => {
        if (!prev) return prev;
        const idx = prev.planned.findIndex((b) => b.id === block.id);
        if (idx < 0) return prev;
        const next = [...prev.planned];
        next[idx] = {
          ...next[idx],
          planned_start_at: nextStartIso,
          planned_duration_minutes: nextDurationMinutes,
        };
        return { ...prev, planned: next };
      });
    },
    [qc],
  );

  const beginOrContinue = useCallback(
    (block: WorkOrderPlanningBlock): Accumulator | null => {
      if (isBlocked?.()) return null;
      if (!block.planned_start_at || !block.can_plan) return null;

      // Fresh burst on a different block → flush the prior burst before
      // accumulating against the new baseline.
      if (accumRef.current && accumRef.current.block.id !== block.id) {
        flush();
      }
      if (!accumRef.current) {
        burstKeyRef.current = filtersKey;
        accumRef.current = {
          block,
          deltaStartMinutes: 0,
          deltaDurationMinutes: 0,
          baselineStartIso: block.planned_start_at,
          baselineDurationMinutes: block.planned_duration_minutes ?? 60,
        };
      }
      return accumRef.current;
    },
    [filtersKey, flush, isBlocked],
  );

  const nudgeStart = useCallback(
    (block: WorkOrderPlanningBlock, deltaMinutes: number) => {
      const acc = beginOrContinue(block);
      if (!acc) return;
      acc.deltaStartMinutes += deltaMinutes;
      const nextStartIso = shiftIsoByMinutes(acc.baselineStartIso, acc.deltaStartMinutes);
      const nextDuration = acc.baselineDurationMinutes + acc.deltaDurationMinutes;
      patchOptimistic(acc.block, nextStartIso, Math.max(15, nextDuration));
      scheduleCommit();
    },
    [beginOrContinue, patchOptimistic, scheduleCommit],
  );

  const nudgeDuration = useCallback(
    (block: WorkOrderPlanningBlock, deltaMinutes: number) => {
      const acc = beginOrContinue(block);
      if (!acc) return;
      const proposed = acc.baselineDurationMinutes + acc.deltaDurationMinutes + deltaMinutes;
      // Floor at 15 min so a long Shift+ArrowDown burst can't collapse the
      // block to zero. Mirrors the drag controller's `Math.max(1, …)` cell
      // clamp.
      if (proposed < 15) return;
      acc.deltaDurationMinutes += deltaMinutes;
      const nextStartIso = shiftIsoByMinutes(acc.baselineStartIso, acc.deltaStartMinutes);
      const nextDuration = acc.baselineDurationMinutes + acc.deltaDurationMinutes;
      patchOptimistic(acc.block, nextStartIso, nextDuration);
      scheduleCommit();
    },
    [beginOrContinue, patchOptimistic, scheduleCommit],
  );

  // Unmount: flush pending burst so a half-typed nudge commits rather
  // than vanishing. The previous implementation cleared accumRef without
  // firing onCommit — ArrowRight + click-away within debounceMs (300ms)
  // committed an optimistic cache patch but no server-side PATCH ever
  // fired. Truth refetched on next mount → silent data loss
  // (full-review C2, 2026-05-12).
  //
  // onCommit is async; useEffect cleanups can't await, so we fire it
  // synchronously and let React Query track the mutation. The route
  // change has already torn down the page, so the rollback dialog can't
  // render — but the mutation completes and the cache is correct for
  // the next visit. This trades a missed rollback affordance (when
  // navigating away mid-burst) for not silently losing the edit. The
  // explicit choice: silent data loss > missed rollback UI.
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const acc = accumRef.current;
      accumRef.current = null;
      if (!acc) return;
      if (acc.deltaStartMinutes === 0 && acc.deltaDurationMinutes === 0) return;
      const nextStartIso = shiftIsoByMinutes(acc.baselineStartIso, acc.deltaStartMinutes);
      const nextDuration =
        acc.deltaDurationMinutes !== 0
          ? Math.max(15, acc.baselineDurationMinutes + acc.deltaDurationMinutes)
          : null;
      onCommitRef.current(acc.block, nextStartIso, nextDuration);
    };
  }, []);

  return { nudgeStart, nudgeDuration, flush };
}

/**
 * Add `deltaMinutes` to an ISO instant via wall-clock arithmetic. `setMinutes`
 * walks LOCAL minutes which is zone-aware: a +30 nudge across the spring-
 * forward DST boundary correctly skips the gap (10:30 → 11:00 wall, not
 * 12:00 wall). Matches the pattern used inside `scheduler-time.cellToIso`.
 */
function shiftIsoByMinutes(iso: string, deltaMinutes: number): string {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() + deltaMinutes);
  return d.toISOString();
}

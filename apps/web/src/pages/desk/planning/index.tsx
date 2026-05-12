import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import type {
  PlanningLaneId,
  WorkOrderPlanningBlock,
  WorkOrderPlanningResponse,
} from '@prequest/shared';
import {
  buildDayBounds,
  cellToIso,
  columnsPerDay as computeColumnsPerDay,
  expandDates,
  isoToCell,
  shiftDate,
  toLocalDateString,
} from '@/lib/scheduler-time';
import { toast, toastError } from '@/lib/toast';
import { apiFetch } from '@/lib/api';
import { ticketKeys } from '@/api/tickets';
import {
  useWorkOrderPlanning,
  workOrderPlanningKeys,
  type PlanningWindowFilters,
} from '@/api/work-order-planning';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { formatRelativeTime } from '@/lib/format';
import { PlanningToolbar } from './components/planning-toolbar';
import { PlanningGrid, type PlanningLane, type PendingBlockDrag } from './components/planning-grid';
import { UnscheduledRail } from './components/unscheduled-rail';
import { usePlanningDrag, type PlanningDragState } from './hooks/use-planning-drag';
import { useKeyboardNudge } from './hooks/use-keyboard-nudge';
import { runOptimisticWithRollback } from './lib/commit-with-rollback';
import { deriveLanesFromBlocks } from './lib/lanes';

const RAIL_STORAGE_KEY = 'desk-planning-rail-collapsed';

// Day-view defaults. Spec: hours 7–19 visible by default, 30-min cells.
// `dayStartHour=0`, `dayEndHour=24` for the data window (per task), but
// the visible window for the grid is the narrower 7–19 band so blocks
// rendered outside that range scroll horizontally into view.
const DAY_START_HOUR = 7;
const DAY_END_HOUR = 19;
const CELL_MINUTES = 30;
const COLUMNS_PER_DAY = computeColumnsPerDay(DAY_START_HOUR, DAY_END_HOUR, CELL_MINUTES);

// "30 minutes" threshold for the past-slot confirm dialog.
const PAST_DROP_GRACE_MS = 30 * 60_000;

// Default duration applied when an operator drags a block from the
// unscheduled rail onto a lane (per spec).
const DEFAULT_PLAN_DURATION_MIN = 90;

/**
 * `/desk/planning` — Slice B planning board. Full-bleed canvas like the
 * room scheduler; does NOT wrap in `SettingsPageShell`.
 *
 * Layout: toolbar on top (~48px), unscheduled rail on the left (~280px,
 * collapsible), planning grid filling the rest.
 *
 * Data flow:
 *   1. Local state holds `{ anchorDate, status[], teamId, railCollapsed }`.
 *      No URL syncing in v1.0 — deferred per spec.
 *   2. `useWorkOrderPlanning` reads the window via `GET /work-orders/planning`.
 *   3. The toolbar mutates state; React Query refetches on the new key.
 *   4. Drag-to-move calls `PATCH /work-orders/:id` with the new
 *      `planned_start_at`. Optimistic update of the planning cache; on
 *      error the cache is invalidated to re-sync.
 */
export function DeskPlanningPage() {
  const qc = useQueryClient();

  // ── Filters & date ─────────────────────────────────────────────────
  const [anchorDate, setAnchorDate] = useState<string>(() => todayInTenantZone());
  const [status, setStatus] = useState<string[]>(() => [
    'new',
    'assigned',
    'in_progress',
    'waiting',
  ]);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => {
    try {
      return typeof window !== 'undefined'
        ? window.localStorage.getItem(RAIL_STORAGE_KEY) === 'true'
        : false;
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(RAIL_STORAGE_KEY, railCollapsed ? 'true' : 'false');
    } catch {
      // ignore storage failures (private mode, quota, etc.)
    }
  }, [railCollapsed]);

  // ── Window math ────────────────────────────────────────────────────
  // `from`/`to` cover the FULL day (0 → 24h local) so the API returns
  // every planned block on that day. The grid visualises 7–19; blocks
  // outside that band scroll horizontally into view via the grid's
  // overflow-auto container.
  const bounds = useMemo(() => buildDayBounds(anchorDate, 0, 24), [anchorDate]);
  const fromIso = bounds.start.toISOString();
  const toIso = bounds.end.toISOString();

  const dates = useMemo(() => expandDates(anchorDate, 'day'), [anchorDate]);
  const totalColumns = COLUMNS_PER_DAY * dates.length;
  const windowStartIso = useMemo(() => {
    const { start } = buildDayBounds(anchorDate, DAY_START_HOUR, DAY_END_HOUR);
    return start.toISOString();
  }, [anchorDate]);
  const windowEndIso = useMemo(() => {
    const { end } = buildDayBounds(anchorDate, DAY_START_HOUR, DAY_END_HOUR);
    return end.toISOString();
  }, [anchorDate]);

  // ── Read ───────────────────────────────────────────────────────────
  const filters: PlanningWindowFilters = useMemo(
    () => ({ from: fromIso, to: toIso, status, teamId }),
    [fromIso, toIso, status, teamId],
  );
  const planningQuery = useWorkOrderPlanning(filters);
  const data: WorkOrderPlanningResponse = planningQuery.data ?? {
    planned: [],
    unscheduled: [],
    lanes: [],
  };

  // ── Mutation helpers ───────────────────────────────────────────────
  // `useUpdateWorkOrder` from `@/api/tickets` requires the work-order id
  // at hook construction time; the planning page mutates many ids, so we
  // can't satisfy the rules-of-hooks by calling the hook inside an event
  // handler. Instead we hit the same `PATCH /work-orders/:id` endpoint
  // imperatively here, and invalidate the ticket detail cache by key so
  // a subsequent navigation re-reads the truth. See `useUpdateWorkOrder`
  // for the canonical optimistic update pattern on the detail cache.
  const mutateWorkOrder = useCallback(
    async (
      id: string,
      payload: {
        planned_start_at?: string;
        planned_duration_minutes?: number;
        assigned_user_id?: string | null;
        assigned_team_id?: string | null;
        assigned_vendor_id?: string | null;
      },
      // X-Client-Request-Id is minted at the gesture root (commitDrop) so a
      // retry through toastError({ retry }) reuses the same id and hits the
      // `command_operations` cached_result fast path. Minting a fresh id per
      // attempt would defeat idempotency on transient failures.
      requestId: string,
    ) => {
      const result = await apiFetch(`/work-orders/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
        headers: { 'X-Client-Request-Id': requestId },
      });
      // Detail invalidation keeps an open `/desk/tickets/:id` panel fresh.
      // Lists invalidation keeps `/desk/tickets` (the main queue) honest —
      // dragging a WO on the board changes its planned_start_at and (for
      // cross-lane moves) its assignment columns, both of which the list
      // renders. Mirrors `useUpdateWorkOrder`'s onSettled in
      // apps/web/src/api/tickets/mutations.ts.
      qc.invalidateQueries({ queryKey: ticketKeys.detail(id) });
      qc.invalidateQueries({ queryKey: ticketKeys.lists() });
      return result;
    },
    [qc],
  );

  const invalidatePlanning = useCallback(() => {
    qc.invalidateQueries({ queryKey: workOrderPlanningKeys.windows() });
  }, [qc]);

  // ── Past-drop confirm ──────────────────────────────────────────────
  const [pendingPastDrop, setPendingPastDrop] = useState<{
    block: WorkOrderPlanningBlock;
    isoStart: string;
    durationMinutes: number | null;
    assigneeOverride: AssigneeOverride | null;
    // `'drop'` reuses commitDrop's payload shape (start + optional duration
    // when unscheduled). `'keyboard'` always sends both because the
    // operator may have nudged duration without touching start (or vice
    // versa) but we don't track which side changed at confirm time.
    kind: 'drop' | 'keyboard';
  } | null>(null);

  // ── Drag controller (chunk 4) ─────────────────────────────────────
  // `usePlanningDrag` needs an `onComplete` that calls `handleDrop`, but
  // `handleDrop` itself depends on `commitDrop` which depends on
  // `mutateWorkOrder` — i.e. a long dependency chain we need to declare
  // first. We use a ref to break the chicken-and-egg ordering: the ref
  // is populated once `handleDrop` is defined, and the hook's
  // `onComplete` reads from the ref at call time.
  const handleDropRef = useRef<((state: PlanningDragState) => void) | null>(null);
  const dragController = usePlanningDrag({
    totalColumns,
    onComplete: (state) => handleDropRef.current?.(state),
  });

  // Server-supplied lanes (P1-1) are the truth — they include idle
  // assignees in the filtered team as drop targets. Falls back to
  // block-derived lanes when the server response is missing the field
  // (initial loading state, legacy response, or test fixtures that
  // omit it).
  const lanes: PlanningLane[] = useMemo(
    () =>
      deriveLanesFromBlocks(
        data.planned,
        data.unscheduled,
        data.lanes && data.lanes.length > 0 ? data.lanes : null,
      ),
    [data.planned, data.unscheduled, data.lanes],
  );

  // Truncation warning — fires once per (window, filter) combination so
  // the dispatcher knows the lane roster is partial. Sonner dedup by
  // id keeps a rapid filter-flip from spamming. Guarded by `data.truncated`
  // so it only emits when the server actually capped.
  const truncatedToastIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!data.truncated) {
      truncatedToastIdRef.current = null;
      return;
    }
    const key = `planning-truncated:${fromIso}:${teamId ?? ''}`;
    if (truncatedToastIdRef.current === key) return;
    truncatedToastIdRef.current = key;
    toast.warning('Showing the 50 busiest lanes', {
      description: 'Filter by team to see a specific roster.',
      id: key,
    });
  }, [data.truncated, fromIso, teamId]);

  // Block (lane → lane) drag start.
  const onBlockPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, block: WorkOrderPlanningBlock) => {
      if (!block.planned_start_at || !block.can_plan) return;
      // If the user grabbed the right-edge resize handle, we don't reach
      // this callback (the handle stops propagation). Still bail-guard.
      const startCell = isoToCell({
        dates,
        columnsPerDay: COLUMNS_PER_DAY,
        dayStartHour: DAY_START_HOUR,
        cellMinutes: CELL_MINUTES,
        iso: block.planned_start_at,
      });
      if (startCell == null) return;
      const cellSpan = Math.max(
        1,
        Math.ceil((block.planned_duration_minutes ?? 60) / CELL_MINUTES),
      );
      const blockEl = e.currentTarget;
      const rect = blockEl.getBoundingClientRect();
      const grabOffsetPx = e.clientX - rect.left;
      const laneEl = blockEl.closest('[data-lane-key]') as HTMLElement | null;
      const originLaneKey = laneEl?.getAttribute('data-lane-key') ?? null;
      dragController.begin(e, {
        blockId: block.id,
        source: 'lane',
        grabOffsetPx,
        cellSpan,
        originLaneKey,
        captureEl: blockEl,
        originStartCell: startCell,
      });
    },
    [dates, dragController],
  );

  const commitDrop = useCallback(
    async (
      block: WorkOrderPlanningBlock,
      isoStart: string,
      durationMinutes: number | null,
      assigneeOverride: AssigneeOverride | null,
      // Optional pre-minted X-Client-Request-Id. The initial gesture mints
      // a fresh uuid; the retry callback (below) passes the SAME uuid so
      // the server's command_operations cached_result fast path can fire.
      requestId?: string,
    ) => {
      const xCid = requestId ?? crypto.randomUUID();
      const wasUnscheduled = block.planned_start_at == null;
      const payload: {
        planned_start_at: string;
        planned_duration_minutes?: number;
        assigned_user_id?: string | null;
        assigned_team_id?: string | null;
        assigned_vendor_id?: string | null;
      } = { planned_start_at: isoStart };
      if (wasUnscheduled && durationMinutes != null) {
        payload.planned_duration_minutes = durationMinutes;
      }
      if (assigneeOverride) {
        payload.assigned_user_id = assigneeOverride.user_id;
        payload.assigned_team_id = assigneeOverride.team_id;
        payload.assigned_vendor_id = assigneeOverride.vendor_id;
      }

      // Capture the key + snapshot once at the start of the gesture. If
      // the operator changes the status/team filter while the PATCH is in
      // flight, the page re-renders against a new `filters` object — and
      // re-reading the key at error time would point at the WRONG cache
      // slot, leaving the optimistic patch un-reverted.
      const planningKey = workOrderPlanningKeys.window(filters);

      await runOptimisticWithRollback<WorkOrderPlanningResponse>({
        qc,
        key: planningKey,
        mutator: (prev) => optimisticMove(prev, block.id, payload, assigneeOverride),
        mutationFn: () => mutateWorkOrder(block.id, payload, xCid),
        onError: (err) => {
          toastError("Couldn't move plan", {
            error: err,
            // Reuse xCid so the retry is idempotent on the server.
            retry: () => commitDrop(block, isoStart, durationMinutes, assigneeOverride, xCid),
          });
        },
        onSettled: invalidatePlanning,
      });
    },
    [filters, invalidatePlanning, mutateWorkOrder, qc],
  );

  // Block resize-handle drag start. Anchors at the current block's start
  // cell; moves only the right edge → only `planned_duration_minutes`
  // changes on commit. No lane reassignment.
  const onBlockResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, block: WorkOrderPlanningBlock) => {
      if (!block.planned_start_at || !block.can_plan) return;
      const startCell = isoToCell({
        dates,
        columnsPerDay: COLUMNS_PER_DAY,
        dayStartHour: DAY_START_HOUR,
        cellMinutes: CELL_MINUTES,
        iso: block.planned_start_at,
      });
      if (startCell == null) return;
      const cellSpan = Math.max(
        1,
        Math.ceil((block.planned_duration_minutes ?? 60) / CELL_MINUTES),
      );
      // The block's body owns the move gesture; the resize handle that
      // dispatched this event is `e.currentTarget`. Capture pointer on
      // the parent block so events keep firing after we leave the
      // handle's tiny hit-area.
      const handleEl = e.currentTarget as HTMLElement;
      const blockEl = (handleEl.parentElement ?? handleEl) as HTMLElement;
      const laneEl = blockEl.closest('[data-lane-key]') as HTMLElement | null;
      const originLaneKey = laneEl?.getAttribute('data-lane-key') ?? null;
      dragController.begin(e, {
        blockId: block.id,
        source: 'resize',
        // grabOffsetPx is unused for resize, the handle is the implicit
        // anchor and the math uses cellAtCursor directly.
        grabOffsetPx: 0,
        cellSpan,
        originLaneKey,
        captureEl: blockEl,
        originStartCell: startCell,
      });
    },
    [dates, dragController],
  );

  // Rail (rail → lane) drag start.
  const onRailPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, block: WorkOrderPlanningBlock) => {
      if (!block.can_plan) return;
      const cellSpan = Math.max(1, Math.ceil(DEFAULT_PLAN_DURATION_MIN / CELL_MINUTES));
      // Rail cards have no positional context — anchor the grab to the
      // card centre so the cursor visually "holds" the card during the
      // drag.
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const grabOffsetPx = rect.width / 2;
      dragController.begin(e, {
        blockId: block.id,
        source: 'rail',
        grabOffsetPx,
        cellSpan,
        originLaneKey: null,
        captureEl: e.currentTarget as HTMLElement,
        originStartCell: 0,
      });
    },
    [dragController],
  );

  const commitResize = useCallback(
    async (
      block: WorkOrderPlanningBlock,
      newDurationMinutes: number,
      requestId?: string,
    ) => {
      const xCid = requestId ?? crypto.randomUUID();
      // Same key-capture discipline as commitDrop — filters can shift
      // mid-flight; reading the key at error time would miss the slot we
      // patched.
      const planningKey = workOrderPlanningKeys.window(filters);

      await runOptimisticWithRollback<WorkOrderPlanningResponse>({
        qc,
        key: planningKey,
        mutator: (prev) => {
          const idx = prev.planned.findIndex((b) => b.id === block.id);
          if (idx < 0) return prev;
          const next = [...prev.planned];
          next[idx] = { ...next[idx], planned_duration_minutes: newDurationMinutes };
          return { ...prev, planned: next };
        },
        mutationFn: () =>
          mutateWorkOrder(block.id, { planned_duration_minutes: newDurationMinutes }, xCid),
        onError: (err) => {
          toastError("Couldn't resize plan", {
            error: err,
            retry: () => commitResize(block, newDurationMinutes, xCid),
          });
        },
        onSettled: invalidatePlanning,
      });
    },
    [filters, invalidatePlanning, mutateWorkOrder, qc],
  );

  /**
   * Commit a keyboard nudge — may shift start, duration, or both. Routed
   * through the same rollback helper as drag so a 4xx/5xx PATCH restores
   * the cache before the toast fires.
   */
  const commitKeyboardChange = useCallback(
    async (
      block: WorkOrderPlanningBlock,
      isoStart: string,
      durationMinutes: number | null,
      requestId?: string,
    ) => {
      const xCid = requestId ?? crypto.randomUUID();
      const payload: {
        planned_start_at: string;
        planned_duration_minutes?: number;
      } = { planned_start_at: isoStart };
      if (durationMinutes != null) payload.planned_duration_minutes = durationMinutes;
      const planningKey = workOrderPlanningKeys.window(filters);
      await runOptimisticWithRollback<WorkOrderPlanningResponse>({
        qc,
        key: planningKey,
        mutator: (prev) => {
          const idx = prev.planned.findIndex((b) => b.id === block.id);
          if (idx < 0) return prev;
          const next = [...prev.planned];
          next[idx] = {
            ...next[idx],
            planned_start_at: isoStart,
            planned_duration_minutes:
              durationMinutes ?? next[idx].planned_duration_minutes,
          };
          return { ...prev, planned: next };
        },
        mutationFn: () => mutateWorkOrder(block.id, payload, xCid),
        onError: (err) => {
          toastError("Couldn't move plan", {
            error: err,
            retry: () => commitKeyboardChange(block, isoStart, durationMinutes, xCid),
          });
        },
        onSettled: invalidatePlanning,
      });
    },
    [filters, invalidatePlanning, mutateWorkOrder, qc],
  );

  // ── Keyboard nudge ────────────────────────────────────────────────
  // Drag/keyboard contention: keyboard input fast-fails if a pointer drag
  // is mid-flight. The drag controller's ctxRef + optimistic patch share a
  // cache slot with the keyboard path — overlapping them would interleave
  // two snapshot/restore sequences against the same key.
  const isDragActive = useCallback(
    () => dragController.active != null,
    [dragController.active],
  );
  const keyboardNudge = useKeyboardNudge({
    qc,
    filters,
    isBlocked: isDragActive,
    onCommit: (block, nextStartIso, nextDurationMinutes) => {
      const dropMs = new Date(nextStartIso).getTime();
      const inPast = dropMs < Date.now() - PAST_DROP_GRACE_MS;
      if (inPast) {
        setPendingPastDrop({
          block,
          isoStart: nextStartIso,
          durationMinutes: nextDurationMinutes,
          assigneeOverride: null,
          kind: 'keyboard',
        });
        return;
      }
      void commitKeyboardChange(block, nextStartIso, nextDurationMinutes);
    },
  });
  const onBlockKeyboardMove = useCallback(
    (block: WorkOrderPlanningBlock, deltaMinutes: number) => {
      keyboardNudge.nudgeStart(block, deltaMinutes);
    },
    [keyboardNudge],
  );
  const onBlockKeyboardResize = useCallback(
    (block: WorkOrderPlanningBlock, deltaMinutes: number) => {
      keyboardNudge.nudgeDuration(block, deltaMinutes);
    },
    [keyboardNudge],
  );
  const onBlockKeyboardFlush = useCallback(() => {
    keyboardNudge.flush();
  }, [keyboardNudge]);

  const handleDrop = useCallback(
    (state: PlanningDragState) => {
      const block =
        data.planned.find((b) => b.id === state.blockId) ??
        data.unscheduled.find((b) => b.id === state.blockId);
      if (!block) return;

      // Resize commits as a duration-only PATCH; bypass the move path.
      if (state.source === 'resize') {
        const newDurationMinutes = state.cellSpan * CELL_MINUTES;
        if (newDurationMinutes === block.planned_duration_minutes) return;
        void commitResize(block, newDurationMinutes);
        return;
      }

      if (!state.targetLaneKey) return;

      const isoStart = cellToIso({
        dates,
        columnsPerDay: COLUMNS_PER_DAY,
        dayStartHour: DAY_START_HOUR,
        cellMinutes: CELL_MINUTES,
        cell: state.newStartCell,
      });
      const dropMs = new Date(isoStart).getTime();
      const inPast = dropMs < Date.now() - PAST_DROP_GRACE_MS;

      // Reassignment rule: rail-source drop or cross-lane move →
      // override the WO's assignment to the lane the cursor landed on.
      // Same-lane drag-move leaves the assignment alone.
      const targetLaneId = parseLaneKey(state.targetLaneKey);
      const originLaneId = state.originLaneKey ? parseLaneKey(state.originLaneKey) : null;
      const assigneeOverride =
        state.source === 'rail' || (originLaneId && !sameLane(originLaneId, targetLaneId))
          ? assigneeForLane(targetLaneId)
          : null;

      // Duration: keep existing for lane moves; default 90 for rail drops
      // (per spec — fresh plan from the backlog).
      const durationMinutes =
        state.source === 'rail'
          ? DEFAULT_PLAN_DURATION_MIN
          : block.planned_duration_minutes;

      if (inPast) {
        setPendingPastDrop({
          block,
          isoStart,
          durationMinutes,
          assigneeOverride,
          kind: 'drop',
        });
        return;
      }
      void commitDrop(block, isoStart, durationMinutes, assigneeOverride);
    },
    [commitDrop, commitResize, data, dates],
  );

  handleDropRef.current = handleDrop;

  const pastDropDescription = pendingPastDrop
    ? `Set the plan to ${formatRelativeTime(pendingPastDrop.isoStart)}?`
    : '';

  const pendingDrag: PendingBlockDrag | null = useMemo(() => {
    const a = dragController.active;
    if (!a) return null;
    if (!a.targetLaneKey) return null;
    return {
      blockId: a.blockId,
      newStartCell: a.newStartCell,
      newEndCell: a.newEndCell,
      targetLaneKey: a.targetLaneKey,
      originLaneKey: a.originLaneKey ?? '',
    };
  }, [dragController.active]);

  const onLaneRowPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (dragController.active) dragController.onPointerMove(e);
    },
    [dragController],
  );
  const onLaneRowPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (dragController.active) dragController.onPointerUp(e);
    },
    [dragController],
  );

  // Global listener so drags still receive move/up events even if the
  // cursor leaves the grid. Escape cancels. pointercancel covers
  // iOS Safari multi-touch escape, scroll takeover, and system
  // interruptions — without it the gesture never ends, ctxRef stays
  // populated, and the re-entrant guard permanently locks the board.
  useEffect(() => {
    if (!dragController.active) return;
    const onMove = (e: PointerEvent) => {
      dragController.onPointerMove(e as unknown as React.PointerEvent);
    };
    const onUp = (e: PointerEvent) => {
      dragController.onPointerUp(e as unknown as React.PointerEvent);
    };
    const onCancel = (e: PointerEvent) => {
      dragController.onPointerCancel(e as unknown as React.PointerEvent);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dragController.cancel();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey);
    };
  }, [dragController]);

  return (
    <div className="flex h-[calc(100vh-3.5rem)] w-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to="/desk"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" /> Service Desk
          </Link>
          <div className="h-4 w-px bg-border" />
          <h1 className="text-sm font-semibold tracking-tight">Planning</h1>
          <span className="text-xs text-muted-foreground">
            {planningQuery.isFetching
              ? 'Updating…'
              : `${data.planned.length} planned · ${data.unscheduled.length} unscheduled`}
          </span>
        </div>
      </div>

      <PlanningToolbar
        anchorDate={anchorDate}
        status={status}
        teamId={teamId}
        railCollapsed={railCollapsed}
        onPrev={() => setAnchorDate((d) => shiftDate(d, -1))}
        onNext={() => setAnchorDate((d) => shiftDate(d, 1))}
        onToday={() => setAnchorDate(todayInTenantZone())}
        onStatusChange={setStatus}
        onTeamChange={setTeamId}
        onToggleRail={() => setRailCollapsed((v) => !v)}
      />

      <div className="flex min-h-0 flex-1">
        {!railCollapsed && (
          <UnscheduledRail
            items={data.unscheduled}
            isLoading={planningQuery.isLoading}
            onItemPointerDown={onRailPointerDown}
            draggingBlockId={
              dragController.active?.source === 'rail' ? dragController.active.blockId : null
            }
          />
        )}

        <div className="min-w-0 flex-1">
          {planningQuery.isError ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <p className="text-sm font-medium text-foreground">
                Couldn't load the planning board
              </p>
              <p className="max-w-md text-xs text-muted-foreground">
                Check your connection and try again. If this keeps happening,
                contact support — the date filter or window may be invalid.
              </p>
              <button
                type="button"
                onClick={() => planningQuery.refetch()}
                className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                Retry
              </button>
            </div>
          ) : (
            <PlanningGrid
              lanes={lanes}
              dates={dates}
              columnsPerDay={COLUMNS_PER_DAY}
              dayStartHour={DAY_START_HOUR}
              dayEndHour={DAY_END_HOUR}
              cellMinutes={CELL_MINUTES}
              windowStartIso={windowStartIso}
              windowEndIso={windowEndIso}
              pendingDrag={pendingDrag}
              onBlockPointerDown={onBlockPointerDown}
              onBlockResizePointerDown={onBlockResizePointerDown}
              onBlockKeyboardMove={onBlockKeyboardMove}
              onBlockKeyboardResize={onBlockKeyboardResize}
              onBlockKeyboardFlush={onBlockKeyboardFlush}
              onLaneRowPointerMove={onLaneRowPointerMove}
              onLaneRowPointerUp={onLaneRowPointerUp}
            />
          )}
        </div>
      </div>

      <ConfirmDialog
        open={!!pendingPastDrop}
        onOpenChange={(o) => {
          if (!o) {
            // Keyboard nudges paint the cache optimistically BEFORE the
            // past-slot dialog fires; cancelling the dialog without
            // invalidating leaves the operator looking at a phantom past
            // time until the next refetch. Drag's past-slot path doesn't
            // need this because drag's optimistic patch only lands inside
            // `commitDrop` which never runs on cancel.
            const wasKeyboard = pendingPastDrop?.kind === 'keyboard';
            setPendingPastDrop(null);
            if (wasKeyboard) invalidatePlanning();
          }
        }}
        title="Backfill plan?"
        description={pastDropDescription}
        confirmLabel="Confirm"
        cancelLabel="Cancel"
        onConfirm={async () => {
          if (!pendingPastDrop) return;
          const { block, isoStart, durationMinutes, assigneeOverride, kind } =
            pendingPastDrop;
          setPendingPastDrop(null);
          if (kind === 'keyboard') {
            await commitKeyboardChange(block, isoStart, durationMinutes);
          } else {
            await commitDrop(block, isoStart, durationMinutes, assigneeOverride);
          }
        }}
      />
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

function todayInTenantZone(): string {
  return toLocalDateString(new Date());
}

interface AssigneeOverride {
  user_id: string | null;
  team_id: string | null;
  vendor_id: string | null;
}

function assigneeForLane(laneId: PlanningLaneId): AssigneeOverride {
  switch (laneId.kind) {
    case 'user':
      return { user_id: laneId.id, team_id: null, vendor_id: null };
    case 'team':
      return { user_id: null, team_id: laneId.id, vendor_id: null };
    case 'vendor':
      return { user_id: null, team_id: null, vendor_id: laneId.id };
    case 'unassigned':
    default:
      return { user_id: null, team_id: null, vendor_id: null };
  }
}

function parseLaneKey(key: string): PlanningLaneId {
  const idx = key.indexOf(':');
  const kind = (idx >= 0 ? key.slice(0, idx) : key) as PlanningLaneId['kind'];
  const rawId = idx >= 0 ? key.slice(idx + 1) : '';
  const id = rawId === '∅' || rawId === '' ? null : rawId;
  return { kind, id, label: '' };
}

function sameLane(a: PlanningLaneId, b: PlanningLaneId): boolean {
  return a.kind === b.kind && (a.id ?? null) === (b.id ?? null);
}

/**
 * Optimistic update — move a block within / between lanes inside the
 * planning cache. When an assignee override is supplied (rail-source or
 * cross-lane drag), the block's lane is recomputed; otherwise the lane
 * stays as-is.
 */
function optimisticMove(
  prev: WorkOrderPlanningResponse,
  blockId: string,
  payload: { planned_start_at: string; planned_duration_minutes?: number },
  assigneeOverride: AssigneeOverride | null,
): WorkOrderPlanningResponse {
  const findIn = (list: WorkOrderPlanningBlock[]) => list.findIndex((b) => b.id === blockId);
  const fromPlanned = findIn(prev.planned);
  const fromUnscheduled = fromPlanned >= 0 ? -1 : findIn(prev.unscheduled);
  const source =
    fromPlanned >= 0
      ? prev.planned[fromPlanned]
      : fromUnscheduled >= 0
        ? prev.unscheduled[fromUnscheduled]
        : null;
  if (!source) return prev;

  const updated: WorkOrderPlanningBlock = {
    ...source,
    planned_start_at: payload.planned_start_at,
    planned_duration_minutes:
      payload.planned_duration_minutes ?? source.planned_duration_minutes,
    lane: assigneeOverride ? laneForOverride(assigneeOverride, source.lane) : source.lane,
  };

  const planned = [...prev.planned];
  const unscheduled = [...prev.unscheduled];
  if (fromPlanned >= 0) planned.splice(fromPlanned, 1);
  if (fromUnscheduled >= 0) unscheduled.splice(fromUnscheduled, 1);
  planned.push(updated);
  return { ...prev, planned, unscheduled };
}

function laneForOverride(
  override: AssigneeOverride,
  fallback: PlanningLaneId,
): PlanningLaneId {
  if (override.user_id) {
    return { kind: 'user', id: override.user_id, label: fallback.label || 'Assignee' };
  }
  if (override.team_id) {
    return { kind: 'team', id: override.team_id, label: fallback.label || 'Team' };
  }
  if (override.vendor_id) {
    return { kind: 'vendor', id: override.vendor_id, label: fallback.label || 'Vendor' };
  }
  return { kind: 'unassigned', id: null, label: 'Unassigned' };
}

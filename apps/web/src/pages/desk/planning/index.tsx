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
import { toastError } from '@/lib/toast';
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
  const data: WorkOrderPlanningResponse = planningQuery.data ?? { planned: [], unscheduled: [] };

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
    ) => {
      const requestId = crypto.randomUUID();
      const result = await apiFetch(`/work-orders/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
        headers: { 'X-Client-Request-Id': requestId },
      });
      qc.invalidateQueries({ queryKey: ticketKeys.detail(id) });
      return result;
    },
    [qc],
  );

  const patchPlanningCache = useCallback(
    (mutator: (prev: WorkOrderPlanningResponse) => WorkOrderPlanningResponse) => {
      qc.setQueryData<WorkOrderPlanningResponse>(
        workOrderPlanningKeys.window(filters),
        (prev) => (prev ? mutator(prev) : prev),
      );
    },
    [qc, filters],
  );

  const invalidatePlanning = useCallback(() => {
    qc.invalidateQueries({ queryKey: workOrderPlanningKeys.windows() });
  }, [qc]);

  // ── Past-drop confirm ──────────────────────────────────────────────
  const [pendingPastDrop, setPendingPastDrop] = useState<{
    block: WorkOrderPlanningBlock;
    isoStart: string;
    durationMinutes: number | null;
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

  const lanes: PlanningLane[] = useMemo(() => {
    const map = new Map<string, PlanningLane>();
    const ensure = (laneId: PlanningLaneId): PlanningLane => {
      const key = `${laneId.kind}:${laneId.id ?? '∅'}`;
      let lane = map.get(key);
      if (!lane) {
        lane = { id: laneId, blocks: [] };
        map.set(key, lane);
      }
      return lane;
    };
    for (const block of data.planned) {
      const lane = ensure(block.lane);
      lane.blocks.push(block);
    }
    return Array.from(map.values());
  }, [data.planned]);

  // Block (lane → lane) drag start.
  const onBlockPointerDown = useCallback(
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
    ) => {
      const wasUnscheduled = block.planned_start_at == null;
      const payload: {
        planned_start_at: string;
        planned_duration_minutes?: number;
      } = { planned_start_at: isoStart };
      if (wasUnscheduled && durationMinutes != null) {
        payload.planned_duration_minutes = durationMinutes;
      }

      patchPlanningCache((prev) => optimisticMove(prev, block.id, payload));

      try {
        await mutateWorkOrder(block.id, payload);
      } catch (err) {
        invalidatePlanning();
        toastError("Couldn't move plan", {
          error: err,
          retry: () => commitDrop(block, isoStart, durationMinutes),
        });
        return;
      }
      invalidatePlanning();
    },
    [invalidatePlanning, mutateWorkOrder, patchPlanningCache],
  );

  const handleDrop = useCallback(
    (state: PlanningDragState) => {
      const block =
        data.planned.find((b) => b.id === state.blockId) ??
        data.unscheduled.find((b) => b.id === state.blockId);
      if (!block) return;
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
      const durationMinutes = block.planned_duration_minutes;

      if (inPast) {
        setPendingPastDrop({ block, isoStart, durationMinutes });
        return;
      }
      void commitDrop(block, isoStart, durationMinutes);
    },
    [commitDrop, data, dates],
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
  // cursor leaves the grid. Escape cancels.
  useEffect(() => {
    if (!dragController.active) return;
    const onMove = (e: PointerEvent) => {
      dragController.onPointerMove(e as unknown as React.PointerEvent);
    };
    const onUp = (e: PointerEvent) => {
      dragController.onPointerUp(e as unknown as React.PointerEvent);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dragController.cancel();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
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
          <UnscheduledRail items={data.unscheduled} isLoading={planningQuery.isLoading} />
        )}

        <div className="min-w-0 flex-1">
          {planningQuery.isError ? (
            <div className="flex h-full items-center justify-center text-sm text-destructive">
              {planningQuery.error instanceof Error
                ? planningQuery.error.message
                : 'Planning board failed to load'}
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
              onLaneRowPointerMove={onLaneRowPointerMove}
              onLaneRowPointerUp={onLaneRowPointerUp}
            />
          )}
        </div>
      </div>

      <ConfirmDialog
        open={!!pendingPastDrop}
        onOpenChange={(o) => {
          if (!o) setPendingPastDrop(null);
        }}
        title="Backfill plan?"
        description={pastDropDescription}
        confirmLabel="Confirm"
        cancelLabel="Cancel"
        onConfirm={async () => {
          if (!pendingPastDrop) return;
          const { block, isoStart, durationMinutes } = pendingPastDrop;
          setPendingPastDrop(null);
          await commitDrop(block, isoStart, durationMinutes);
        }}
      />
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

function todayInTenantZone(): string {
  return toLocalDateString(new Date());
}

/**
 * Optimistic update — move a block within / between lanes inside the
 * planning cache. The block's lane is kept as-is; lane changes from
 * cross-lane drag (reassignment) come in chunk 5 with the rail flow.
 */
function optimisticMove(
  prev: WorkOrderPlanningResponse,
  blockId: string,
  payload: { planned_start_at: string; planned_duration_minutes?: number },
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
  };

  const planned = [...prev.planned];
  const unscheduled = [...prev.unscheduled];
  if (fromPlanned >= 0) planned.splice(fromPlanned, 1);
  if (fromUnscheduled >= 0) unscheduled.splice(fromUnscheduled, 1);
  planned.push(updated);
  return { planned, unscheduled };
}

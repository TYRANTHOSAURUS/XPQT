import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import type {
  PlanningLaneId,
  WorkOrderPlanningResponse,
} from '@prequest/shared';
import {
  buildDayBounds,
  columnsPerDay as computeColumnsPerDay,
  expandDates,
  shiftDate,
  toLocalDateString,
} from '@/lib/scheduler-time';
import {
  useWorkOrderPlanning,
  type PlanningWindowFilters,
} from '@/api/work-order-planning';
import { PlanningToolbar } from './components/planning-toolbar';
import { PlanningGrid, type PlanningLane } from './components/planning-grid';
import { UnscheduledRail } from './components/unscheduled-rail';

const RAIL_STORAGE_KEY = 'desk-planning-rail-collapsed';

// Day-view defaults. Spec: hours 7–19 visible by default, 30-min cells.
// `dayStartHour=0`, `dayEndHour=24` for the data window (per task), but
// the visible window for the grid is the narrower 7–19 band so blocks
// rendered outside that range scroll horizontally into view.
const DAY_START_HOUR = 7;
const DAY_END_HOUR = 19;
const CELL_MINUTES = 30;
const COLUMNS_PER_DAY = computeColumnsPerDay(DAY_START_HOUR, DAY_END_HOUR, CELL_MINUTES);

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
 *
 * Drag-to-move, click-through, and rail-onto-lane interactions land in
 * subsequent chunks.
 */
export function DeskPlanningPage() {
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

  // Build the lane list from the response. Blocks contribute their lane,
  // deduped by key. Unassigned is pinned by `PlanningGrid`'s ordering.
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
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

function todayInTenantZone(): string {
  // `toLocalDateString(new Date())` returns the system-local date, which
  // matches `Europe/Amsterdam` for users in the Benelux. For travellers
  // we'd want the Amsterdam zone explicitly — defer until that's a real
  // requirement. The Slice A `plan-field` makes the same assumption.
  return toLocalDateString(new Date());
}

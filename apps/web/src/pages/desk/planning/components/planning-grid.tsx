import { useMemo } from 'react';
import type { PlanningLaneId, WorkOrderPlanningBlock } from '@prequest/shared';
import type { LocalDateString } from '@/lib/scheduler-time';
import { PlanningTimeAxis } from './planning-time-axis';
import { PlanningNowLine } from './planning-now-line';
import { PlanningLaneRow } from './planning-lane-row';

// Note on reuse: I evaluated lifting `SchedulerGrid` directly. It's
// virtualised against room rows + a reservation map and is heavily
// shaped around the booking concerns (rule outcomes, buffer shading per
// block, multi-room ghosts, etc). Decoupling it would be more invasive
// than maintaining a planning-specific clone. For v1 the planning grid
// is unvirtualised — typical lane counts (5–30) fit in DOM comfortably;
// we can lift Tanstack virtual later if the desk grows beyond ~100
// lanes per page.

export interface PlanningLane {
  id: PlanningLaneId;
  blocks: WorkOrderPlanningBlock[];
}

export interface PendingBlockDrag {
  blockId: string;
  newStartCell: number;
  newEndCell: number;
  /** Lane the cursor is currently over. */
  targetLaneKey: string;
  /** Lane the drag started on. */
  originLaneKey: string;
}

interface Props {
  lanes: PlanningLane[];
  dates: LocalDateString[];
  columnsPerDay: number;
  dayStartHour: number;
  dayEndHour: number;
  cellMinutes: number;
  windowStartIso: string;
  windowEndIso: string;
  laneLabelWidth?: number;
  rowHeight?: number;
  pendingDrag?: PendingBlockDrag | null;
  onBlockPointerDown?: (e: React.PointerEvent<HTMLDivElement>, block: WorkOrderPlanningBlock) => void;
  /** Resize-handle pointer-down — passed through to each lane row. */
  onBlockResizePointerDown?: (e: React.PointerEvent<HTMLDivElement>, block: WorkOrderPlanningBlock) => void;
  onLaneRowPointerMove?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onLaneRowPointerUp?: (e: React.PointerEvent<HTMLDivElement>) => void;
}

function laneKey(lane: PlanningLaneId): string {
  return `${lane.kind}:${lane.id ?? '∅'}`;
}

export function PlanningGrid({
  lanes,
  dates,
  columnsPerDay,
  dayStartHour,
  dayEndHour,
  cellMinutes,
  windowStartIso,
  windowEndIso,
  laneLabelWidth = 240,
  rowHeight = 64,
  pendingDrag,
  onBlockPointerDown,
  onBlockResizePointerDown,
  onLaneRowPointerMove,
  onLaneRowPointerUp,
}: Props) {
  const totalColumns = columnsPerDay * dates.length;

  const ordered = useMemo(() => orderLanes(lanes), [lanes]);

  return (
    <div className="relative h-full w-full overflow-auto">
      <PlanningTimeAxis
        dates={dates}
        dayStartHour={dayStartHour}
        dayEndHour={dayEndHour}
        cellMinutes={cellMinutes}
        laneLabelWidth={laneLabelWidth}
      />

      <div className="relative">
        <PlanningNowLine
          dates={dates}
          dayStartHour={dayStartHour}
          dayEndHour={dayEndHour}
          laneLabelWidth={laneLabelWidth}
        />

        {ordered.map((lane) => {
          const key = laneKey(lane.id);
          const isDropTarget =
            !!pendingDrag &&
            pendingDrag.targetLaneKey === key &&
            pendingDrag.originLaneKey !== key;
          const pendingForRow =
            pendingDrag && pendingDrag.targetLaneKey === key
              ? {
                  blockId: pendingDrag.blockId,
                  newStartCell: pendingDrag.newStartCell,
                  newEndCell: pendingDrag.newEndCell,
                }
              : null;
          return (
            <PlanningLaneRow
              key={key}
              lane={lane.id}
              blocks={lane.blocks}
              dates={dates}
              columnsPerDay={columnsPerDay}
              dayStartHour={dayStartHour}
              cellMinutes={cellMinutes}
              totalColumns={totalColumns}
              laneLabelWidth={laneLabelWidth}
              rowHeight={rowHeight}
              windowStartIso={windowStartIso}
              windowEndIso={windowEndIso}
              pendingDrag={pendingForRow}
              isPinned={lane.id.kind === 'unassigned'}
              isDropTarget={isDropTarget}
              onBlockPointerDown={onBlockPointerDown}
              onBlockResizePointerDown={onBlockResizePointerDown}
              onLaneRowPointerMove={onLaneRowPointerMove}
              onLaneRowPointerUp={onLaneRowPointerUp}
            />
          );
        })}

        {ordered.length === 0 && (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            No planned work in this window.
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Order lanes: pinned (unassigned) first, then alphabetical by label.
 * Ties go to lane kind (user → team → vendor) for stable rendering.
 */
function orderLanes(lanes: PlanningLane[]): PlanningLane[] {
  const KIND_ORDER: Record<PlanningLaneId['kind'], number> = {
    unassigned: -1,
    user: 0,
    team: 1,
    vendor: 2,
  };
  return [...lanes].sort((a, b) => {
    const ak = KIND_ORDER[a.id.kind];
    const bk = KIND_ORDER[b.id.kind];
    if (ak === -1 && bk !== -1) return -1;
    if (bk === -1 && ak !== -1) return 1;
    const labelCmp = a.id.label.localeCompare(b.id.label);
    if (labelCmp !== 0) return labelCmp;
    return ak - bk;
  });
}

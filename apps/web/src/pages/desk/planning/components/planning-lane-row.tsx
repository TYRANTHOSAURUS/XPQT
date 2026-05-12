import { memo } from 'react';
import { Users, User, Building2, CircleSlash } from 'lucide-react';
import type { PlanningLaneId, WorkOrderPlanningBlock } from '@prequest/shared';
import { cn } from '@/lib/utils';
import { isoToCell, type LocalDateString } from '@/lib/scheduler-time';
import { PlanningBlock } from './planning-block';
import { LaneBufferShading } from './lane-buffer-shading';

interface PendingDrag {
  blockId: string;
  newStartCell: number;
  newEndCell: number;
}

interface Props {
  lane: PlanningLaneId;
  blocks: WorkOrderPlanningBlock[];
  /** Local-zone date strings rendered as columns. */
  dates: LocalDateString[];
  columnsPerDay: number;
  dayStartHour: number;
  cellMinutes: number;
  totalColumns: number;
  laneLabelWidth: number;
  rowHeight: number;
  windowStartIso: string;
  windowEndIso: string;
  /** Drag state for a block currently being moved on this lane. */
  pendingDrag?: PendingDrag | null;
  /** Pointer-down on a block — forwarded to the drag controller. */
  onBlockPointerDown?: (e: React.PointerEvent<HTMLDivElement>, block: WorkOrderPlanningBlock) => void;
  /** Pointer-down on a block's right-edge resize handle — forwarded to the
   *  drag controller with a `'resize'` source so only the duration changes. */
  onBlockResizePointerDown?: (e: React.PointerEvent<HTMLDivElement>, block: WorkOrderPlanningBlock) => void;
  /** Keyboard arrow nudges — forwarded to the page's debounced nudge hook. */
  onBlockKeyboardMove?: (block: WorkOrderPlanningBlock, deltaMinutes: number) => void;
  onBlockKeyboardResize?: (block: WorkOrderPlanningBlock, deltaMinutes: number) => void;
  onBlockKeyboardFlush?: () => void;
  /** Lane row pointer events (for drag-move tracking + rail-to-lane drops). */
  onLaneRowPointerMove?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onLaneRowPointerUp?: (e: React.PointerEvent<HTMLDivElement>) => void;
  /** Whether this lane is pinned to the top (`unassigned`). */
  isPinned?: boolean;
  /** Whether this lane should highlight as a drop target during drag. */
  isDropTarget?: boolean;
}

function LaneIcon({ kind }: { kind: PlanningLaneId['kind'] }) {
  switch (kind) {
    case 'user':
      return <User className="size-3.5 text-muted-foreground" aria-hidden />;
    case 'team':
      return <Users className="size-3.5 text-muted-foreground" aria-hidden />;
    case 'vendor':
      return <Building2 className="size-3.5 text-muted-foreground" aria-hidden />;
    case 'unassigned':
    default:
      return <CircleSlash className="size-3.5 text-muted-foreground" aria-hidden />;
  }
}

/**
 * One resource lane on the planning grid. Renders the lane header on the
 * left and an absolutely-positioned block layer on the right. Past-slot
 * striping (`LaneBufferShading`) sits behind the blocks; cell hairlines
 * are painted via CSS gradients for a flat DOM cost.
 *
 * Chunk 4 added drag wiring — `pendingDrag` reflects the live preview
 * position of whichever block is being dragged onto this lane.
 */
export const PlanningLaneRow = memo(function PlanningLaneRow({
  lane,
  blocks,
  dates,
  columnsPerDay,
  dayStartHour,
  cellMinutes,
  totalColumns,
  laneLabelWidth,
  rowHeight,
  windowStartIso,
  windowEndIso,
  pendingDrag,
  onBlockPointerDown,
  onBlockResizePointerDown,
  onBlockKeyboardMove,
  onBlockKeyboardResize,
  onBlockKeyboardFlush,
  onLaneRowPointerMove,
  onLaneRowPointerUp,
  isPinned,
  isDropTarget,
}: Props) {
  return (
    <div
      data-lane-key={`${lane.kind}:${lane.id ?? '∅'}`}
      data-lane-kind={lane.kind}
      data-lane-id={lane.id ?? ''}
      data-pinned={isPinned ? 'true' : undefined}
      className={cn(
        'grid border-b transition-colors duration-100',
        isDropTarget && 'bg-primary/[0.03]',
        isPinned && 'bg-muted/30',
      )}
      style={{
        gridTemplateColumns: `${laneLabelWidth}px 1fr`,
        height: `${rowHeight}px`,
        transitionTimingFunction: 'var(--ease-snap)',
      }}
    >
      {/* Lane header — sticky to the left so it survives horizontal scroll. */}
      <div
        className={cn(
          'sticky left-0 z-10 flex min-w-0 items-center gap-2 border-r bg-background px-3',
          isPinned && 'bg-muted/30',
        )}
        style={{ boxShadow: 'inset -8px 0 8px -8px rgba(0,0,0,0.06)' }}
      >
        <LaneIcon kind={lane.kind} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium leading-tight">{lane.label}</div>
          <div className="truncate text-[11px] uppercase tracking-wide text-muted-foreground">
            {lane.kind === 'unassigned' ? 'Unassigned' : lane.kind}
          </div>
        </div>
      </div>

      {/* Lane canvas — relative so blocks/buffer/hairlines can stack. */}
      <div
        className="relative h-full overflow-hidden"
        onPointerMove={onLaneRowPointerMove}
        onPointerUp={onLaneRowPointerUp}
      >
        <LaneBufferShading
          windowStartIso={windowStartIso}
          windowEndIso={windowEndIso}
          totalColumns={totalColumns}
        />

        {/* Cell hairlines — pure CSS background. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage: [
              `linear-gradient(to right, rgba(127,127,127,0.18) 1px, transparent 1px)`,
              `linear-gradient(to right, rgba(127,127,127,0.07) 1px, transparent 1px)`,
            ].join(', '),
            backgroundSize: [
              `${(100 / totalColumns) * 2}% 100%`,
              `${100 / totalColumns}% 100%`,
            ].join(', '),
          }}
        />

        {/* Blocks. */}
        {blocks.map((block) => {
          if (!block.planned_start_at) return null;
          const startCell = isoToCell({
            dates,
            columnsPerDay,
            dayStartHour,
            cellMinutes,
            iso: block.planned_start_at,
          });
          if (startCell == null) return null;

          // Default duration when null = 60 min, per spec.
          const duration = block.planned_duration_minutes ?? 60;
          const cellSpan = Math.max(1, Math.ceil(duration / cellMinutes));

          const isDragging = pendingDrag?.blockId === block.id;
          const renderStart = isDragging ? pendingDrag!.newStartCell : startCell;
          const renderSpan = isDragging
            ? Math.max(1, pendingDrag!.newEndCell - pendingDrag!.newStartCell + 1)
            : cellSpan;

          // End ISO from the committed start + duration. The deadline
          // overlay uses [start, end]; the drag preview floats over the
          // committed block until commit.
          const blockEndMs =
            new Date(block.planned_start_at).getTime() + duration * 60_000;
          const endIso = new Date(blockEndMs).toISOString();

          const leftPct = (renderStart / totalColumns) * 100;
          const widthPct = (renderSpan / totalColumns) * 100;

          return (
            <PlanningBlock
              key={block.id}
              block={block}
              leftPct={leftPct}
              widthPct={widthPct}
              startIso={block.planned_start_at}
              endIso={endIso}
              isDragging={isDragging}
              cellMinutes={cellMinutes}
              onPointerDown={
                onBlockPointerDown ? (e) => onBlockPointerDown(e, block) : undefined
              }
              onResizeHandlePointerDown={
                onBlockResizePointerDown ? (e) => onBlockResizePointerDown(e, block) : undefined
              }
              onKeyboardMove={onBlockKeyboardMove}
              onKeyboardResize={onBlockKeyboardResize}
              onKeyboardFlush={onBlockKeyboardFlush}
            />
          );
        })}
      </div>
    </div>
  );
});

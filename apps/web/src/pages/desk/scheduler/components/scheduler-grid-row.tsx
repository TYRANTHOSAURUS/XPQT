import { memo, useMemo } from 'react';
import { cn } from '@/lib/utils';
import type { RankedRoom, Reservation, RuleOutcome } from '@/api/room-booking';
// RuleOutcome is referenced in the prop signature for `onCellClickWhenDenied`.
import { SchedulerEventBlock } from './scheduler-event-block';
import { SchedulerBufferShading } from './scheduler-buffer-shading';
import { buildCellBackground, type CellOutcomeMap } from './scheduler-grid-cell';
import { SchedulerRuleTag, type RuleTagOutcome } from './scheduler-rule-tag';

interface Props {
  room: RankedRoom;
  reservations: Reservation[];
  /** Window-relative cell math: every reservation's start_at is mapped to a column index. */
  windowStartIso: string;
  windowEndIso: string;
  totalColumns: number;
  /** Px width of the leading "room name" column. */
  rowLabelWidth: number;
  /** Cells the operator has shift-selected on this row (multi-room mode). */
  selectedCells: Set<number>;
  /** Per-cell outcomes when "Booking for" is set. */
  cellOutcomes?: CellOutcomeMap;
  /** Drag-create preview range (rendered as a translucent block). */
  pendingCreate?: { startCell: number; endCell: number } | null;
  /** Drag-resize / move preview, keyed by reservation id. */
  pendingDrag?: { reservationId: string; newStartCell: number; newEndCell: number; collide: boolean } | null;

  // Pointer handlers
  onCellPointerDown?: (e: React.PointerEvent<HTMLDivElement>, spaceId: string) => void;
  onCellPointerMove?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onCellPointerUp?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onCellShiftClick?: (cell: number, spaceId: string) => void;
  onCellHover?: (cell: number, spaceId: string) => void;

  onEventClick?: (reservation: Reservation) => void;
  onEventResizeStart?: (e: React.PointerEvent<HTMLElement>, reservation: Reservation, edge: 'start' | 'end', startCell: number, endCell: number, rowEl: HTMLElement) => void;
  onEventMoveStart?: (e: React.PointerEvent<HTMLElement>, reservation: Reservation, startCell: number, endCell: number, rowEl: HTMLElement) => void;

  onCellClickWhenDenied?: (cell: number, outcome: RuleOutcome) => void;
}

/**
 * Convert an ISO timestamp into a cell index inside the visible window.
 * Cell width = (windowEnd - windowStart) / totalColumns.
 */
function isoToCell(iso: string, windowStartMs: number, msPerCell: number): number {
  const ts = new Date(iso).getTime();
  return Math.round((ts - windowStartMs) / msPerCell);
}

export const SchedulerGridRow = memo(function SchedulerGridRow({
  room,
  reservations,
  windowStartIso,
  windowEndIso,
  totalColumns,
  rowLabelWidth,
  selectedCells,
  cellOutcomes,
  pendingCreate,
  pendingDrag,
  onCellPointerDown,
  onCellPointerMove,
  onCellPointerUp,
  onCellShiftClick,
  onCellHover,
  onEventClick,
  onEventResizeStart,
  onEventMoveStart,
  onCellClickWhenDenied,
}: Props) {
  const windowStartMs = useMemo(() => new Date(windowStartIso).getTime(), [windowStartIso]);
  const windowEndMs = useMemo(() => new Date(windowEndIso).getTime(), [windowEndIso]);
  const msPerCell = useMemo(
    () => (windowEndMs - windowStartMs) / totalColumns,
    [windowStartMs, windowEndMs, totalColumns],
  );

  const blocks = useMemo(() => {
    return reservations
      .map((r) => {
        const meetingStart = isoToCell(r.start_at, windowStartMs, msPerCell);
        const meetingEnd = isoToCell(r.end_at, windowStartMs, msPerCell);
        const effStart = isoToCell(r.effective_start_at, windowStartMs, msPerCell);
        const effEnd = isoToCell(r.effective_end_at, windowStartMs, msPerCell);
        return { reservation: r, meetingStart, meetingEnd, effStart, effEnd };
      })
      .filter(({ effEnd, effStart }) => effEnd > 0 && effStart < totalColumns);
  }, [reservations, windowStartMs, msPerCell, totalColumns]);

  const bgStyle = cellOutcomes ? buildCellBackground(cellOutcomes, totalColumns) : undefined;

  // Pull the floor/building label off the parent_chain for the room column
  // sub-line. The chain is ordered root→leaf so the last element is the
  // closest enclosing space (typically a floor).
  const parentLabel = (() => {
    const chain = room.parent_chain ?? [];
    if (chain.length === 0) return null;
    return chain[chain.length - 1]?.name ?? null;
  })();

  return (
    <div
      className="grid border-b transition-colors duration-100 hover:bg-muted/20"
      style={{
        gridTemplateColumns: `${rowLabelWidth}px 1fr`,
        transitionTimingFunction: 'var(--ease-snap)',
      }}
    >
      {/* Room name column */}
      <div className="sticky left-0 z-10 flex min-w-0 items-center gap-2 border-r bg-background px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{room.name}</div>
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <span className="tabular-nums">
              {room.capacity ? `${room.capacity} seats` : '—'}
            </span>
            {parentLabel && (
              <>
                <span aria-hidden className="text-muted-foreground/50">·</span>
                <span className="truncate">{parentLabel}</span>
              </>
            )}
            {room.amenities.length > 0 && (
              <>
                <span aria-hidden className="text-muted-foreground/50">·</span>
                <span className="truncate">
                  {room.amenities.slice(0, 2).join(', ')}
                  {room.amenities.length > 2 && ` +${room.amenities.length - 2}`}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Slot column */}
      <div
        className="relative h-12 cursor-cell"
        style={bgStyle}
        onPointerDown={(e) => onCellPointerDown?.(e, room.space_id)}
        onPointerMove={(e) => {
          onCellPointerMove?.(e);
          if (onCellHover) {
            const rect = e.currentTarget.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const cell = Math.min(totalColumns - 1, Math.max(0, Math.floor((x / rect.width) * totalColumns)));
            onCellHover(cell, room.space_id);
          }
        }}
        onPointerUp={onCellPointerUp}
        onClick={(e) => {
          if (e.shiftKey && onCellShiftClick) {
            const rect = e.currentTarget.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const cell = Math.min(totalColumns - 1, Math.max(0, Math.floor((x / rect.width) * totalColumns)));
            onCellShiftClick(cell, room.space_id);
          } else if (cellOutcomes && onCellClickWhenDenied) {
            const rect = e.currentTarget.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const cell = Math.min(totalColumns - 1, Math.max(0, Math.floor((x / rect.width) * totalColumns)));
            const outcome = cellOutcomes[cell];
            if (outcome === 'deny') {
              // Surface the override flow (the page may decline if the user
              // doesn't have rooms.override_rules — the API also gates it).
              onCellClickWhenDenied(cell, room.rule_outcome);
            }
          }
        }}
      >
        {/* Vertical cell hairlines + heavier hour gridlines — pure CSS
            background to avoid N divs. The thinner line every cell, plus a
            darker line every two cells (= one hour at 30-min granularity),
            gives the operator a quick visual anchor for hour boundaries
            without clutter. */}
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

        {/* Selected cells (shift-click multi-room mode) */}
        {[...selectedCells].map((cell) => (
          <div
            key={`sel-${cell}`}
            aria-hidden
            className="absolute top-0 bottom-0 bg-primary/15 border-x border-primary/40"
            style={{
              left: `${(cell / totalColumns) * 100}%`,
              width: `${(1 / totalColumns) * 100}%`,
            }}
          />
        ))}

        {/* Buffer shading (sits behind blocks) */}
        {blocks.map(({ reservation, meetingStart, meetingEnd, effStart, effEnd }) => (
          <BufferLayer
            key={`buf-${reservation.id}`}
            effStart={effStart}
            meetingStart={meetingStart}
            meetingEnd={meetingEnd}
            effEnd={effEnd}
            totalColumns={totalColumns}
          />
        ))}

        {/* Event blocks */}
        {blocks.map(({ reservation, meetingStart, meetingEnd }) => {
          const isDragging = pendingDrag?.reservationId === reservation.id;
          const startCell = isDragging ? pendingDrag!.newStartCell : meetingStart;
          const endCell = isDragging ? pendingDrag!.newEndCell : meetingEnd;
          const dragState = isDragging
            ? pendingDrag!.collide
              ? 'collide'
              : 'clean'
            : 'idle';
          return (
            <SchedulerEventBlock
              key={reservation.id}
              reservation={reservation}
              startCell={startCell}
              endCell={endCell}
              totalColumns={totalColumns}
              dragState={dragState}
              isDragging={isDragging}
              onClick={(e) => {
                e.stopPropagation();
                onEventClick?.(reservation);
              }}
              onResizeStart={
                onEventResizeStart
                  ? (e) => onEventResizeStart(e, reservation, 'start', meetingStart, meetingEnd, e.currentTarget.parentElement as HTMLElement)
                  : undefined
              }
              onResizeEnd={
                onEventResizeStart
                  ? (e) => onEventResizeStart(e, reservation, 'end', meetingStart, meetingEnd, e.currentTarget.parentElement as HTMLElement)
                  : undefined
              }
              onMoveStart={
                onEventMoveStart
                  ? (e) => onEventMoveStart(e, reservation, meetingStart, meetingEnd, e.currentTarget.parentElement as HTMLElement)
                  : undefined
              }
            />
          );
        })}

        {/* Drag-create preview */}
        {pendingCreate && pendingCreate.endCell >= pendingCreate.startCell && (
          <div
            aria-hidden
            className={cn(
              'absolute top-1 bottom-1 rounded-md border-2 border-dashed pointer-events-none',
              'bg-primary/10 border-primary/60',
            )}
            style={{
              left: `${(pendingCreate.startCell / totalColumns) * 100}%`,
              width: `${((pendingCreate.endCell - pendingCreate.startCell + 1) / totalColumns) * 100}%`,
            }}
          />
        )}

        {/* Rule tag — show only when an outcome is set on a hovered cell.
            We render a single leading tag at the row's first non-allow cell
            so the row stays readable; per-cell tooltips live on the
            hover-tooltip layer in a follow-up. */}
        {cellOutcomes && (() => {
          const first = Object.entries(cellOutcomes).find(
            ([, v]) => v && v !== 'allow',
          );
          if (!first) return null;
          const [cell, outcome] = first;
          const cellNum = Number(cell);
          const left = (cellNum / totalColumns) * 100;
          return (
            <div
              className="absolute top-1 z-10"
              style={{ left: `calc(${left}% + 4px)` }}
            >
              <SchedulerRuleTag
                outcome={outcome as RuleTagOutcome}
                message={room.rule_outcome.denial_message ?? null}
              />
            </div>
          );
        })()}
      </div>
    </div>
  );
});

/**
 * Buffer shading rendered behind a single block's effective range. Two
 * shaded segments — leading (effStart..meetingStart) and trailing
 * (meetingEnd..effEnd). The visible meeting itself is left untinted so
 * its block reads cleanly.
 */
function BufferLayer({
  effStart, meetingStart, meetingEnd, effEnd, totalColumns,
}: {
  effStart: number; meetingStart: number; meetingEnd: number; effEnd: number; totalColumns: number;
}) {
  return (
    <>
      {effStart < meetingStart && (
        <SchedulerBufferShading
          startCell={effStart}
          endCell={meetingStart}
          totalColumns={totalColumns}
        />
      )}
      {effEnd > meetingEnd && (
        <SchedulerBufferShading
          startCell={meetingEnd}
          endCell={effEnd}
          totalColumns={totalColumns}
        />
      )}
    </>
  );
}

import { useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { RankedRoom, Reservation, RuleOutcome } from '@/api/room-booking';
import { SchedulerGridRow } from './scheduler-grid-row';
import { SchedulerTimeAxis } from './scheduler-time-axis';
import { SchedulerNowLine } from './scheduler-now-line';
import type { CellOutcomeMap } from './scheduler-grid-cell';
import type { ResizeState } from '../hooks/use-drag-resize';
import type { MoveState } from '../hooks/use-drag-move';
import type { DragCreateRange } from '../hooks/use-drag-create';

interface Props {
  rooms: RankedRoom[];
  reservationsBySpaceId: Map<string, Reservation[]>;
  windowStartIso: string;
  windowEndIso: string;
  totalColumns: number;
  dates: string[];
  dayStartHour: number;
  dayEndHour: number;
  cellMinutes: number;

  rowHeight?: number;
  rowLabelWidth?: number;

  /** Per-room cell outcomes when "Booking for: <person>" is set. */
  cellOutcomesByRoom: Map<string, CellOutcomeMap>;
  /** Cells the operator has shift-selected (multi-room mode), keyed by space_id. */
  selectedCellsByRoom: Map<string, Set<number>>;

  /** Drag state during a create. */
  pendingCreate: DragCreateRange | null;
  /** Drag state during a resize. */
  pendingResize: (ResizeState & { spaceId: string; collide: boolean }) | null;
  /** Drag state during a move. */
  pendingMove: (MoveState & { spaceId: string; collide: boolean }) | null;

  // Pointer handlers — bound to the row component
  onCellPointerDown: (e: React.PointerEvent<HTMLDivElement>, spaceId: string) => void;
  onCellPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onCellPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
  onCellShiftClick: (cell: number, spaceId: string) => void;
  onCellHover: (cell: number, spaceId: string) => void;

  onEventClick: (reservation: Reservation) => void;
  onEventResizeStart: (
    e: React.PointerEvent<HTMLElement>,
    reservation: Reservation,
    edge: 'start' | 'end',
    startCell: number,
    endCell: number,
    rowEl: HTMLElement,
  ) => void;
  onEventMoveStart: (
    e: React.PointerEvent<HTMLElement>,
    reservation: Reservation,
    startCell: number,
    endCell: number,
    rowEl: HTMLElement,
  ) => void;

  onCellClickWhenDenied: (cell: number, outcome: RuleOutcome, room: RankedRoom) => void;
}

const EMPTY_CELL_SET: Set<number> = new Set();

/**
 * The virtualised scheduler grid. Rooms are virtualised vertically with
 * `@tanstack/react-virtual` so even 200 rooms fit in <1.2 s perceived
 * paint — we only mount ~12 rows at any moment regardless of total
 * count. Time-as-columns is *not* virtualised because the column count
 * is bounded (24 hours × 1–2 cells/hour × 7 days = up to 336 cells; CSS
 * percentage widths inside one row keep the cost flat).
 *
 * Why row-virtualisation alone hits the budget at 50 × 7:
 *   - DOM scales with visible-rows × eventsInWindow, not total rows.
 *   - The rest of the row paint is CSS (gradients, % positions) — no
 *     per-cell <div> nodes.
 */
export function SchedulerGrid({
  rooms,
  reservationsBySpaceId,
  windowStartIso,
  windowEndIso,
  totalColumns,
  dates,
  dayStartHour,
  dayEndHour,
  cellMinutes,
  rowHeight = 48,
  rowLabelWidth = 220,
  cellOutcomesByRoom,
  selectedCellsByRoom,
  pendingCreate,
  pendingResize,
  pendingMove,
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
  const parentRef = useRef<HTMLDivElement | null>(null);

  const rowVirtualizer = useVirtualizer({
    count: rooms.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 6,
  });

  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  const pendingCreateBySpace = useMemo(() => {
    if (!pendingCreate) return null;
    return {
      spaceId: pendingCreate.spaceId,
      startCell: pendingCreate.startCell,
      endCell: pendingCreate.endCell,
    };
  }, [pendingCreate]);

  return (
    <div
      ref={parentRef}
      className="relative flex-1 overflow-auto"
      // Performance: one scroll container; Tanstack virtual recomputes
      // visible rows on scroll. Inner content is `position:relative` so
      // the now-line + axis stack correctly.
    >
      <SchedulerTimeAxis
        dates={dates}
        dayStartHour={dayStartHour}
        dayEndHour={dayEndHour}
        cellMinutes={cellMinutes}
      />

      <div
        style={{
          height: `${totalSize}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualRows.map((vr) => {
          const room = rooms[vr.index];
          if (!room) return null;
          const reservations = reservationsBySpaceId.get(room.space_id) ?? [];
          const cellOutcomes = cellOutcomesByRoom.get(room.space_id);
          const selectedCells = selectedCellsByRoom.get(room.space_id) ?? EMPTY_CELL_SET;
          const pendingCreateForRow =
            pendingCreateBySpace && pendingCreateBySpace.spaceId === room.space_id
              ? { startCell: pendingCreateBySpace.startCell, endCell: pendingCreateBySpace.endCell }
              : null;
          const pendingDragForRow =
            pendingResize && pendingResize.spaceId === room.space_id
              ? {
                  reservationId: pendingResize.reservationId,
                  newStartCell: pendingResize.newStartCell,
                  newEndCell: pendingResize.newEndCell,
                  collide: pendingResize.collide,
                }
              : pendingMove && pendingMove.spaceId === room.space_id
                ? {
                    reservationId: pendingMove.reservationId,
                    newStartCell: pendingMove.newStartCell,
                    newEndCell: pendingMove.newEndCell,
                    collide: pendingMove.collide,
                  }
                : null;
          return (
            <div
              key={room.space_id}
              data-index={vr.index}
              ref={rowVirtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                transform: `translateY(${vr.start}px)`,
              }}
            >
              <SchedulerGridRow
                room={room}
                reservations={reservations}
                windowStartIso={windowStartIso}
                windowEndIso={windowEndIso}
                totalColumns={totalColumns}
                rowLabelWidth={rowLabelWidth}
                selectedCells={selectedCells}
                cellOutcomes={cellOutcomes}
                pendingCreate={pendingCreateForRow}
                pendingDrag={pendingDragForRow}
                onCellPointerDown={onCellPointerDown}
                onCellPointerMove={onCellPointerMove}
                onCellPointerUp={onCellPointerUp}
                onCellShiftClick={onCellShiftClick}
                onCellHover={onCellHover}
                onEventClick={onEventClick}
                onEventResizeStart={onEventResizeStart}
                onEventMoveStart={onEventMoveStart}
                onCellClickWhenDenied={(cell, outcome) => onCellClickWhenDenied(cell, outcome, room)}
              />
            </div>
          );
        })}
      </div>

      <SchedulerNowLine
        dates={dates}
        dayStartHour={dayStartHour}
        dayEndHour={dayEndHour}
        rowLabelWidth={rowLabelWidth}
      />
    </div>
  );
}

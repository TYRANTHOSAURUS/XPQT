import { useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Reservation, RuleOutcome, SchedulerRoom } from '@/api/room-booking';
import { SchedulerGridRow } from './scheduler-grid-row';
import { SchedulerTimeAxis } from './scheduler-time-axis';
import { SchedulerNowLine } from './scheduler-now-line';
import type { CellOutcomeMap } from './scheduler-grid-cell';
import type { ResizeState } from '../hooks/use-drag-resize';
import type { MoveState } from '../hooks/use-drag-move';
import type { DragCreateRange } from '../hooks/use-drag-create';

interface Props {
  rooms: SchedulerRoom[];
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

  /**
   * Hide building/floor in the room column when the operator has already
   * filtered by them in the toolbar — repeating the filter on every row is
   * noise. Passed through to each row.
   */
  hideBuilding?: boolean;
  hideFloor?: boolean;

  /** Click on a room cell — used to open the page-level inspector. */
  onRoomClick?: (room: SchedulerRoom) => void;
  /** Currently-inspected room id. Highlighted in the row column. */
  activeRoomId?: string | null;

  /** Per-room cell outcomes when "Booking for: <person>" is set. */
  cellOutcomesByRoom: Map<string, CellOutcomeMap>;
  /** Cells the operator has shift-selected (multi-room mode), keyed by space_id. */
  selectedCellsByRoom: Map<string, Set<number>>;

  /** Drag state during a create. */
  pendingCreate: DragCreateRange | null;
  /** Drag state during a resize. */
  pendingResize: (ResizeState & { spaceId: string; collide: boolean }) | null;
  /** Drag state during a move. `isGhost` indicates a cross-row preview. */
  pendingMove: (MoveState & { spaceId: string; collide: boolean; isGhost: boolean }) | null;

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

  onCellClickWhenDenied: (cell: number, outcome: RuleOutcome, room: SchedulerRoom) => void;
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
  rowHeight = 68,
  rowLabelWidth = 288,
  hideBuilding,
  hideFloor,
  onRoomClick,
  activeRoomId,
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

  // Fixed-size virtualizer. Every row paints exactly `rowHeight` px because
  // SchedulerGridRow's own outer element clamps to `h-14` — without that
  // clamp, the room-name column's two text lines + padding could nudge
  // rows past the estimate, leaving gaps as the virtualizer translated
  // each row to its measured top. Stay deterministic, drop measureElement.
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
        rowLabelWidth={rowLabelWidth}
      />

      <div
        style={{
          height: `${totalSize}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {/* The now-line has to sit *inside* this content container —
            the scroll container's box is only viewport-tall, so an
            `absolute inset-y-0` on the scroll container would clip the
            line to the visible area and slide it offscreen as soon as
            the operator scrolled past row ~12. Mounted here, it spans
            the full virtualised-rows height. */}
        <SchedulerNowLine
          dates={dates}
          dayStartHour={dayStartHour}
          dayEndHour={dayEndHour}
          rowLabelWidth={rowLabelWidth}
        />

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
                    isGhost: pendingMove.isGhost,
                  }
                : null;
          return (
            <div
              key={room.space_id}
              data-index={vr.index}
              data-space-id={room.space_id}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: `${rowHeight}px`,
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
                rowHeight={rowHeight}
                hideBuilding={hideBuilding}
                hideFloor={hideFloor}
                onRoomClick={onRoomClick}
                isActive={activeRoomId === room.space_id}
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
                onCellClickWhenDenied={onCellClickWhenDenied}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

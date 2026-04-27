import { memo, useMemo } from 'react';
import {
  AlertTriangle,
  Ban,
  Hourglass,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Reservation, RuleOutcome, SchedulerRoom } from '@/api/room-booking';
// RuleOutcome is referenced in the prop signature for `onCellClickWhenDenied`.
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { RoomThumbnail } from '@/components/room-thumbnail';
import { amenityMeta, humanizeAmenity } from '@/components/room-amenities';
import { SchedulerEventBlock } from './scheduler-event-block';
import { SchedulerBufferShading } from './scheduler-buffer-shading';
import { buildCellBackground, type CellOutcomeMap } from './scheduler-grid-cell';
import { SchedulerRuleTag, type RuleTagOutcome } from './scheduler-rule-tag';

/**
 * Map the room's effective rule outcome to a small status badge rendered
 * before the room name. Each non-allow state pairs a unique icon shape
 * (Ban / Hourglass / AlertTriangle) with a unique colour — operators
 * with red-green colour blindness can still distinguish "deny" from
 * "require approval" because the *shapes* differ. `allow` and
 * `allow_override` render no badge — the absence of a marker is the
 * affirmative signal.
 */
interface StatusBadge {
  Icon: LucideIcon;
  label: string;
  className: string;
}

function statusBadge(effect: RuleOutcome['effect']): StatusBadge | null {
  switch (effect) {
    case 'deny':
      return {
        Icon: Ban,
        label: 'Booking denied for this person',
        className: 'text-destructive',
      };
    case 'require_approval':
      return {
        Icon: Hourglass,
        label: 'Requires approval for this person',
        className: 'text-amber-600 dark:text-amber-400',
      };
    case 'warn':
      return {
        Icon: AlertTriangle,
        label: 'Booking allowed with a warning',
        className: 'text-yellow-600 dark:text-yellow-400',
      };
    default:
      return null;
  }
}

interface Props {
  room: SchedulerRoom;
  reservations: Reservation[];
  /** Window-relative cell math: every reservation's start_at is mapped to a column index. */
  windowStartIso: string;
  windowEndIso: string;
  totalColumns: number;
  /** Px width of the leading "room name" column. */
  rowLabelWidth: number;
  /**
   * Fixed row height (px) the virtualizer paints rows at. The outer grid
   * container clamps to this value; the slot column stretches to fill the
   * remaining content area (parent height minus the 1px bottom border)
   * via `h-full`, so multi-line label content can't push the row past the
   * virtualizer's estimate and create gaps between rows.
   */
  rowHeight?: number;
  /**
   * The toolbar already shows a building filter chip — when set, the row's
   * own location line redundantly repeats it. Hide on a per-axis basis so
   * the column reads as the *new* info: capacity + amenities.
   */
  hideBuilding?: boolean;
  hideFloor?: boolean;
  /** Click on the room cell — opens the page-level inspector panel. */
  onRoomClick?: (room: SchedulerRoom) => void;
  /** True when this row is the inspector's current selection. Highlights
   *  the room column so operators can see what the panel is showing. */
  isActive?: boolean;
  /** Cells the operator has shift-selected on this row (multi-room mode). */
  selectedCells: Set<number>;
  /** Per-cell outcomes when "Booking for" is set. */
  cellOutcomes?: CellOutcomeMap;
  /** Drag-create preview range (rendered as a translucent block). */
  pendingCreate?: { startCell: number; endCell: number } | null;
  /**
   * Drag-resize / move preview, keyed by reservation id.
   *
   * `isGhost` is set when this row is the *target* of a cross-row drag-move
   * (the operator picked up an event from a different lane and is hovering
   * over this one). The reservation isn't part of this row's `reservations`
   * list, so we render a translucent placeholder instead of trying to
   * substitute its position.
   */
  pendingDrag?: {
    reservationId: string;
    newStartCell: number;
    newEndCell: number;
    collide: boolean;
    isGhost?: boolean;
  } | null;

  // Pointer handlers
  onCellPointerDown?: (e: React.PointerEvent<HTMLDivElement>, spaceId: string) => void;
  onCellPointerMove?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onCellPointerUp?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onCellShiftClick?: (cell: number, spaceId: string) => void;
  onCellHover?: (cell: number, spaceId: string) => void;

  onEventClick?: (reservation: Reservation) => void;
  onEventResizeStart?: (e: React.PointerEvent<HTMLElement>, reservation: Reservation, edge: 'start' | 'end', startCell: number, endCell: number, rowEl: HTMLElement) => void;
  onEventMoveStart?: (e: React.PointerEvent<HTMLElement>, reservation: Reservation, startCell: number, endCell: number, rowEl: HTMLElement) => void;

  onCellClickWhenDenied?: (cell: number, outcome: RuleOutcome, room: SchedulerRoom) => void;
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
  rowHeight = 68,
  hideBuilding,
  hideFloor,
  onRoomClick,
  isActive,
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

  // Resolve building / floor by chain type rather than position — avoids
  // brittle "last element is floor" assumptions when the hierarchy is
  // deeper (site → building → floor → wing → room) or shallower.
  const chain = room.parent_chain ?? [];
  const buildingNode = chain.find((c) => c.type === 'building');
  const floorNode = chain.find((c) => c.type === 'floor');
  const locationParts: string[] = [];
  if (!hideBuilding && buildingNode) locationParts.push(buildingNode.name);
  if (!hideFloor && floorNode) locationParts.push(floorNode.name);
  const locationLabel = locationParts.length > 0 ? locationParts.join(' · ') : null;

  // Cap visible amenity icons; surplus reads as "+N".
  const visibleAmenities = room.amenities.slice(0, 4);
  const hiddenAmenities = room.amenities.slice(visibleAmenities.length);
  const overflowAmenities = hiddenAmenities.length;

  const status = statusBadge(room.rule_outcome.effect);

  return (
    <div
      className="grid border-b transition-colors duration-100 hover:bg-muted/20"
      style={{
        gridTemplateColumns: `${rowLabelWidth}px 1fr`,
        height: `${rowHeight}px`,
        transitionTimingFunction: 'var(--ease-snap)',
      }}
    >
      {/* Room column. The right-edge inset shadow visibly floats the
          pinned column over the slot canvas during horizontal scroll —
          a plain border-r blurs into vertical hour gridlines.
          Layout: 48px thumbnail · text stack (name / capacity+icons /
          location). Clicking anywhere on the column opens the detail
          modal — that's why the wrapper is a button. The slot-column
          interactions stay isolated to that column's pointer handlers. */}
      <button
        type="button"
        onClick={() => onRoomClick?.(room)}
        className={cn(
          'group/room sticky left-0 z-10 flex min-w-0 items-center gap-3 overflow-hidden border-r px-3 py-1.5 text-left transition-colors hover:bg-muted/30 focus-visible:relative focus-visible:z-20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-[-2px]',
          isActive ? 'bg-primary/5' : 'bg-background',
        )}
        style={{
          boxShadow: 'inset -8px 0 8px -8px rgba(0,0,0,0.06)',
        }}
        aria-label={`Open details for ${room.name}`}
        aria-current={isActive ? 'true' : undefined}
      >
        {/* Active row indicator — a 2px primary bar on the left edge,
            visible even when the column scrolls. */}
        {isActive && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-0 w-[2px] bg-primary"
          />
        )}
        {/* Thumbnail (or RoomTypeIcon fallback). Lazy-loaded; the
            scheduler virtualises rows so only ~12 are mounted at a time,
            bounding concurrent image fetches regardless of total rooms.
            The image is decorative — the name sits right next to it, so
            screen readers should not double-announce. */}
        <RoomThumbnail
          variant="square"
          size={44}
          imageUrl={room.image_url}
          capacity={room.capacity}
          keywords={room.keywords}
        />

        <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
          <div className="flex min-w-0 items-center gap-1">
            {status && (
              <Tooltip>
                <TooltipTrigger
                  render={<span />}
                  aria-label={status.label}
                  className={cn('flex shrink-0 items-center', status.className)}
                >
                  <status.Icon className="size-3" aria-hidden />
                </TooltipTrigger>
                <TooltipContent>{status.label}</TooltipContent>
              </Tooltip>
            )}
            <div className="truncate text-sm font-medium leading-tight group-hover/room:underline">
              {room.name}
            </div>
          </div>
          <div className="flex items-center gap-2 leading-tight">
            {room.capacity != null && (
              <Tooltip>
                <TooltipTrigger
                  render={<span />}
                  className="flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-[13px] font-semibold leading-none tabular-nums text-foreground"
                  aria-label={`Seats ${room.capacity}`}
                >
                  <Users aria-hidden className="size-3.5 text-foreground/70" />
                  {room.capacity}
                </TooltipTrigger>
                <TooltipContent>Seats {room.capacity}</TooltipContent>
              </Tooltip>
            )}
            {visibleAmenities.length > 0 && (
              <div className="flex min-w-0 items-center gap-2">
                {visibleAmenities.map((slug) => {
                  const { Icon, label } = amenityMeta(slug);
                  return (
                    <Tooltip key={slug}>
                      <TooltipTrigger
                        render={<span />}
                        aria-label={label}
                        className="flex shrink-0 items-center text-muted-foreground group-hover/room:text-foreground/80"
                      >
                        {Icon ? (
                          <Icon className="size-4" />
                        ) : (
                          <span className="rounded bg-muted px-1 text-[10px] uppercase tracking-wide">
                            {label.slice(0, 3)}
                          </span>
                        )}
                      </TooltipTrigger>
                      <TooltipContent>{label}</TooltipContent>
                    </Tooltip>
                  );
                })}
                {overflowAmenities > 0 && (
                  <Tooltip>
                    <TooltipTrigger
                      render={<span />}
                      className="text-[11px] tabular-nums text-muted-foreground group-hover/room:text-foreground/80"
                      aria-label={`${overflowAmenities} more`}
                    >
                      +{overflowAmenities}
                    </TooltipTrigger>
                    <TooltipContent>
                      {hiddenAmenities.map(humanizeAmenity).join(' · ')}
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            )}
          </div>
          {locationLabel && (
            <div className="truncate text-[11px] leading-tight text-muted-foreground/80">
              {locationLabel}
            </div>
          )}
        </div>
      </button>

      {/* Slot column. Height is *not* set explicitly — the grid track
          (`height: rowHeight` on the parent, minus the 1px border-b under
          box-sizing: border-box) is what aligns rows. Setting an explicit
          `height: rowHeight` here previously overflowed the parent's
          content area by 1px and visually erased the row's bottom border. */}
      <div
        className="relative h-full cursor-cell overflow-hidden"
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
              onCellClickWhenDenied(cell, room.rule_outcome, room);
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

        {/* Cross-row drag-move ghost — painted in the destination row so
            the operator gets feedback that they're hovering over a valid
            target lane. The original row keeps painting the source block
            in its origin position; once the drop persists, realtime /
            invalidation will reflow both rows. */}
        {pendingDrag?.isGhost && pendingDrag.newEndCell >= pendingDrag.newStartCell && (
          <div
            aria-hidden
            className={cn(
              'absolute top-1 bottom-1 rounded-md border-2 border-dashed pointer-events-none',
              pendingDrag.collide
                ? 'bg-destructive/10 border-destructive/60'
                : 'bg-primary/15 border-primary/70',
            )}
            style={{
              left: `${(pendingDrag.newStartCell / totalColumns) * 100}%`,
              width: `${((pendingDrag.newEndCell - pendingDrag.newStartCell + 1) / totalColumns) * 100}%`,
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

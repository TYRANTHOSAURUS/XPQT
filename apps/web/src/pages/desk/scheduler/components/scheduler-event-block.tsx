import { memo } from 'react';
import { cn } from '@/lib/utils';
import type { Reservation } from '@/api/room-booking';

interface Props {
  reservation: Reservation;
  /** Cell index where the *meeting* (not the buffer) starts. */
  startCell: number;
  /** Cell index where the meeting ends (exclusive). */
  endCell: number;
  totalColumns: number;
  /** Drag state hint — green border = clean, red border = collides. */
  dragState?: 'idle' | 'clean' | 'collide';
  /** Visual hint when this is the block currently being dragged. */
  isDragging?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  /** Pointer-down on the leading edge — starts a resize-start drag. */
  onResizeStart?: (e: React.PointerEvent<HTMLElement>) => void;
  /** Pointer-down on the trailing edge — starts a resize-end drag. */
  onResizeEnd?: (e: React.PointerEvent<HTMLElement>) => void;
  /** Pointer-down on the body — starts a move drag. */
  onMoveStart?: (e: React.PointerEvent<HTMLElement>) => void;
}

const STATUS_STYLES: Record<Reservation['status'], string> = {
  confirmed:
    'bg-primary/15 border-primary/40 text-foreground hover:bg-primary/20',
  checked_in:
    'bg-emerald-500/15 border-emerald-500/40 text-foreground hover:bg-emerald-500/20',
  pending_approval:
    'bg-amber-500/15 border-amber-500/40 text-foreground hover:bg-amber-500/20',
  draft: 'bg-muted border-border text-muted-foreground',
  released: 'bg-muted/40 border-border text-muted-foreground',
  cancelled: 'bg-muted/30 border-border text-muted-foreground line-through',
  completed: 'bg-muted/40 border-border text-muted-foreground',
};

/**
 * One reservation block painted on the row. Absolutely positioned by
 * `(startCell, endCell, totalColumns)` so the row doesn't reflow when
 * blocks shift; CSS percentages keep the math simple and the GPU happy.
 *
 * Memoised — re-renders only when its own props change. The grid renders
 * O(eventsInWindow) of these; combined with the row-level virtualisation
 * this is the cheapest part of paint.
 */
export const SchedulerEventBlock = memo(function SchedulerEventBlock({
  reservation,
  startCell,
  endCell,
  totalColumns,
  dragState = 'idle',
  isDragging,
  onClick,
  onResizeStart,
  onResizeEnd,
  onMoveStart,
}: Props) {
  if (endCell <= startCell) return null;
  const left = (startCell / totalColumns) * 100;
  const width = ((endCell - startCell) / totalColumns) * 100;

  const dragRing =
    dragState === 'collide'
      ? 'ring-2 ring-destructive/70'
      : dragState === 'clean'
        ? 'ring-2 ring-emerald-500/70'
        : 'ring-0';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick?.(e as unknown as React.MouseEvent);
        }
      }}
      onPointerDown={(e) => {
        // Body-level pointer-down → move drag. Edge handles override below.
        if ((e.target as HTMLElement).dataset?.resize) return;
        onMoveStart?.(e);
      }}
      className={cn(
        'absolute top-1 bottom-1 rounded-md border text-[11px] leading-tight px-1.5 py-1 cursor-pointer overflow-hidden select-none',
        'transition-[box-shadow,background-color,opacity] duration-100',
        STATUS_STYLES[reservation.status],
        dragRing,
        isDragging && 'opacity-80 shadow-lg',
      )}
      style={{
        left: `${left}%`,
        width: `${width}%`,
        transitionTimingFunction: 'var(--ease-snap)',
      }}
    >
      {/* Leading edge resize handle */}
      {onResizeStart && (
        <span
          data-resize="start"
          onPointerDown={onResizeStart}
          className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize"
        />
      )}
      {/* Trailing edge resize handle */}
      {onResizeEnd && (
        <span
          data-resize="end"
          onPointerDown={onResizeEnd}
          className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize"
        />
      )}

      <div className="flex items-center gap-1 truncate font-medium">
        {reservation.status === 'pending_approval' && (
          <span className="size-1.5 rounded-full bg-amber-500 shrink-0" />
        )}
        {reservation.status === 'checked_in' && (
          <span className="size-1.5 rounded-full bg-emerald-500 shrink-0" />
        )}
        <span className="truncate">
          {reservation.attendee_count ?? 1} attendees
        </span>
      </div>
    </div>
  );
});

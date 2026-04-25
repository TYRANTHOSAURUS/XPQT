import { memo, useMemo } from 'react';
import { Clock, ShieldCheck, Hourglass, CheckCircle2, Users } from 'lucide-react';
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
    'bg-primary/10 border-primary/40 hover:bg-primary/15 [&_.event-text]:text-foreground',
  checked_in:
    'bg-emerald-500/15 border-emerald-500/45 hover:bg-emerald-500/20 [&_.event-text]:text-foreground',
  pending_approval:
    'bg-amber-500/12 border-amber-500/45 hover:bg-amber-500/18 [&_.event-text]:text-foreground',
  draft: 'bg-muted border-border [&_.event-text]:text-muted-foreground',
  released: 'bg-muted/40 border-border [&_.event-text]:text-muted-foreground',
  cancelled: 'bg-muted/30 border-border [&_.event-text]:text-muted-foreground line-through',
  completed: 'bg-muted/40 border-border [&_.event-text]:text-muted-foreground',
};

const STATUS_ICON: Record<Reservation['status'], React.ReactNode> = {
  confirmed: <ShieldCheck className="size-3 shrink-0 text-primary" />,
  checked_in: <CheckCircle2 className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400" />,
  pending_approval: <Hourglass className="size-3 shrink-0 text-amber-600 dark:text-amber-400" />,
  draft: <Clock className="size-3 shrink-0 text-muted-foreground" />,
  released: <Clock className="size-3 shrink-0 text-muted-foreground" />,
  cancelled: <Clock className="size-3 shrink-0 text-muted-foreground" />,
  completed: <Clock className="size-3 shrink-0 text-muted-foreground" />,
};

const TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

function formatTimeRange(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  return `${TIME_FORMATTER.format(start)} – ${TIME_FORMATTER.format(end)}`;
}

/**
 * One reservation block painted on the row. Absolutely positioned by
 * `(startCell, endCell, totalColumns)` so the row doesn't reflow when
 * blocks shift; CSS percentages keep the math simple and the GPU happy.
 *
 * Visual hierarchy: status icon + time range on the leading edge, attendee
 * count on the trailing edge if there's room. Time is the most useful
 * thing to read at a glance — it's what the operator scans for.
 *
 * Memoised — re-renders only when its own props change.
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
  const timeLabel = useMemo(
    () => formatTimeRange(reservation.start_at, reservation.end_at),
    [reservation.start_at, reservation.end_at],
  );

  if (endCell <= startCell) return null;
  const left = (startCell / totalColumns) * 100;
  const width = ((endCell - startCell) / totalColumns) * 100;
  const cells = endCell - startCell;
  const showAttendees = cells >= 2 && (reservation.attendee_count ?? 0) > 0;
  // Below ~3 cells the time range eats the entire block — drop to a single
  // start-time label so the block stays readable.
  const showCompactTime = cells <= 2;

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
      title={`${timeLabel} · ${reservation.attendee_count ?? 1} attendees`}
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
        'absolute top-1 bottom-1 select-none overflow-hidden rounded-md border px-1.5 py-1 text-[11px] leading-tight cursor-pointer',
        'transition-[box-shadow,background-color,opacity] duration-100',
        STATUS_STYLES[reservation.status],
        dragRing,
        isDragging && 'opacity-90 shadow-md ring-1 ring-foreground/10',
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

      <div className="event-text flex h-full min-w-0 items-center gap-1.5">
        {STATUS_ICON[reservation.status]}
        <span className="truncate font-medium tabular-nums">
          {showCompactTime
            ? TIME_FORMATTER.format(new Date(reservation.start_at))
            : timeLabel}
        </span>
        {showAttendees && (
          <span className="ml-auto inline-flex shrink-0 items-center gap-0.5 tabular-nums text-muted-foreground">
            <Users className="size-3" />
            {reservation.attendee_count}
          </span>
        )}
      </div>
    </div>
  );
});

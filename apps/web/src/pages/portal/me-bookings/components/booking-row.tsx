import { ArrowRight, Clock, MapPin, RefreshCw, Users as UsersIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatRef } from '@/lib/format-ref';
import type { Reservation } from '@/api/room-booking';
import { BookingStatusPill } from '@/components/booking-detail/booking-status-pill';

interface Props {
  reservation: Reservation;
  /** Optional joined display data — picked up from the API list response when present. */
  spaceName?: string | null;
  /** True when this booking is part of a recurrence series. */
  partOfSeries?: boolean;
  /** Render the row as a Link to the drawer route. */
  href: string;
  /** Show a primary action affordance based on status. */
  onCheckIn?: () => void;
  onRestore?: () => void;
  isActing?: boolean;
}

const TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

/**
 * Booking list row — Linear-style: time slab on the left, room + meta in the
 * middle, status pill + inline action on the right. Hover reveals the chevron
 * affordance so it reads as a navigable target without competing with the
 * status pill or the inline check-in CTA.
 */
export function BookingRow({
  reservation,
  spaceName,
  partOfSeries,
  href,
  onCheckIn,
  onRestore,
  isActing,
}: Props) {
  const start = new Date(reservation.start_at);
  const end = new Date(reservation.end_at);
  const startLabel = TIME_FORMATTER.format(start);
  const endLabel = TIME_FORMATTER.format(end);
  const durationLabel = formatDuration(start, end);

  const showCheckIn =
    reservation.status === 'confirmed' &&
    reservation.check_in_required &&
    onCheckIn !== undefined &&
    isWithinCheckInWindow(reservation);

  const showRestore =
    reservation.status === 'cancelled' &&
    reservation.cancellation_grace_until !== null &&
    new Date(reservation.cancellation_grace_until!).getTime() > Date.now() &&
    onRestore !== undefined;

  const isPast = end.getTime() < Date.now();
  const isMuted =
    reservation.status === 'cancelled' ||
    reservation.status === 'released' ||
    isPast;

  return (
    <Link
      to={href}
      className={cn(
        'group/row flex items-stretch gap-3 px-3 py-2.5 transition-colors',
        'hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none',
        isMuted && 'opacity-70',
      )}
      style={{ transitionDuration: '120ms', transitionTimingFunction: 'var(--ease-snap)' }}
    >
      {/* Time slab */}
      <div className="flex w-20 shrink-0 flex-col text-right tabular-nums">
        <span className="text-[15px] font-semibold leading-tight">{startLabel}</span>
        <span className="text-[11px] text-muted-foreground leading-tight">{endLabel}</span>
      </div>

      {/* Vertical divider */}
      <span aria-hidden className="self-stretch w-px bg-border/60" />

      {/* Title + meta */}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'truncate text-[14px] font-medium',
              isMuted && 'line-through decoration-muted-foreground/60',
            )}
          >
            {spaceName ?? 'Room'}
          </span>
          {partOfSeries && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              <RefreshCw className="size-2.5" />
              series
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
          <span className="font-mono tabular-nums">
            {formatRef('reservation', reservation.module_number)}
          </span>
          <span className="inline-flex items-center gap-1 tabular-nums">
            <Clock className="size-3" />
            {durationLabel}
          </span>
          {typeof reservation.attendee_count === 'number' && reservation.attendee_count > 0 && (
            <span className="inline-flex items-center gap-1 tabular-nums">
              <UsersIcon className="size-3" />
              {reservation.attendee_count}
            </span>
          )}
          {reservation.check_in_required && reservation.status === 'confirmed' && !reservation.checked_in_at && (
            <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
              <MapPin className="size-3" />
              check-in required
            </span>
          )}
        </div>
      </div>

      {/* Trailing: status + action + chevron */}
      <div className="flex shrink-0 items-center gap-2">
        <BookingStatusPill reservation={reservation} />
        {showCheckIn && (
          <Button
            size="sm"
            variant="default"
            disabled={isActing}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onCheckIn?.();
            }}
          >
            Check in
          </Button>
        )}
        {showRestore && (
          <Button
            size="sm"
            variant="outline"
            disabled={isActing}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onRestore?.();
            }}
          >
            Restore
          </Button>
        )}
        <ArrowRight className="size-3.5 text-muted-foreground/60 opacity-0 transition-opacity group-hover/row:opacity-100" />
      </div>
    </Link>
  );
}

function formatDuration(start: Date, end: Date): string {
  const ms = end.getTime() - start.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (rem === 0) return `${hours} h`;
  return `${hours} h ${rem} min`;
}

function isWithinCheckInWindow(r: { start_at: string; check_in_grace_minutes: number }): boolean {
  const start = new Date(r.start_at).getTime();
  if (!Number.isFinite(start)) return false;
  const now = Date.now();
  // Spec §4.2: "near start" — show check-in 15 min before through grace window.
  const earliestShow = start - 15 * 60_000;
  const latestShow = start + r.check_in_grace_minutes * 60_000;
  return now >= earliestShow && now <= latestShow;
}

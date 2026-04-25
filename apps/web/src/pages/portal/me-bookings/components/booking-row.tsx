import { CalendarDays } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatFullTimestamp } from '@/lib/format';
import type { Reservation } from '@/api/room-booking';
import { BookingStatusPill } from './booking-status-pill';

interface Props {
  reservation: Reservation;
  /** Optional joined display data — picked up from the API list response when present. */
  spaceName?: string | null;
  /** True when this booking is part of a recurrence series. */
  partOfSeries?: boolean;
  /** Render the row as a Link to the drawer route, OR as a button (controlled drawer). */
  href: string;
  /** Show a primary action affordance based on status (Check in / Restore / Rebook). */
  onCheckIn?: () => void;
  onRestore?: () => void;
  isActing?: boolean;
}

/**
 * Booking list row per §4.2. Inline decision affordance on the trailing edge:
 *  - `Check in` near start time on confirmed bookings with `check_in_required`.
 *  - `Restore` on cancelled bookings still inside the grace window.
 *  - `Rebook` on released bookings (links back to the picker prefilled).
 *
 * Recurring series collapse to one grouped row per spec; the count of
 * occurrences shows in the subtitle. Today the API returns one row per
 * occurrence so we just badge it — collapsing happens in Phase G.
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

  const startLabel = formatFullTimestamp(reservation.start_at) || '—';
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

  return (
    <div
      className={cn(
        'group/row flex items-center gap-4 border-b px-4 py-3.5 last:border-b-0 transition-colors',
        'hover:bg-accent/30',
      )}
      style={{ transitionDuration: '120ms', transitionTimingFunction: 'var(--ease-snap)' }}
    >
      <Link to={href} className="flex flex-1 items-center gap-4 min-w-0">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-purple-500/15 text-purple-500">
          <CalendarDays className="size-4" />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block truncate text-sm font-medium">
            {spaceName ?? 'Room'}
            {partOfSeries && (
              <span className="ml-2 align-middle text-[10px] uppercase tracking-wide text-muted-foreground">
                series
              </span>
            )}
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground tabular-nums">
            <time dateTime={reservation.start_at} title={formatFullTimestamp(reservation.start_at)}>
              {startLabel}
            </time>
            {durationLabel && <span className="ml-1.5">· {durationLabel}</span>}
          </span>
        </span>
      </Link>

      <BookingStatusPill reservation={reservation} />

      <div className="flex shrink-0 items-center gap-1.5">
        {showCheckIn && (
          <Button size="sm" variant="default" onClick={onCheckIn} disabled={isActing}>
            Check in
          </Button>
        )}
        {showRestore && (
          <Button size="sm" variant="outline" onClick={onRestore} disabled={isActing}>
            Restore
          </Button>
        )}
        {reservation.status === 'released' && (
          <Link
            to="/portal/rooms"
            className="text-[11px] text-muted-foreground hover:text-foreground"
          >
            Rebook
          </Link>
        )}
      </div>
    </div>
  );
}

function formatDuration(start: Date, end: Date): string | null {
  const ms = end.getTime() - start.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
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

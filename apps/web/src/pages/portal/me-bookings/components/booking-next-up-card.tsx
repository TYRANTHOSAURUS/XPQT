import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight, CheckCircle2, Clock, MapPin, Users as UsersIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useCheckInBooking } from '@/api/room-booking';
import type { Reservation } from '@/api/room-booking';
import { toast } from 'sonner';

interface Props {
  reservation: Reservation;
  spaceName?: string | null;
  href: string;
}

const TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});
const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'short',
  day: 'numeric',
});

/**
 * Big "your next booking" card at the top of /portal/me/bookings.
 *
 * Shown only when there is at least one upcoming booking. Surfaces the most
 * imminent decision the user has to make — typically check-in for a meeting
 * starting soon, otherwise just "your next room" so they can confirm where
 * to go without scanning a list.
 *
 * The countdown updates locally every 15 s — cheap and avoids stale labels
 * like "starts in 1 min" lingering for 5 minutes.
 */
export function BookingNextUpCard({ reservation, spaceName, href }: Props) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(t);
  }, []);

  const start = new Date(reservation.start_at).getTime();
  const end = new Date(reservation.end_at).getTime();
  const diff = start - now;
  const inSession = now >= start && now < end;

  const checkIn = useCheckInBooking();
  const onCheckIn = async () => {
    try {
      await checkIn.mutateAsync(reservation.id);
      toast.success('Checked in');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Check-in failed');
    }
  };

  const showCheckIn =
    reservation.status === 'confirmed' &&
    reservation.check_in_required &&
    !reservation.checked_in_at &&
    diff <= 15 * 60_000 && // 15 min before through grace
    diff >= -reservation.check_in_grace_minutes * 60_000;

  const countdown = formatCountdown(diff, inSession, end - now);

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-2xl border bg-card p-5 transition-shadow',
        showCheckIn && 'border-primary/40 ring-1 ring-primary/20',
      )}
    >
      {/* Subtle decorative background */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-12 -top-12 size-44 rounded-full bg-primary/5 blur-2xl"
      />

      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
        <span className="size-1.5 rounded-full bg-primary" />
        {inSession ? 'In session now' : 'Next up'}
      </div>

      <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-2xl font-semibold tracking-tight">
          {spaceName ?? 'Room booking'}
        </h2>
        <span className="text-[13px] text-muted-foreground tabular-nums">
          {DATE_FORMATTER.format(start)} · {TIME_FORMATTER.format(start)}–{TIME_FORMATTER.format(end)}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Clock className="size-3.5" />
          {countdown}
        </span>
        {typeof reservation.attendee_count === 'number' && reservation.attendee_count > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <UsersIcon className="size-3.5" />
            {reservation.attendee_count}{' '}
            {reservation.attendee_count === 1 ? 'attendee' : 'attendees'}
          </span>
        )}
        {reservation.check_in_required && reservation.checked_in_at && (
          <span className="inline-flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="size-3.5" />
            Checked in
          </span>
        )}
        {reservation.check_in_required && !reservation.checked_in_at && !inSession && (
          <span className="inline-flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
            <MapPin className="size-3.5" />
            Check-in required at the room
          </span>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {showCheckIn && (
          <Button onClick={onCheckIn} disabled={checkIn.isPending}>
            {checkIn.isPending ? 'Checking in…' : 'Check in now'}
          </Button>
        )}
        <Link
          to={href}
          className={cn(
            'inline-flex h-9 items-center gap-1.5 rounded-md border bg-background px-3 text-sm font-medium transition-colors hover:bg-accent/40',
          )}
          style={{
            transitionDuration: '120ms',
            transitionTimingFunction: 'var(--ease-snap)',
          }}
        >
          View details
          <ArrowRight className="size-3.5 opacity-70" />
        </Link>
      </div>
    </div>
  );
}

function formatCountdown(diffMs: number, inSession: boolean, endsInMs: number): string {
  if (inSession) {
    const mins = Math.max(0, Math.round(endsInMs / 60_000));
    if (mins < 60) return `Ends in ${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m === 0 ? `Ends in ${h} h` : `Ends in ${h} h ${m} min`;
  }
  if (diffMs <= 0) return 'Starting now';
  const mins = Math.round(diffMs / 60_000);
  if (mins < 60) return `Starts in ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `Starts in ${hours} h`;
  const days = Math.round(hours / 24);
  return `Starts in ${days} ${days === 1 ? 'day' : 'days'}`;
}

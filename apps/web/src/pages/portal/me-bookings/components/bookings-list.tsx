import { useMemo } from 'react';
import { CalendarPlus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { buttonVariants } from '@/components/ui/button';
import {
  useReservationList,
  useCheckInBooking,
  useRestoreBooking,
} from '@/api/room-booking';
import type { MyReservationItem } from '@/api/room-booking';
import { useSpaces } from '@/api/spaces';
import { toast } from 'sonner';
import { BookingRow } from './booking-row';
import { BookingDayGroup } from './booking-day-group';
import { BookingNextUpCard } from './booking-next-up-card';

type TabValue = 'upcoming' | 'past' | 'cancelled';

interface Props {
  /** Maps a reservation id to its drawer href. */
  buildHref: (reservationId: string) => string;
  tab: TabValue;
  onTabChange: (tab: TabValue) => void;
}

const DAY_HEADER_FORMATTER = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});

export function BookingsList({ buildHref, tab, onTabChange }: Props) {
  const { data, isPending, isFetching } = useReservationList({ scope: tab, limit: 100 });
  // We still hydrate spaces locally for fallback room names — the API now
  // joins `space_name` server-side, but if a row predates that backfill we
  // gracefully fall back to the spaces list.
  const { data: spaces } = useSpaces();
  const items = useMemo(() => data?.items ?? [], [data]);

  const spaceNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of spaces ?? []) map.set(s.id, s.name);
    return map;
  }, [spaces]);

  const resolveSpaceName = (r: MyReservationItem): string | null => {
    if (r.space_name) return r.space_name;
    return spaceNameById.get(r.space_id) ?? null;
  };

  const checkIn = useCheckInBooking();
  const restore = useRestoreBooking();

  const handleCheckIn = async (id: string) => {
    try {
      await checkIn.mutateAsync(id);
      toast.success('Checked in');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Check-in failed');
    }
  };

  const handleRestore = async (id: string) => {
    try {
      await restore.mutateAsync(id);
      toast.success('Booking restored');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Restore failed');
    }
  };

  // Grouping. Upcoming gets calendar-style buckets (Today / Tomorrow / Wed,
  // Apr 30 / Wed, May 7). Past + cancelled keep flat reverse-chronological
  // order — date headers there read like noise.
  const groups = useMemo(() => groupByDay(items, tab), [items, tab]);

  // The hero only shows on the Upcoming tab and only when there's a sensible
  // candidate. We pick the most-imminent active booking — confirmed,
  // checked_in, or pending_approval — because "next up" should reflect what
  // the user actually has to action, not a cancelled or released slot.
  const heroBooking = useMemo(() => {
    if (tab !== 'upcoming') return null;
    return (
      items.find(
        (r) =>
          r.status === 'confirmed' ||
          r.status === 'checked_in' ||
          r.status === 'pending_approval',
      ) ?? null
    );
  }, [items, tab]);

  return (
    <>
      <Tabs value={tab} onValueChange={(v) => onTabChange(v as TabValue)} className="mb-5">
        <TabsList>
          {(['upcoming', 'past', 'cancelled'] as const).map((t) => (
            <TabsTrigger key={t} value={t} className="capitalize">
              {t}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {isPending && items.length === 0 && <ListSkeleton />}

      {!isPending && items.length === 0 && <EmptyState tab={tab} />}

      {!isPending && items.length > 0 && (
        <div
          className="flex flex-col gap-6"
          data-fetching={isFetching ? 'true' : 'false'}
        >
          {heroBooking && (
            <BookingNextUpCard
              reservation={heroBooking}
              spaceName={resolveSpaceName(heroBooking)}
              href={buildHref(heroBooking.id)}
            />
          )}

          {groups.map((group) => (
            <BookingDayGroup
              key={group.key}
              title={group.title}
              subtitle={group.subtitle}
              meta={group.items.length === 1 ? '1 booking' : `${group.items.length} bookings`}
            >
              {group.items.map((r) => (
                <BookingRow
                  key={r.id}
                  reservation={r}
                  spaceName={resolveSpaceName(r)}
                  partOfSeries={Boolean(r.recurrence_series_id)}
                  href={buildHref(r.id)}
                  onCheckIn={() => handleCheckIn(r.id)}
                  onRestore={() => handleRestore(r.id)}
                  isActing={checkIn.isPending || restore.isPending}
                />
              ))}
            </BookingDayGroup>
          ))}
        </div>
      )}
    </>
  );
}

interface DayGroup {
  key: string;
  title: string;
  subtitle?: string;
  items: MyReservationItem[];
}

/**
 * Bucket reservations into calendar-friendly day groups for the Upcoming
 * tab; flat single-bucket otherwise. The bucket key uses the local
 * yyyy-mm-dd because we want "the day the booking starts" to map to
 * the user's wall clock, not UTC midnight.
 */
function groupByDay(items: MyReservationItem[], tab: TabValue): DayGroup[] {
  if (tab !== 'upcoming') {
    return items.length === 0 ? [] : [{ key: tab, title: labelForTab(tab), items }];
  }
  const today = startOfLocalDay(new Date());
  const todayIso = isoDay(today);
  const tomorrowIso = isoDay(new Date(today.getTime() + 24 * 60 * 60 * 1000));
  const buckets = new Map<string, DayGroup>();

  for (const r of items) {
    const d = startOfLocalDay(new Date(r.start_at));
    const key = isoDay(d);
    const existing = buckets.get(key);
    if (existing) {
      existing.items.push(r);
      continue;
    }
    let title: string;
    let subtitle: string | undefined;
    if (key === todayIso) {
      title = 'Today';
      subtitle = DAY_HEADER_FORMATTER.format(d);
    } else if (key === tomorrowIso) {
      title = 'Tomorrow';
      subtitle = DAY_HEADER_FORMATTER.format(d);
    } else {
      title = DAY_HEADER_FORMATTER.format(d);
    }
    buckets.set(key, { key, title, subtitle, items: [r] });
  }
  return Array.from(buckets.values()).sort((a, b) => (a.key < b.key ? -1 : 1));
}

function labelForTab(tab: TabValue): string {
  if (tab === 'past') return 'Past bookings';
  return 'Cancelled and auto-released';
}

function startOfLocalDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function isoDay(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="h-32 animate-pulse rounded-2xl border bg-card" />
      <div className="space-y-2">
        <div className="h-4 w-24 animate-pulse rounded bg-muted/60" />
        <div className="overflow-hidden rounded-xl border bg-card divide-y divide-border/60">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3 px-3 py-2.5">
              <div className="h-9 w-20 shrink-0 rounded bg-muted/60" />
              <div className="flex-1 space-y-2">
                <div className="h-3.5 w-1/2 rounded bg-muted/60" />
                <div className="h-3 w-1/3 rounded bg-muted/40" />
              </div>
              <div className="h-5 w-16 rounded bg-muted/40" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ tab }: { tab: TabValue }) {
  return (
    <div className="flex flex-col items-center gap-4 rounded-2xl border bg-card/40 px-6 py-20 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted/60">
        <CalendarPlus className="size-5 text-muted-foreground" />
      </div>
      <div className="space-y-1.5">
        <h3 className="text-base font-semibold">
          {tab === 'upcoming'
            ? 'No bookings on the calendar'
            : tab === 'past'
              ? 'Past bookings will appear here'
              : 'No cancelled bookings'}
        </h3>
        <p className="max-w-sm text-sm text-muted-foreground text-pretty">
          {tab === 'upcoming'
            ? 'You have nothing booked yet. Find a room when you need one.'
            : tab === 'past'
              ? 'Past meetings show up here once they wrap up.'
              : 'Cancellations show here for the grace window so you can restore them.'}
        </p>
      </div>
      {tab === 'upcoming' && (
        <Link to="/portal/rooms" className={buttonVariants({ size: 'sm' })}>
          Book a room
        </Link>
      )}
    </div>
  );
}

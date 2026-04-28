import { useMemo } from 'react';
import { ArrowRight, CalendarPlus, Clock } from 'lucide-react';
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
import { toastError, toastSuccess } from '@/lib/toast';
import { formatFullTimestamp, formatRelativeTime } from '@/lib/format';
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
      toastSuccess('Checked in');
    } catch (e) {
      toastError("Couldn't check in", { error: e, retry: () => handleCheckIn(id) });
    }
  };

  const handleRestore = async (id: string) => {
    try {
      await restore.mutateAsync(id);
      toastSuccess('Booking restored');
    } catch (e) {
      toastError("Couldn't restore booking", { error: e, retry: () => handleRestore(id) });
    }
  };

  // Grouping. Upcoming gets calendar-style buckets (Today / Tomorrow / Wed,
  // Apr 30 / Wed, May 7). Past + cancelled keep flat reverse-chronological
  // order — date headers there read like noise.
  // Pending-approval items live in their own callout above and are filtered
  // out here so they don't appear twice on the Upcoming tab.
  const groupedItems = useMemo(
    () =>
      tab === 'upcoming'
        ? items.filter((r) => r.status !== 'pending_approval')
        : items,
    [items, tab],
  );
  const groups = useMemo(() => groupByDay(groupedItems, tab), [groupedItems, tab]);

  // The hero shows only on Upcoming tab + only when a *confirmed* booking
  // is the user's nearest action. Pending-approval bookings are NOT
  // candidates — they get their own callout above so they don't look like
  // "ready to attend" decisions.
  const heroBooking = useMemo(() => {
    if (tab !== 'upcoming') return null;
    return (
      items.find(
        (r) => r.status === 'confirmed' || r.status === 'checked_in',
      ) ?? null
    );
  }, [items, tab]);

  // Surface pending-approval bookings as their own section so the user
  // can SEE that their request landed and is in flight. Without this,
  // pending bookings sat at the bottom of the date-grouped list with
  // only a small purple pill — easy to miss when you're scanning for
  // "what's next." Empty when no pending exists.
  const pendingItems = useMemo(() => {
    if (tab !== 'upcoming') return [];
    return items.filter((r) => r.status === 'pending_approval');
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
          {pendingItems.length > 0 && (
            <PendingApprovalsSection
              items={pendingItems}
              resolveSpaceName={resolveSpaceName}
              buildHref={buildHref}
            />
          )}

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

/**
 * Standalone "Pending approval" section, rendered above Next-up so a
 * just-submitted approval-route booking is impossible to miss. Each
 * row is a clear "we know about your request, here's where it stands"
 * line — purple accent matches the status pill, ArrowRight on hover
 * confirms it's clickable to the detail.
 */
function PendingApprovalsSection({
  items,
  resolveSpaceName,
  buildHref,
}: {
  items: MyReservationItem[];
  resolveSpaceName: (r: MyReservationItem) => string | null;
  buildHref: (id: string) => string;
}) {
  return (
    <section
      aria-labelledby="pending-approval-header"
      className="overflow-hidden rounded-2xl border border-purple-500/30 bg-purple-500/[0.04] dark:border-purple-500/40 dark:bg-purple-500/10"
    >
      <header className="flex items-center justify-between gap-2 border-b border-purple-500/20 px-4 py-2.5 dark:border-purple-500/30">
        <div className="flex items-center gap-2">
          <Clock className="size-3.5 text-purple-700 dark:text-purple-300" />
          <h3
            id="pending-approval-header"
            className="text-[11px] font-medium uppercase tracking-wider text-purple-800 dark:text-purple-200"
          >
            Awaiting approval
          </h3>
        </div>
        <span className="text-[11px] tabular-nums text-purple-700/80 dark:text-purple-300/80">
          {items.length === 1 ? '1 request' : `${items.length} requests`}
        </span>
      </header>
      <ul className="divide-y divide-purple-500/15 dark:divide-purple-500/25">
        {items.map((r) => (
          <li key={r.id}>
            <Link
              to={buildHref(r.id)}
              className="group/pending flex items-center gap-3 px-4 py-3 [transition:background-color_120ms_var(--ease-snap)] hover:bg-purple-500/10 focus-visible:bg-purple-500/10 focus-visible:outline-none"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {resolveSpaceName(r) ?? 'Room'}
                </div>
                <div className="mt-0.5 text-[12px] text-muted-foreground tabular-nums">
                  {formatFullTimestamp(r.start_at)}
                  <span className="ml-2 text-[11px] text-purple-700 dark:text-purple-300">
                    Submitted {formatRelativeTime(r.created_at)}
                  </span>
                </div>
              </div>
              <ArrowRight className="size-3.5 shrink-0 text-purple-700/60 opacity-0 transition-opacity group-hover/pending:opacity-100 dark:text-purple-300/70" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
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

import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle, CalendarClock, CalendarDays, CheckCircle2, Inbox, Plus, Search, Users as UsersIcon, X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  ToggleGroup, ToggleGroupItem,
} from '@/components/ui/toggle-group';
import { useOperatorReservations } from '@/api/room-booking';
import type { OperatorReservationItem, ReservationStatus } from '@/api/room-booking';
import { useAuth } from '@/providers/auth-provider';
import { formatRelativeTime, formatFullTimestamp } from '@/lib/format';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { BookingDetailPanel } from '@/components/booking-detail/booking-detail-panel';
import { BookingComposerModal } from '@/components/booking-composer-v2/booking-composer-modal';
import { LateChangesWidget } from '@/components/desk/late-changes-widget';
import { cn } from '@/lib/utils';

type Scope =
  | 'pending_approval'
  | 'upcoming'
  | 'past'
  | 'cancelled'
  | 'all'
  | 'bundles';

const SCOPES: { value: Scope; label: string; description: string }[] = [
  { value: 'pending_approval', label: 'Pending', description: 'Awaiting approval' },
  { value: 'upcoming', label: 'Upcoming', description: 'Confirmed and active' },
  { value: 'past', label: 'Past', description: 'Already happened' },
  { value: 'cancelled', label: 'Cancelled', description: 'Cancelled or auto-released' },
  { value: 'bundles', label: 'Bundles', description: 'Reservations with services' },
  { value: 'all', label: 'All', description: 'Every reservation' },
];

const TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});
const DAY_FORMATTER = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});

/**
 * /desk/bookings — operator list view of every reservation in the tenant.
 * Visible to anyone with rooms.read_all or rooms.admin. The desk scheduler
 * (`/desk/scheduler`) is the calendar-grid sibling; this is the table-list
 * version operators reach for when they want to triage a queue ("what's
 * pending approval right now?", "which bookings does Thomas have today?").
 *
 * URL drives state — `?scope=` keeps deep-links shareable, `?id=` opens
 * the booking detail drawer. Search is a local-only filter on the already-
 * fetched scope (≤ 200 rows server-cap), so no debounce; if the user wants
 * truly cross-scope search later we'll lift to the backend.
 */
export function DeskBookingsPage() {
  const [params, setParams] = useSearchParams();
  const scope = (params.get('scope') as Scope | null) ?? 'pending_approval';
  const selectedId = params.get('id');
  const [search, setSearch] = useState('');

  // The 'bundles' chip is a server-side filter (`has_bundle=true`,
  // booking-services-roadmap §9.1.9). Backend uses partial index 00199 so
  // even a tenant with thousands of room-only reservations stays cheap.
  // Previously this filtered client-side on top of scope='all', which
  // forced the API to ship up to 200 reservations only to drop most of them.
  const fetchScope: Exclude<Scope, 'bundles'> = scope === 'bundles' ? 'all' : scope;
  const { data, isLoading, error, isFetching } = useOperatorReservations({
    scope: fetchScope,
    limit: 200,
    has_bundle: scope === 'bundles' ? true : undefined,
  });

  const allItems = useMemo<OperatorReservationItem[]>(() => {
    return (data?.items ?? []) as OperatorReservationItem[];
  }, [data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allItems;
    return allItems.filter((r) => {
      const requester = `${r.requester_first_name ?? ''} ${r.requester_last_name ?? ''}`.toLowerCase();
      return (
        (r.space_name ?? '').toLowerCase().includes(q) ||
        requester.includes(q)
      );
    });
  }, [allItems, search]);

  // Group by local day. The desk page is meant to land on "today" so we
  // show a Today header if any rows fall on it; otherwise we group by date.
  const groups = useMemo(() => groupByDay(filtered, scope), [filtered, scope]);

  const setScope = (next: Scope) => {
    const p = new URLSearchParams(params);
    p.set('scope', next);
    p.delete('id');
    setParams(p, { replace: true });
  };

  // Carry transferable filter context to /desk/scheduler when the user
  // hits "Open scheduler". Today the bookings page only has a search
  // term and (future) a building filter; both keys map 1:1 to scheduler
  // URL params (`?q=…&building=…`). Page-specific keys like `scope` and
  // `id` are intentionally dropped — they don't translate.
  const schedulerLinkTo = useMemo(() => {
    const sp = new URLSearchParams();
    const q = search.trim();
    if (q) sp.set('q', q);
    const building = params.get('building');
    if (building) sp.set('building', building);
    const qs = sp.toString();
    return qs ? `/desk/scheduler?${qs}` : '/desk/scheduler';
  }, [search, params]);

  const openDetail = (id: string) => {
    const p = new URLSearchParams(params);
    p.set('id', id);
    setParams(p, { replace: true });
  };

  const closeDetail = () => {
    const p = new URLSearchParams(params);
    p.delete('id');
    setParams(p, { replace: true });
  };

  const selectedSpaceName =
    allItems.find((r) => r.id === selectedId)?.space_name ?? null;

  const { person } = useAuth();
  const [composerOpen, setComposerOpen] = useState(false);

  const list = (
    <div className="absolute inset-0 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="border-b px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Bookings</h1>
            <p className="text-xs text-muted-foreground">
              Every room reservation in this workspace. Use the scheduler for the calendar grid.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link to={schedulerLinkTo}>
              <Button variant="outline" size="sm" className="gap-1.5">
                <CalendarDays className="size-3.5" />
                Open scheduler
              </Button>
            </Link>
            <Button
              size="sm"
              className="gap-1.5"
              onClick={() => setComposerOpen(true)}
              disabled={!person}
            >
              <Plus className="size-3.5" />
              New booking
            </Button>
          </div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 border-b px-6 py-3">
        <ToggleGroup
          value={[scope]}
          onValueChange={(v) => {
            const next = v[0] as Scope | undefined;
            if (next) setScope(next);
          }}
          variant="outline"
          className="h-8"
        >
          {SCOPES.map((s) => (
            <ToggleGroupItem
              key={s.value}
              value={s.value}
              aria-label={s.description}
              className="h-8 px-3 text-xs"
            >
              {s.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        <div className="relative ml-auto w-full max-w-sm">
          <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by room or requester…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 pl-8 pr-8 text-sm"
          />
          {search && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        <span className="hidden text-xs text-muted-foreground tabular-nums sm:inline">
          {isLoading ? 'Loading…' : `${filtered.length} of ${allItems.length}`}
        </span>
      </div>

      {/* List */}
      <div
        className="flex-1 overflow-auto"
        data-fetching={isFetching ? 'true' : 'false'}
      >
        <div className="px-6 pt-4">
          <LateChangesWidget />
        </div>
        {error ? (
          <div
            role="alert"
            className="flex flex-col items-center gap-3 px-6 py-16 text-center"
          >
            <span
              aria-hidden
              className="flex size-10 items-center justify-center rounded-full bg-destructive/10"
            >
              <AlertTriangle className="size-5 text-destructive" />
            </span>
            <h2 className="text-base font-semibold">Couldn't load bookings</h2>
            <p className="max-w-sm text-sm text-muted-foreground">
              {error instanceof Error ? error.message : 'Unknown error'}
            </p>
            <p className="text-xs text-muted-foreground">
              This page requires the <code className="chip">rooms.read_all</code> or{' '}
              <code className="chip">rooms.admin</code> permission.
            </p>
          </div>
        ) : isLoading ? (
          <ListSkeleton />
        ) : filtered.length === 0 ? (
          <EmptyState scope={scope} hasSearch={Boolean(search)} />
        ) : (
          <div className="flex flex-col gap-6 px-6 py-5">
            {groups.map((group) => (
              <section key={group.key}>
                <header className="mb-2 flex items-baseline justify-between gap-2 px-1">
                  <h2 className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {group.title}
                    {group.subtitle && (
                      <span className="ml-2 text-[11px] font-normal normal-case tracking-normal">
                        {group.subtitle}
                      </span>
                    )}
                  </h2>
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {group.items.length}
                  </span>
                </header>
                <div className="overflow-hidden rounded-xl border bg-card divide-y divide-border/60">
                  {group.items.map((r) => (
                    <BookingRow
                      key={r.id}
                      item={r}
                      selected={selectedId === r.id}
                      onSelect={() => openDetail(r.id)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>

    </div>
  );

  const composerModal = (
    <BookingComposerModal
      open={composerOpen}
      onOpenChange={setComposerOpen}
      mode="operator"
      entrySource="desk-list"
      callerPersonId={person?.id ?? ''}
      hostFirstName={person?.first_name ?? null}
      onBooked={() => setComposerOpen(false)}
    />
  );

  return (
    <>
      <Group orientation="horizontal" style={{ height: '100%' }}>
        {selectedId ? (
          <>
            <Panel id="list" defaultSize="55%" className="relative">
              {list}
            </Panel>
            <Separator />
            <Panel id="detail" defaultSize="45%" className="relative">
              <BookingDetailPanel
                reservationId={selectedId}
                spaceName={selectedSpaceName}
                onClose={closeDetail}
              />
            </Panel>
          </>
        ) : (
          <Panel id="list" className="relative">
            {list}
          </Panel>
        )}
      </Group>
      {composerModal}
    </>
  );
}

function BookingRow({
  item,
  selected,
  onSelect,
}: {
  item: OperatorReservationItem;
  selected: boolean;
  onSelect: () => void;
}) {
  const start = new Date(item.start_at);
  const end = new Date(item.end_at);
  const startLabel = TIME_FORMATTER.format(start);
  const endLabel = TIME_FORMATTER.format(end);
  const requesterName = formatRequester(item);
  const isPast = end.getTime() < Date.now();
  const isCancelled = item.status === 'cancelled' || item.status === 'released';

  return (
    <button
      type="button"
      onClick={onSelect}
      data-selected={selected ? 'true' : undefined}
      className={cn(
        'group/row flex w-full items-stretch gap-3 px-3 py-2.5 text-left transition-colors',
        'hover:bg-accent/30',
        selected && 'bg-primary/5',
        (isPast || isCancelled) && !selected && 'opacity-70',
      )}
      style={{ transitionDuration: '120ms', transitionTimingFunction: 'var(--ease-snap)' }}
    >
      {/* Time slab */}
      <div className="flex w-20 shrink-0 flex-col text-right tabular-nums">
        <span className="text-[14px] font-semibold leading-tight">{startLabel}</span>
        <span className="text-[11px] text-muted-foreground leading-tight">{endLabel}</span>
      </div>

      <span aria-hidden className="self-stretch w-px bg-border/60" />

      {/* Room + requester */}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'truncate text-[14px] font-medium',
              isCancelled && 'line-through decoration-muted-foreground/60',
            )}
          >
            {item.space_name ?? 'Unknown room'}
          </span>
          {item.recurrence_series_id && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              series
            </span>
          )}
          {/* Post-canonicalisation (2026-05-02): the per-row "services"
              chip used to gate on `item.booking_bundle_id`, which under
              the new projection is ALWAYS equal to `item.id` and so the
              chip would render on every row. Without a per-row
              "has-services" signal on the operator list response we
              can't tell from this layer alone — the chip is omitted
              until the backend list grows a discriminator. The
              `?scope=bundles` toggle still narrows the LIST to bookings
              with attached services (server-side via has_bundle=true). */}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
          {/* Reference chip retired post-canonicalisation (2026-05-02) —
              `bookings` table has no per-booking monotonic counter. The
              meta line still surfaces the requester / time / status. */}
          <span className="truncate">{requesterName}</span>
          {typeof item.attendee_count === 'number' && item.attendee_count > 0 && (
            <span className="inline-flex items-center gap-1 tabular-nums">
              <UsersIcon className="size-3" />
              {item.attendee_count}
            </span>
          )}
          {item.checked_in_at && (
            <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="size-3" />
              checked in
            </span>
          )}
        </div>
      </div>

      {/* Trailing meta */}
      <div className="flex shrink-0 items-center gap-3">
        <StatusPill status={item.status} />
        <time
          dateTime={item.created_at}
          title={`Created ${formatFullTimestamp(item.created_at)}`}
          className="hidden w-20 text-right text-[11px] text-muted-foreground tabular-nums sm:block"
        >
          {formatRelativeTime(item.created_at)}
        </time>
      </div>
    </button>
  );
}

function StatusPill({ status }: { status: ReservationStatus }) {
  const config: Record<
    ReservationStatus,
    { label: string; className: string }
  > = {
    draft: { label: 'Draft', className: 'bg-muted text-muted-foreground' },
    pending_approval: {
      label: 'Pending',
      className: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
    },
    confirmed: {
      label: 'Confirmed',
      className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    },
    checked_in: {
      label: 'Checked in',
      className: 'bg-emerald-600/15 text-emerald-800 dark:text-emerald-300',
    },
    released: {
      label: 'Auto-released',
      className: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
    },
    cancelled: { label: 'Cancelled', className: 'bg-muted text-muted-foreground' },
    completed: { label: 'Completed', className: 'bg-muted text-muted-foreground' },
  };
  const c = config[status];
  return (
    <Badge
      variant="outline"
      className={cn('h-5 border-transparent px-2 text-[10px] font-medium', c.className)}
    >
      {c.label}
    </Badge>
  );
}

interface DayGroup {
  key: string;
  title: string;
  subtitle?: string;
  items: OperatorReservationItem[];
}

/**
 * For pending_approval / upcoming we group by start day so the operator
 * sees an ordered Today / Tomorrow / [date] structure. For past + cancelled
 * we keep a flat list since reverse-chrono is the right read there and
 * date-grouping every single past row makes the page noisy.
 */
function groupByDay(items: OperatorReservationItem[], scope: Scope): DayGroup[] {
  if (
    scope !== 'upcoming' &&
    scope !== 'pending_approval' &&
    scope !== 'all' &&
    scope !== 'bundles'
  ) {
    return items.length === 0
      ? []
      : [{ key: scope, title: labelFor(scope), items }];
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
      subtitle = DAY_FORMATTER.format(d);
    } else if (key === tomorrowIso) {
      title = 'Tomorrow';
      subtitle = DAY_FORMATTER.format(d);
    } else {
      title = DAY_FORMATTER.format(d);
    }
    buckets.set(key, { key, title, subtitle, items: [r] });
  }
  // Upcoming + pending want soonest-first; "all" shows newest-first which
  // means most-recent-day first.
  const sorted = Array.from(buckets.values());
  sorted.sort((a, b) =>
    scope === 'all' ? (a.key < b.key ? 1 : -1) : a.key < b.key ? -1 : 1,
  );
  return sorted;
}

function labelFor(scope: Scope): string {
  if (scope === 'past') return 'Past bookings';
  if (scope === 'cancelled') return 'Cancelled and auto-released';
  return SCOPES.find((s) => s.value === scope)?.label ?? scope;
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

function formatRequester(item: OperatorReservationItem): string {
  const first = item.requester_first_name?.trim();
  const last = item.requester_last_name?.trim();
  if (first || last) return [first, last].filter(Boolean).join(' ');
  return 'Unknown requester';
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-6 px-6 py-5">
      {[0, 1].map((i) => (
        <div key={i}>
          <div className="mb-2 h-3.5 w-24 animate-pulse rounded bg-muted/60" />
          <div className="overflow-hidden rounded-xl border bg-card divide-y divide-border/60">
            {[0, 1, 2].map((j) => (
              <div key={j} className="flex items-center gap-3 px-3 py-2.5">
                <div className="h-9 w-20 shrink-0 rounded bg-muted/60" />
                <div className="flex-1 space-y-2">
                  <div className="h-3.5 w-1/3 rounded bg-muted/60" />
                  <div className="h-3 w-1/4 rounded bg-muted/40" />
                </div>
                <div className="h-5 w-20 rounded bg-muted/40" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ scope, hasSearch }: { scope: Scope; hasSearch: boolean }) {
  let title: string;
  let body: string;
  if (hasSearch) {
    title = 'No matches';
    body = 'Try different search terms or switch the scope filter.';
  } else if (scope === 'pending_approval') {
    title = 'Inbox zero';
    body = 'No bookings awaiting approval right now.';
  } else if (scope === 'upcoming') {
    title = 'Nothing on the calendar';
    body = 'No upcoming bookings in this workspace.';
  } else if (scope === 'past') {
    title = 'No past bookings';
    body = 'Past bookings will appear here once they wrap up.';
  } else if (scope === 'cancelled') {
    title = 'No cancellations';
    body = 'No cancelled or auto-released bookings yet.';
  } else if (scope === 'bundles') {
    title = 'No bundled bookings';
    body =
      'No reservations have catering, AV, or setup attached. Anyone can add services from the booking dialog or place a standalone order.';
  } else {
    title = 'No bookings yet';
    body = 'Bookings will show here once anyone reserves a room.';
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 py-20 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted/60">
        {scope === 'pending_approval' ? (
          <CalendarClock className="size-5 text-muted-foreground" />
        ) : (
          <Inbox className="size-5 text-muted-foreground" />
        )}
      </div>
      <div className="space-y-1">
        <h3 className="text-base font-semibold">{title}</h3>
        <p className="max-w-sm text-sm text-muted-foreground text-pretty">{body}</p>
      </div>
    </div>
  );
}

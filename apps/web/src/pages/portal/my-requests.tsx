import { useMemo, useState } from 'react';
import { flushSync } from 'react-dom';
import { Link } from 'react-router-dom';
import { CheckCircle2, CalendarDays, Archive, Inbox, Plus } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTicketList } from '@/api/tickets';
import { useAuth } from '@/providers/auth-provider';
import { PortalPage } from '@/components/portal/portal-page';
import { PortalRequestRow } from '@/components/portal/portal-request-row';
import { derivePortalStatus } from '@/lib/portal-status';
import { formatTicketRef } from '@/lib/format-ref';
import { startViewTransition } from '@/lib/view-transitions';
import { cn } from '@/lib/utils';

interface Ticket {
  id: string;
  ticket_kind: 'case' | 'work_order';
  module_number: number;
  title: string;
  status_category: string;
  assigned_team?: { name: string } | null;
  assigned_user?: { first_name: string; last_name: string } | null;
  sla_resolution_breached_at: string | null;
  created_at: string;
}

type TabValue = 'all' | 'open' | 'scheduled' | 'closed';

const OPEN_STATUSES = new Set(['new', 'assigned', 'in_progress', 'waiting']);
const CLOSED_STATUSES = new Set(['resolved', 'closed']);

const EMPTY_STATE: Record<TabValue, { Icon: React.ComponentType<{ className?: string }>; title: string; hint?: string }> = {
  open:      { Icon: CheckCircle2, title: 'All caught up.', hint: 'Nothing waiting on you right now.' },
  all:       { Icon: Inbox,        title: 'No requests yet.', hint: 'Submit one from the home page to get started.' },
  scheduled: { Icon: CalendarDays, title: 'No upcoming bookings.' },
  closed:    { Icon: Archive,      title: 'No closed requests yet.' },
};

export function MyRequestsPage() {
  const { person } = useAuth();
  const [tab, setTabRaw] = useState<TabValue>('open');

  /**
   * Same-document tab change — wrap in startViewTransition so the
   * `portal-requests-list` element crossfades between row sets instead
   * of swapping instantly. React Router's `viewTransition` prop only
   * helps cross-route; intra-page state changes need this manual call.
   *
   * flushSync is required so the DOM commits before the browser takes
   * the post-callback snapshot — without it React's batching can defer
   * the update past the snapshot point and the transition no-ops.
   */
  const setTab = (next: TabValue) => {
    if (next === tab) return;
    startViewTransition(() => flushSync(() => setTabRaw(next)));
  };

  const { data, isPending: loading } = useTicketList<Ticket>({
    requesterPersonId: person?.id ?? null,
  });
  const allTickets = person?.id ? (data?.items ?? []) : [];

  const counts = useMemo(() => ({
    all:       allTickets.length,
    open:      allTickets.filter((t) => OPEN_STATUSES.has(t.status_category)).length,
    scheduled: 0,
    closed:    allTickets.filter((t) => CLOSED_STATUSES.has(t.status_category)).length,
  }), [allTickets]);

  const filtered = useMemo(() => {
    if (tab === 'all') return allTickets;
    if (tab === 'open') return allTickets.filter((t) => OPEN_STATUSES.has(t.status_category));
    if (tab === 'closed') return allTickets.filter((t) => CLOSED_STATUSES.has(t.status_category));
    return []; // scheduled — empty in Wave 2
  }, [allTickets, tab]);

  const empty = EMPTY_STATE[tab];

  return (
    <PortalPage>
      {/* Page header */}
      <div className="flex items-end justify-between gap-4 mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">My requests</h1>
        <Link
          to="/portal/submit"
          viewTransition
          className={cn(
            buttonVariants({ size: 'sm' }),
            'shrink-0 gap-1.5',
          )}
        >
          <Plus className="size-3.5" />
          New request
        </Link>
      </div>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as TabValue)} className="mb-4">
        <TabsList>
          {(['open', 'all', 'scheduled', 'closed'] as const).map((t) => (
            <TabsTrigger key={t} value={t} className="gap-1.5 capitalize">
              {t}
              {counts[t] > 0 && (
                <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1 text-[10px] font-medium text-muted-foreground tabular-nums">
                  {counts[t]}
                </span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* Loading skeletons keep page rhythm — no layout shift on load */}
      {loading && allTickets.length === 0 && (
        <div className="rounded-xl border border-border/70 bg-card overflow-hidden divide-y divide-border/60">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3.5">
              <div className="portal-skeleton size-8 shrink-0 rounded-lg" />
              <div className="flex-1 space-y-1.5">
                <div className="portal-skeleton h-3.5 w-2/5 rounded" />
                <div className="portal-skeleton h-2.5 w-1/4 rounded" />
              </div>
              <div className="portal-skeleton h-5 w-16 shrink-0 rounded-md" />
            </div>
          ))}
        </div>
      )}

      {/* List — view-transition-name lets the browser crossfade rows on tab change */}
      {!loading && filtered.length > 0 && (
        <div
          className="portal-stagger rounded-xl border border-border/70 bg-card overflow-hidden divide-y divide-border/60"
          style={{ viewTransitionName: 'portal-requests-list' }}
        >
          {filtered.map((ticket) => {
            const assigneeName = ticket.assigned_user
              ? `${ticket.assigned_user.first_name} ${ticket.assigned_user.last_name}`.trim() || null
              : null;
            return (
              <PortalRequestRow
                key={ticket.id}
                href={`/portal/requests/${ticket.id}`}
                kind="ticket"
                ref={formatTicketRef(ticket.ticket_kind, ticket.module_number)}
                title={ticket.title}
                subtitle={ticket.assigned_team?.name ?? null}
                timestamp={ticket.created_at}
                assigneeName={assigneeName}
                status={derivePortalStatus(ticket.status_category, ticket.sla_resolution_breached_at)}
              />
            );
          })}
        </div>
      )}

      {/* Empty state — varied per tab */}
      {!loading && filtered.length === 0 && (
        <div className="portal-rise rounded-xl border border-border/70 bg-card px-6 py-16 flex flex-col items-center gap-3 text-center">
          <empty.Icon className="size-6 text-muted-foreground/60" aria-hidden />
          <div>
            <p className="text-sm font-medium">{empty.title}</p>
            {empty.hint && <p className="mt-1 text-xs text-muted-foreground">{empty.hint}</p>}
          </div>
        </div>
      )}
    </PortalPage>
  );
}

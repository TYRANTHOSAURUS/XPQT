import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { buttonVariants } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTicketList } from '@/api/tickets';
import { useAuth } from '@/providers/auth-provider';
import { PortalPage } from '@/components/portal/portal-page';
import { PortalRequestRow } from '@/components/portal/portal-request-row';

interface Ticket {
  id: string;
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

function deriveStatus(ticket: Ticket): { label: string; tone: 'inprog' | 'waiting' | 'scheduled' | 'done' | 'breached' } {
  if (ticket.sla_resolution_breached_at) {
    return { label: 'Delayed', tone: 'breached' };
  }
  switch (ticket.status_category) {
    case 'new':         return { label: 'Submitted', tone: 'scheduled' };
    case 'assigned':    return { label: 'Assigned', tone: 'inprog' };
    case 'in_progress': return { label: 'In progress', tone: 'inprog' };
    case 'waiting':     return { label: 'Waiting', tone: 'waiting' };
    case 'resolved':    return { label: 'Resolved', tone: 'done' };
    case 'closed':      return { label: 'Closed', tone: 'done' };
    default:            return { label: 'Submitted', tone: 'scheduled' };
  }
}

export function MyRequestsPage() {
  const { person } = useAuth();
  const [tab, setTab] = useState<TabValue>('open');

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

  return (
    <PortalPage>
      {/* Page header */}
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">My Requests</h1>
          <p className="mt-1 text-sm text-muted-foreground text-pretty">
            Everything you've submitted, booked, or invited.
          </p>
        </div>
        <Link to="/portal" className={buttonVariants({ size: 'sm', className: 'shrink-0' })}>
          + New request
        </Link>
      </div>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as TabValue)} className="mb-4">
        <TabsList>
          {(['open', 'all', 'scheduled', 'closed'] as const).map((t) => (
            <TabsTrigger key={t} value={t} className="gap-1.5 capitalize">
              {t}
              {counts[t] > 0 && (
                <span className="tabular-nums text-[11px] opacity-60">{counts[t]}</span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* Loading */}
      {loading && allTickets.length === 0 && (
        <div className="text-sm text-muted-foreground py-4">Loading your requests…</div>
      )}

      {/* List */}
      {!loading && filtered.length > 0 && (
        <div className="rounded-xl border bg-card overflow-hidden divide-y">
          {filtered.map((ticket) => {
            const assigneeName = ticket.assigned_user
              ? `${ticket.assigned_user.first_name} ${ticket.assigned_user.last_name}`.trim() || null
              : null;
            return (
              <PortalRequestRow
                key={ticket.id}
                href={`/portal/requests/${ticket.id}`}
                kind="ticket"
                title={ticket.title}
                subtitle={ticket.assigned_team?.name ?? null}
                timestamp={ticket.created_at}
                assigneeName={assigneeName}
                status={deriveStatus(ticket)}
              />
            );
          })}
        </div>
      )}

      {/* Empty state */}
      {!loading && filtered.length === 0 && (
        <div className="rounded-xl border bg-card px-6 py-16 flex flex-col items-center gap-3 text-center">
          <p className="text-sm text-muted-foreground">No requests in this view.</p>
        </div>
      )}
    </PortalPage>
  );
}

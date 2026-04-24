import { Link } from 'react-router-dom';
import { useQuery, queryOptions } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';
import { useAuth } from '@/providers/auth-provider';

interface MineTicket {
  id: string;
  title: string;
  status: string;
  created_at: string;
  request_type_name: string | null;
}

interface TicketListResponse {
  items: MineTicket[];
}

const mineTicketsOptions = (personId: string) =>
  queryOptions({
    queryKey: ['portal', 'my-open-tickets', personId],
    queryFn: ({ signal }) =>
      apiFetch<TicketListResponse>(
        `/tickets?requester_person_id=${encodeURIComponent(personId)}&status_category=open,in_progress&limit=4`,
        { signal },
      ).then((res) => res.items ?? []),
    staleTime: 30_000,
    enabled: !!personId,
  });

export function PortalActivityPanel() {
  const { person } = useAuth();
  const personId = person?.id ?? '';
  const { data: tickets = [], isPending } = useQuery(mineTicketsOptions(personId));

  const anyActivity = tickets.length > 0;

  return (
    <aside className="rounded-xl border bg-card">
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div className="text-sm font-semibold">Your activity</div>
        <Link to="/portal/requests" className="text-xs text-muted-foreground hover:text-foreground">View all</Link>
      </div>

      {isPending && (
        <div className="px-4 py-6 text-xs text-muted-foreground">Loading…</div>
      )}

      {!isPending && !anyActivity && (
        <div className="px-4 py-6 text-xs text-muted-foreground">
          Nothing open. Click a service to get started.
        </div>
      )}

      {tickets.map((t) => (
        <Link
          key={t.id}
          to={`/portal/requests/${t.id}`}
          className="flex items-start gap-3 border-t px-4 py-3 hover:bg-accent/40"
        >
          <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-blue-500/15 text-blue-500">
            <FileText className="size-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium">{t.title}</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              {t.request_type_name ?? 'Request'} · {formatRelativeTime(t.created_at)}
            </div>
          </div>
          <span className="shrink-0 rounded bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-500">
            Open
          </span>
        </Link>
      ))}
    </aside>
  );
}

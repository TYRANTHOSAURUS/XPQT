import { Link } from 'react-router-dom';
import { useQuery, queryOptions } from '@tanstack/react-query';
import { CheckCircle2, FileText } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';
import { useAuth } from '@/providers/auth-provider';
import {
  derivePortalStatus,
  REQUEST_KIND_TILE,
  STATUS_TONE_CLASSES,
} from '@/lib/portal-status';
import { cn } from '@/lib/utils';

interface MineTicket {
  id: string;
  title: string;
  status: string;
  status_category: string;
  created_at: string;
  request_type_name: string | null;
  sla_resolution_breached_at?: string | null;
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
    <aside className="rounded-xl border border-border/70 bg-card overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/60">
        <div className="text-sm font-semibold">Your activity</div>
        <Link
          to="/portal/requests"
          viewTransition
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          style={{ transitionTimingFunction: 'var(--ease-portal)', transitionDuration: 'var(--dur-portal-press)' }}
        >
          View all
        </Link>
      </div>

      {isPending && (
        <div className="divide-y divide-border/60">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <div className="portal-skeleton size-6 shrink-0 rounded-md" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="portal-skeleton h-3 w-2/3 rounded" />
                <div className="portal-skeleton h-2.5 w-1/3 rounded" />
              </div>
              <div className="portal-skeleton h-4 w-12 shrink-0 rounded" />
            </div>
          ))}
        </div>
      )}

      {!isPending && !anyActivity && (
        <div className="px-4 py-10 flex flex-col items-center gap-2 text-center">
          <CheckCircle2 className="size-5 text-muted-foreground/60" aria-hidden />
          <p className="text-xs text-muted-foreground">All caught up.</p>
        </div>
      )}

      {!isPending && anyActivity && (
        <div className="portal-stagger divide-y divide-border/60">
          {tickets.map((t) => {
            const status = derivePortalStatus(t.status_category, t.sla_resolution_breached_at);
            return (
              <Link
                key={t.id}
                to={`/portal/requests/${t.id}`}
                viewTransition
                className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-accent/40"
                style={{ transitionTimingFunction: 'var(--ease-portal)', transitionDuration: 'var(--dur-portal-press)' }}
              >
                <div className={cn('mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md', REQUEST_KIND_TILE.ticket)}>
                  <FileText className="size-3.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium">{t.title}</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {t.request_type_name ?? 'Request'} · {formatRelativeTime(t.created_at)}
                  </div>
                </div>
                <span
                  className={cn(
                    'shrink-0 rounded px-2 py-0.5 text-[10px] font-medium tabular-nums',
                    'transition-colors duration-200',
                    STATUS_TONE_CLASSES[status.tone],
                  )}
                  style={{ transitionTimingFunction: 'var(--ease-portal)' }}
                >
                  {status.label}
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </aside>
  );
}

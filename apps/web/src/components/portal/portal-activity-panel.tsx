import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, FileText, Plus } from 'lucide-react';
import { formatRelativeTime } from '@/lib/format';
import { useAuth } from '@/providers/auth-provider';
import { derivePortalStatus, REQUEST_KIND_TILE } from '@/lib/portal-status';
import { cn } from '@/lib/utils';
import { portalMyOpenTicketsOptions } from '@/api/portal-tickets';
import { PortalStatusPill } from './portal-status-pill';

export function PortalActivityPanel() {
  const { person } = useAuth();
  const personId = person?.id ?? '';
  const { data: tickets = [], isPending } = useQuery(portalMyOpenTicketsOptions(personId));

  // Distinguish "all closed for now" from "no requests ever". The first
  // visit to the portal should nudge toward a first action; otherwise the
  // panel reads "All caught up" which is wrong for a brand-new user.
  const hasNeverSubmitted = !isPending && tickets.length === 0;
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
        <div className="divide-y divide-border/60" aria-busy="true" aria-live="polite">
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

      {hasNeverSubmitted && (
        <div className="px-4 py-10 flex flex-col items-center gap-3 text-center">
          <CheckCircle2 className="size-5 text-muted-foreground/60" aria-hidden />
          <div>
            <p className="text-xs font-medium">All caught up.</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Nothing waiting on you right now.
            </p>
          </div>
          <Link
            to="/portal/submit"
            viewTransition
            className="inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-background px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-accent/40"
            style={{ transitionTimingFunction: 'var(--ease-portal)', transitionDuration: 'var(--dur-portal-press)' }}
          >
            <Plus className="size-3" aria-hidden />
            Submit a request
          </Link>
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
                  <FileText className="size-3.5" aria-hidden />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium">{t.title}</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {t.request_type_name ?? 'Request'} · {formatRelativeTime(t.created_at)}
                  </div>
                </div>
                <PortalStatusPill status={status} size="xs" />
              </Link>
            );
          })}
        </div>
      )}
    </aside>
  );
}

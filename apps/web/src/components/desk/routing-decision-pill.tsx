import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatRelativeTime, formatFullTimestamp } from '@/lib/format';
import { useTicketRoutingDecision } from '@/api/tickets';

/**
 * "Routed by …" breadcrumb for a ticket. Surfaces the latest row from
 * `routing_decisions` so an operator can answer "why was this ticket
 * assigned where it is?" without leaving the detail view.
 *
 * Click navigates to Routing Studio's Audit tab pre-filtered to this
 * ticket — see the deep-link contract on `RoutingStudioPage`. The Studio
 * itself enforces `routing.read`; non-admins clicking through will land
 * on Studio's own access-denied UI rather than a silent failure.
 */
export function RoutingDecisionPill({ ticketId }: { ticketId: string }) {
  const { data, isPending, isError } = useTicketRoutingDecision(ticketId);

  if (isPending) {
    return <span className="text-xs text-muted-foreground">Loading…</span>;
  }

  // Networking failure (rare) — render nothing rather than a noisy error;
  // the rest of the ticket detail keeps working.
  if (isError) return null;

  // Ticket created before audit log existed, or manually assigned without
  // running the resolver. "—" matches the rest of the sidebar's empty cells.
  if (!data) {
    return <span className="text-sm text-muted-foreground">—</span>;
  }

  const label =
    data.chosen_by === 'rule' && data.rule_name
      ? data.rule_name
      : data.chosen_by === 'unassigned'
        ? 'No match — left unassigned'
        : humanizeChosenBy(data.chosen_by);

  return (
    <Link
      to={`/admin/routing-studio?tab=audit&ticket=${ticketId}`}
      className={cn(
        'group inline-flex h-8 max-w-full items-center gap-1.5 rounded-md border bg-muted/40 px-2',
        'text-sm hover:bg-muted hover:text-foreground hover:border-border',
        'transition-colors duration-120 ease-[var(--ease-snap)]',
        'min-w-0',
      )}
      title={`Decided ${formatFullTimestamp(data.decided_at)} · click to open in Routing Studio`}
    >
      <Compass className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{label}</span>
      <time
        dateTime={data.decided_at}
        className="shrink-0 text-xs text-muted-foreground tabular-nums"
      >
        {formatRelativeTime(data.decided_at)}
      </time>
    </Link>
  );
}

function humanizeChosenBy(chosenBy: string): string {
  // chosen_by enum values use snake_case; show them with proper casing for
  // the few non-rule paths an admin might see in the wild (location_team,
  // asset_override, request_type_default, etc.).
  return chosenBy
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

import { Link } from 'react-router-dom';
import { ArrowRight, LifeBuoy, Wrench } from 'lucide-react';
import { useBundle, type BundleTicketRef } from '@/api/booking-bundles';
import { formatTicketRef } from '@/lib/format-ref';
import { cn } from '@/lib/utils';

interface Props {
  bundleId: string;
}

// Status dot palette — matches the desk surface's status semantics:
// new = neutral, assigned/waiting = amber, in_progress = blue,
// resolved/closed = emerald. Single source of truth so we read the
// same way as the rest of the desk.
const STATUS_DOT: Record<string, string> = {
  new: 'bg-muted-foreground/60',
  assigned: 'bg-amber-500',
  waiting: 'bg-amber-500',
  in_progress: 'bg-blue-500',
  resolved: 'bg-emerald-500',
  closed: 'bg-emerald-500',
};

/**
 * Service-desk command-center view of every ticket attached to this
 * booking — work orders for catering / AV / setup, plus any case
 * ticket spawned by an approval or escalation.
 *
 * Visually distinct from the services list above: a left rail (blue
 * for case, amber for work order) replaces the bg-tinted icon square
 * so the two sections don't blur together. Status lives on the meta
 * line as a dot+label so the right edge stays clean for the chevron.
 *
 * Reads from the same `useBundle(bundleId)` cache the services
 * section uses — TanStack Query dedupes, no extra fetch.
 */
export function BundleWorkOrdersSection({ bundleId }: Props) {
  const { data, isLoading } = useBundle(bundleId);

  if (isLoading || !data) return null;
  const tickets = data.tickets ?? [];
  if (tickets.length === 0) return null;

  return (
    <div className="border-t">
      <div className="flex items-center justify-between gap-3 px-5 pt-3 pb-1">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Fulfillment ({tickets.length})
        </span>
      </div>
      <ul className="px-5 pb-3">
        {tickets.map((t) => (
          <TicketRow key={t.id} ticket={t} />
        ))}
      </ul>
    </div>
  );
}

function TicketRow({ ticket }: { ticket: BundleTicketRef }) {
  const isCase = ticket.ticket_kind === 'case';
  const ref = formatTicketRef(ticket.ticket_kind, ticket.module_number);
  const statusLabel = ticket.status_category
    ? ticket.status_category.replace(/_/g, ' ')
    : 'unknown';
  const dotClass = STATUS_DOT[ticket.status_category ?? ''] ?? STATUS_DOT.new;

  return (
    <li>
      <Link
        to={`/desk/tickets/${ticket.id}`}
        className={cn(
          'group/wo flex items-center gap-3 border-b py-2 pl-2 pr-1 last:border-b-0',
          'border-l-2 transition-colors hover:bg-accent/30 focus-visible:bg-accent/30 focus-visible:outline-none',
          isCase
            ? 'border-l-blue-500/60 dark:border-l-blue-400/60'
            : 'border-l-amber-500/60 dark:border-l-amber-400/60',
        )}
        style={{
          transitionDuration: '120ms',
          transitionTimingFunction: 'var(--ease-snap)',
        }}
      >
        <span
          aria-hidden
          className={cn(
            'shrink-0',
            isCase ? 'text-blue-700 dark:text-blue-400' : 'text-amber-700 dark:text-amber-400',
          )}
        >
          {isCase ? <LifeBuoy className="size-3.5" /> : <Wrench className="size-3.5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <code data-chip className="font-mono text-xs font-medium tabular-nums">
              {ref}
            </code>
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
              {isCase ? 'Case' : 'Work order'}
            </span>
          </div>
          <div className="mt-0.5 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground capitalize">
            <span aria-hidden className={cn('size-1.5 rounded-full', dotClass)} />
            {statusLabel}
          </div>
        </div>
        <ArrowRight className="size-3.5 shrink-0 text-muted-foreground/60 opacity-0 transition-opacity group-hover/wo:opacity-100" />
      </Link>
    </li>
  );
}

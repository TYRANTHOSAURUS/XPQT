import { memo } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import {
  type Ticket,
  PriorityIcon,
  SlaCell,
  statusConfig,
  timeAgo,
} from './ticket-row-cells';
import { formatTicketRef } from '@/lib/format-ref';

interface Props {
  ticket: Ticket;
  selected: boolean;
  checked: boolean;
  /** When the row's context menu is open, hold a persistent highlight so the
   *  origin row stays visually attached to the menu. */
  menuOpen?: boolean;
  onSelect: (id: string) => void;
  onToggleCheck: (id: string) => void;
}

/**
 * Linear-style ticket row — flex layout, hairline divider, no table chrome.
 * Column positions match the header strip in the tickets list view.
 *
 * Wrapped in `memo` so a row only re-renders when its own ticket / selected /
 * checked changes — typing in the toolbar search or selecting a different row
 * doesn't cascade re-renders across all 50+ visible rows.
 */
function TicketListRowImpl({
  ticket,
  selected,
  checked,
  menuOpen,
  onSelect,
  onToggleCheck,
}: Props) {
  const status = statusConfig[ticket.status_category] ?? statusConfig.new;

  return (
    <div
      role="button"
      tabIndex={0}
      data-selected={selected ? 'true' : undefined}
      onClick={() => onSelect(ticket.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(ticket.id);
        }
      }}
      className={`group flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors ${
        selected
          ? 'bg-accent'
          : menuOpen
            ? 'bg-muted/50'
            : 'hover:bg-muted/30'
      }`}
      // Inset shadow over border + padding shift — keeps cell text
      // anchored when selection toggles. contentVisibility skips render
      // work for rows scrolled off-screen; intrinsic size keeps the
      // scrollbar stable.
      style={{
        contentVisibility: 'auto',
        containIntrinsicSize: 'auto 52px',
        boxShadow: selected ? 'inset 2px 0 0 var(--primary)' : undefined,
      }}
    >
      <div className="w-4 shrink-0" onClick={(e) => e.stopPropagation()}>
        <Checkbox checked={checked} onCheckedChange={() => onToggleCheck(ticket.id)} />
      </div>

      <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground tabular-nums truncate">
        {formatTicketRef(ticket.ticket_kind, ticket.module_number)}
      </span>

      <div className="flex w-28 items-center gap-2 shrink-0">
        <div
          className={`h-2 w-2 rounded-full shrink-0 transition-colors ${status.dotColor}`}
          style={{ transitionDuration: 'var(--dur-portal-hover)', transitionTimingFunction: 'var(--ease-portal)' }}
        />
        <span className="text-xs text-muted-foreground truncate">{status.label}</span>
      </div>

      <div className="w-6 shrink-0 flex justify-center">
        <PriorityIcon priority={ticket.priority} />
      </div>

      <div className="flex-1 min-w-0">
        <div className="truncate text-sm">{ticket.title}</div>
        {(ticket.requester || ticket.location) && (
          <div className="truncate text-xs text-muted-foreground">
            {ticket.requester ? `${ticket.requester.first_name} ${ticket.requester.last_name}` : ''}
            {ticket.location ? ` · ${ticket.location.name}` : ''}
          </div>
        )}
      </div>

      <span className="w-36 shrink-0 truncate text-xs text-muted-foreground">
        {ticket.assigned_team?.name ?? '—'}
      </span>

      <div className="w-24 shrink-0 text-xs">
        <SlaCell
          dueAt={ticket.sla_resolution_due_at}
          breachedAt={ticket.sla_resolution_breached_at}
        />
      </div>

      <span className="w-10 shrink-0 text-right text-xs text-muted-foreground">
        {timeAgo(ticket.created_at)}
      </span>
    </div>
  );
}

export const TicketListRow = memo(TicketListRowImpl);

import { Checkbox } from '@/components/ui/checkbox';
import {
  type Ticket,
  PriorityIcon,
  SlaCell,
  statusConfig,
  timeAgo,
} from './ticket-row-cells';

interface Props {
  ticket: Ticket;
  selected: boolean;
  checked: boolean;
  onSelect: (id: string) => void;
  onToggleCheck: (id: string) => void;
}

/**
 * Linear-style ticket row — flex layout, hairline divider, no table chrome.
 * Column positions match the header strip in the tickets list view.
 */
export function TicketListRow({ ticket, selected, checked, onSelect, onToggleCheck }: Props) {
  const status = statusConfig[ticket.status_category] ?? statusConfig.new;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(ticket.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(ticket.id);
        }
      }}
      className={`group flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors ${
        selected
          ? 'bg-accent border-l-2 border-l-primary pl-[10px]'
          : 'border-l-2 border-l-transparent hover:bg-muted/30'
      }`}
    >
      <div className="w-4 shrink-0" onClick={(e) => e.stopPropagation()}>
        <Checkbox checked={checked} onCheckedChange={() => onToggleCheck(ticket.id)} />
      </div>

      <div className="flex w-28 items-center gap-2 shrink-0">
        <div className={`h-2 w-2 rounded-full shrink-0 ${status.dotColor}`} />
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

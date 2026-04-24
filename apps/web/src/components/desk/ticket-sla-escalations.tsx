import { useTicketSlaCrossings, type SlaCrossing as Crossing } from '@/api/sla-policies';

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function describe(c: Crossing): { main: string; muted: boolean } {
  const when = new Date(c.fired_at).toLocaleString(); // design-check:allow — legacy; migrate to formatFullTimestamp when next editing
  const label = `${when} — ${capitalize(c.timer_type)} ${c.at_percent}%`;
  if (c.action === 'skipped_no_manager') {
    return { main: `${label} — skipped (no manager on record)`, muted: true };
  }
  const verb = c.action === 'escalate' ? 'Escalated to' : 'Notified';
  const who = c.target_name ?? (c.target_type === 'manager_of_requester' ? "requester's manager" : 'target');
  return { main: `${label} → ${verb} ${who}`, muted: false };
}

interface Props {
  ticketId: string;
}

export function TicketSlaEscalations({ ticketId }: Props) {
  const { data, isPending: loading } = useTicketSlaCrossings(ticketId);
  if (loading) return null;
  if (!data || data.length === 0) return null;

  return (
    <div>
      <div className="text-xs text-muted-foreground mb-1.5">Escalations</div>
      <ul className="space-y-1">
        {data.map((c) => {
          const { main, muted } = describe(c);
          return (
            <li
              key={c.id}
              className={`text-xs ${muted ? 'text-muted-foreground italic' : ''}`}
            >
              {main}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

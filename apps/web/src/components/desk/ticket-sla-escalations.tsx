import { useApi } from '@/hooks/use-api';

interface Crossing {
  id: string;
  fired_at: string;
  timer_type: 'response' | 'resolution';
  at_percent: number;
  action: 'notify' | 'escalate' | 'skipped_no_manager';
  target_type: 'user' | 'team' | 'manager_of_requester';
  target_id: string | null;
  target_name: string | null;
  notification_id: string | null;
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function describe(c: Crossing): { main: string; muted: boolean } {
  const when = new Date(c.fired_at).toLocaleString();
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
  const { data, loading } = useApi<Crossing[]>(`/sla/tickets/${ticketId}/crossings`, [ticketId]);
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

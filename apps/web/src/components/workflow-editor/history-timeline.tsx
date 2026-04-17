import { ArrowRight, CheckCircle, Pause, Play, AlertCircle, GitBranch } from 'lucide-react';

export interface InstanceEvent {
  id: string;
  event_type: string;
  node_id: string | null;
  node_type: string | null;
  decision: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

const iconFor = (type: string) => {
  switch (type) {
    case 'instance_started': return Play;
    case 'instance_completed': return CheckCircle;
    case 'instance_waiting': return Pause;
    case 'instance_resumed': return Play;
    case 'instance_failed': return AlertCircle;
    case 'decision_made': return GitBranch;
    default: return ArrowRight;
  }
};

function labelFor(e: InstanceEvent): string {
  if (e.event_type === 'instance_started') return 'Workflow started';
  if (e.event_type === 'instance_completed') return 'Workflow completed';
  if (e.event_type === 'instance_failed') return 'Workflow failed';
  if (e.event_type === 'instance_waiting') return `Waiting at ${e.node_type ?? '—'}`;
  if (e.event_type === 'instance_resumed') return 'Resumed';
  if (e.event_type === 'decision_made') return `Decision at ${e.node_type ?? '—'}`;
  if (e.event_type === 'node_entered') return `Entered ${e.node_type ?? '—'}`;
  if (e.event_type === 'node_exited') return `Exited ${e.node_type ?? '—'}`;
  return e.event_type;
}

export function HistoryTimeline({ events }: { events: InstanceEvent[] }) {
  if (events.length === 0) return <p className="text-sm text-muted-foreground">No events yet.</p>;

  return (
    <ol className="space-y-2">
      {events.map((e) => {
        const Icon = iconFor(e.event_type);
        return (
          <li key={e.id} className="flex items-start gap-2 text-sm">
            <Icon className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="font-medium">{labelFor(e)}</span>
                <time className="text-xs text-muted-foreground">{new Date(e.created_at).toLocaleTimeString()}</time>
              </div>
              {e.decision && <div className="text-xs text-muted-foreground">Decision: {e.decision}</div>}
              {e.payload && Object.keys(e.payload).length > 0 && (
                <pre className="text-[11px] text-muted-foreground mt-0.5 font-mono">{JSON.stringify(e.payload)}</pre>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

import { useParams, useNavigate } from 'react-router-dom';
import { useApi } from '@/hooks/use-api';
import { RuntimeViewer } from '@/components/workflow-editor/runtime-viewer';
import { HistoryTimeline, type InstanceEvent } from '@/components/workflow-editor/history-timeline';
import type { WorkflowGraph } from '@/components/workflow-editor/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface Instance {
  id: string;
  status: string;
  current_node_id: string | null;
  definition: { id: string; name: string; graph_definition: WorkflowGraph };
  started_at: string;
  completed_at: string | null;
}

export function WorkflowInstancePage() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: instance, loading } = useApi<Instance>(`/workflows/instances/${id}`, [id]);
  const { data: events } = useApi<InstanceEvent[]>(`/workflows/instances/${id}/events`, [id]);

  if (loading || !instance) return <div className="p-6 text-muted-foreground">Loading…</div>;

  return (
    <div className="flex flex-col h-[calc(100vh-64px)]">
      <div className="border-b px-4 py-2 flex items-center gap-3">
        <Button variant="link" size="sm" onClick={() => navigate(`/admin/workflow-templates/${instance.definition.id}`)}>
          ← Definition
        </Button>
        <div className="font-semibold">{instance.definition.name}</div>
        <Badge variant="outline" className="capitalize">{instance.status}</Badge>
      </div>
      <div className="flex-1 grid grid-cols-[1fr_320px] min-h-0">
        <div className="min-w-0">
          <RuntimeViewer
            graph={instance.definition.graph_definition ?? { nodes: [], edges: [] }}
            events={events ?? []}
            currentNodeId={instance.current_node_id}
          />
        </div>
        <aside className="border-l p-4 overflow-auto">
          <div className="text-xs font-semibold uppercase text-muted-foreground mb-2">Timeline</div>
          <HistoryTimeline events={events ?? []} />
        </aside>
      </div>
    </div>
  );
}

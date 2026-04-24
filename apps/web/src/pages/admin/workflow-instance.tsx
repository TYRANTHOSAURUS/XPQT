import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, queryOptions } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { workflowKeys } from '@/api/workflows';
import { RuntimeViewer } from '@/components/workflow-editor/runtime-viewer';
import { HistoryTimeline, type InstanceEvent } from '@/components/workflow-editor/history-timeline';
import type { WorkflowGraph } from '@/components/workflow-editor/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

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
  const { data: instance, isPending: loading } = useQuery(queryOptions({
    queryKey: workflowKeys.instanceDetail(id),
    queryFn: ({ signal }) => apiFetch<Instance>(`/workflows/instances/${id}`, { signal }),
    enabled: Boolean(id),
    staleTime: 10_000,
  }));
  const { data: events } = useQuery(queryOptions({
    queryKey: [...workflowKeys.instanceDetail(id), 'events'] as const,
    queryFn: ({ signal }) => apiFetch<InstanceEvent[]>(`/workflows/instances/${id}/events`, { signal }),
    enabled: Boolean(id),
    staleTime: 10_000,
  }));

  if (loading || !instance) return (
    <div className="flex flex-col h-[calc(100vh-64px)]">
      <div className="border-b px-4 py-2 flex items-center gap-3">
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-5 w-16" />
      </div>
      <div className="flex-1 grid grid-cols-[1fr_320px] min-h-0">
        <Skeleton className="m-4" />
        <aside className="border-l p-4 space-y-3">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </aside>
      </div>
    </div>
  );

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

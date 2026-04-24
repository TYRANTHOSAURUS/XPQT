import { useCallback } from 'react';
import { useQuery, queryOptions } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type { WorkflowDefinition, WorkflowGraph } from '@/components/workflow-editor/types';

export function useWorkflow(id: string) {
  return useQuery(queryOptions({
    queryKey: ['workflows', 'definitions', 'detail', id] as const,
    queryFn: ({ signal }) => apiFetch<WorkflowDefinition>(`/workflows/${id}`, { signal }),
    enabled: Boolean(id),
    staleTime: 60_000,
  }));
}

export interface SimulateResult {
  path: string[];
  events: Array<{ event_type: string; node_id?: string; node_type?: string; decision?: string; payload?: Record<string, unknown> }>;
  terminated: boolean;
  stoppedAt?: { node_id: string; node_type: string; reason: string };
  errors?: string[];
}

export function useWorkflowMutations(id: string) {
  const saveGraph = useCallback(async (graph: WorkflowGraph) => {
    return apiFetch<WorkflowDefinition>(`/workflows/${id}/graph`, {
      method: 'PATCH',
      body: JSON.stringify({ graph_definition: graph }),
    });
  }, [id]);

  const publish = useCallback(async () => {
    return apiFetch<WorkflowDefinition>(`/workflows/${id}/publish`, { method: 'POST' });
  }, [id]);

  const unpublish = useCallback(async () => {
    return apiFetch<WorkflowDefinition>(`/workflows/${id}/unpublish`, { method: 'POST' });
  }, [id]);

  const clone = useCallback(async (name?: string) => {
    return apiFetch<WorkflowDefinition>(`/workflows/${id}/clone`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  }, [id]);

  const simulate = useCallback(async (ticket: Record<string, unknown>) => {
    return apiFetch<SimulateResult>(`/workflows/${id}/simulate`, {
      method: 'POST',
      body: JSON.stringify({ ticket }),
    });
  }, [id]);

  return { saveGraph, publish, unpublish, clone, simulate };
}

import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface WorkflowInstance {
  id: string;
  status: string;
  current_node_id: string | null;
  workflow_definition_id: string;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description?: string | null;
  definition?: unknown;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export const workflowKeys = {
  all: ['workflows'] as const,
  instances: () => [...workflowKeys.all, 'instances'] as const,
  instancesByTicket: (ticketId: string) =>
    [...workflowKeys.instances(), 'by-ticket', ticketId] as const,
  instanceDetail: (id: string) => [...workflowKeys.instances(), 'detail', id] as const,
  definitions: () => [...workflowKeys.all, 'definitions'] as const,
  definitionsList: () => [...workflowKeys.definitions(), 'list'] as const,
  definition: (id: string) => [...workflowKeys.definitions(), 'detail', id] as const,
} as const;

/** Live workflow instances for a ticket. T1 — advances as steps complete. */
export function ticketWorkflowInstancesOptions(ticketId: string) {
  return queryOptions({
    queryKey: workflowKeys.instancesByTicket(ticketId),
    queryFn: ({ signal }) =>
      apiFetch<WorkflowInstance[]>(`/workflows/instances/ticket/${ticketId}`, { signal }),
    enabled: Boolean(ticketId),
    staleTime: 10_000,
  });
}

export function useTicketWorkflowInstances(ticketId: string) {
  return useQuery(ticketWorkflowInstancesOptions(ticketId));
}

export function workflowDefinitionsListOptions() {
  return queryOptions({
    queryKey: workflowKeys.definitionsList(),
    queryFn: ({ signal }) => apiFetch<WorkflowDefinition[]>('/workflows', { signal }),
    staleTime: 5 * 60_000,
  });
}
export function useWorkflowDefinitions() {
  return useQuery(workflowDefinitionsListOptions());
}

export function workflowInstanceOptions(id: string | null | undefined) {
  return queryOptions({
    queryKey: workflowKeys.instanceDetail(id ?? ''),
    queryFn: ({ signal }) => apiFetch<WorkflowInstance>(`/workflows/instances/${id}`, { signal }),
    enabled: Boolean(id),
    staleTime: 10_000,
  });
}
export function useWorkflowInstance(id: string | null | undefined) {
  return useQuery(workflowInstanceOptions(id));
}

export type UpsertWorkflowPayload = Partial<Omit<WorkflowDefinition, 'id' | 'created_at' | 'updated_at'>> & {
  name: string;
};

export function useUpsertWorkflow() {
  const qc = useQueryClient();
  return useMutation<WorkflowDefinition, Error, { id: string | null; payload: UpsertWorkflowPayload }>({
    mutationFn: ({ id, payload }) =>
      apiFetch<WorkflowDefinition>(
        id ? `/workflows/${id}` : '/workflows',
        { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload) },
      ),
    onSettled: () => qc.invalidateQueries({ queryKey: workflowKeys.all }),
  });
}

export function useDeleteWorkflow() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: (id) => apiFetch(`/workflows/${id}`, { method: 'DELETE' }),
    onSettled: () => qc.invalidateQueries({ queryKey: workflowKeys.all }),
  });
}

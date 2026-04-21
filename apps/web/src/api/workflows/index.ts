import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface WorkflowInstance {
  id: string;
  status: string;
  current_node_id: string | null;
  workflow_definition_id: string;
}

export const workflowKeys = {
  all: ['workflows'] as const,
  instances: () => [...workflowKeys.all, 'instances'] as const,
  instancesByTicket: (ticketId: string) =>
    [...workflowKeys.instances(), 'by-ticket', ticketId] as const,
  definitions: () => [...workflowKeys.all, 'definition'] as const,
  definition: (id: string) => [...workflowKeys.definitions(), id] as const,
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

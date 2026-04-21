import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface SlaPolicy {
  id: string;
  name: string;
}

export const slaPolicyKeys = {
  all: ['sla-policies'] as const,
  lists: () => [...slaPolicyKeys.all, 'list'] as const,
  list: () => [...slaPolicyKeys.lists(), {}] as const,
  detail: (id: string) => [...slaPolicyKeys.all, 'detail', id] as const,
} as const;

export function slaPoliciesListOptions() {
  return queryOptions({
    queryKey: slaPolicyKeys.list(),
    queryFn: ({ signal }) => apiFetch<SlaPolicy[]>('/sla-policies', { signal }),
    staleTime: Infinity, // T4 — admin-edited; mutations must invalidate.
    gcTime: Infinity,
  });
}

export function useSlaPolicies() {
  return useQuery(slaPoliciesListOptions());
}

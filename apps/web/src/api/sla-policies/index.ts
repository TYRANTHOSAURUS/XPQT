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
  details: () => [...slaPolicyKeys.all, 'detail'] as const,
  detail: (id: string) => [...slaPolicyKeys.details(), id] as const,
} as const;

export function slaPoliciesListOptions() {
  return queryOptions({
    queryKey: slaPolicyKeys.list(),
    queryFn: ({ signal }) => apiFetch<SlaPolicy[]>('/sla-policies', { signal }),
    // T3 until the admin SLA-policies page (apps/web/src/pages/admin/sla-policies.tsx)
    // migrates to RQ and invalidates slaPolicyKeys.lists() on create/update/delete.
    // Once that's done, raise to Infinity per §7.2 T4.
    staleTime: 5 * 60_000,
  });
}

export function useSlaPolicies() {
  return useQuery(slaPoliciesListOptions());
}

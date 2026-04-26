import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { costCenterKeys } from './keys';
import type { CostCenter } from './types';

export function costCenterListOptions(filters: { active?: boolean } = {}) {
  return queryOptions({
    queryKey: costCenterKeys.list(filters),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams();
      if (filters.active != null) params.set('active', String(filters.active));
      const qs = params.toString();
      return apiFetch<CostCenter[]>(`/admin/cost-centers${qs ? `?${qs}` : ''}`, { signal });
    },
    staleTime: 30_000,
  });
}

export function useCostCenters(filters: { active?: boolean } = {}) {
  return useQuery(costCenterListOptions(filters));
}

export function costCenterDetailOptions(id: string) {
  return queryOptions({
    queryKey: costCenterKeys.detail(id),
    queryFn: ({ signal }) =>
      apiFetch<CostCenter>(`/admin/cost-centers/${id}`, { signal }),
    staleTime: 30_000,
    enabled: Boolean(id),
  });
}

export function useCostCenter(id: string) {
  return useQuery(costCenterDetailOptions(id));
}

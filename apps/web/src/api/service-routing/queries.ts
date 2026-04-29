import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { serviceRoutingKeys } from './keys';
import type { ServiceRoutingRow } from './types';

export function serviceRoutingListOptions() {
  return queryOptions({
    queryKey: serviceRoutingKeys.list(),
    queryFn: ({ signal }) =>
      apiFetch<ServiceRoutingRow[]>('/admin/service-routing', { signal }),
    staleTime: 30_000,
  });
}

export function useServiceRoutings() {
  return useQuery(serviceRoutingListOptions());
}

export function serviceRoutingDetailOptions(id: string) {
  return queryOptions({
    queryKey: serviceRoutingKeys.detail(id),
    queryFn: ({ signal }) =>
      apiFetch<ServiceRoutingRow>(`/admin/service-routing/${id}`, { signal }),
    staleTime: 30_000,
    enabled: Boolean(id),
  });
}

export function useServiceRouting(id: string) {
  return useQuery(serviceRoutingDetailOptions(id));
}

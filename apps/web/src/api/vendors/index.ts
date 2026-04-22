import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface Vendor {
  id: string;
  name: string;
  active?: boolean;
}

export const vendorKeys = {
  all: ['vendors'] as const,
  lists: () => [...vendorKeys.all, 'list'] as const,
  list: () => [...vendorKeys.lists(), {}] as const,
  details: () => [...vendorKeys.all, 'detail'] as const,
  detail: (id: string) => [...vendorKeys.details(), id] as const,
} as const;

export function vendorsListOptions() {
  return queryOptions({
    queryKey: vendorKeys.list(),
    queryFn: ({ signal }) => apiFetch<Vendor[]>('/vendors', { signal }),
    staleTime: 5 * 60_000, // T3
  });
}

export function useVendors() {
  return useQuery(vendorsListOptions());
}

import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface Vendor {
  id: string;
  name: string;
  active?: boolean;
  default_sla_policy_id?: string | null;
  default_team_id?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  domain?: string | null;
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

export type UpsertVendorPayload = Partial<Omit<Vendor, 'id'>> & { name: string };

export function useUpsertVendor() {
  const qc = useQueryClient();
  return useMutation<Vendor, Error, { id: string | null; payload: UpsertVendorPayload }>({
    mutationFn: ({ id, payload }) =>
      apiFetch<Vendor>(
        id ? `/vendors/${id}` : '/vendors',
        { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload) },
      ),
    onSettled: () => qc.invalidateQueries({ queryKey: vendorKeys.all }),
  });
}

export function useDeleteVendor() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: (id) => apiFetch(`/vendors/${id}`, { method: 'DELETE' }),
    onSettled: () => qc.invalidateQueries({ queryKey: vendorKeys.all }),
  });
}

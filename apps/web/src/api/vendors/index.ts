import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

/**
 * Vendor fulfillment mode (daily-list spec §2). 'paper_only' / 'hybrid'
 * vendors get a printed list emailed at cutoff; 'portal' vendors use
 * the vendor portal exclusively.
 */
export type VendorFulfillmentMode = 'portal' | 'paper_only' | 'hybrid';

export interface Vendor {
  id: string;
  name: string;
  active?: boolean;
  contact_email?: string | null;
  contact_phone?: string | null;
  website?: string | null;
  notes?: string | null;
  owning_team_id?: string | null;
  owning_team?: { id: string; name: string } | null;
  default_sla_policy_id?: string | null;
  default_team_id?: string | null;
  /** @deprecated kept for legacy callers — use contact_email. */
  email?: string | null;
  /** @deprecated kept for legacy callers — use contact_phone. */
  phone?: string | null;
  address?: string | null;
  domain?: string | null;

  // -----------------------------------------------------------------
  // Daily-list fields (vendor portal Phase A spec §3). DB column names
  // retain the Dutch "daglijst_" prefix; see daily-list.module.ts top
  // doc for the deferred-rename rationale.
  // -----------------------------------------------------------------
  fulfillment_mode?: VendorFulfillmentMode | null;
  daglijst_email?: string | null;
  daglijst_language?: 'nl' | 'fr' | 'en' | 'de' | null;
  /** Offset mode: send N minutes before earliest delivery in the bucket. */
  daglijst_cutoff_offset_minutes?: number | null;
  /** Clock mode: send daily at this Europe/Amsterdam wall-clock time (HH:mm). */
  daglijst_send_clock_time?: string | null;
  /** Status-inference grace period for paper-only vendors (Sprint 4). */
  daglijst_inferred_status_grace_minutes?: number | null;
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

export function vendorDetailOptions(id: string | null | undefined) {
  return queryOptions({
    queryKey: vendorKeys.detail(id ?? ''),
    queryFn: ({ signal }) => apiFetch<Vendor>(`/vendors/${id}`, { signal }),
    enabled: Boolean(id),
    staleTime: 5 * 60_000,
  });
}

export function useVendor(id: string | null | undefined) {
  return useQuery(vendorDetailOptions(id));
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

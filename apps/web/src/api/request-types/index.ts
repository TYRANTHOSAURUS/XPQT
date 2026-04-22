import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface RequestTypeDetail {
  id: string;
  name: string;
  domain: string;
  form_schema_id?: string | null;
  fulfillment_strategy?: string;
  requires_asset?: boolean;
  asset_required?: boolean;
  asset_type_filter?: string[];
  requires_location?: boolean;
  location_required?: boolean;
}

export const requestTypeKeys = {
  all: ['request-types'] as const,
  lists: () => [...requestTypeKeys.all, 'list'] as const,
  list: () => [...requestTypeKeys.lists(), {}] as const,
  details: () => [...requestTypeKeys.all, 'detail'] as const,
  detail: (id: string) => [...requestTypeKeys.details(), id] as const,
} as const;

export function requestTypeDetailOptions(id: string | null | undefined) {
  return queryOptions({
    queryKey: requestTypeKeys.detail(id ?? ''),
    queryFn: ({ signal }) => apiFetch<RequestTypeDetail>(`/request-types/${id}`, { signal }),
    enabled: Boolean(id),
    // T3 until apps/web/src/components/admin/request-type-dialog.tsx migrates to
    // RQ mutations that invalidate requestTypeKeys on save. Once that's done,
    // raise to Infinity per §7.2 T4.
    staleTime: 5 * 60_000,
  });
}

export function useRequestType(id: string | null | undefined) {
  return useQuery(requestTypeDetailOptions(id));
}

import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface RequestTypeDetail {
  id: string;
  name: string;
  domain: string;
  fulfillment_strategy?: string;
  requires_asset?: boolean;
  asset_required?: boolean;
  asset_type_filter?: string[];
  requires_location?: boolean;
  location_required?: boolean;
}

export interface RequestTypeFormVariant {
  id: string;
  criteria_set_id: string | null;
  form_schema_id: string;
  priority: number;
  starts_at: string | null;
  ends_at: string | null;
  active: boolean;
}

export const requestTypeKeys = {
  all: ['request-types'] as const,
  lists: () => [...requestTypeKeys.all, 'list'] as const,
  list: () => [...requestTypeKeys.lists(), {}] as const,
  details: () => [...requestTypeKeys.all, 'detail'] as const,
  detail: (id: string) => [...requestTypeKeys.details(), id] as const,
  formVariants: (id: string) => [...requestTypeKeys.detail(id), 'form-variants'] as const,
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

/**
 * Default form schema for a request type = the active row in
 * `request_type_form_variants` with `criteria_set_id IS NULL`. Replaces the
 * old `request_types.form_schema_id` column that migration 00098 dropped.
 * Desk-side callers (agent create, ticket detail) pick the default because
 * they have no requester persona to drive audience-conditional variants.
 */
export function requestTypeDefaultFormSchemaOptions(id: string | null | undefined) {
  return queryOptions({
    queryKey: requestTypeKeys.formVariants(id ?? ''),
    queryFn: async ({ signal }) => {
      const variants = await apiFetch<RequestTypeFormVariant[]>(
        `/request-types/${id}/form-variants`,
        { signal },
      );
      return variants.find((v) => v.criteria_set_id === null && v.active) ?? null;
    },
    enabled: Boolean(id),
    staleTime: 5 * 60_000,
  });
}

export function useRequestTypeDefaultFormSchema(id: string | null | undefined) {
  return useQuery(requestTypeDefaultFormSchemaOptions(id));
}

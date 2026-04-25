import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { configEntityKeys } from '@/api/config-entities';

export interface RequestTypeListItem {
  id: string;
  name: string;
  domain: string;
  active: boolean;
  sla_policy?: { id: string; name: string } | null;
  fulfillment_strategy?: 'asset' | 'location' | 'fixed' | 'auto';
  location_granularity?: string | null;
  requires_approval?: boolean;
}

export interface RequestTypeDetail extends RequestTypeListItem {
  requires_asset?: boolean;
  asset_required?: boolean;
  asset_type_filter?: string[];
  requires_location?: boolean;
  location_required?: boolean;
  default_team_id?: string | null;
  approval_approver_team_id?: string | null;
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
    // T4 — request types are admin-edited, request-type-dialog calls
    // useUpsertRequestType which invalidates requestTypeKeys.all. Cache
    // forever until then.
    staleTime: Infinity,
    gcTime: Infinity,
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
    // T4 — variants change only via the request-type dialog, which
    // invalidates requestTypeKeys.all on save.
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

export function useRequestTypeDefaultFormSchema(id: string | null | undefined) {
  return useQuery(requestTypeDefaultFormSchemaOptions(id));
}

/** Full list for admin tables + pickers. T4 — useUpsertRequestType invalidates. */
export function requestTypesListOptions() {
  return queryOptions({
    queryKey: requestTypeKeys.list(),
    queryFn: ({ signal }) => apiFetch<RequestTypeListItem[]>('/request-types', { signal }),
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

export function useRequestTypes() {
  return useQuery(requestTypesListOptions());
}

export interface UpsertRequestTypePayload {
  name: string;
  domain: string | null;
  active?: boolean;
  sla_policy_id?: string | null;
  location_granularity?: string | null;
  fulfillment_strategy?: 'asset' | 'location' | 'fixed' | 'auto';
  requires_asset?: boolean;
  asset_required?: boolean;
  asset_type_filter?: string[];
  requires_location?: boolean;
  location_required?: boolean;
  default_team_id?: string | null;
  requires_approval?: boolean;
  approval_approver_team_id?: string | null;
}

/**
 * Create or update a request type. Invalidates every consumer key so the
 * sidebar RT picker, ticket detail, portal submit, routing studio, etc.
 * all pick up the new config without a page reload.
 */
export function useUpsertRequestType() {
  const qc = useQueryClient();
  return useMutation<RequestTypeDetail, Error, { id: string | null; payload: UpsertRequestTypePayload }>({
    mutationFn: ({ id, payload }) =>
      apiFetch<RequestTypeDetail>(
        id ? `/request-types/${id}` : '/request-types',
        {
          method: id ? 'PATCH' : 'POST',
          body: JSON.stringify(payload),
        },
      ),
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: requestTypeKeys.all }),
      ]),
  });
}

/** Upsert the default form variant (criteria_set_id IS NULL) for a request type. */
export function useUpsertDefaultFormVariant(requestTypeId: string) {
  const qc = useQueryClient();
  return useMutation<unknown, Error, { form_schema_id: string; variantId?: string | null }>({
    mutationFn: ({ form_schema_id, variantId }) =>
      apiFetch(
        `/request-types/${requestTypeId}/form-variants${variantId ? `/${variantId}` : ''}`,
        {
          method: variantId ? 'PATCH' : 'POST',
          body: JSON.stringify({
            criteria_set_id: null,
            form_schema_id,
            priority: 0,
            active: true,
          }),
        },
      ),
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: requestTypeKeys.formVariants(requestTypeId) }),
        qc.invalidateQueries({ queryKey: requestTypeKeys.detail(requestTypeId) }),
        qc.invalidateQueries({ queryKey: configEntityKeys.all }),
      ]),
  });
}

/** Toggle active flag on a request type (admin list quick action). */
export function useToggleRequestType() {
  const qc = useQueryClient();
  return useMutation<RequestTypeListItem, Error, { id: string; active: boolean }>({
    mutationFn: ({ id, active }) =>
      apiFetch<RequestTypeListItem>(`/request-types/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active }),
      }),
    onMutate: async ({ id, active }) => {
      await qc.cancelQueries({ queryKey: requestTypeKeys.list() });
      const previous = qc.getQueryData<RequestTypeListItem[]>(requestTypeKeys.list());
      if (previous) {
        qc.setQueryData<RequestTypeListItem[]>(
          requestTypeKeys.list(),
          previous.map((rt) => (rt.id === id ? { ...rt, active } : rt)),
        );
      }
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      const prev = (ctx as { previous?: RequestTypeListItem[] } | undefined)?.previous;
      if (prev) qc.setQueryData(requestTypeKeys.list(), prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: requestTypeKeys.all }),
  });
}

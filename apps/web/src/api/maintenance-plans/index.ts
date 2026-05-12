import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { withErrorHandling } from '@/lib/errors';

/**
 * MaintenancePlan client module — admin CRUD over /admin/maintenance/plans.
 *
 * Mirrors apps/api/src/modules/maintenance/maintenance-plan.service.ts:22-47
 * (MaintenancePlanRow) + dto/maintenance-plan.dto.ts (DTOs).
 *
 * Key factory follows docs/react-query-guidelines.md: `all` → `list` /
 * `detail`. Hooks: useMaintenancePlans / useMaintenancePlan /
 * useCreateMaintenancePlan / useUpdateMaintenancePlan /
 * useDeleteMaintenancePlan. Mutations carry withErrorHandling so callers
 * don't need a bespoke onError; route page errors throw to
 * RouteErrorBoundary via usePageQuery.
 */

export type RecurrenceUnit = 'day' | 'week' | 'month' | 'year';
export type MaintenancePlanPriority = 'low' | 'normal' | 'high' | 'critical';

export interface MaintenancePlan {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  active: boolean;
  asset_id: string | null;
  asset_type_id: string | null;
  request_type_id: string;
  location_id: string | null;
  title_template: string;
  description_template: string | null;
  priority: MaintenancePlanPriority;
  planned_duration_minutes: number | null;
  recurrence_interval: number;
  recurrence_unit: RecurrenceUnit;
  anchor_date: string;
  lead_days: number;
  next_run_at: string;
  last_completed_at: string | null;
  last_generated_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

export interface MaintenancePlanListResponse {
  rows: MaintenancePlan[];
  total: number;
}

export interface MaintenancePlanCreateBody {
  name: string;
  description?: string | null;
  active?: boolean;
  asset_id?: string | null;
  asset_type_id?: string | null;
  request_type_id: string;
  location_id?: string | null;
  title_template: string;
  description_template?: string | null;
  priority?: MaintenancePlanPriority;
  planned_duration_minutes?: number | null;
  recurrence_interval: number;
  recurrence_unit: RecurrenceUnit;
  anchor_date: string;
  lead_days?: number;
}

export type MaintenancePlanUpdateBody = Partial<MaintenancePlanCreateBody>;

export interface MaintenancePlanDeleteResponse {
  ok: true;
  mode: 'soft' | 'hard';
}

export interface MaintenancePlanListFilters {
  asset_id?: string;
  asset_type_id?: string;
  request_type_id?: string;
  active?: boolean;
  limit?: number;
  offset?: number;
}

export const maintenancePlanKeys = {
  all: ['maintenance-plans'] as const,
  lists: () => [...maintenancePlanKeys.all, 'list'] as const,
  list: (filters: MaintenancePlanListFilters = {}) =>
    [...maintenancePlanKeys.lists(), filters] as const,
  details: () => [...maintenancePlanKeys.all, 'detail'] as const,
  detail: (id: string) => [...maintenancePlanKeys.details(), id] as const,
} as const;

function listQueryParams(
  filters: MaintenancePlanListFilters,
): Record<string, string> | undefined {
  const params: Record<string, string> = {};
  if (filters.asset_id) params.asset_id = filters.asset_id;
  if (filters.asset_type_id) params.asset_type_id = filters.asset_type_id;
  if (filters.request_type_id) params.request_type_id = filters.request_type_id;
  if (filters.active !== undefined) params.active = String(filters.active);
  if (filters.limit !== undefined) params.limit = String(filters.limit);
  if (filters.offset !== undefined) params.offset = String(filters.offset);
  return Object.keys(params).length > 0 ? params : undefined;
}

export function maintenancePlansListOptions(
  filters: MaintenancePlanListFilters = {},
) {
  return queryOptions({
    queryKey: maintenancePlanKeys.list(filters),
    queryFn: ({ signal }) =>
      apiFetch<MaintenancePlanListResponse>('/admin/maintenance/plans', {
        signal,
        query: listQueryParams(filters),
      }),
    staleTime: 60_000,
  });
}

export function useMaintenancePlans(filters: MaintenancePlanListFilters = {}) {
  return useQuery(maintenancePlansListOptions(filters));
}

export function maintenancePlanDetailOptions(id: string | null | undefined) {
  return queryOptions({
    queryKey: maintenancePlanKeys.detail(id ?? ''),
    queryFn: ({ signal }) =>
      apiFetch<MaintenancePlan>(`/admin/maintenance/plans/${id}`, { signal }),
    enabled: Boolean(id),
    staleTime: 60_000,
  });
}

export function useMaintenancePlan(id: string | null | undefined) {
  return useQuery(maintenancePlanDetailOptions(id));
}

export function useCreateMaintenancePlan() {
  const qc = useQueryClient();
  return useMutation<MaintenancePlan, Error, MaintenancePlanCreateBody>({
    mutationFn: (body) =>
      apiFetch<MaintenancePlan>('/admin/maintenance/plans', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: maintenancePlanKeys.lists() }),
    ...withErrorHandling({ actionTitle: "Couldn't create maintenance plan" }),
  });
}

export function useUpdateMaintenancePlan(id: string) {
  const qc = useQueryClient();
  return useMutation<MaintenancePlan, Error, MaintenancePlanUpdateBody>({
    mutationFn: (body) =>
      apiFetch<MaintenancePlan>(`/admin/maintenance/plans/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: (plan) => {
      qc.setQueryData(maintenancePlanKeys.detail(id), plan);
      qc.invalidateQueries({ queryKey: maintenancePlanKeys.lists() });
    },
    ...withErrorHandling({ actionTitle: "Couldn't update maintenance plan" }),
  });
}

export function useDeleteMaintenancePlan() {
  const qc = useQueryClient();
  return useMutation<MaintenancePlanDeleteResponse, Error, string>({
    mutationFn: (id) =>
      apiFetch<MaintenancePlanDeleteResponse>(`/admin/maintenance/plans/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: maintenancePlanKeys.all }),
    ...withErrorHandling({ actionTitle: "Couldn't delete maintenance plan" }),
  });
}

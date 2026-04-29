import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { serviceRoutingKeys } from './keys';
import type { ServiceCategory, ServiceRoutingRow } from './types';

export interface ServiceRoutingCreatePayload {
  /** NULL = tenant default. */
  location_id?: string | null;
  service_category: ServiceCategory;
  internal_team_id?: string | null;
  default_lead_time_minutes?: number;
  sla_policy_id?: string | null;
  active?: boolean;
}

export interface ServiceRoutingUpdatePayload {
  internal_team_id?: string | null;
  default_lead_time_minutes?: number;
  sla_policy_id?: string | null;
  active?: boolean;
}

export function useCreateServiceRouting() {
  const qc = useQueryClient();
  return useMutation<ServiceRoutingRow, Error, ServiceRoutingCreatePayload>({
    mutationFn: (payload) =>
      apiFetch<ServiceRoutingRow>('/admin/service-routing', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: serviceRoutingKeys.lists() });
    },
  });
}

export function useUpdateServiceRouting() {
  const qc = useQueryClient();
  return useMutation<ServiceRoutingRow, Error, { id: string; patch: ServiceRoutingUpdatePayload }>({
    mutationFn: ({ id, patch }) =>
      apiFetch<ServiceRoutingRow>(`/admin/service-routing/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: serviceRoutingKeys.detail(id) });
      qc.invalidateQueries({ queryKey: serviceRoutingKeys.lists() });
    },
  });
}

export function useDeleteServiceRouting() {
  const qc = useQueryClient();
  return useMutation<{ id: string }, Error, string>({
    mutationFn: (id) =>
      apiFetch<{ id: string }>(`/admin/service-routing/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: serviceRoutingKeys.detail(id) });
      qc.invalidateQueries({ queryKey: serviceRoutingKeys.lists() });
    },
  });
}

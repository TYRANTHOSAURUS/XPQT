import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { costCenterKeys } from './keys';
import type { CostCenter } from './types';

export interface CostCenterUpsertPayload {
  code: string;
  name: string;
  description?: string | null;
  default_approver_person_id?: string | null;
  active?: boolean;
}

export function useCreateCostCenter() {
  const qc = useQueryClient();
  return useMutation<CostCenter, Error, CostCenterUpsertPayload>({
    mutationFn: (payload) =>
      apiFetch<CostCenter>('/admin/cost-centers', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: costCenterKeys.lists() });
    },
  });
}

export function useUpdateCostCenter() {
  const qc = useQueryClient();
  return useMutation<CostCenter, Error, { id: string; patch: Partial<CostCenterUpsertPayload> }>({
    mutationFn: ({ id, patch }) =>
      apiFetch<CostCenter>(`/admin/cost-centers/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: costCenterKeys.detail(id) });
      qc.invalidateQueries({ queryKey: costCenterKeys.lists() });
    },
  });
}

export function useDeleteCostCenter() {
  const qc = useQueryClient();
  return useMutation<{ id: string }, Error, string>({
    mutationFn: (id) =>
      apiFetch<{ id: string }>(`/admin/cost-centers/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: costCenterKeys.detail(id) });
      qc.invalidateQueries({ queryKey: costCenterKeys.lists() });
    },
  });
}

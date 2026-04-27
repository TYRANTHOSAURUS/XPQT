import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { bundleTemplateKeys } from './keys';
import type { BundleTemplate, BundleTemplatePayload } from './types';

export interface BundleTemplateUpsertPayload {
  name: string;
  description?: string | null;
  icon?: string | null;
  active?: boolean;
  payload: BundleTemplatePayload;
}

export function useCreateBundleTemplate() {
  const qc = useQueryClient();
  return useMutation<BundleTemplate, Error, BundleTemplateUpsertPayload>({
    mutationFn: (payload) =>
      apiFetch<BundleTemplate>('/admin/bundle-templates', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: bundleTemplateKeys.lists() });
    },
  });
}

export function useUpdateBundleTemplate() {
  const qc = useQueryClient();
  return useMutation<BundleTemplate, Error, { id: string; patch: Partial<BundleTemplateUpsertPayload> }>({
    mutationFn: ({ id, patch }) =>
      apiFetch<BundleTemplate>(`/admin/bundle-templates/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: bundleTemplateKeys.detail(id) });
      qc.invalidateQueries({ queryKey: bundleTemplateKeys.lists() });
    },
  });
}

export function useDeleteBundleTemplate() {
  const qc = useQueryClient();
  return useMutation<{ id: string }, Error, string>({
    mutationFn: (id) =>
      apiFetch<{ id: string }>(`/admin/bundle-templates/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: bundleTemplateKeys.detail(id) });
      qc.invalidateQueries({ queryKey: bundleTemplateKeys.lists() });
    },
  });
}

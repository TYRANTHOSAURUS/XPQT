import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { spaceKeys } from './keys';
import type {
  BulkUpdateResult,
  CreateSpacePayload,
  Space,
  UpdateSpacePayload,
} from './types';

export function useCreateSpace() {
  const qc = useQueryClient();
  return useMutation<Space, Error, CreateSpacePayload>({
    mutationFn: (payload) =>
      apiFetch<Space>('/spaces', { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: spaceKeys.tree() });
      qc.invalidateQueries({ queryKey: spaceKeys.lists() });
    },
  });
}

export function useUpdateSpace(id: string) {
  const qc = useQueryClient();
  return useMutation<Space, Error, UpdateSpacePayload>({
    mutationFn: (payload) =>
      apiFetch<Space>(`/spaces/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
    onSuccess: (updated) => {
      qc.setQueryData(spaceKeys.detail(id), updated);
      qc.invalidateQueries({ queryKey: spaceKeys.tree() });
    },
  });
}

export function useMoveSpace(id: string) {
  const qc = useQueryClient();
  return useMutation<Space, Error, { parent_id: string | null }>({
    mutationFn: (payload) =>
      apiFetch<Space>(`/spaces/${id}/move`, { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: spaceKeys.all });
    },
  });
}

export function useDeleteSpace() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) =>
      apiFetch<void>(`/spaces/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: false }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: spaceKeys.all });
    },
  });
}

export function useBulkUpdateSpaces() {
  const qc = useQueryClient();
  return useMutation<BulkUpdateResult, Error, { ids: string[]; patch: UpdateSpacePayload }>({
    mutationFn: (payload) =>
      apiFetch<BulkUpdateResult>('/spaces/bulk', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: spaceKeys.all });
    },
  });
}

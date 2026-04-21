import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type { FormField } from '@/components/admin/form-builder/premade-fields';

export interface ConfigEntity {
  id: string;
  current_version?: { definition: { fields: FormField[] } } | null;
}

export const configEntityKeys = {
  all: ['config-entities'] as const,
  details: () => [...configEntityKeys.all, 'detail'] as const,
  detail: (id: string) => [...configEntityKeys.details(), id] as const,
} as const;

export function configEntityOptions(id: string | null | undefined) {
  return queryOptions({
    queryKey: configEntityKeys.detail(id ?? ''),
    queryFn: ({ signal }) => apiFetch<ConfigEntity>(`/config-entities/${id}`, { signal }),
    enabled: Boolean(id),
    staleTime: Infinity, // T4 — config data, admin-edited.
    gcTime: Infinity,
  });
}

export function useConfigEntity(id: string | null | undefined) {
  return useQuery(configEntityOptions(id));
}

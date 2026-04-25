import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type { FormField } from '@/components/admin/form-builder/premade-fields';

export interface ConfigEntity {
  id: string;
  display_name?: string;
  type?: string;
  current_version?: { definition: { fields: FormField[] } } | null;
}

export interface FormSchemaListItem {
  id: string;
  display_name: string;
}

export const configEntityKeys = {
  all: ['config-entities'] as const,
  lists: () => [...configEntityKeys.all, 'list'] as const,
  list: (type: string | null) => [...configEntityKeys.lists(), { type }] as const,
  details: () => [...configEntityKeys.all, 'detail'] as const,
  detail: (id: string) => [...configEntityKeys.details(), id] as const,
} as const;

export function configEntityOptions(id: string | null | undefined) {
  return queryOptions({
    queryKey: configEntityKeys.detail(id ?? ''),
    queryFn: ({ signal }) => apiFetch<ConfigEntity>(`/config-entities/${id}`, { signal }),
    enabled: Boolean(id),
    // T4 — config entities are admin-edited; useUpsertConfigEntity invalidates
    // configEntityKeys.all on save.
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

export function useConfigEntity(id: string | null | undefined) {
  return useQuery(configEntityOptions(id));
}

export function formSchemasListOptions() {
  return queryOptions({
    queryKey: configEntityKeys.list('form_schema'),
    queryFn: ({ signal }) =>
      apiFetch<FormSchemaListItem[]>('/config-entities', {
        signal,
        query: { type: 'form_schema' },
      }),
    // T4 — same invalidation chain.
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

export function useFormSchemas() {
  return useQuery(formSchemasListOptions());
}

export interface UpsertConfigEntityPayload {
  display_name: string;
  type: string;
  definition: { fields: FormField[] };
}

/** Create or update a config entity (form schemas, criteria sets, etc). */
export function useUpsertConfigEntity() {
  const qc = useQueryClient();
  return useMutation<ConfigEntity, Error, { id: string | null; payload: UpsertConfigEntityPayload }>({
    mutationFn: ({ id, payload }) =>
      apiFetch<ConfigEntity>(
        id ? `/config-entities/${id}` : '/config-entities',
        {
          method: id ? 'PATCH' : 'POST',
          body: JSON.stringify(payload),
        },
      ),
    onSettled: () => qc.invalidateQueries({ queryKey: configEntityKeys.all }),
  });
}

export function useDeleteConfigEntity() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: (id) => apiFetch(`/config-entities/${id}`, { method: 'DELETE' }),
    onSettled: () => qc.invalidateQueries({ queryKey: configEntityKeys.all }),
  });
}

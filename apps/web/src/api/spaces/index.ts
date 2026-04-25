export * from './types';
export * from './keys';
export * from './queries';
export * from './mutations';

import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { spaceKeys } from './keys';
import type { Space } from './types';

export interface SpaceListFilters {
  types?: string[] | null;
  search?: string | null;
  activeOnly?: boolean | null;
}

export function spacesListOptions(filters: SpaceListFilters = {}) {
  // Normalize so equivalent filter shapes share a cache entry.
  const normalized = {
    types: filters.types?.length ? [...filters.types].sort() : undefined,
    search: filters.search || undefined,
    activeOnly: filters.activeOnly || undefined,
  };
  return queryOptions({
    queryKey: spaceKeys.list(normalized as Record<string, unknown>),
    queryFn: ({ signal }) =>
      apiFetch<Space[]>('/spaces', {
        signal,
        query: {
          types: normalized.types?.join(','),
          search: normalized.search,
          active_only: normalized.activeOnly ? 'true' : undefined,
        },
      }),
    staleTime: 5 * 60_000,
  });
}

export function useSpaces(filters: SpaceListFilters = {}) {
  return useQuery(spacesListOptions(filters));
}

export interface UpsertSpacePayload {
  name: string;
  type: string;
  parent_id?: string | null;
  archived?: boolean;
}

export function useUpsertSpace() {
  const qc = useQueryClient();
  return useMutation<Space, Error, { id: string | null; payload: UpsertSpacePayload }>({
    mutationFn: ({ id, payload }) =>
      apiFetch<Space>(
        id ? `/spaces/${id}` : '/spaces',
        { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload) },
      ),
    onSettled: (_data, _err, vars) => {
      // Hierarchy mutation: lists + tree + (when editing) detail. Children
      // queries hang off the tree key already.
      const tasks: Promise<unknown>[] = [
        qc.invalidateQueries({ queryKey: spaceKeys.lists() }),
        qc.invalidateQueries({ queryKey: spaceKeys.tree() }),
      ];
      if (vars.id) tasks.push(qc.invalidateQueries({ queryKey: spaceKeys.detail(vars.id) }));
      return Promise.all(tasks);
    },
  });
}

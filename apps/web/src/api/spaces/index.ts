export * from './types';
export * from './keys';
export * from './queries';
export * from './mutations';

import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { spaceKeys } from './keys';
import type { Space } from './types';

export function spacesListOptions() {
  return queryOptions({
    queryKey: spaceKeys.list(),
    queryFn: ({ signal }) => apiFetch<Space[]>('/spaces', { signal }),
    staleTime: 5 * 60_000,
  });
}

export function useSpaces() {
  return useQuery(spacesListOptions());
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
    onSettled: () => qc.invalidateQueries({ queryKey: spaceKeys.all }),
  });
}

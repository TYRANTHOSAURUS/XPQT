import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface Space {
  id: string;
  name: string;
  type: string;
  parent_id?: string | null;
  archived?: boolean;
  depth?: number;
}

export const spaceKeys = {
  all: ['spaces'] as const,
  lists: () => [...spaceKeys.all, 'list'] as const,
  list: () => [...spaceKeys.lists(), {}] as const,
  details: () => [...spaceKeys.all, 'detail'] as const,
  detail: (id: string) => [...spaceKeys.details(), id] as const,
} as const;

export function spacesListOptions() {
  return queryOptions({
    queryKey: spaceKeys.list(),
    queryFn: ({ signal }) => apiFetch<Space[]>('/spaces', { signal }),
    staleTime: 5 * 60_000, // T3 — hierarchy changes rarely.
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

export function useDeleteSpace() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: (id) => apiFetch(`/spaces/${id}`, { method: 'DELETE' }),
    onSettled: () => qc.invalidateQueries({ queryKey: spaceKeys.all }),
  });
}

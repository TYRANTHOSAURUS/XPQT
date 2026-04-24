import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { spaceKeys } from './keys';
import type { Space, SpaceTreeNode } from './types';

export function spaceTreeQueryOptions() {
  return queryOptions({
    queryKey: spaceKeys.tree(),
    queryFn: ({ signal }) => apiFetch<SpaceTreeNode[]>('/spaces/hierarchy', { signal }),
    staleTime: 30_000,
  });
}

export function useSpaceTree() {
  return useQuery(spaceTreeQueryOptions());
}

export function spaceDetailQueryOptions(id: string | null | undefined) {
  return queryOptions({
    queryKey: id ? spaceKeys.detail(id) : [...spaceKeys.details(), 'none'],
    queryFn: ({ signal }) => apiFetch<Space>(`/spaces/${id}`, { signal }),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

export function useSpaceDetail(id: string | null | undefined) {
  return useQuery(spaceDetailQueryOptions(id));
}

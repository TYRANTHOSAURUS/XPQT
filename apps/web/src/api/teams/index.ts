import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface Team {
  id: string;
  name: string;
}

export const teamKeys = {
  all: ['teams'] as const,
  lists: () => [...teamKeys.all, 'list'] as const,
  list: () => [...teamKeys.lists(), {}] as const,
  detail: (id: string) => [...teamKeys.all, 'detail', id] as const,
} as const;

export function teamsListOptions() {
  return queryOptions({
    queryKey: teamKeys.list(),
    queryFn: ({ signal }) => apiFetch<Team[]>('/teams', { signal }),
    staleTime: 5 * 60_000, // T3 — admin-edited, rarely changes during a session.
  });
}

export function useTeams() {
  return useQuery(teamsListOptions());
}

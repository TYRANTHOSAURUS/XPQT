import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface Team {
  id: string;
  name: string;
  description?: string | null;
  default_sla_policy_id?: string | null;
  active?: boolean;
}

export const teamKeys = {
  all: ['teams'] as const,
  lists: () => [...teamKeys.all, 'list'] as const,
  list: () => [...teamKeys.lists(), {}] as const,
  details: () => [...teamKeys.all, 'detail'] as const,
  detail: (id: string) => [...teamKeys.details(), id] as const,
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

export type UpsertTeamPayload = Partial<Omit<Team, 'id'>> & { name: string };

export function useUpsertTeam() {
  const qc = useQueryClient();
  return useMutation<Team, Error, { id: string | null; payload: UpsertTeamPayload }>({
    mutationFn: ({ id, payload }) =>
      apiFetch<Team>(
        id ? `/teams/${id}` : '/teams',
        { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload) },
      ),
    onSettled: () => qc.invalidateQueries({ queryKey: teamKeys.all }),
  });
}

export function useDeleteTeam() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: (id) => apiFetch(`/teams/${id}`, { method: 'DELETE' }),
    onSettled: () => qc.invalidateQueries({ queryKey: teamKeys.all }),
  });
}

import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface Team {
  id: string;
  name: string;
  description?: string | null;
  domain_scope?: string | null;
  location_scope?: string | null;
  org_node_id?: string | null;
  org_node?: { id: string; name: string; code?: string | null } | null;
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

export function teamDetailOptions(id: string | null | undefined) {
  return queryOptions({
    queryKey: teamKeys.detail(id ?? ''),
    queryFn: ({ signal }) => apiFetch<Team>(`/teams/${id}`, { signal }),
    enabled: Boolean(id),
    staleTime: 5 * 60_000,
  });
}

export function useTeam(id: string | null | undefined) {
  return useQuery(teamDetailOptions(id));
}

export interface TeamMember {
  id: string;
  team_id: string;
  user_id: string;
  user?: {
    id: string;
    email: string;
    person?: { id: string; first_name: string; last_name: string } | null;
  } | null;
}

export function teamMembersOptions(id: string | null | undefined) {
  return queryOptions({
    queryKey: [...teamKeys.detail(id ?? ''), 'members'] as const,
    queryFn: ({ signal }) => apiFetch<TeamMember[]>(`/teams/${id}/members`, { signal }),
    enabled: Boolean(id),
    staleTime: 60_000,
  });
}

export function useTeamMembers(id: string | null | undefined) {
  return useQuery(teamMembersOptions(id));
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

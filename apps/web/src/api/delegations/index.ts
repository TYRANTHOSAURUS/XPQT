import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface Delegation {
  id: string;
  delegator_person_id: string;
  delegate_person_id: string;
  starts_at: string;
  ends_at: string | null;
  active: boolean;
  created_at: string;
}

export const delegationKeys = {
  all: ['delegations'] as const,
  lists: () => [...delegationKeys.all, 'list'] as const,
  list: () => [...delegationKeys.lists(), {}] as const,
} as const;

export function delegationsListOptions() {
  return queryOptions({
    queryKey: delegationKeys.list(),
    queryFn: ({ signal }) => apiFetch<Delegation[]>('/delegations', { signal }),
    staleTime: 60_000,
  });
}
export function useDelegations() {
  return useQuery(delegationsListOptions());
}

export type UpsertDelegationPayload = Partial<Omit<Delegation, 'id' | 'created_at'>> & {
  delegator_person_id: string;
  delegate_person_id: string;
  starts_at: string;
};

export function useUpsertDelegation() {
  const qc = useQueryClient();
  return useMutation<Delegation, Error, { id: string | null; payload: UpsertDelegationPayload }>({
    mutationFn: ({ id, payload }) =>
      apiFetch<Delegation>(
        id ? `/delegations/${id}` : '/delegations',
        { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload) },
      ),
    onSettled: () => qc.invalidateQueries({ queryKey: delegationKeys.lists() }),
  });
}

export function useDeleteDelegation() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: (id) => apiFetch(`/delegations/${id}`, { method: 'DELETE' }),
    onSettled: () => qc.invalidateQueries({ queryKey: delegationKeys.lists() }),
  });
}

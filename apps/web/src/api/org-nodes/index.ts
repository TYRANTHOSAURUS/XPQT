import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface OrgNode {
  id: string;
  name: string;
  code?: string | null;
  parent_id: string | null;
  type?: string | null;
}

export const orgNodeKeys = {
  all: ['org-nodes'] as const,
  lists: () => [...orgNodeKeys.all, 'list'] as const,
  list: () => [...orgNodeKeys.lists(), {}] as const,
  details: () => [...orgNodeKeys.all, 'detail'] as const,
  detail: (id: string) => [...orgNodeKeys.details(), id] as const,
} as const;

export function orgNodesListOptions() {
  return queryOptions({
    queryKey: orgNodeKeys.list(),
    queryFn: ({ signal }) => apiFetch<OrgNode[]>('/org-nodes', { signal }),
    staleTime: 5 * 60_000, // T3
  });
}

export function useOrgNodes() {
  return useQuery(orgNodesListOptions());
}

export interface UpsertOrgNodePayload {
  name: string;
  parent_id?: string | null;
  type?: string | null;
}

export function useUpsertOrgNode() {
  const qc = useQueryClient();
  return useMutation<OrgNode, Error, { id: string | null; payload: UpsertOrgNodePayload }>({
    mutationFn: ({ id, payload }) =>
      apiFetch<OrgNode>(
        id ? `/org-nodes/${id}` : '/org-nodes',
        { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload) },
      ),
    onSettled: (_data, _err, vars) => {
      const tasks: Promise<unknown>[] = [qc.invalidateQueries({ queryKey: orgNodeKeys.lists() })];
      if (vars.id) tasks.push(qc.invalidateQueries({ queryKey: orgNodeKeys.detail(vars.id) }));
      return Promise.all(tasks);
    },
  });
}

export function useDeleteOrgNode() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: (id) => apiFetch(`/org-nodes/${id}`, { method: 'DELETE' }),
    onSettled: (_data, _err, id) =>
      Promise.all([
        qc.invalidateQueries({ queryKey: orgNodeKeys.lists() }),
        qc.removeQueries({ queryKey: orgNodeKeys.detail(id) }),
      ]),
  });
}

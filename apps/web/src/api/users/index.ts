import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface UserOption {
  id: string;
  email: string;
  /** Convenience label returned by some endpoints. Derive if absent. */
  full_name?: string;
  person?: { first_name?: string; last_name?: string } | null;
  active?: boolean;
}

export function userLabel(u: Pick<UserOption, 'email' | 'full_name' | 'person'>): string {
  if (u.full_name) return u.full_name;
  if (u.person) {
    const combined = `${u.person.first_name ?? ''} ${u.person.last_name ?? ''}`.trim();
    if (combined) return combined;
  }
  return u.email;
}

export const userKeys = {
  all: ['users'] as const,
  lists: () => [...userKeys.all, 'list'] as const,
  list: () => [...userKeys.lists(), {}] as const,
  details: () => [...userKeys.all, 'detail'] as const,
  detail: (id: string) => [...userKeys.details(), id] as const,
} as const;

export function usersListOptions() {
  return queryOptions({
    queryKey: userKeys.list(),
    queryFn: ({ signal }) => apiFetch<UserOption[]>('/users', { signal }),
    staleTime: 5 * 60_000, // T3 — user set changes rarely.
  });
}

export function useUsers() {
  return useQuery(usersListOptions());
}

export interface UpsertUserPayload {
  email?: string;
  active?: boolean;
  person_id?: string | null;
}

export function useUpsertUser() {
  const qc = useQueryClient();
  return useMutation<UserOption, Error, { id: string | null; payload: UpsertUserPayload }>({
    mutationFn: ({ id, payload }) =>
      apiFetch<UserOption>(
        id ? `/users/${id}` : '/users',
        { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload) },
      ),
    onSettled: (_data, _err, vars) => {
      const tasks: Promise<unknown>[] = [qc.invalidateQueries({ queryKey: userKeys.lists() })];
      if (vars.id) tasks.push(qc.invalidateQueries({ queryKey: userKeys.detail(vars.id) }));
      return Promise.all(tasks);
    },
  });
}

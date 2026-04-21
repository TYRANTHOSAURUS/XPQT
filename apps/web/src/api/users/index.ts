import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface UserOption {
  id: string;
  email: string;
  person?: { first_name?: string; last_name?: string } | null;
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

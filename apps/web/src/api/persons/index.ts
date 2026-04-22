import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface Person {
  id: string;
  first_name: string;
  last_name: string;
  email?: string | null;
  department?: string | null;
}

export const personKeys = {
  all: ['persons'] as const,
  lists: () => [...personKeys.all, 'list'] as const,
  list: (search: string | null) => [...personKeys.lists(), { search }] as const,
  details: () => [...personKeys.all, 'detail'] as const,
  detail: (id: string) => [...personKeys.details(), id] as const,
} as const;

/**
 * Full persons directory. Used for @mention suggestions; cached aggressively
 * since the directory rarely changes during a session.
 */
export function personsListOptions() {
  return queryOptions({
    queryKey: personKeys.list(null),
    queryFn: ({ signal }) => apiFetch<Person[]>('/persons', { signal }),
    staleTime: 5 * 60_000, // T3
  });
}

export function usePersons() {
  return useQuery(personsListOptions());
}

/**
 * Server-side search (used when the client-side filter over the full list
 * isn't enough). Separate cache entry per query so previous searches don't
 * refetch when the user backspaces back to an earlier term.
 */
export function personsSearchOptions(search: string) {
  return queryOptions({
    queryKey: personKeys.list(search),
    queryFn: ({ signal }) =>
      apiFetch<Person[]>('/persons', { signal, query: { search } }),
    enabled: search.trim().length >= 2,
    staleTime: 30_000, // T2 — search results are "right now" context.
  });
}

export function usePersonsSearch(search: string) {
  return useQuery(personsSearchOptions(search));
}

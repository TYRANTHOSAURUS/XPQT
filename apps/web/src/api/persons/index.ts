import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface Person {
  id: string;
  first_name: string;
  last_name: string;
  /** Convenience field returned by some endpoints. Derive `${first} ${last}` if absent. */
  full_name?: string;
  email?: string | null;
  department?: string | null;
}

export function personFullName(p: Pick<Person, 'first_name' | 'last_name' | 'full_name'>): string {
  return p.full_name ?? `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim();
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
 * since the directory rarely changes during a session. Optional type filter
 * for the admin persons page (employee / contractor / vendor_contact / etc).
 */
export function personsListOptions(typeFilter?: string | null) {
  const typed = typeFilter && typeFilter !== 'all' ? typeFilter : null;
  return queryOptions({
    queryKey: [...personKeys.lists(), { type: typed }] as const,
    queryFn: ({ signal }) =>
      apiFetch<Person[]>('/persons', {
        signal,
        query: typed ? { type: typed } : undefined,
      }),
    staleTime: 5 * 60_000, // T3
  });
}

export function usePersons(typeFilter?: string | null) {
  return useQuery(personsListOptions(typeFilter));
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

/**
 * Resolve a single person by id — used by selection controls (pickers) to
 * reliably render the selected label even when the id is not in the current
 * list/search page.
 */
export function personDetailOptions(id: string | null | undefined) {
  return queryOptions({
    queryKey: personKeys.detail(id ?? '__none__'),
    queryFn: ({ signal }) => apiFetch<Person>(`/persons/${id}`, { signal }),
    enabled: !!id,
    staleTime: 5 * 60_000,
  });
}

export function usePerson(id: string | null | undefined) {
  return useQuery(personDetailOptions(id));
}

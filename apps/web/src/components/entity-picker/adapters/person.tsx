import { apiFetch } from '@/lib/api';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  personFullName,
  type Person,
} from '@/api/persons';
import type { EntityAdapter } from '../types';

const SEARCH_KEY = ['persons', 'entity-picker-search'] as const;

export const personEntityAdapter: EntityAdapter<Person> = {
  type: 'person',
  noun: 'person',
  searchPlaceholder: 'Search by name or email…',

  searchQueryOptions(query, filter) {
    const trimmed = query.trim();
    return {
      queryKey: [...SEARCH_KEY, { q: trimmed, filter: filter ?? null }] as const,
      queryFn: ({ signal }) =>
        apiFetch<Person[]>('/persons', {
          signal,
          query: {
            ...(trimmed ? { search: trimmed } : {}),
            ...(filter ?? {}),
          } as Record<string, string>,
        }),
      // Cheap dedup: the directory rarely changes during a session, but
      // not so long that newly-created persons stay invisible.
      staleTime: 30_000,
    };
  },

  detailQueryOptions(id) {
    return {
      queryKey: ['persons', 'detail', id] as const,
      queryFn: ({ signal }) => apiFetch<Person>(`/persons/${id}`, { signal }),
      staleTime: 5 * 60_000,
      enabled: Boolean(id),
    };
  },

  renderListItem(p) {
    return (
      <div className="flex items-center gap-2 min-w-0">
        <Avatar className="size-6 shrink-0">
          {p.avatar_url ? <AvatarImage src={p.avatar_url} alt="" /> : null}
          <AvatarFallback className="text-[10px]">
            {initials(p)}
          </AvatarFallback>
        </Avatar>
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="truncate text-sm">{personFullName(p)}</span>
          {p.email ? (
            <span className="truncate text-xs text-muted-foreground">{p.email}</span>
          ) : null}
        </div>
      </div>
    );
  },

  renderSelected(p) {
    return (
      <span className="flex items-center gap-2 min-w-0">
        <Avatar className="size-5 shrink-0">
          {p.avatar_url ? <AvatarImage src={p.avatar_url} alt="" /> : null}
          <AvatarFallback className="text-[9px]">
            {initials(p)}
          </AvatarFallback>
        </Avatar>
        <span className="truncate">{personFullName(p)}</span>
      </span>
    );
  },

  itemLabel(p) {
    return personFullName(p);
  },
};

function initials(p: Person): string {
  const first = p.first_name?.[0] ?? '';
  const last = p.last_name?.[0] ?? '';
  return (first + last || '?').toUpperCase();
}

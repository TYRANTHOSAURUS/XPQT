import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { searchKeys } from './keys';

export type SearchKind =
  | 'ticket'
  | 'person'
  // Synthetic — the backend's `/search` endpoint returns `kind: 'person'`
  // for visitor-typed persons (extra.type === 'visitor'). The command
  // palette splits person hits into a separate `visitor` group so they
  // surface as visitors and link to `/desk/visitors?q=…` instead of the
  // generic /admin/persons row. Backend never emits this kind directly.
  | 'visitor'
  | 'space'
  | 'room'
  | 'location'
  | 'asset'
  | 'vendor'
  | 'team'
  | 'request_type'
  | 'reservation';

export interface SearchHit {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle: string | null;
  breadcrumb: string | null;
  score: number;
  extra: Record<string, unknown> | null;
}

export interface SearchResponse {
  query: string;
  total: number;
  groups: Partial<Record<SearchKind, SearchHit[]>>;
}

export function searchOptions(q: string, types?: SearchKind[], limit = 4) {
  const trimmed = q.trim();
  const enabled = trimmed.length >= 2;

  const params = new URLSearchParams();
  if (enabled) params.set('q', trimmed);
  if (types?.length) params.set('types', types.join(','));
  if (limit && limit !== 4) params.set('limit', String(limit));

  // `params` is derived from the same trimmed/types/limit triple now in
  // the queryKey; it's only the URLSearchParams serialisation.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  return queryOptions({
    queryKey: searchKeys.query(trimmed, types, limit),
    queryFn: ({ signal }) =>
      apiFetch<SearchResponse>(`/search?${params.toString()}`, { signal }),
    enabled,
    // Same query within 30s reuses the cached payload — typing back over a
    // recent query is free.
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    // Keep the previous result on screen while the next query is in flight,
    // so groups don't flash empty on every keystroke.
    placeholderData: (prev) => prev,
  });
}

export function useSearch(q: string, types?: SearchKind[], limit?: number) {
  return useQuery(searchOptions(q, types, limit));
}

export const SEARCH_KIND_LABEL: Record<SearchKind, string> = {
  ticket: 'Tickets',
  person: 'People',
  visitor: 'Visitors',
  space: 'Locations',
  room: 'Rooms',
  location: 'Locations',
  asset: 'Assets',
  vendor: 'Vendors',
  team: 'Teams',
  request_type: 'Request types',
  reservation: 'Bookings',
};

// Visitors render BEFORE persons so a search hit for "james" surfaces
// as the visitor first, not as a person row that links to /admin/persons.
export const SEARCH_KIND_ORDER: SearchKind[] = [
  'ticket',
  'visitor',
  'person',
  'reservation',
  'room',
  'space',
  'asset',
  'vendor',
  'team',
  'request_type',
];

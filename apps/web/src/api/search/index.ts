import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { searchKeys } from './keys';

export type SearchKind =
  | 'ticket'
  | 'person'
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

  return queryOptions({
    queryKey: searchKeys.query(trimmed, types),
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
  space: 'Locations',
  room: 'Rooms',
  location: 'Locations',
  asset: 'Assets',
  vendor: 'Vendors',
  team: 'Teams',
  request_type: 'Request types',
  reservation: 'Bookings',
};

export const SEARCH_KIND_ORDER: SearchKind[] = [
  'ticket',
  'person',
  'reservation',
  'room',
  'space',
  'asset',
  'vendor',
  'team',
  'request_type',
];

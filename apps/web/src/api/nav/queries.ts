import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { navKeys } from './keys';
import type { NavCount } from './types';

const COUNT_STALE_MS = 30_000;

/**
 * Inbox unread count for the desk-shell rail badge. Re-fetches on tab focus
 * so a user returning to the tab sees a fresh number. Realtime invalidation
 * happens at the call site (DeskSidebar) when a relevant event fires.
 */
export function inboxCountOptions() {
  return queryOptions({
    queryKey: navKeys.inboxCount(),
    queryFn: ({ signal }) => apiFetch<NavCount>('/tickets/inbox/count', { signal }),
    staleTime: COUNT_STALE_MS,
    refetchOnWindowFocus: true,
  });
}

export function useInboxUnreadCount() {
  return useQuery(inboxCountOptions());
}

/**
 * Pending approvals count for the caller's own queue. Auth-derived on the
 * server — no caller-id needed in the query.
 */
export function approvalsCountOptions() {
  return queryOptions({
    queryKey: navKeys.approvalsCount(),
    queryFn: ({ signal }) =>
      apiFetch<NavCount>('/approvals/pending/me/count', { signal }),
    staleTime: COUNT_STALE_MS,
    refetchOnWindowFocus: true,
  });
}

export function useMyPendingApprovalsCount() {
  return useQuery(approvalsCountOptions());
}

/**
 * Expected-visitors-today count for the rail badge. Per-building; the
 * caller passes the currently-selected reception building. When `buildingId`
 * is null/empty the query is disabled (the rail simply won't show a count
 * until the operator picks a building).
 */
export function visitorsCountOptions(buildingId: string | null) {
  return queryOptions({
    queryKey: navKeys.visitorsCount(buildingId),
    queryFn: ({ signal }) =>
      apiFetch<NavCount>('/reception/today/count', {
        signal,
        query: { building_id: buildingId ?? '' },
      }),
    staleTime: COUNT_STALE_MS,
    refetchOnWindowFocus: true,
    enabled: Boolean(buildingId),
  });
}

export function useExpectedVisitorsCount(buildingId: string | null) {
  return useQuery(visitorsCountOptions(buildingId));
}

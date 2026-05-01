import { queryOptions, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { ticketKeys, type TicketListFilters } from './keys';
import type { TicketActivity, TicketDetail } from './types';

export interface TicketListResponse<TItem = TicketDetail> {
  items: TItem[];
  next_cursor?: string | null;
}

/**
 * Open-ticket detail view. Cache tier T1 (§7.2) — short staleTime because the
 * desk has many hands editing at once.
 */
export function ticketDetailOptions(id: string) {
  return queryOptions({
    queryKey: ticketKeys.detail(id),
    queryFn: ({ signal }) => apiFetch<TicketDetail>(`/tickets/${id}`, { signal }),
    staleTime: 10_000,
    enabled: Boolean(id),
  });
}

export function useTicketDetail(id: string) {
  return useQuery(ticketDetailOptions(id));
}

export function ticketActivitiesOptions(id: string) {
  return queryOptions({
    queryKey: ticketKeys.activities(id),
    queryFn: ({ signal }) => apiFetch<TicketActivity[]>(`/tickets/${id}/activities`, { signal }),
    staleTime: 10_000,
    enabled: Boolean(id),
  });
}

export function useTicketActivities(id: string) {
  return useQuery(ticketActivitiesOptions(id));
}

export function ticketTagSuggestionsOptions() {
  return queryOptions({
    queryKey: ticketKeys.tagSuggestions(),
    queryFn: ({ signal }) => apiFetch<string[]>('/tickets/tags', { signal }),
    staleTime: 5 * 60_000, // T3 — tag vocabulary changes slowly.
  });
}

export function useTicketTagSuggestions() {
  return useQuery(ticketTagSuggestionsOptions());
}

/**
 * Ticket list (desk queues + inbox). Filters are deep-equal-compared by RQ so
 * toggling between the same filter set hits the cache. keepPreviousData keeps
 * the current list visible while a new filter is in flight — no flash to empty.
 *
 * Null vs undefined:
 * - `undefined` / omitted ⇒ no filter
 * - explicit `null` on an assignee field ⇒ "unassigned" (IS NULL on the server)
 */
// Server reads the literal `'null'` string to mean IS NULL on nullable filters.
// Pure helper — extracted from ticketListOptions so it's not part of queryFn's
// closure (otherwise @tanstack/query/exhaustive-deps flags a missing dep).
const nullable = (v: string | null | undefined): string | undefined =>
  v === null ? 'null' : (v ?? undefined);

export function ticketListOptions<TItem = TicketDetail>(filters: TicketListFilters) {
  return queryOptions({
    queryKey: ticketKeys.list(filters),
    queryFn: ({ signal }) =>
      apiFetch<TicketListResponse<TItem>>('/tickets', {
        signal,
        query: {
          // Default scope: top-level tickets only. Portal views that filter by
          // requester drop this constraint so users see their full history
          // (cases AND their work orders).
          parent_ticket_id: filters.requesterPersonId ? undefined : 'null',
          status_category: filters.status ?? undefined,
          priority: filters.priority ?? undefined,
          assigned_team_id: nullable(filters.assignedTeamId),
          assigned_user_id: nullable(filters.assignedUserId),
          assigned_vendor_id: nullable(filters.assignedVendorId),
          requester_person_id: filters.requesterPersonId ?? undefined,
          location_id: filters.locationId ?? undefined,
          sla_at_risk: filters.slaAtRisk ? 'true' : undefined,
          sla_breached: filters.slaBreached ? 'true' : undefined,
          search: filters.q ?? undefined,
          page: filters.page ?? undefined,
        },
      }),
    staleTime: 30_000, // T2
    placeholderData: keepPreviousData,
  });
}

export function useTicketList<TItem = TicketDetail>(filters: TicketListFilters) {
  return useQuery(ticketListOptions<TItem>(filters));
}

/**
 * Prefetch a ticket's detail + activity feed. Call from row hover/focus so
 * the detail view paints from cache when the user clicks.
 *
 * `staleTime` is set inside prefetchQuery so a hover on a row whose detail
 * is already fresh is a no-op — no request storm on mouse sweep.
 */
export function usePrefetchTicket() {
  const qc = useQueryClient();
  return (id: string) => {
    if (!id) return;
    qc.prefetchQuery({ ...ticketDetailOptions(id), staleTime: 30_000 });
    qc.prefetchQuery({ ...ticketActivitiesOptions(id), staleTime: 30_000 });
  };
}

/**
 * GET /work-orders/:id/can-plan — small query the FE uses to hide or
 * disable the plandate affordance without waiting for a 403. Returns
 * `{ canPlan: boolean }`. Companion to useSetWorkOrderPlan.
 *
 * Cache key is anchored on the ticket detail so a detail invalidation
 * also drops the canPlan answer (assignment changes can flip it).
 */
export function workOrderCanPlanOptions(id: string) {
  return queryOptions({
    queryKey: [...ticketKeys.detail(id), 'work-order-can-plan'] as const,
    queryFn: ({ signal }) =>
      apiFetch<{ canPlan: boolean }>(`/work-orders/${id}/can-plan`, { signal }),
    staleTime: 60_000,
    enabled: Boolean(id),
  });
}

export function useCanPlanWorkOrder(id: string) {
  return useQuery(workOrderCanPlanOptions(id));
}

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

/**
 * Sliced subscriptions to a ticket's individual fields. Sidebar pickers
 * (Status, Priority, Team, Assignee, Vendor, Tags, Watchers, Cost) read just
 * one field each — using `select` here lets RQ skip the picker's re-render
 * when an unrelated field changes (e.g. the activity feed appends, or
 * description is edited). Selectors are module-scope so they stay stable
 * across renders (anti-pattern §16: inline arrows defeat the optimization).
 *
 * Each hook returns just the slice + the standard isPending/error so the
 * caller can render unchanged.
 */
const selectStatusCategory = (t: TicketDetail) => t.status_category;
const selectStatus = (t: TicketDetail) => t.status;
const selectPriority = (t: TicketDetail) => t.priority;
const selectWaitingReason = (t: TicketDetail) => t.waiting_reason;
const selectAssignedTeam = (t: TicketDetail) => t.assigned_team ?? null;
const selectAssignedAgent = (t: TicketDetail) => t.assigned_agent ?? null;
const selectAssignedVendor = (t: TicketDetail) => t.assigned_vendor ?? null;
const selectTags = (t: TicketDetail) => t.tags;
const selectWatchers = (t: TicketDetail) => t.watchers ?? [];
const selectCost = (t: TicketDetail) => t.cost ?? null;
const selectSlaId = (t: TicketDetail) => t.sla_id;
const selectSlaDue = (t: TicketDetail) => ({
  due: t.sla_resolution_due_at,
  breached: t.sla_resolution_breached_at,
});
const selectInteractionMode = (t: TicketDetail) => t.interaction_mode;

export const useTicketStatusCategory = (id: string) =>
  useQuery({ ...ticketDetailOptions(id), select: selectStatusCategory });
export const useTicketStatus = (id: string) =>
  useQuery({ ...ticketDetailOptions(id), select: selectStatus });
export const useTicketPriority = (id: string) =>
  useQuery({ ...ticketDetailOptions(id), select: selectPriority });
export const useTicketWaitingReason = (id: string) =>
  useQuery({ ...ticketDetailOptions(id), select: selectWaitingReason });
export const useTicketAssignedTeam = (id: string) =>
  useQuery({ ...ticketDetailOptions(id), select: selectAssignedTeam });
export const useTicketAssignedAgent = (id: string) =>
  useQuery({ ...ticketDetailOptions(id), select: selectAssignedAgent });
export const useTicketAssignedVendor = (id: string) =>
  useQuery({ ...ticketDetailOptions(id), select: selectAssignedVendor });
export const useTicketTags = (id: string) =>
  useQuery({ ...ticketDetailOptions(id), select: selectTags });
export const useTicketWatchers = (id: string) =>
  useQuery({ ...ticketDetailOptions(id), select: selectWatchers });
export const useTicketCost = (id: string) =>
  useQuery({ ...ticketDetailOptions(id), select: selectCost });
export const useTicketSlaId = (id: string) =>
  useQuery({ ...ticketDetailOptions(id), select: selectSlaId });
export const useTicketSlaDue = (id: string) =>
  useQuery({ ...ticketDetailOptions(id), select: selectSlaDue });
export const useTicketInteractionMode = (id: string) =>
  useQuery({ ...ticketDetailOptions(id), select: selectInteractionMode });

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
 */
export function ticketListOptions<TItem = TicketDetail>(filters: TicketListFilters) {
  return queryOptions({
    queryKey: ticketKeys.list(filters),
    queryFn: ({ signal }) =>
      apiFetch<TicketListResponse<TItem>>('/tickets', {
        signal,
        query: {
          parent_ticket_id: filters.requesterPersonId ? undefined : 'null',
          status: filters.status ?? undefined,
          status_category: filters.statusCategory ?? undefined,
          priority: filters.priority ?? undefined,
          assigned_team_id: filters.assignedTeamId ?? undefined,
          assigned_user_id: filters.assignedUserId ?? undefined,
          assigned_vendor_id: filters.assignedVendorId ?? undefined,
          request_type_id: filters.requestTypeId ?? undefined,
          requester_person_id: filters.requesterPersonId ?? undefined,
          location_id: filters.locationId ?? undefined,
          search: filters.q ?? undefined,
          page: filters.page ?? undefined,
        },
      }),
    // T1 — multi-agent desk. Other agents change ticket status / assignment
    // all the time; 30s of staleness was confusing. 10s strikes a balance
    // with focus refetch picking up the rest. Realtime via Supabase channels
    // would let this go Infinity-with-pushed-patches; that's a separate
    // workstream.
    staleTime: 10_000,
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

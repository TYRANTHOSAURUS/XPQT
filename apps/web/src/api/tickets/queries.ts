import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { ticketKeys } from './keys';
import type { TicketActivity, TicketDetail } from './types';

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

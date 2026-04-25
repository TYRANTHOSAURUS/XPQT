import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export const reportKeys = {
  all: ['reports'] as const,
  overview: () => [...reportKeys.all, 'overview'] as const,
  slaPerformance: (days: number) => [...reportKeys.all, 'sla-performance', days] as const,
  byTeam: () => [...reportKeys.all, 'by-team'] as const,
} as const;

// Reports are aggregations — refetching every 60s is wasteful since the
// underlying data changes far slower than that and admins don't need
// minute-fresh dashboards. 5min keeps the cache warm across page nav while
// still picking up the day's activity.
const REPORTS_STALE = 5 * 60_000;

export function ticketsOverviewOptions<T = unknown>() {
  return queryOptions({
    queryKey: reportKeys.overview(),
    queryFn: ({ signal }) => apiFetch<T>('/reports/tickets/overview', { signal }),
    staleTime: REPORTS_STALE,
  });
}
export function useTicketsOverview<T = unknown>() {
  return useQuery(ticketsOverviewOptions<T>());
}

export function slaPerformanceOptions<T = unknown>(days: number) {
  return queryOptions({
    queryKey: reportKeys.slaPerformance(days),
    queryFn: ({ signal }) =>
      apiFetch<T>('/reports/sla/performance', { signal, query: { days } }),
    staleTime: REPORTS_STALE,
  });
}
export function useSlaPerformance<T = unknown>(days: number) {
  return useQuery(slaPerformanceOptions<T>(days));
}

export function ticketsByTeamOptions<T = unknown>() {
  return queryOptions({
    queryKey: reportKeys.byTeam(),
    queryFn: ({ signal }) => apiFetch<T>('/reports/tickets/by-team', { signal }),
    staleTime: REPORTS_STALE,
  });
}
export function useTicketsByTeam<T = unknown>() {
  return useQuery(ticketsByTeamOptions<T>());
}

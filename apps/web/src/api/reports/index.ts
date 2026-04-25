import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export const reportKeys = {
  all: ['reports'] as const,
  overview: () => [...reportKeys.all, 'overview'] as const,
  slaPerformance: (days: number) => [...reportKeys.all, 'sla-performance', days] as const,
  byTeam: () => [...reportKeys.all, 'by-team'] as const,
  byLocation: () => [...reportKeys.all, 'by-location'] as const,
  volume: (days: number) => [...reportKeys.all, 'volume', days] as const,
} as const;

export function ticketsOverviewOptions<T = unknown>() {
  return queryOptions({
    queryKey: reportKeys.overview(),
    queryFn: ({ signal }) => apiFetch<T>('/reports/tickets/overview', { signal }),
    staleTime: 60_000, // T2
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
    staleTime: 60_000,
  });
}
export function useSlaPerformance<T = unknown>(days: number) {
  return useQuery(slaPerformanceOptions<T>(days));
}

export function ticketsByTeamOptions<T = unknown>() {
  return queryOptions({
    queryKey: reportKeys.byTeam(),
    queryFn: ({ signal }) => apiFetch<T>('/reports/tickets/by-team', { signal }),
    staleTime: 60_000,
  });
}
export function useTicketsByTeam<T = unknown>() {
  return useQuery(ticketsByTeamOptions<T>());
}

export function ticketsByLocationOptions<T = unknown>() {
  return queryOptions({
    queryKey: reportKeys.byLocation(),
    queryFn: ({ signal }) => apiFetch<T>('/reports/tickets/by-location', { signal }),
    staleTime: 60_000,
  });
}
export function useTicketsByLocation<T = unknown>() {
  return useQuery(ticketsByLocationOptions<T>());
}

export interface TicketsVolumeResponse {
  created_by_day: Record<string, number>;
  resolved_by_day: Record<string, number>;
  period_days: number;
}

export function ticketsVolumeOptions(days: number) {
  return queryOptions({
    queryKey: reportKeys.volume(days),
    queryFn: ({ signal }) =>
      apiFetch<TicketsVolumeResponse>('/reports/tickets/volume', { signal, query: { days } }),
    staleTime: 60_000,
  });
}
export function useTicketsVolume(days: number) {
  return useQuery(ticketsVolumeOptions(days));
}

import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type {
  BookingsReportParams,
  BookingsOverviewResponse,
  UtilizationReportResponse,
  NoShowsReportResponse,
  ServicesReportResponse,
  DemandReportResponse,
} from './types';

export type {
  BookingsReportParams, BookingsOverviewParams,
  BookingsOverviewResponse, UtilizationReportResponse,
  NoShowsReportResponse, ServicesReportResponse, DemandReportResponse,
} from './types';

export const bookingReportKeys = {
  all: ['booking-reports'] as const,
  overview:    (p: BookingsReportParams) => [...bookingReportKeys.all, 'overview',    p] as const,
  utilization: (p: BookingsReportParams) => [...bookingReportKeys.all, 'utilization', p] as const,
  noShows:     (p: BookingsReportParams) => [...bookingReportKeys.all, 'no-shows',    p] as const,
  services:    (p: BookingsReportParams) => [...bookingReportKeys.all, 'services',    p] as const,
  demand:      (p: BookingsReportParams) => [...bookingReportKeys.all, 'demand',      p] as const,
} as const;

function makeReportOptions<T>(
  path: string,
  keyMaker: (p: BookingsReportParams) => readonly unknown[],
) {
  return (params: BookingsReportParams) => queryOptions({
    queryKey: keyMaker(params),
    queryFn: ({ signal }) =>
      apiFetch<T>(path, {
        signal,
        query: {
          from: params.from,
          to: params.to,
          building_id: params.building_id ?? null,
          tz: params.tz,
        },
      }),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}

export const bookingsOverviewOptions    = makeReportOptions<BookingsOverviewResponse>('/reports/bookings/overview',    bookingReportKeys.overview);
export const bookingsUtilizationOptions = makeReportOptions<UtilizationReportResponse>('/reports/bookings/utilization', bookingReportKeys.utilization);
export const bookingsNoShowsOptions     = makeReportOptions<NoShowsReportResponse>('/reports/bookings/no-shows',       bookingReportKeys.noShows);
export const bookingsServicesOptions    = makeReportOptions<ServicesReportResponse>('/reports/bookings/services',      bookingReportKeys.services);
export const bookingsDemandOptions      = makeReportOptions<DemandReportResponse>('/reports/bookings/demand',          bookingReportKeys.demand);

export const useBookingsOverview    = (p: BookingsReportParams) => useQuery(bookingsOverviewOptions(p));
export const useBookingsUtilization = (p: BookingsReportParams) => useQuery(bookingsUtilizationOptions(p));
export const useBookingsNoShows     = (p: BookingsReportParams) => useQuery(bookingsNoShowsOptions(p));
export const useBookingsServices    = (p: BookingsReportParams) => useQuery(bookingsServicesOptions(p));
export const useBookingsDemand      = (p: BookingsReportParams) => useQuery(bookingsDemandOptions(p));

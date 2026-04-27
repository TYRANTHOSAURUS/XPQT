import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type { BookingsOverviewParams, BookingsOverviewResponse } from './types';

export type { BookingsOverviewParams, BookingsOverviewResponse } from './types';

export const bookingReportKeys = {
  all: ['booking-reports'] as const,
  overview: (params: BookingsOverviewParams) =>
    [...bookingReportKeys.all, 'overview', params] as const,
} as const;

export function bookingsOverviewOptions(params: BookingsOverviewParams) {
  return queryOptions({
    queryKey: bookingReportKeys.overview(params),
    queryFn: ({ signal }) =>
      apiFetch<BookingsOverviewResponse>('/reports/bookings/overview', {
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

export function useBookingsOverview(params: BookingsOverviewParams) {
  return useQuery(bookingsOverviewOptions(params));
}

import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { bundleKeys } from './keys';
import type { BookingBundle } from './types';

export function bundleDetailOptions(id: string) {
  return queryOptions({
    queryKey: bundleKeys.detail(id),
    queryFn: ({ signal }) => apiFetch<BookingBundle>(`/booking-bundles/${id}`, { signal }),
    staleTime: 30_000,
    enabled: Boolean(id),
  });
}

export function useBundle(id: string) {
  return useQuery(bundleDetailOptions(id));
}

// Lists land in slice 2E.

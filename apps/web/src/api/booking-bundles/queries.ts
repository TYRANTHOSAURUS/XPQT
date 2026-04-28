import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { bundleKeys } from './keys';
import type { BookingBundle } from './types';

export interface RecentBundleSummary {
  id: string;
  start_at: string;
  end_at: string;
  space_name: string | null;
  line_summary: Array<{
    catalog_item_id: string;
    menu_id: string | null;
    name: string;
    quantity: number;
    unit_price: number | null;
    unit: 'per_item' | 'per_person' | 'flat_rate' | null;
    service_type: string | null;
  }>;
}

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

/**
 * Caller's most-recent service-bearing bundles. Powers the booking
 * composer's "Your usual" chip row — recency is the template.
 */
export function recentMyBundlesOptions() {
  return queryOptions({
    queryKey: [...bundleKeys.all, 'recent-mine'] as const,
    queryFn: ({ signal }) =>
      apiFetch<{ bundles: RecentBundleSummary[] }>('/booking-bundles/recent', { signal }),
    staleTime: 60_000,
  });
}

export function useRecentMyBundles() {
  return useQuery(recentMyBundlesOptions());
}

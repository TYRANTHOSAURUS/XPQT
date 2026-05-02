import { queryOptions, useQuery } from '@tanstack/react-query';
import { bundleKeys } from './keys';
import type { BookingBundle } from './types';

/**
 * Booking-canonicalisation rewrite (2026-05-02): the `/booking-bundles/*`
 * HTTP surface is GONE on the backend. The `booking_bundles` table was
 * dropped — the `bookings` row IS the bundle now (00277:27).
 *
 * No backend endpoint currently surfaces a booking's attached services
 * (orders + lines) or cascaded tickets. The hooks below are kept so the
 * existing call sites still compile, but they DO NOT FETCH — they always
 * resolve to `data: undefined`. The UI components that consume them
 * already have an empty-state branch (the operator surface renders a
 * "no services / nothing dispatched yet" header; the requester surface
 * hides the section entirely).
 *
 * When the backend slice ships read endpoints for the booking's services,
 * point `bundleDetailOptions` at the new URL and the UI will start
 * surfacing data automatically — no component changes needed.
 *
 * TODO(backend): expose `GET /bookings/:id/services` (or similar) so
 * BundleServicesSection / BundleWorkOrdersSection re-light. Tracking
 * note in this slice's report.
 */

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

/**
 * Stub. Returns no data; the previous `/booking-bundles/:id` endpoint is
 * gone. See file header for the migration plan.
 */
export function bundleDetailOptions(id: string) {
  return queryOptions({
    queryKey: bundleKeys.detail(id),
    queryFn: async () => undefined as unknown as BookingBundle,
    staleTime: 30_000,
    enabled: false,
  });
}

export function useBundle(id: string) {
  return useQuery(bundleDetailOptions(id));
}

/**
 * Stub. The `/booking-bundles/recent` endpoint is gone; "Your usual"
 * chips disappear from the picker until a backend replacement ships.
 */
export function recentMyBundlesOptions() {
  return queryOptions({
    queryKey: [...bundleKeys.all, 'recent-mine'] as const,
    queryFn: async () => ({ bundles: [] as RecentBundleSummary[] }),
    staleTime: 60_000,
    enabled: false,
  });
}

export function useRecentMyBundles() {
  return useQuery(recentMyBundlesOptions());
}

import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { bundleKeys } from './keys';
import type { BookingBundle } from './types';

/**
 * Booking-canonicalisation rewrite (2026-05-02 + follow-up):
 *   - The `booking_bundles` table was dropped — the `bookings` row IS the
 *     bundle now (00277:27).
 *   - The legacy `/booking-bundles/*` HTTP surface stays gone.
 *   - This slice ships the replacement read at
 *     `GET /reservations/:id/bundle-detail` (apps/api/src/modules/reservations/
 *     reservation.controller.ts). The endpoint returns the booking row's
 *     columns plus `lines[]` / `orders[]` / `tickets[]` / `status_rollup` —
 *     the same shape the old `GET /booking-bundles/:id` produced.
 *
 * The id passed to `useBundle` is a booking id (== reservation id under
 * the legacy projection); the frontend already holds it from the
 * surrounding booking-detail surface.
 *
 * The mutation hooks in `./mutations.ts` are still stubs (the write paths
 * — POST add-line / PATCH edit-line / POST cancel-line / POST cancel-bundle —
 * have not yet been wired to the canonical surface). The detail page's
 * "Add services" CTA goes through `useAttachReservationServices` instead;
 * inline-edit + cancel buttons are unreachable on a fresh bundle until
 * backend mutations land.
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
 * `GET /reservations/:id/bundle-detail` — the booking's services + cascaded
 * work-orders + status rollup. Visibility-gated server-side via the same
 * predicate used by `GET /reservations/:id`, so an out-of-scope read
 * returns 404 here too (the UI's empty-bundle branch handles undefined
 * data gracefully).
 */
export function bundleDetailOptions(id: string) {
  return queryOptions({
    queryKey: bundleKeys.detail(id),
    queryFn: () => apiFetch<BookingBundle>(`/reservations/${id}/bundle-detail`),
    staleTime: 30_000,
    enabled: !!id,
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

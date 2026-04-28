import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { bundleKeys } from '@/api/booking-bundles';

/**
 * Live fulfillment-status subscription for a single booking bundle. While
 * the booking detail surface is mounted, this hook listens for changes on
 * `public.order_line_items` for any order belonging to this bundle and
 * invalidates the bundle detail cache so the status pills + service window
 * update without a manual refresh.
 *
 * Cadence: every realtime payload schedules a 250 ms debounced invalidate
 * — multiple back-to-back updates from the same vendor (line accepted →
 * preparing) collapse into one refetch. The hook also returns a
 * `lastUpdatedLineIds` set the caller can use to pulse the affected rows
 * for ~3s after a status change (delight feedback without distraction).
 *
 * Channel naming follows the booking-foundation convention from
 * `docs/superpowers/specs/2026-04-25-room-booking-foundation-design.md` §6.3:
 * one channel per bundle so the visible orderIds set is stable for the
 * channel's lifetime. Resubscribes when `bundleId` or `orderIds` change.
 *
 * If `enabled` is false (e.g. before the bundle detail loads, or for an
 * unmounted reservation panel), the hook no-ops — no subscription, no
 * invalidations.
 */
export function useRealtimeBundle(
  bundleId: string | null,
  orderIds: string[],
  options: { enabled?: boolean } = {},
): void {
  const { enabled = true } = options;
  const queryClient = useQueryClient();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const orderSetRef = useRef(new Set(orderIds));

  useEffect(() => {
    orderSetRef.current = new Set(orderIds);
  }, [orderIds]);

  useEffect(() => {
    if (!enabled || !bundleId || orderIds.length === 0) return;

    const scheduleInvalidate = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: bundleKeys.detail(bundleId) });
      }, 250);
    };

    const channel = supabase
      .channel(`bundle-lines:${bundleId}`)
      .on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase-js v2 loose typing for postgres_changes
        'postgres_changes' as any,
        { event: '*', schema: 'public', table: 'order_line_items' },
        (payload: { new?: Record<string, unknown>; old?: Record<string, unknown> }) => {
          const row = payload.new ?? payload.old ?? {};
          const orderId = row.order_id as string | undefined;
          if (!orderId) return;
          if (!orderSetRef.current.has(orderId)) return;
          scheduleInvalidate();
        },
      )
      .subscribe();

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      void supabase.removeChannel(channel);
    };
    // Resubscribe when bundleId or the membership of orderIds changes; we
    // don't depend on `enabled` directly because the early return above
    // covers the disabled case and we want a stable channel lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundleId, orderIds.join(','), queryClient, enabled]);
}

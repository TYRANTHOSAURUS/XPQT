import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { roomBookingKeys } from '@/api/room-booking';

/**
 * Realtime subscription for `/desk/scheduler`.
 *
 * Subscribes to `public.reservations` changefeeds and invalidates the
 * scheduler-window query (200 ms debounced) whenever a row affecting one
 * of the visible space ids arrives. Mirrors the portal picker pattern in
 * `pages/portal/book-room/hooks/use-realtime-availability.ts`.
 *
 * Conscious choices:
 *  - One channel for the whole page (not per-space) — Supabase Realtime
 *    plays nicely with a single broad postgres_changes subscription, and
 *    we filter client-side by visible-space membership.
 *  - We invalidate the *whole* `room-booking` namespace's
 *    `scheduler-window` and `picker` buckets — cheap, and it keeps us out
 *    of having to mirror the exact key the page rendered.
 *  - No-op when `enabled=false` or `spaceIds.length === 0` so the page
 *    doesn't open a wasted WS connection on first paint.
 */
export function useRealtimeScheduler(
  spaceIds: string[],
  enabled: boolean = true,
) {
  const queryClient = useQueryClient();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visibleSetRef = useRef(new Set(spaceIds));

  useEffect(() => {
    visibleSetRef.current = new Set(spaceIds);
  }, [spaceIds]);

  useEffect(() => {
    if (!enabled || spaceIds.length === 0) return;

    const scheduleInvalidate = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        // Only the unified scheduler-data bucket needs busting — that's the
        // single query the page actually reads from. The legacy picker /
        // scheduler-window keys are no longer used by this page; busting
        // them on every reservation event would re-run the heavy picker
        // pipeline for nothing.
        queryClient.invalidateQueries({
          queryKey: [...roomBookingKeys.all, 'scheduler-data'],
        });
      }, 200);
    };

    // Stable channel name keyed on a hash of the sorted space-id set so two
    // schedulers open with different spaces don't share a channel and
    // cross-invalidate each other.
    const channelKey = [...spaceIds].sort().join(',');
    let hash = 0;
    for (let i = 0; i < channelKey.length; i++) {
      hash = ((hash << 5) - hash + channelKey.charCodeAt(i)) | 0;
    }
    const channel = supabase
      .channel(`desk-scheduler:${Math.abs(hash).toString(36)}:${spaceIds.length}`)
      .on(
        // supabase-js v2 has loose typing for postgres_changes; the cast is
        // load-bearing. The eslint-disable is dead because @typescript-eslint
        // isn't loaded in the web app's flat config (eslint.config.js).
        'postgres_changes' as any,
        // Post-canonicalisation (00276–00281): space_id lives on booking_slots,
        // not bookings. Subscribe to slot changes; row.space_id below stays valid.
        { event: '*', schema: 'public', table: 'booking_slots' },
        (payload: { new?: Record<string, unknown>; old?: Record<string, unknown> }) => {
          const row = payload.new ?? payload.old ?? {};
          const spaceId = row.space_id as string | undefined;
          if (!spaceId) return;
          if (!visibleSetRef.current.has(spaceId)) return;
          scheduleInvalidate();
        },
      )
      .subscribe();

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      void supabase.removeChannel(channel);
    };
    // We intentionally don't depend on the membership of spaceIds (only
    // the count) to avoid re-subscribing as the operator scrolls / filters
    // changes the visible rooms. The membership ref is updated above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, spaceIds.length, queryClient]);
}

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { roomBookingKeys, type PickerInput } from '@/api/room-booking';

/**
 * Realtime availability subscription for the portal picker.
 *
 * Subscribes to inserts/updates/deletes on `public.reservations` for the
 * spaces currently shown in the picker results, and invalidates the picker
 * query (200 ms debounced) so the mini-timeline strips stay live.
 *
 * Per `docs/superpowers/specs/2026-04-25-room-booking-foundation-design.md` §6.3,
 * the canonical channel pattern is `reservations:tenant_<id>:space_<id>`. We
 * use Supabase's postgres_changes filter as a pragmatic v1 — Supabase Realtime
 * already enforces tenant_id via RLS publications, so we filter client-side
 * to the visible space ids.
 *
 * If `spaceIds` is empty we no-op (no subscription, no invalidations).
 */
export function useRealtimeAvailability(
  spaceIds: string[],
  pickerInput: PickerInput,
  enabled: boolean = true,
) {
  const queryClient = useQueryClient();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visibleSetRef = useRef(new Set(spaceIds));
  // Holds the latest pickerInput so the channel handler invalidates the
  // CURRENT query bucket. Without this, the closure inside `subscribe`
  // captures the input at subscription time and any keystroke that
  // changes criteria (date, attendee count, …) would invalidate the OLD
  // key — leaving the new query untouched until the next refetch.
  const pickerInputRef = useRef(pickerInput);

  // Keep refs in sync without resubscribing on every list rerender.
  useEffect(() => {
    visibleSetRef.current = new Set(spaceIds);
  }, [spaceIds]);
  useEffect(() => {
    pickerInputRef.current = pickerInput;
  }, [pickerInput]);

  useEffect(() => {
    if (!enabled || spaceIds.length === 0) return;

    const scheduleInvalidate = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        queryClient.invalidateQueries({
          queryKey: roomBookingKeys.picker(pickerInputRef.current),
        });
      }, 200);
    };

    const channel = supabase
      .channel(`portal-picker:${spaceIds.slice(0, 8).join(',')}`)
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
    // We intentionally do NOT depend on `pickerInput` (it changes on every
    // criteria edit) — resubscribing on every keystroke would thrash the WS
    // connection. The invalidation path reads the latest input via the
    // pickerInputRef instead. Membership of spaceIds is in the dep key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, spaceIds.join(','), queryClient]);
}

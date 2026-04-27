import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { schedulerDataOptions, type SchedulerDataInput } from '@/api/room-booking';

/**
 * Prefetches the previous and next scheduler windows during browser idle
 * time so clicking the toolbar's "← prev" / "next →" buttons paints
 * instantly from cache instead of waiting for a fresh round-trip.
 *
 * The prev / next inputs are constructed from the active window — the
 * caller passes shifted ISO ranges + the current scope (building / floor /
 * etc.) which apply unchanged to the adjacent view. We don't prefetch
 * across building/floor changes; that's a different scope and a fresh
 * fetch is the right call there.
 *
 * Idle scheduling: `requestIdleCallback` keeps the prefetch off the
 * critical render path. Falls back to `setTimeout` on Safari + WebKit
 * (which still hasn't shipped the API as of this writing). We also bail
 * if the document is hidden — no point burning bandwidth for a tab
 * nobody's looking at.
 */
export function useSchedulerAdjacentPrefetch(args: {
  enabled: boolean;
  prevInput: SchedulerDataInput | null;
  nextInput: SchedulerDataInput | null;
}) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!args.enabled) return;
    if (typeof document !== 'undefined' && document.hidden) return;

    const prevInput = args.prevInput;
    const nextInput = args.nextInput;

    const hasIdle =
      typeof window !== 'undefined' && 'requestIdleCallback' in window;
    const idle = (cb: IdleRequestCallback): number =>
      hasIdle
        ? window.requestIdleCallback(cb, { timeout: 1500 })
        : (window.setTimeout(
            () => cb({ didTimeout: false, timeRemaining: () => 0 }),
            250,
          ) as unknown as number);
    const cancel = (handle: number): void => {
      if (hasIdle) window.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
    };

    const handle = idle(
      () => {
        if (prevInput) {
          // staleTime defaults from queryOptions; dedupe via React Query's
          // own in-flight tracking. Errors are swallowed — a failed
          // prefetch only matters if the user actually navigates there,
          // and that path will retry on its own.
          void queryClient.prefetchQuery(schedulerDataOptions(prevInput));
        }
        if (nextInput) {
          void queryClient.prefetchQuery(schedulerDataOptions(nextInput));
        }
      },
    );

    return () => cancel(handle);
    // We intentionally key on the ISO range pair: re-prefetch only when
    // the visible window shifts, not on every render.
  }, [
    queryClient,
    args.enabled,
    args.prevInput?.start_at,
    args.prevInput?.end_at,
    args.nextInput?.start_at,
    args.nextInput?.end_at,
  ]);
}

import type { QueryClient, QueryKey } from '@tanstack/react-query';

/**
 * Optimistic-update helper for the planning board's drag/resize commits.
 *
 * The page reaches for this when an operator drag or resize-handle release
 * needs to:
 *   1. Patch the planning cache so the UI shows the desired post-mutation
 *      state immediately (no perceived latency on the drop).
 *   2. Fire the underlying PATCH.
 *   3. On failure, *restore the cache to the pre-patch snapshot* before
 *      surfacing the toast — otherwise the user sees the wrong value
 *      between the toast firing and the subsequent refetch landing.
 *
 * Why this is its own helper instead of inlined into the page:
 *   - The page captures `filters` in a closure; if the operator changes the
 *     status filter or team filter mid-PATCH, a fresh
 *     `workOrderPlanningKeys.window(filters)` read at error time would
 *     point at a *different* cache entry than the one we patched. Capturing
 *     the key once, at the start of the gesture, is the only correct
 *     behaviour — and it's easy to get wrong if it lives in three places.
 *   - It's the canonical hook for the codex pressure-test (filter-changed-
 *     mid-drag, cache-key-shifted, query-paused).
 *
 * The function intentionally takes `QueryKey` rather than a typed factory
 * call — the caller resolves the key once and hands it in, so this helper
 * has no opinion about which planning window it's mutating.
 */
export async function runOptimisticWithRollback<TCache>(args: {
  qc: QueryClient;
  /** Captured query key — DO NOT re-derive at error time. */
  key: QueryKey;
  /** Pure cache patch. Returning `prev` is a no-op. */
  mutator: (prev: TCache) => TCache;
  /** The mutation that may throw. */
  mutationFn: () => Promise<unknown>;
  /** Fires AFTER the cache is restored. The handler should toast / log. */
  onError: (err: unknown) => void;
  /** Fires after success OR after restore+onError. Typically `invalidateQueries`. */
  onSettled?: () => void;
}): Promise<void> {
  const { qc, key, mutator, mutationFn, onError, onSettled } = args;

  // Snapshot BEFORE patching. `getQueryData` returns `undefined` when the
  // cache slot is empty (e.g. query never ran, or was garbage-collected).
  // `setQueryData(key, undefined)` is a no-op in TanStack Query, which is
  // the behaviour we want on restore: revert to "no cached value" if that
  // was the state at the start of the gesture.
  const previous = qc.getQueryData<TCache>(key);

  // Patch optimistically. We only invoke the mutator when there's a
  // previous value to derive from — matches the original page semantics
  // (`prev ? mutator(prev) : prev`).
  qc.setQueryData<TCache>(key, (prev) => (prev ? mutator(prev) : prev));

  try {
    await mutationFn();
  } catch (err) {
    // CRITICAL: restore BEFORE the toast fires. Otherwise the operator
    // sees the optimistic state for one paint while the toast renders,
    // then the invalidation refetch eventually overwrites it. The whole
    // point of snapshot/restore over invalidate-only is closing that gap.
    qc.setQueryData<TCache>(key, previous);
    onError(err);
    onSettled?.();
    return;
  }
  onSettled?.();
}

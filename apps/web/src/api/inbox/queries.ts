/**
 * Read-side hooks for the `/me/inbox` surface.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step F.
 *
 * Three hooks:
 *
 *   - `useInbox({ limit })` — paginated list. The bell-popover passes
 *     `{ limit: 5 }` to render the latest five rows; the full page uses
 *     `useInboxInfinite()` to wire the cursor scroller.
 *
 *   - `useInboxInfinite({ limit })` — `useInfiniteQuery` variant. The page
 *     primary; throws page-class errors via `usePageQuery`-equivalent
 *     classification path. The infinite-query analogue (`usePageQuery` is
 *     non-infinite by design) is implemented here as a thin throwToBoundary
 *     wrapper because the spec mandates page-replacement on page-class
 *     errors.
 *
 *   - `useInboxCount()` — `{ unread, total }` for the bell badge. Tighter
 *     polling (refetch on focus + 30s staleTime) so the badge stays fresh
 *     even when Realtime is broken (defense in depth).
 */

import { useEffect } from 'react';
import {
  queryOptions,
  useInfiniteQuery,
  useQuery,
  type InfiniteData,
} from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { classify, throwToBoundary } from '@/lib/errors';
import { inboxKeys, type InboxListArgs } from './keys';
import {
  INBOX_DEFAULT_LIMIT,
  type InboxCountResponse,
  type InboxListResponse,
} from './types';

/* ── List (single page) ──────────────────────────────────────────────── */

/**
 * Single-page list options — used by the bell-popover with `{ limit: 5 }`.
 * For the full page use `useInboxInfinite` instead.
 */
export function inboxListOptions(args: InboxListArgs = {}) {
  const limit = args.limit ?? INBOX_DEFAULT_LIMIT;
  return queryOptions({
    queryKey: inboxKeys.list(args),
    queryFn: ({ signal }) =>
      apiFetch<InboxListResponse>('/me/inbox', { signal, query: { limit } }),
    // 30s cache — Realtime invalidates on INSERT, focus refetch covers
    // the case where the WS dropped silently.
    staleTime: 30_000,
  });
}

export function useInbox(args: InboxListArgs = {}) {
  return useQuery(inboxListOptions(args));
}

/* ── List (infinite) ─────────────────────────────────────────────────── */

const PAGE_CLASSES = new Set(['not_found', 'permission', 'server', 'unknown']);

/**
 * Infinite-query variant for the full inbox page. `useInfiniteQuery` does
 * not pair with `usePageQuery` (the latter wraps `useQuery`), so the
 * page-class throw-to-boundary contract is implemented inline here.
 *
 * Cursor protocol: server returns `nextCursor: string | null`. We pass it
 * back as the `cursor` query-string param on the next page. `null` =
 * terminal page.
 */
export function useInboxInfinite(args: InboxListArgs = {}) {
  const limit = args.limit ?? INBOX_DEFAULT_LIMIT;
  const result = useInfiniteQuery<
    InboxListResponse,
    unknown,
    InfiniteData<InboxListResponse>,
    ReturnType<typeof inboxKeys.list>,
    string | null
  >({
    queryKey: inboxKeys.list(args),
    initialPageParam: null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    queryFn: ({ signal, pageParam }) =>
      apiFetch<InboxListResponse>('/me/inbox', {
        signal,
        query: {
          limit,
          cursor: pageParam ?? undefined,
        },
      }),
    staleTime: 30_000,
  });

  // Mirror usePageQuery — throw page-class errors to RouteErrorBoundary so
  // the page replaces instead of toasting over a broken list.
  useEffect(() => {
    if (!result.isError) return;
    const classified = classify(result.error, { callSite: 'route_load' });
    if (PAGE_CLASSES.has(classified.class)) {
      throwToBoundary(result.error);
    }
  }, [result.isError, result.error]);

  return result;
}

/* ── Count ───────────────────────────────────────────────────────────── */

export function inboxCountOptions() {
  return queryOptions({
    queryKey: inboxKeys.count(),
    queryFn: ({ signal }) => apiFetch<InboxCountResponse>('/me/inbox/count', { signal }),
    // 30s — same cadence as the list. Realtime read-flip UPDATE bumps it.
    staleTime: 30_000,
  });
}

export function useInboxCount() {
  return useQuery(inboxCountOptions());
}

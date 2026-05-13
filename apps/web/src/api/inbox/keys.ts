/**
 * Query-key factory for the per-user inbox notification feed.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step F. Per `docs/react-query-guidelines.md`
 * §3 every inbox query is keyed through this factory — never inline.
 *
 * Hierarchy:
 *   all                      → ['inbox']
 *     ├─ lists()             → ['inbox', 'list']
 *     │    └─ list(args)     → ['inbox', 'list', { limit }]
 *     ├─ count()             → ['inbox', 'count']
 *     └─ details()           → ['inbox', 'detail']
 *          └─ detail(id)     → ['inbox', 'detail', id]
 *
 * The Realtime subscription (`apps/web/src/lib/realtime/inbox-subscription.ts`)
 * invalidates `inboxKeys.all` on INSERT and `inboxKeys.count()` on read-flip
 * UPDATE. The bell-popover (`limit: 5`) and the full page (infinite, default
 * limit 20) live under different `list(args)` buckets so they refetch
 * independently — but a top-level `inboxKeys.all` invalidation busts both.
 */

/** Args for the paginated list query — only the page size is part of the key. */
export interface InboxListArgs {
  /** Items per page. Server caps at 100. */
  limit?: number;
}

export const inboxKeys = {
  all: ['inbox'] as const,

  lists: () => [...inboxKeys.all, 'list'] as const,
  /**
   * One bucket per `limit` value. Cursor pagination merges into the same
   * bucket via `useInfiniteQuery`; the cursor is NOT in the key (per
   * TanStack v5 infinite-query convention).
   */
  list: (args: InboxListArgs = {}) => [...inboxKeys.lists(), args] as const,

  count: () => [...inboxKeys.all, 'count'] as const,

  details: () => [...inboxKeys.all, 'detail'] as const,
  detail: (id: string) => [...inboxKeys.details(), id] as const,
} as const;

/**
 * Inbox Realtime subscription hook.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step F. Mounts a per-(tenant, user)
 * Supabase Realtime channel that listens for changes to
 * `public.inbox_notifications` and invalidates the React Query cache so
 * the bell badge + popover + full page paint within ~250ms of an INSERT
 * (the outbox dispatcher's enqueue path).
 *
 * Design choices:
 *
 *   - **Channel naming.** `inbox:tenant_<id>:user_<id>` is purely a
 *     client-side routing key — RLS already gates row visibility on the
 *     server (00391 lines 79-99). The per-user channel keeps two desk
 *     operators on the same tenant from cross-invalidating each other.
 *
 *   - **INSERT vs UPDATE handling.** A new row (INSERT) needs both the list
 *     and the count to refresh, so we bust `inboxKeys.all`. A read-flip
 *     (UPDATE on read_at) only changes the unread count — the row's
 *     content is unchanged — so we narrow the invalidation to
 *     `inboxKeys.count()` to avoid re-rendering the full list every time
 *     the user clicks a row.
 *
 *   - **DELETE.** Treated like INSERT — bust `inboxKeys.all`. Today nothing
 *     deletes inbox rows in v1; future retention prune will. Cheap to
 *     handle now.
 *
 *   - **Filter.** Supabase Realtime accepts a comma-separated list of
 *     equality predicates that act as a logical AND, so we scope by BOTH
 *     `tenant_id=eq.<id>` AND `user_id=eq.<id>` at the broadcast layer.
 *     Without the `user_id` predicate every tenant member's WS would
 *     receive every other member's inbox payload (`booking_id`,
 *     `chain_id`, `approver_person_id`) — a tenant-internal user-data
 *     leak. RLS still gates row visibility on the server; the explicit
 *     filter is the narrow-broadcast layer of the same fence.
 *
 *   - **Disabled when ids missing.** Pre-login (auth context still
 *     resolving) the hook no-ops. Re-mounts when tenantId / userId become
 *     available (sign-in flow).
 *
 * Callers: mounted once per app shell — see desk-layout / admin-layout /
 * portal-layout. Mounting it in multiple shells is harmless because each
 * mount opens a separate channel keyed identically; supabase-js de-dupes
 * on channel name, but the safe default is to mount once per shell, the
 * pages that use it cover non-overlapping URL ranges.
 */

import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { toastSuccess } from '@/lib/toast';
import { inboxKeys } from '@/api/inbox';

export interface InboxSubscriptionArgs {
  tenantId: string | null | undefined;
  userId: string | null | undefined;
}

/**
 * Build the channel name for a (tenant, user) pair. Exported so tests can
 * assert the shape without re-implementing the rule.
 */
export function inboxChannelName(tenantId: string, userId: string): string {
  return `inbox:tenant_${tenantId}:user_${userId}`;
}

type RealtimePayload = {
  eventType?: 'INSERT' | 'UPDATE' | 'DELETE';
  new?: Record<string, unknown>;
  old?: Record<string, unknown>;
};

/**
 * Pure dispatch function — exported so the subscription tests can call it
 * directly without a live channel. Routes the payload to the right
 * invalidation + toast.
 */
export function handleInboxRealtimePayload(
  payload: RealtimePayload,
  queryClient: QueryClient,
  options: { onPath?: string; toast?: (title: string) => void } = {},
): void {
  const eventType = payload.eventType ?? 'INSERT';
  const onInboxPage = options.onPath?.startsWith('/me/inbox') ?? false;
  const toast = options.toast ?? ((title: string) => toastSuccess(title));

  if (eventType === 'UPDATE') {
    // Read-flip — count changed, list content didn't.
    void queryClient.invalidateQueries({ queryKey: inboxKeys.count() });
    return;
  }

  // INSERT or DELETE — bust the whole namespace.
  void queryClient.invalidateQueries({ queryKey: inboxKeys.all });

  if (eventType === 'INSERT' && !onInboxPage) {
    // Avoid double-signalling on the inbox page itself — the new row
    // arrives in-list, the user is already looking at the feed.
    toast('New notification');
  }
}

/**
 * Mount the inbox Realtime subscription for the current actor. Pass
 * `tenantId` + `userId` from the auth provider (`appUser.tenant_id`,
 * `appUser.id`). When either is null/undefined the hook no-ops and tears
 * down any prior channel.
 */
export function useInboxSubscription({ tenantId, userId }: InboxSubscriptionArgs): void {
  const queryClient = useQueryClient();
  const location = useLocation();
  // Hold the latest pathname in a ref so the channel callback (created once
  // per tenant/user pair) always sees the current route — without that, a
  // route change wouldn't tear down the channel but the closure-captured
  // pathname would be stale and we'd toast on the inbox page.
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;

  useEffect(() => {
    if (!tenantId || !userId) return;

    const channel = supabase
      .channel(inboxChannelName(tenantId, userId))
      .on(
        // supabase-js v2 has loose typing for postgres_changes; the cast
        // mirrors the convention used by use-realtime-scheduler.ts:67.
        'postgres_changes' as any,
        {
          event: '*',
          schema: 'public',
          table: 'inbox_notifications',
          filter: `tenant_id=eq.${tenantId},user_id=eq.${userId}`,
        },
        (payload: RealtimePayload & { new?: { user_id?: string } }) => {
          // Filter scopes BOTH by tenant_id AND user_id to prevent
          // cross-user leakage at the broadcast layer; the post-receive
          // user_id check below is defense-in-depth in case Realtime ever
          // changes its filter semantics.
          const row = payload.new ?? payload.old ?? {};
          const rowUserId = (row as { user_id?: string }).user_id;
          if (rowUserId && rowUserId !== userId) return;
          handleInboxRealtimePayload(payload, queryClient, {
            onPath: pathRef.current,
          });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [tenantId, userId, queryClient]);
}

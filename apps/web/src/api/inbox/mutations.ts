/**
 * Write-side hooks for the `/me/inbox` surface.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step F.
 *
 * Two hooks:
 *
 *   - `useMarkInboxRead` — flip a single row to `read_at = now()`. Idempotent
 *     server-side; the response echoes the existing `readAt` on re-mark so
 *     client cache stays stable across retries.
 *
 *   - `useMarkAllInboxRead` — bulk flip every unread row for the actor.
 *     Server returns `{ marked: number }`; `marked === 0` is a valid
 *     response (everything was already read).
 *
 * Both hooks invalidate `inboxKeys.all` on settle so the list + count buckets
 * refresh together. The list optimistic update is intentionally NOT wired
 * here — Realtime will paint the read state within ~250ms (the channel
 * subscription invalidates on the read_at UPDATE), and avoiding optimistic
 * update keeps the cache one-sourced (server). Re-evaluate if the visible
 * latency complaint surfaces.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { withErrorHandling } from '@/lib/errors';
import { inboxKeys } from './keys';
import type { InboxMarkAllReadResponse, InboxMarkReadResponse } from './types';

export function useMarkInboxRead() {
  const queryClient = useQueryClient();
  return useMutation<InboxMarkReadResponse, Error, string>({
    mutationFn: (id) =>
      apiFetch<InboxMarkReadResponse>(`/me/inbox/${id}/read`, { method: 'POST' }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.all });
    },
    ...withErrorHandling({ actionTitle: "Couldn't mark notification as read" }),
  });
}

export function useMarkAllInboxRead() {
  const queryClient = useQueryClient();
  return useMutation<InboxMarkAllReadResponse, Error, void>({
    mutationFn: () =>
      apiFetch<InboxMarkAllReadResponse>('/me/inbox/read-all', { method: 'POST' }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.all });
    },
    ...withErrorHandling({ actionTitle: "Couldn't mark notifications as read" }),
  });
}

/**
 * Write-side hooks for the `/admin/notification-templates` admin surface.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step G.
 *
 * One mutation:
 *
 *   - `useUpsertNotificationTemplate(eventKind)` — PUT to the per-event
 *     endpoint with `{ locale, subject_override?, cta_text_override?,
 *     body_intro_override? }`. Used by the auto-save flow: each per-field
 *     debounced save calls `mutate({ locale, [field]: nextValue })` —
 *     other fields stay unchanged on the server because the upsert layers
 *     onto the existing row (the missing keys keep their prior DB values
 *     thanks to the supabase-js `.upsert(..., { onConflict })` semantics
 *     when only the changed column is supplied via `.update()` chain... NO
 *     — that's wrong for upsert. The body MUST include every field the
 *     admin wants to retain; the service-layer normalizes empty strings
 *     to null, but explicit null clears the override.
 *
 *     Practical consequence for the caller: when changing one field, send
 *     ALL THREE fields in the body so the unchanged ones aren't wiped to
 *     null. The admin UI's auto-save closure captures the latest snapshot
 *     of all three fields per locale tab and resends them together.
 *
 * Cache invalidation: invalidates the tenant-wide list + the per-event
 * detail bucket on settle so both the index page and the editor's "live"
 * copy refresh.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { withErrorHandling } from '@/lib/errors';
import { notificationTemplateKeys } from './keys';
import type { TemplateOverrideRow, TemplateUpsertBody } from './types';

export function useUpsertNotificationTemplate(eventKind: string) {
  const queryClient = useQueryClient();
  return useMutation<TemplateOverrideRow, Error, TemplateUpsertBody>({
    mutationFn: (body) =>
      apiFetch<TemplateOverrideRow>(
        `/admin/notification-templates/${encodeURIComponent(eventKind)}`,
        {
          method: 'PUT',
          body: JSON.stringify(body),
        },
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: notificationTemplateKeys.all });
    },
    ...withErrorHandling({ actionTitle: "Couldn't save notification template" }),
  });
}

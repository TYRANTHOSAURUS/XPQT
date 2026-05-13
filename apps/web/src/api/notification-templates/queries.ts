/**
 * Read-side hooks for the `/admin/notification-templates` admin surface.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step G.
 *
 * Two hooks:
 *
 *   - `useNotificationTemplates()` — lists every override row for the
 *     tenant. Powers the index page's status badges (Default / Customized).
 *     Page-class errors (403 from missing permission, 500) throw to
 *     RouteErrorBoundary via `usePageQuery` — admin shouldn't see "loading"
 *     followed by a toast over an empty table.
 *
 *   - `useNotificationTemplate(eventKind)` — EN+NL slot fetch for the
 *     detail editor. Same page-replacement contract.
 */

import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { usePageQuery } from '@/lib/errors';
import { notificationTemplateKeys } from './keys';
import type { TemplateDetailResponse, TemplateOverrideRow } from './types';

export function notificationTemplatesListOptions() {
  return queryOptions({
    queryKey: notificationTemplateKeys.list(),
    queryFn: ({ signal }) =>
      apiFetch<TemplateOverrideRow[]>('/admin/notification-templates', { signal }),
    // Cache mostly inert — admin edits don't churn this. 60s is the
    // sibling pattern (criteria-sets, webhooks).
    staleTime: 60_000,
  });
}

export function useNotificationTemplates() {
  return usePageQuery(notificationTemplatesListOptions());
}

export function notificationTemplateOptions(eventKind: string | undefined) {
  return queryOptions({
    queryKey: notificationTemplateKeys.detail(eventKind ?? ''),
    queryFn: ({ signal }) =>
      apiFetch<TemplateDetailResponse>(
        `/admin/notification-templates/${encodeURIComponent(eventKind ?? '')}`,
        { signal },
      ),
    enabled: Boolean(eventKind),
    staleTime: 60_000,
  });
}

export function useNotificationTemplate(eventKind: string | undefined) {
  // Detail page primary fetch — page-class errors throw to RouteErrorBoundary.
  return usePageQuery(notificationTemplateOptions(eventKind));
}

/** Plain (non-page) version for prefetch/sidebar use cases. */
export function useNotificationTemplateQuiet(eventKind: string | undefined) {
  return useQuery(notificationTemplateOptions(eventKind));
}

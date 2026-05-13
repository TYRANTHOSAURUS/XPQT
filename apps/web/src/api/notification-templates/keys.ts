/**
 * Query-key factory for the per-tenant notification-template overrides
 * surface (admin UI).
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step G. Per `docs/react-query-guidelines.md`
 * §3 every query is keyed through this factory — never inline.
 *
 * Hierarchy:
 *   all                          → ['notification-templates']
 *     ├─ lists()                 → ['notification-templates', 'list']
 *     │    └─ list()             → ['notification-templates', 'list', {}]
 *     └─ details()               → ['notification-templates', 'detail']
 *          └─ detail(eventKind)  → ['notification-templates', 'detail', eventKind]
 *
 * Mutations invalidate `notificationTemplateKeys.all` so the index list +
 * any open detail page both refresh after a write.
 */

export const notificationTemplateKeys = {
  all: ['notification-templates'] as const,

  lists: () => [...notificationTemplateKeys.all, 'list'] as const,
  /**
   * Single bucket — the index page is always the full list per tenant.
   * The args object is empty today; preserved as `{}` so the shape stays
   * forward-compatible if filtering is added later (e.g. by locale).
   */
  list: () => [...notificationTemplateKeys.lists(), {}] as const,

  details: () => [...notificationTemplateKeys.all, 'detail'] as const,
  detail: (eventKind: string) =>
    [...notificationTemplateKeys.details(), eventKind] as const,
} as const;

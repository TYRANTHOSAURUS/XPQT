/**
 * Wire-shape types for the `/admin/notification-templates` API surface.
 *
 * Source of truth: apps/api/src/modules/notifications/template-overrides.service.ts
 * (TemplateOverrideRow). The shapes here MUST mirror the service's output
 * — keep them in sync when columns evolve.
 *
 * Naming note: the API uses snake_case column names verbatim (matches the
 * DB schema in 00392). The admin UI consumes these directly without a
 * camelCase transform; the override fields are end-user-edited strings,
 * never struct-typed enough for casing to matter.
 */

export type TemplateLocale = 'en' | 'nl';

/** One override row from the DB. Both EN and NL slots can be present. */
export interface TemplateOverrideRow {
  id: string;
  tenant_id: string;
  event_kind: string;
  locale: TemplateLocale;
  subject_override: string | null;
  cta_text_override: string | null;
  body_intro_override: string | null;
  updated_at: string;
  updated_by_user_id: string | null;
}

/** GET /admin/notification-templates/:eventKind response shape. */
export interface TemplateDetailResponse {
  eventKind: string;
  en: TemplateOverrideRow | null;
  nl: TemplateOverrideRow | null;
}

/** PUT /admin/notification-templates/:eventKind body. */
export interface TemplateUpsertBody {
  locale: TemplateLocale;
  subject_override?: string | null;
  cta_text_override?: string | null;
  body_intro_override?: string | null;
}

/**
 * Static registry of event kinds the admin UI knows how to render. Mirrors
 * the backend `ALLOWED_EVENT_KINDS` set in template-overrides.service.ts +
 * the resolver's `NotificationEventPayloads` type. When a new event kind
 * ships, append it here AND extend the backend allowlist + resolver
 * registry in the same PR — the API would otherwise 422 on
 * `validation.failed`.
 *
 * `label` + `description` are EN strings; NL i18n is deferred (no
 * messages.nl pipeline in shared yet — see CLAUDE.md i18n section in the
 * Form composition rules; admin pages today are EN-only). Marked TODO so
 * the next NL pass picks it up.
 */
export interface KnownEventKind {
  /** Stable id matching the DB `event_kind` column. */
  kind: string;
  /** Title-case label for tables + breadcrumbs. */
  label: string;
  /** One-sentence description for list rows + page descriptions. */
  description: string;
}

/* TODO(i18n): translate labels + descriptions into NL when messages.nl
 * lands in @prequest/shared. Today admin UI is EN-only, matching every
 * other admin surface in the app. */
export const KNOWN_EVENT_KINDS: KnownEventKind[] = [
  {
    kind: 'booking.approval_required',
    label: 'Booking — approval required',
    description:
      'Sent to approvers when a booking enters the approval chain. Reaches users + every member of approver teams.',
  },
];

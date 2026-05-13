import { Injectable, Logger } from '@nestjs/common';
import { AppErrors } from '../../common/errors';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

/**
 * NotificationTemplateService — CRUD for `notification_template_overrides`.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step G (admin UI for tenant-scoped
 * notification template overrides).
 *
 * ── Audit pattern (mirrors branding.service.ts:217-238) ─────────────────
 *
 * Migration 00392 explicitly drops the prescribed audit trigger because
 * `audit_event_from_row()` does not exist on the codebase. Audit writes
 * are emitted from TS via `supabase.admin.from('audit_events').insert(...)`.
 * Failures log + warn but never block the mutation (try/catch around the
 * insert; never throw).
 *
 * ── Empty-string normalization ──────────────────────────────────────────
 *
 * Architect I5: empty / whitespace-only override fields are stored as
 * `null` so the renderer's empty-string fallback (which it also handles
 * defensively) doesn't have to be the only line of defense. An admin
 * blanking a field reverts to the default — the row stays so the
 * (tenant, event_kind, locale) link is preserved with `updated_by_user_id`
 * tracking.
 *
 * ── Tenant + permission gating ──────────────────────────────────────────
 *
 * - Reads use `supabase.admin` filtered explicitly by tenant_id.
 * - Writes are gated by the controller via `PermissionGuard.requirePermission`
 *   on `notifications.manage_templates` (canonical permission already
 *   registered in `packages/shared/src/permissions.ts:381`).
 * - The DB-level RLS policy in 00392 enforces the same key as a
 *   defense-in-depth boundary against direct DB writes.
 */

const ALLOWED_EVENT_KINDS = new Set<string>(['booking.approval_required']);
const ALLOWED_LOCALES = new Set<TemplateLocale>(['en', 'nl']);

export type TemplateLocale = 'en' | 'nl';

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

export interface TemplateOverrideUpsert {
  subject_override?: string | null;
  cta_text_override?: string | null;
  body_intro_override?: string | null;
}

@Injectable()
export class NotificationTemplateService {
  private readonly log = new Logger(NotificationTemplateService.name);

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Return every override row for the current tenant. Optional filters
   * narrow by `eventKind` / `locale`. Order: most-recently-updated first
   * so the admin UI's "Customized" surface shows the freshest edits.
   */
  async list(filters: { eventKind?: string; locale?: TemplateLocale } = {}): Promise<TemplateOverrideRow[]> {
    const tenantId = TenantContext.current().id;
    let q = this.supabase.admin
      .from('notification_template_overrides')
      .select(
        'id, tenant_id, event_kind, locale, subject_override, cta_text_override, body_intro_override, updated_at, updated_by_user_id',
      )
      .eq('tenant_id', tenantId);

    if (filters.eventKind) q = q.eq('event_kind', filters.eventKind);
    if (filters.locale) q = q.eq('locale', filters.locale);

    const { data, error } = await q.order('updated_at', { ascending: false });
    if (error) {
      throw AppErrors.server('unknown.server_error', { cause: error });
    }
    return (data ?? []) as TemplateOverrideRow[];
  }

  /**
   * Return EN + NL overrides for a single event_kind. Always returns BOTH
   * locales — null entries when the row doesn't exist yet. The admin UI
   * uses the dual-locale shape to render its EN/NL tabs without an extra
   * "is row registered?" probe.
   */
  async getByEventKind(eventKind: string): Promise<{
    eventKind: string;
    en: TemplateOverrideRow | null;
    nl: TemplateOverrideRow | null;
  }> {
    this.assertKnownEventKind(eventKind);
    const rows = await this.list({ eventKind });
    return {
      eventKind,
      en: rows.find((r) => r.locale === 'en') ?? null,
      nl: rows.find((r) => r.locale === 'nl') ?? null,
    };
  }

  /**
   * Insert-or-update the override row for `(tenant, event_kind, locale)`.
   *
   * Empty / whitespace-only fields normalize to `null` (architect I5). When
   * EVERY field normalizes to null AND there's no existing row, we still
   * insert — the row's existence is meaningful as an "admin reviewed and
   * accepted defaults" signal in the audit log. (Same posture as branding
   * defaults — explicit nulls beat absent rows for compliance traceability.)
   *
   * Returns the post-write row so the controller can echo it back to the
   * client without a follow-up read.
   */
  async upsert(
    eventKind: string,
    locale: TemplateLocale,
    fields: TemplateOverrideUpsert,
    actor: { userId: string },
  ): Promise<TemplateOverrideRow> {
    this.assertKnownEventKind(eventKind);
    this.assertKnownLocale(locale);
    const tenantId = TenantContext.current().id;

    const normalized: Required<TemplateOverrideUpsert> = {
      subject_override: normalize(fields.subject_override),
      cta_text_override: normalize(fields.cta_text_override),
      body_intro_override: normalize(fields.body_intro_override),
    };

    // Capture the prior row so the audit diff is meaningful (and so we can
    // return the right "created vs updated" event_type).
    const priorRows = await this.list({ eventKind, locale });
    const prior = priorRows[0] ?? null;

    const { data, error } = await this.supabase.admin
      .from('notification_template_overrides')
      .upsert(
        {
          tenant_id: tenantId,
          event_kind: eventKind,
          locale,
          subject_override: normalized.subject_override,
          cta_text_override: normalized.cta_text_override,
          body_intro_override: normalized.body_intro_override,
          updated_by_user_id: actor.userId,
          // updated_at refreshed by the trigger (00392:62-66). Don't set
          // it manually — relying on the trigger keeps a single source of
          // truth and avoids client-clock drift in the audit timeline.
        },
        { onConflict: 'tenant_id,event_kind,locale' },
      )
      .select(
        'id, tenant_id, event_kind, locale, subject_override, cta_text_override, body_intro_override, updated_at, updated_by_user_id',
      )
      .single();

    if (error) {
      throw AppErrors.server('unknown.server_error', { cause: error });
    }
    const row = data as TemplateOverrideRow;

    await this.writeAuditEvent(
      prior
        ? 'notification_template_override.updated'
        : 'notification_template_override.created',
      row.id,
      {
        event_kind: eventKind,
        locale,
        before: prior
          ? {
              subject_override: prior.subject_override,
              cta_text_override: prior.cta_text_override,
              body_intro_override: prior.body_intro_override,
            }
          : null,
        after: {
          subject_override: row.subject_override,
          cta_text_override: row.cta_text_override,
          body_intro_override: row.body_intro_override,
        },
        updated_by_user_id: actor.userId,
      },
    );

    return row;
  }

  /** Throw if the event kind isn't in the registry. Keeps invalid kinds
   *  out of the table and out of the audit trail. */
  private assertKnownEventKind(eventKind: string): void {
    if (!ALLOWED_EVENT_KINDS.has(eventKind)) {
      throw AppErrors.validationFailed('generic.bad_request', {
        detail: `Unknown event_kind: ${eventKind}`,
      });
    }
  }

  private assertKnownLocale(locale: string): void {
    if (!ALLOWED_LOCALES.has(locale as TemplateLocale)) {
      throw AppErrors.validationFailed('generic.bad_request', {
        detail: `Unknown locale: ${locale}. Allowed: en, nl`,
      });
    }
  }

  /** Mirror of branding.service.ts:217-238. Best-effort; never throws. */
  private async writeAuditEvent(
    eventType: string,
    entityId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    const tenant = TenantContext.current();
    try {
      const { error } = await this.supabase.admin.from('audit_events').insert({
        tenant_id: tenant.id,
        event_type: eventType,
        entity_type: 'notification_template_override',
        entity_id: entityId,
        details,
      });
      if (error) {
        this.log.warn(`audit_insert_failed: ${eventType} ${error.message}`);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.log.warn(`audit_insert_threw: ${eventType} ${detail}`);
    }
  }
}

/**
 * Trim + collapse empty / whitespace strings to `null`. Architect I5 —
 * mirror of the resolver's normalize() so a stored empty string never
 * reaches the renderer.
 */
function normalize(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

/**
 * NotificationTemplateService — CRUD for `notification_template_overrides`.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step G (admin UI for tenant-scoped
 * notification template overrides).
 *
 * ── Self-review I6 — STUB SHIPPED IN SUB-STEP C ─────────────────────────
 *
 * This file lands in sub-step C as a placeholder so the module exports the
 * service token + sub-step G has a concrete file to fill in (CRUD methods).
 *
 * Reasoning:
 *   1. Migration 00392 introduces `notification_template_overrides` but
 *      DROPS the audit trigger (`audit_event_from_row` does not exist
 *      on remote). That means write-side audit MUST be done from TS, the
 *      same pattern as branding.service.ts:226-238.
 *   2. NotificationsModule already exists — adding the stub now lets
 *      sub-step G implement methods without touching the module wiring.
 *   3. The contract documented below is binding for sub-step G: every
 *      mutation must emit an audit_events row. Skipping this is a P0
 *      regression (admin tweaks to subject lines / body intros that
 *      reach approver inboxes are auditable).
 *
 * ── CONTRACT for sub-step G implementations ─────────────────────────────
 *
 * Every mutation method MUST:
 *   - Resolve TenantContext.current() at the top of the method.
 *   - Filter every Supabase query by tenant_id (#0 invariant — memory:
 *     feedback_tenant_id_ultimate_rule).
 *   - Compute a before/after diff and emit one audit_events row per
 *     mutation with `event_type` in:
 *       'notification_template_override.created'
 *       'notification_template_override.updated'
 *       'notification_template_override.deleted'
 *     and `entity_type='notification_template_override'`,
 *     `entity_id=<override_row.id>`. See branding.service.ts:226-238 for
 *     the canonical pattern (try / catch / log; never block the mutation
 *     on audit failure).
 *   - Use AppErrors.* factories — no raw `new Error(...)`. The
 *     notifications module is not yet in MIGRATED_MODULES of
 *     check-app-errors.sh, but the policy applies (CLAUDE.md §Error
 *     handling).
 *   - Touch this docblock when the contract changes; the auditability
 *     guarantee is the load-bearing reason this service exists.
 *
 * ── Sub-step G method skeleton ──────────────────────────────────────────
 *
 *   list({ eventKind?, locale? }): Promise<TemplateOverrideRow[]>
 *   getOne(id): Promise<TemplateOverrideRow | null>
 *   upsert({ eventKind, locale, subject?, ctaText?, bodyIntro? }):
 *     Promise<TemplateOverrideRow>
 *   delete(id): Promise<void>
 *
 *   (Validation — Zod via throwZodError; per-field empty-string-is-null
 *    happens at the resolver layer, not here, so an admin can clear a
 *    subject without deleting the row.)
 */

@Injectable()
export class NotificationTemplateService {
  // Logger reserved for sub-step G's CRUD methods (audit warns +
  // override-mutation traces). Kept as a `void` reference so the
  // unused-symbol gate stays happy without losing the docblock context.
  private readonly log = new Logger(NotificationTemplateService.name);

  constructor(private readonly supabase: SupabaseService) {
    void this.log;
  }

  /**
   * Sub-step G FILLS IN this method body. Returning `[]` for now keeps
   * the service shape stable so consumers can be written against the
   * interface ahead of CRUD landing.
   */
  async list(_filters: {
    eventKind?: string;
    locale?: 'en' | 'nl';
  } = {}): Promise<unknown[]> {
    // TODO(b4a5-step-g): implement list of notification_template_overrides
    // filtered by tenant_id + optional eventKind/locale. Order by
    // updated_at DESC. See contract docblock above for audit / error
    // handling requirements.
    void _filters;
    void this.supabase;
    void TenantContext;
    return [];
  }
}

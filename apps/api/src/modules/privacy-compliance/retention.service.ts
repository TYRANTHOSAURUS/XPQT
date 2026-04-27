import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../../common/db/db.service';
import type { EntityRef } from './data-category.adapter';
import { DataCategoryRegistry } from './data-category-registry.service';
import { AuditOutboxService } from './audit-outbox.service';
import { GdprEventType } from './event-types';

/**
 * Surface for tenant-retention configuration + retention-application logic.
 *
 * Sprint 1 ships:
 *   - Settings CRUD (read + update with audit + LIA enforcement)
 *   - Idempotent default seeding hook
 *   - applyRetention(dryRun) wired against the (currently empty) adapter
 *     registry — gives the worker something safe to call before adapters land
 *
 * Sprint 2 brings adapters online so applyRetention does real work.
 *
 * Spec: docs/superpowers/specs/2026-04-27-gdpr-baseline-design.md §4.
 */
@Injectable()
export class RetentionService {
  constructor(
    private readonly db: DbService,
    private readonly registry: DataCategoryRegistry,
    private readonly auditOutbox: AuditOutboxService,
  ) {}

  /**
   * Idempotently seed the default retention categories for a tenant. Calls
   * the same SQL function the tenants insert-trigger uses, so app code and
   * DB-side path stay consistent.
   */
  async seedDefaultsForTenant(tenantId: string): Promise<void> {
    await this.db.query(`select public.seed_default_retention_for_tenant($1::uuid)`, [tenantId]);
  }

  async getCategorySettings(tenantId: string, category: string): Promise<TenantRetentionSettings> {
    const row = await this.db.queryOne<TenantRetentionSettings>(
      `select * from tenant_retention_settings
        where tenant_id = $1 and data_category = $2`,
      [tenantId, category],
    );
    if (!row) {
      throw new NotFoundException(
        `Retention settings missing for tenant=${tenantId} category=${category} — run seedDefaultsForTenant`,
      );
    }
    return row;
  }

  async listCategorySettings(tenantId: string): Promise<TenantRetentionSettings[]> {
    return this.db.queryMany<TenantRetentionSettings>(
      `select * from tenant_retention_settings
        where tenant_id = $1
        order by data_category`,
      [tenantId],
    );
  }

  /**
   * Update a category's retention. Enforces:
   *   - `gdpr.configure` permission gate (caller responsibility — wire at controller).
   *   - `cap_retention_days` upper bound from existing row (cap is immutable; only
   *     "global" upgrade path is a code change + new migration).
   *   - LIA text required when extending past the system default.
   *   - Reason captured into audit event payload.
   */
  async setCategorySettings(
    tenantId: string,
    category: string,
    patch: SetCategorySettingsInput,
    actorUserId: string,
    reason: string,
  ): Promise<TenantRetentionSettings> {
    if (!reason || reason.trim().length < 8) {
      throw new BadRequestException('Reason required (>=8 chars) for retention setting changes.');
    }

    const current = await this.getCategorySettings(tenantId, category);

    const nextRetentionDays = patch.retentionDays ?? current.retention_days;
    if (nextRetentionDays < 0) {
      throw new BadRequestException('retention_days must be >= 0.');
    }
    if (current.cap_retention_days !== null && nextRetentionDays > current.cap_retention_days) {
      throw new BadRequestException(
        `Retention exceeds cap (${current.cap_retention_days} days). Contact support to discuss legal exception.`,
      );
    }

    // LIA enforcement: when extending past the registry default, require text.
    const adapter = this.registry.get(category);
    const systemDefault = adapter?.defaultRetentionDays ?? current.retention_days;
    const isExtendingPastDefault = nextRetentionDays > systemDefault;
    const liaText = patch.liaText ?? current.lia_text;

    if (isExtendingPastDefault && (!liaText || liaText.trim().length < 32)) {
      throw new BadRequestException(
        'LIA (Legitimate Interest Assessment) text required (>=32 chars) when extending retention past the system default.',
      );
    }

    const updated = await this.db.queryOne<TenantRetentionSettings>(
      `update tenant_retention_settings
          set retention_days              = $3,
              lia_text                    = coalesce($4, lia_text),
              lia_text_updated_at         = case when $4 is not null then now() else lia_text_updated_at end,
              lia_text_updated_by_user_id = case when $4 is not null then $5::uuid else lia_text_updated_by_user_id end
        where tenant_id = $1 and data_category = $2
        returning *`,
      [tenantId, category, nextRetentionDays, patch.liaText ?? null, actorUserId],
    );

    if (!updated) {
      throw new NotFoundException(`Retention settings disappeared mid-update (tenant=${tenantId} category=${category}).`);
    }

    await this.auditOutbox.emit({
      tenantId,
      eventType: GdprEventType.RetentionSettingChanged,
      entityType: 'tenant_retention_settings',
      entityId: updated.id,
      actorUserId,
      details: {
        data_category: category,
        previous_retention_days: current.retention_days,
        next_retention_days: nextRetentionDays,
        lia_text_changed: patch.liaText !== undefined,
        reason,
      },
    });

    if (patch.liaText !== undefined) {
      await this.auditOutbox.emit({
        tenantId,
        eventType: GdprEventType.LiaUpdated,
        entityType: 'tenant_retention_settings',
        entityId: updated.id,
        actorUserId,
        details: { data_category: category, reason },
      });
    }

    return updated;
  }

  /**
   * Scan-only: ask each adapter what's expired for a tenant+category.
   * Used for dry-run preview in the privacy admin UI.
   */
  async scanExpired(tenantId: string, category: string): Promise<EntityRef[]> {
    const adapter = this.registry.get(category);
    if (!adapter) return [];                         // no adapter yet → nothing scannable

    const settings = await this.getCategorySettings(tenantId, category);
    return adapter.scanForExpired(tenantId, settings.retention_days);
  }

  /**
   * Apply retention for a tenant+category. Filters out anything currently
   * under a legal hold, then either anonymizes or hard-deletes per category
   * convention (today: hard-delete only for categories without an
   * anonymization path; anonymize otherwise).
   *
   * Sprint 1: returns counts only when adapter is registered. With no
   * adapters, returns zeros — safe.
   */
  async applyRetention(
    tenantId: string,
    category: string,
    options: { dryRun?: boolean } = {},
  ): Promise<RetentionApplyResult> {
    const adapter = this.registry.get(category);
    if (!adapter) {
      return { tenantId, category, scanned: 0, anonymized: 0, hardDeleted: 0, skippedHeld: 0, dryRun: !!options.dryRun };
    }

    const expired = await this.scanExpired(tenantId, category);

    // Filter: tenant-wide and category-wide holds short-circuit; person-level
    // holds filter individual refs.
    const heldByTenant = await this.hasTenantWideHold(tenantId);
    const heldByCategory = await this.hasCategoryHold(tenantId, category);
    if (heldByTenant || heldByCategory) {
      await this.auditOutbox.emit({
        tenantId,
        eventType: GdprEventType.RetentionRunSkipped,
        details: { data_category: category, scanned: expired.length, reason: heldByTenant ? 'tenant_wide_hold' : 'category_hold' },
      });
      return { tenantId, category, scanned: expired.length, anonymized: 0, hardDeleted: 0, skippedHeld: expired.length, dryRun: !!options.dryRun };
    }

    const heldPersonIds = await this.heldPersonIds(tenantId);
    const filtered: EntityRef[] = [];
    let skippedHeld = 0;

    for (const ref of expired) {
      const linkedPersonId = await this.refSubjectPersonId(ref);
      if (linkedPersonId && heldPersonIds.has(linkedPersonId)) {
        skippedHeld += 1;
        continue;
      }
      filtered.push(ref);
    }

    if (options.dryRun) {
      return { tenantId, category, scanned: expired.length, anonymized: 0, hardDeleted: 0, skippedHeld, dryRun: true };
    }

    if (filtered.length > 0) {
      // Convention: categories with no anonymization path opt-in via legal_basis === 'none'
      // (e.g. calendar_event_content) or by registering hardDelete-only adapters.
      const legal = adapter.legalBasis;
      if (legal === 'none') {
        await adapter.hardDelete(filtered);
        await this.auditOutbox.emit({
          tenantId,
          eventType: GdprEventType.RetentionHardDeleted,
          details: { data_category: category, count: filtered.length },
        });
      } else {
        await adapter.anonymize(filtered);
        await this.auditOutbox.emit({
          tenantId,
          eventType: GdprEventType.RetentionAnonymized,
          details: { data_category: category, count: filtered.length },
        });
      }
    }

    await this.auditOutbox.emit({
      tenantId,
      eventType: GdprEventType.RetentionRunCompleted,
      details: {
        data_category: category,
        scanned: expired.length,
        applied: filtered.length,
        skipped_held: skippedHeld,
      },
    });

    return {
      tenantId,
      category,
      scanned: expired.length,
      anonymized: adapter.legalBasis === 'none' ? 0 : filtered.length,
      hardDeleted: adapter.legalBasis === 'none' ? filtered.length : 0,
      skippedHeld,
      dryRun: false,
    };
  }

  /** Tenants the worker should iterate. */
  async listActiveTenantIds(): Promise<string[]> {
    const rows = await this.db.queryMany<{ id: string }>(
      `select id from tenants where status = 'active' order by id`,
    );
    return rows.map((r) => r.id);
  }

  /** Categories present in tenant_retention_settings for a tenant. */
  async listSeededCategories(tenantId: string): Promise<string[]> {
    const rows = await this.db.queryMany<{ data_category: string }>(
      `select data_category from tenant_retention_settings
        where tenant_id = $1 order by data_category`,
      [tenantId],
    );
    return rows.map((r) => r.data_category);
  }

  // -------------------- legal hold helpers --------------------

  private async hasTenantWideHold(tenantId: string): Promise<boolean> {
    const r = await this.db.queryOne<{ exists: boolean }>(
      `select exists(select 1 from legal_holds
                       where tenant_id = $1
                         and hold_type = 'tenant_wide'
                         and released_at is null
                         and (expires_at is null or expires_at > now())) as exists`,
      [tenantId],
    );
    return r?.exists ?? false;
  }

  private async hasCategoryHold(tenantId: string, category: string): Promise<boolean> {
    const r = await this.db.queryOne<{ exists: boolean }>(
      `select exists(select 1 from legal_holds
                       where tenant_id = $1
                         and hold_type = 'category'
                         and data_category = $2
                         and released_at is null
                         and (expires_at is null or expires_at > now())) as exists`,
      [tenantId, category],
    );
    return r?.exists ?? false;
  }

  private async heldPersonIds(tenantId: string): Promise<Set<string>> {
    const rows = await this.db.queryMany<{ subject_person_id: string }>(
      `select subject_person_id from legal_holds
        where tenant_id = $1
          and hold_type = 'person'
          and subject_person_id is not null
          and released_at is null
          and (expires_at is null or expires_at > now())`,
      [tenantId],
    );
    return new Set(rows.map((r) => r.subject_person_id));
  }

  /**
   * Default heuristic: if the resource type is `persons`, the subject is the
   * resource itself. Otherwise the adapter is responsible for surfacing a
   * person link via the EntityRef (TODO Sprint 2: extend EntityRef with optional
   * subject_person_id so adapters can declare it cheaply).
   */
  private async refSubjectPersonId(ref: EntityRef): Promise<string | null> {
    if (ref.resourceType === 'persons') return ref.resourceId;
    return null;
  }
}

export interface TenantRetentionSettings {
  id: string;
  tenant_id: string;
  data_category: string;
  retention_days: number;
  cap_retention_days: number | null;
  lia_text: string | null;
  lia_text_updated_at: string | null;
  lia_text_updated_by_user_id: string | null;
  legal_basis: string;
  created_at: string;
  updated_at: string;
}

export interface SetCategorySettingsInput {
  retentionDays?: number;
  liaText?: string | null;
}

export interface RetentionApplyResult {
  tenantId: string;
  category: string;
  scanned: number;
  anonymized: number;
  hardDeleted: number;
  skippedHeld: number;
  dryRun: boolean;
}

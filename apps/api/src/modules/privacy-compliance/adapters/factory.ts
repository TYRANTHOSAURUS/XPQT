import { Logger } from '@nestjs/common';
import type { DbService } from '../../../common/db/db.service';
import type {
  AnonymizeContext,
  DataCategoryAdapter,
  EntityRef,
  ExportSection,
  LegalBasis,
} from '../data-category.adapter';

/**
 * Adapter factories for the common patterns. Concrete adapters in this
 * module are built by composing these — keeps each category file tiny
 * and the patterns auditable in one place.
 *
 * Sprint 2 ships:
 *   - makeHardDeleteByDateAdapter — hard-delete rows past retention.
 *   - makeNoOpAdapter             — categories with no warehoused rows
 *                                   (e.g. calendar_event_content) or where
 *                                   another adapter handles the actual PII
 *                                   (e.g. past_bookings — PII via FK to
 *                                   persons; PersonsAdapter does the work).
 *   - makePendingSpecAdapter      — stub for categories whose backing tables
 *                                   ship with a downstream spec; logs once
 *                                   at boot so we don't silently miss them.
 */

export interface HardDeleteAdapterConfig {
  category: string;
  description: string;
  defaultRetentionDays: number;
  capRetentionDays: number | null;
  /** Source table. Must have tenant_id and a date column to filter on. */
  table: string;
  /** Column whose timestamp determines "past retention". */
  dateColumn: string;
  /**
   * Person-FK columns on the row whose values populate EntityRef.subjectPersonIds.
   * Used by the orchestrator to filter out rows covered by person-level legal
   * holds. Omit when no person link exists (webhook_events).
   */
  personFkColumns?: readonly string[];
  /** Optional WHERE-fragment appended to the scan to exclude already-processed rows. */
  alreadyProcessedPredicate?: string;
  /**
   * Optional: how to surface this category in a per-person export bundle.
   * If omitted, exportForPerson returns an empty section. webhook_events
   * for example has no per-person link, so the omission is correct.
   */
  exportForPerson?: (db: DbService, tenantId: string, personId: string) => Promise<ExportSection>;
  erasureRefs?: (db: DbService, tenantId: string, personId: string) => Promise<EntityRef[]>;
}

export function makeHardDeleteByDateAdapter(
  config: HardDeleteAdapterConfig,
  db: DbService,
): DataCategoryAdapter {
  const log = new Logger(`Adapter:${config.category}`);
  const alreadyProcessed = config.alreadyProcessedPredicate ?? '';

  return {
    category: config.category,
    description: config.description,
    defaultRetentionDays: config.defaultRetentionDays,
    capRetentionDays: config.capRetentionDays,
    legalBasis: 'none' as LegalBasis,                      // 'none' routes orchestrator to hardDelete

    async scanForExpired(tenantId: string, retentionDays: number): Promise<EntityRef[]> {
      // Retention 0 = no warehousing → never scan. Treat as no-op.
      if (retentionDays <= 0) return [];

      const personFkSelect = (config.personFkColumns ?? []).join(', ');
      const selectExpr = personFkSelect ? `id, ${personFkSelect}` : 'id';

      const rows = await db.queryMany<Record<string, string | null>>(
        `select ${selectExpr} from ${config.table}
          where tenant_id = $1
            and ${config.dateColumn} < now() - ($2 || ' days')::interval
            ${alreadyProcessed ? `and ${alreadyProcessed}` : ''}
          order by ${config.dateColumn}
          limit 100000`,                                   // hard cap per scan; nightly cap clips further
        [tenantId, retentionDays.toString()],
      );

      return rows.map((r) => {
        const subjectPersonIds = (config.personFkColumns ?? [])
          .map((col) => r[col])
          .filter((v): v is string => typeof v === 'string' && v.length > 0);
        return {
          category: config.category,
          resourceType: config.table,
          resourceId: r.id as string,
          tenantId,
          subjectPersonIds: subjectPersonIds.length > 0 ? subjectPersonIds : undefined,
        };
      });
    },

    async anonymize(_refs: EntityRef[], _context: AnonymizeContext = { reason: 'retention' }): Promise<void> {
      // Hard-delete categories don't have an anonymization path. Orchestrator
      // routes to hardDelete because legalBasis === 'none'; this should never fire.
      log.warn('anonymize() invoked on a hard-delete-only adapter — orchestrator misroute');
    },

    async hardDelete(refs: EntityRef[]): Promise<void> {
      if (refs.length === 0) return;
      const ids = refs.map((r) => r.resourceId);
      const tenantId = refs[0].tenantId;
      // Single-tenant batch (orchestrator never mixes tenants in one call,
      // but the WHERE belt-and-braces protects against bugs).
      await db.query(
        `delete from ${config.table}
          where tenant_id = $1 and id = any($2::uuid[])`,
        [tenantId, ids],
      );
    },

    async exportForPerson(tenantId: string, personId: string): Promise<ExportSection> {
      if (config.exportForPerson) return config.exportForPerson(db, tenantId, personId);
      return {
        category: config.category,
        description: config.description,
        records: [],
        totalCount: 0,
      };
    },

    async erasureRefs(tenantId: string, personId: string): Promise<EntityRef[]> {
      if (config.erasureRefs) return config.erasureRefs(db, tenantId, personId);
      return [];
    },
  };
}

export interface NoOpAdapterConfig {
  category: string;
  description: string;
  defaultRetentionDays: number;
  capRetentionDays: number | null;
  legalBasis: LegalBasis;
  /** Why this adapter is a no-op. Surfaced in logs. */
  rationale: string;
}

/**
 * Adapter that scans nothing and applies nothing. Two valid uses:
 *   - `calendar_event_content`: retention 0 / 'none' — we don't warehouse it.
 *   - `past_bookings` / `past_orders` / `personal_data_access_logs`:
 *     PII is either FK to persons (handled by PersonsAdapter) or partition-
 *     drop only (handled by RetentionWorker.maintainPdalPartitions).
 */
export function makeNoOpAdapter(config: NoOpAdapterConfig): DataCategoryAdapter {
  return {
    category: config.category,
    description: `${config.description} (no-op: ${config.rationale})`,
    defaultRetentionDays: config.defaultRetentionDays,
    capRetentionDays: config.capRetentionDays,
    legalBasis: config.legalBasis,
    async scanForExpired() { return []; },
    async anonymize(_refs: EntityRef[], _context: AnonymizeContext = { reason: 'retention' }) {},
    async hardDelete() {},
    async exportForPerson() {
      return { category: config.category, description: config.description, records: [], totalCount: 0 };
    },
    async erasureRefs() { return []; },
  };
}

export interface PendingSpecAdapterConfig {
  category: string;
  description: string;
  defaultRetentionDays: number;
  capRetentionDays: number | null;
  legalBasis: LegalBasis;
  /** Which spec brings this category online. Surfaced in boot log. */
  pendingSpec: string;
}

/**
 * Stub for categories whose backing tables haven't shipped yet — the table
 * lands with a downstream spec (visitor management, daglijst, MS Graph, etc.).
 *
 * Logs once at registration so we never lose track of what's missing. When
 * the spec lands, the team replaces this stub with a concrete adapter and
 * the boot log loses the warning entry.
 */
export function makePendingSpecAdapter(config: PendingSpecAdapterConfig): DataCategoryAdapter {
  const log = new Logger(`Adapter:${config.category}`);
  log.warn(
    `pending implementation — table not yet shipped (waiting on: ${config.pendingSpec}). ` +
    `RetentionWorker treats this category as no-op until then.`,
  );
  return makeNoOpAdapter({
    category: config.category,
    description: config.description,
    defaultRetentionDays: config.defaultRetentionDays,
    capRetentionDays: config.capRetentionDays,
    legalBasis: config.legalBasis,
    rationale: `pending ${config.pendingSpec}`,
  });
}

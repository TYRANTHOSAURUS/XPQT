import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../../common/db/db.service';
import { AnonymizationAuditService } from '../anonymization-audit.service';
import type {
  AnonymizeContext,
  DataCategoryAdapter,
  EntityRef,
  ExportSection,
  LegalBasis,
} from '../data-category.adapter';

/**
 * person_ref_in_past_records — persons table.
 *
 * The actual person row is the canonical PII anchor. Once `left_at` has
 * passed + retention has elapsed, this adapter replaces the PII fields
 * (first_name / last_name / email / phone) with stable placeholders so:
 *   - past bookings, orders, audit_events still reference a valid person row
 *     (FK integrity preserved; no cascading data loss).
 *   - The person row itself no longer carries PII.
 *
 * Default retention 90 days post-`left_at`, hard cap 90 days. The cap
 * matches contractual + accounting needs: bookings/orders keep their
 * person FK, but the person row no longer reveals who that was.
 *
 * Spec: gdpr-baseline-design.md §3 + §5 (departure cleanup).
 */
@Injectable()
export class PersonsAdapter implements DataCategoryAdapter {
  readonly category = 'person_ref_in_past_records';
  readonly description = 'Person rows referenced by retained records (bookings, orders, audits).';
  readonly defaultRetentionDays = 90;
  readonly capRetentionDays = 90;
  readonly legalBasis: LegalBasis = 'contract';

  constructor(
    private readonly db: DbService,
    private readonly anonAudit: AnonymizationAuditService,
  ) {}

  async scanForExpired(tenantId: string, retentionDays: number): Promise<EntityRef[]> {
    if (retentionDays <= 0) return [];

    // Anonymize when person has left AND retention has elapsed since departure
    // AND not already anonymized.
    const rows = await this.db.queryMany<{ id: string }>(
      `select id from persons
        where tenant_id = $1
          and left_at is not null
          and left_at < now() - ($2 || ' days')::interval
          and anonymized_at is null
        order by left_at
        limit 100000`,
      [tenantId, retentionDays.toString()],
    );

    return rows.map((r) => ({
      category: this.category,
      resourceType: 'persons',
      resourceId: r.id,
      tenantId,
    }));
  }

  async anonymize(refs: EntityRef[], context: AnonymizeContext = { reason: 'retention' }): Promise<void> {
    if (refs.length === 0) return;
    const tenantId = refs[0].tenantId;
    const ids = refs.map((r) => r.resourceId);

    await this.db.tx(async (client) => {
      // Snapshot originals → 7-day restore window (skipped for erasure).
      await this.anonAudit.snapshotTx(client, {
        dataCategory: this.category,
        refs,
        reason: context.reason,
        initiatedByUserId: context.initiatedByUserId ?? null,
        fetchOriginals: async () => {
          const r = await client.query<{
            id: string; first_name: string | null; last_name: string | null;
            email: string | null; phone: string | null; avatar_url: string | null;
          }>(
            `select id, first_name, last_name, email, phone, avatar_url
               from persons
              where tenant_id = $1 and id = any($2::uuid[])`,
            [tenantId, ids],
          );
          return r.rows.map((row) => ({
            resourceType: 'persons',
            resourceId: row.id,
            payload: {
              first_name: row.first_name,
              last_name: row.last_name,
              email: row.email,
              phone: row.phone,
              avatar_url: row.avatar_url,
            },
          }));
        },
      });

      // In-place anonymize. Each person gets a stable hash-based placeholder
      // so re-runs are idempotent and audit logs that already captured the
      // placeholder still resolve consistently. anonymized_reason matches
      // the AnonymizeContext so the persons row tells the truth about why
      // it was scrubbed.
      for (const id of ids) {
        const placeholder = personPlaceholder(id);
        await client.query(
          `update persons
              set first_name        = $3,
                  last_name         = $4,
                  email             = null,
                  phone             = null,
                  avatar_url        = null,
                  anonymized_at     = now(),
                  anonymized_reason = $5
            where tenant_id = $1 and id = $2 and anonymized_at is null`,
          [tenantId, id, 'Former employee', placeholder, context.reason],
        );
      }
    });
  }

  async hardDelete(_refs: EntityRef[]): Promise<void> {
    // persons is anonymize-only. Hard-delete would cascade to bookings/orders
    // and break legal-retention accounting records.
  }

  async exportForPerson(tenantId: string, personId: string): Promise<ExportSection> {
    const row = await this.db.queryOne(
      `select id, type, first_name, last_name, email, phone, cost_center,
              manager_person_id, external_source, active, default_location_id,
              created_at, updated_at, left_at, is_external,
              last_seen_in_active_booking_at, anonymized_at, anonymized_reason
         from persons
        where tenant_id = $1 and id = $2`,
      [tenantId, personId],
    );
    return {
      category: this.category,
      description: 'The subject\'s person record.',
      records: row ? [row] : [],
      totalCount: row ? 1 : 0,
    };
  }

  async erasureRefs(tenantId: string, personId: string): Promise<EntityRef[]> {
    const row = await this.db.queryOne<{ id: string }>(
      `select id from persons
        where tenant_id = $1 and id = $2 and anonymized_at is null`,
      [tenantId, personId],
    );
    if (!row) return [];
    return [{
      category: this.category,
      resourceType: 'persons',
      resourceId: row.id,
      tenantId,
    }];
  }
}

/**
 * Stable per-person placeholder. Same input → same output, so a re-run of
 * the anonymizer is fully idempotent and any cached display name in
 * downstream tables stays consistent.
 */
function personPlaceholder(personId: string): string {
  const short = createHash('sha256').update(personId).digest('hex').slice(0, 8);
  return `#${short}`;
}

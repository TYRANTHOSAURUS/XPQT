import { Injectable } from '@nestjs/common';
import { DbService } from '../../../common/db/db.service';
import { AnonymizationAuditService } from '../anonymization-audit.service';
import type {
  DataCategoryAdapter,
  EntityRef,
  ExportSection,
  LegalBasis,
} from '../data-category.adapter';

/**
 * visitor_records — visitors table.
 *
 * Default retention 180 days, cap 365 days. Anonymization preserves
 * operational analytics (visit_date, site_id, status) while removing
 * the visitor-specific PII (badge_id; the linked person row is anonymized
 * separately by PersonsAdapter when the person leaves the tenant).
 *
 * Spec: gdpr-baseline-design.md §3 + §4 (visitor_records pattern).
 */
@Injectable()
export class VisitorRecordsAdapter implements DataCategoryAdapter {
  readonly category = 'visitor_records';
  readonly description = 'Visitor check-in records — name + host + visit timestamp.';
  readonly defaultRetentionDays = 180;
  readonly capRetentionDays = 365;
  readonly legalBasis: LegalBasis = 'legitimate_interest';

  constructor(
    private readonly db: DbService,
    private readonly anonAudit: AnonymizationAuditService,
  ) {}

  async scanForExpired(tenantId: string, retentionDays: number): Promise<EntityRef[]> {
    if (retentionDays <= 0) return [];

    // Visit considered "completed" once the date is past + the visitor's
    // status is terminal. We anonymize once retention has elapsed since the
    // visit_date AND the visitor isn't pending future activity.
    const rows = await this.db.queryMany<{ id: string }>(
      `select id from visitors
        where tenant_id = $1
          and anonymized_at is null
          and visit_date < (current_date - ($2 || ' days')::interval)
          and status in ('checked_out','no_show','cancelled')
        order by visit_date
        limit 100000`,
      [tenantId, retentionDays.toString()],
    );

    return rows.map((r) => ({
      category: this.category,
      resourceType: 'visitors',
      resourceId: r.id,
      tenantId,
    }));
  }

  async anonymize(refs: EntityRef[]): Promise<void> {
    if (refs.length === 0) return;
    const tenantId = refs[0].tenantId;
    const ids = refs.map((r) => r.resourceId);

    await this.db.tx(async (client) => {
      // 1. Snapshot originals → anonymization_audit (7-day restore window).
      await this.anonAudit.snapshotTx(client, {
        dataCategory: this.category,
        refs,
        reason: 'retention',
        fetchOriginals: async () => {
          const rows = await client.query<{
            id: string; badge_id: string | null; person_id: string;
            host_person_id: string; status: string; visit_date: string;
          }>(
            `select id, badge_id, person_id, host_person_id, status, visit_date
               from visitors
              where tenant_id = $1 and id = any($2::uuid[])`,
            [tenantId, ids],
          );
          return rows.rows.map((r) => ({
            resourceType: 'visitors',
            resourceId: r.id,
            payload: {
              badge_id: r.badge_id,
              person_id: r.person_id,
              host_person_id: r.host_person_id,
              status: r.status,
              visit_date: r.visit_date,
            },
          }));
        },
      });

      // 2. In-place anonymize. badge_id removed; person FKs preserved (the
      // person rows themselves are anonymized by PersonsAdapter at their
      // own retention schedule). Analytics columns (visit_date, site_id,
      // status) preserved.
      await client.query(
        `update visitors
            set badge_id      = null,
                anonymized_at = now()
          where tenant_id = $1 and id = any($2::uuid[])
            and anonymized_at is null`,
        [tenantId, ids],
      );
    });
  }

  async hardDelete(_refs: EntityRef[]): Promise<void> {
    // visitor_records is anonymize-only. The hard-delete companion category
    // visitor_photos_ids handles the destructive path for blobs.
  }

  async exportForPerson(tenantId: string, personId: string): Promise<ExportSection> {
    const rows = await this.db.queryMany(
      `select id, visit_date, site_id, status, badge_id, pre_registered,
              checked_in_at, checked_out_at, anonymized_at, host_person_id
         from visitors
        where tenant_id = $1
          and (person_id = $2 or host_person_id = $2)
        order by visit_date desc`,
      [tenantId, personId],
    );
    return {
      category: this.category,
      description: 'Visitor records where the subject is the visitor or the host.',
      records: rows,
      totalCount: rows.length,
    };
  }

  async erasureRefs(tenantId: string, personId: string): Promise<EntityRef[]> {
    const rows = await this.db.queryMany<{ id: string }>(
      `select id from visitors
        where tenant_id = $1
          and (person_id = $2 or host_person_id = $2)
          and anonymized_at is null`,
      [tenantId, personId],
    );
    return rows.map((r) => ({
      category: this.category,
      resourceType: 'visitors',
      resourceId: r.id,
      tenantId,
    }));
  }
}

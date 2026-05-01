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
 * visitor_records — visitors table.
 *
 * Default retention 180 days, cap 365 days. Anonymization preserves
 * operational analytics (visit timestamp, building, status) while removing
 * the visitor-specific PII columns (badge_id, denorm name/email/phone/
 * company, meeting_room_id, notes_for_visitor, notes_for_reception). The
 * linked persons row is anonymized separately by PersonsAdapter at its
 * own retention schedule; the persons→visitors PII sync trigger (00268)
 * also propagates anonymization the other direction.
 *
 * Visitor management v1 (00248-00269) shifted the canonical timestamp
 * from `visit_date` (DATE) to `expected_at` (TIMESTAMPTZ). Both are kept
 * for backwards compatibility — the retention scan picks whichever is
 * non-null per row via coalesce(expected_at::date, visit_date).
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
    // visit_date / expected_at AND the visitor isn't pending future activity.
    //
    // Status filter MUST include 'denied' (visitor management v1 added this
    // terminal state for type=interview rejections — without it, denied rows
    // never expire and PII leaks past retention).
    //
    // Date filter uses coalesce(expected_at::date, visit_date) so that v1
    // rows (which write expected_at and have visit_date defaulted) and
    // legacy rows (visit_date populated, expected_at NULL) are both honoured.
    const rows = await this.db.queryMany<{ id: string; person_id: string; host_person_id: string }>(
      `select id, person_id, host_person_id from visitors
        where tenant_id = $1
          and anonymized_at is null
          and coalesce(expected_at::date, visit_date)
              < (current_date - ($2 || ' days')::interval)
          and status in ('checked_out','no_show','cancelled','denied')
        order by coalesce(expected_at::date, visit_date)
        limit 100000`,
      [tenantId, retentionDays.toString()],
    );

    return rows.map((r) => ({
      category: this.category,
      resourceType: 'visitors',
      resourceId: r.id,
      tenantId,
      subjectPersonIds: [r.person_id, r.host_person_id].filter(Boolean),
    }));
  }

  async anonymize(refs: EntityRef[], context: AnonymizeContext = { reason: 'retention' }): Promise<void> {
    if (refs.length === 0) return;
    const tenantId = refs[0].tenantId;
    const ids = refs.map((r) => r.resourceId);

    await this.db.tx(async (client) => {
      // 1. Snapshot originals → anonymization_audit (7-day restore window).
      // For erasure_request, snapshotTx short-circuits — no recoverable copy.
      await this.anonAudit.snapshotTx(client, {
        dataCategory: this.category,
        refs,
        reason: context.reason,
        initiatedByUserId: context.initiatedByUserId ?? null,
        fetchOriginals: async () => {
          const rows = await client.query<{
            id: string; badge_id: string | null; person_id: string | null;
            host_person_id: string; status: string; visit_date: string;
            first_name: string | null; last_name: string | null;
            email: string | null; phone: string | null; company: string | null;
            meeting_room_id: string | null;
            notes_for_visitor: string | null; notes_for_reception: string | null;
          }>(
            `select id, badge_id, person_id, host_person_id, status, visit_date,
                    first_name, last_name, email, phone, company,
                    meeting_room_id, notes_for_visitor, notes_for_reception
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
              first_name: r.first_name,
              last_name: r.last_name,
              email: r.email,
              phone: r.phone,
              company: r.company,
              meeting_room_id: r.meeting_room_id,
              notes_for_visitor: r.notes_for_visitor,
              notes_for_reception: r.notes_for_reception,
            },
          }));
        },
      });

      // 2. In-place anonymize. NULL person_id to break the visitor-identity
      //    chain (a non-null FK would still resolve to a recoverable name +
      //    email via the persons row). host_person_id is kept — hosts are
      //    employees, anonymized separately by PersonsAdapter at their own
      //    retention schedule. badge_id removed. Analytics columns
      //    (visit_date, site_id, status, building_id, expected_at) preserved.
      //
      //    Visitor management v1 added denorm PII columns (first_name,
      //    last_name, email, phone, company) maintained by app writes +
      //    the persons→visitors sync trigger (00268). All five must be
      //    blanked here; the sync trigger fires only on persons UPDATE,
      //    not on retention-driven visitor anonymization.
      //
      //    meeting_room_id is treated as PII (it's the room number /
      //    floor that the visitor was meeting at — combined with date +
      //    company it can re-identify). Notes columns are visitor-facing
      //    free text; nuke them.
      await client.query(
        `update visitors
            set badge_id            = null,
                person_id           = null,
                first_name          = null,
                last_name           = null,
                email               = null,
                phone               = null,
                company             = null,
                meeting_room_id     = null,
                notes_for_visitor   = null,
                notes_for_reception = null,
                anonymized_at       = now()
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

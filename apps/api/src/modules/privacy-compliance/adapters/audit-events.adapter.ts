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
 * audit_events — long-retention compliance log (default 7 years for NL
 * accounting). Anonymization redacts identifying email/IP traces from the
 * `details` JSONB while preserving the event_type, tenant, timestamps, and
 * structural relationships. Without this, audit logs become a back-door
 * around erasure requests.
 *
 * Spec: gdpr-baseline-design.md §3 + §4 (audit_events anonymization).
 */
@Injectable()
export class AuditEventsAdapter implements DataCategoryAdapter {
  readonly category = 'audit_events';
  readonly description = 'Compliance audit log — 7-year retention for accounting.';
  readonly defaultRetentionDays = 2555;          // 7 years (NL accounting)
  readonly capRetentionDays: number | null = null;
  readonly legalBasis: LegalBasis = 'legal_obligation';

  /** JSONB keys redacted during anonymization. Each is replaced with a hash placeholder. */
  private static readonly REDACT_KEYS = [
    'actor_email', 'actor_phone', 'actor_ip',
    'subject_email', 'subject_phone', 'subject_ip',
    'email', 'phone', 'ip', 'ip_address', 'ip_hash',
  ] as const;

  constructor(
    private readonly db: DbService,
    private readonly anonAudit: AnonymizationAuditService,
  ) {}

  async scanForExpired(tenantId: string, retentionDays: number): Promise<EntityRef[]> {
    if (retentionDays <= 0) return [];

    const rows = await this.db.queryMany<{ id: string }>(
      `select id from audit_events
        where tenant_id = $1
          and created_at < now() - ($2 || ' days')::interval
          and not coalesce((details->>'anonymized')::boolean, false)
        order by created_at
        limit 100000`,
      [tenantId, retentionDays.toString()],
    );

    return rows.map((r) => ({
      category: this.category,
      resourceType: 'audit_events',
      resourceId: r.id,
      tenantId,
    }));
  }

  async anonymize(refs: EntityRef[]): Promise<void> {
    if (refs.length === 0) return;
    const tenantId = refs[0].tenantId;
    const ids = refs.map((r) => r.resourceId);

    await this.db.tx(async (client) => {
      await this.anonAudit.snapshotTx(client, {
        dataCategory: this.category,
        refs,
        reason: 'retention',
        fetchOriginals: async () => {
          const r = await client.query<{ id: string; details: unknown; ip_address: string | null }>(
            `select id, details, ip_address
               from audit_events
              where tenant_id = $1 and id = any($2::uuid[])`,
            [tenantId, ids],
          );
          return r.rows.map((row) => ({
            resourceType: 'audit_events',
            resourceId: row.id,
            payload: { details: row.details, ip_address: row.ip_address },
          }));
        },
      });

      // Redact details.{actor_email,...} via a sequence of conditional
      // jsonb_set calls, one per key, gated by ?-membership so we don't
      // bloat the JSON with absent fields. Final jsonb_set marks the row
      // anonymized so scanForExpired won't return it again.
      let setExpr = 'details';
      for (const key of AuditEventsAdapter.REDACT_KEYS) {
        setExpr = `case when (${setExpr}) ? '${key}' then jsonb_set(${setExpr}, '{${key}}', '"<redacted>"'::jsonb, false) else (${setExpr}) end`;
      }
      setExpr = `jsonb_set(${setExpr}, '{anonymized}', 'true'::jsonb, true)`;

      await client.query(
        `update audit_events
            set details    = ${setExpr},
                ip_address = null
          where tenant_id = $1 and id = any($2::uuid[])
            and not coalesce((details->>'anonymized')::boolean, false)`,
        [tenantId, ids],
      );
    });
  }

  async hardDelete(_refs: EntityRef[]): Promise<void> {
    // audit_events is legal-obligation retention; hard delete is forbidden.
  }

  async exportForPerson(tenantId: string, personId: string): Promise<ExportSection> {
    // Person link via actor_user_id requires a join; users.person_id is the
    // bridge. For Sprint 2 we ship the simpler "actor matched directly via
    // user→person" path. Sprint 3 will broaden via search-in-details for
    // subject_person_id occurrences.
    const rows = await this.db.queryMany(
      `select ae.id, ae.event_type, ae.entity_type, ae.entity_id,
              ae.created_at, ae.details
         from audit_events ae
         join users u on u.id = ae.actor_user_id
        where ae.tenant_id = $1
          and u.person_id = $2
        order by ae.created_at desc
        limit 5000`,                              // bound the export per category
      [tenantId, personId],
    );
    return {
      category: this.category,
      description: 'Audit events where the subject is the actor (via user→person).',
      records: rows,
      totalCount: rows.length,
    };
  }

  async erasureRefs(tenantId: string, personId: string): Promise<EntityRef[]> {
    // Erasure of audit events is partial — legal_obligation prevents wholesale
    // delete, but PII redaction is allowed. Return refs so the orchestrator
    // can call .anonymize on them. The redaction set above scrubs PII from
    // details + nulls ip_address.
    const rows = await this.db.queryMany<{ id: string }>(
      `select ae.id
         from audit_events ae
         join users u on u.id = ae.actor_user_id
        where ae.tenant_id = $1
          and u.person_id = $2
          and not coalesce((ae.details->>'anonymized')::boolean, false)
        limit 100000`,
      [tenantId, personId],
    );
    return rows.map((r) => ({
      category: this.category,
      resourceType: 'audit_events',
      resourceId: r.id,
      tenantId,
    }));
  }
}

import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DbService } from '../../common/db/db.service';
import type { EntityRef } from './data-category.adapter';

/**
 * 7-day restore window for retention anonymization.
 *
 * Adapters that anonymize PII in-place call `snapshot()` BEFORE the UPDATE
 * so the originals are recoverable. After the 7-day window, RetentionWorker.
 * purgeAnonymizationAudit() hard-deletes these rows.
 *
 * Hard-delete categories (legal_basis === 'none', e.g. cctv_footage) do NOT
 * snapshot — there's nothing to recover, and we don't want to make GDPR
 * erasure recoverable.
 *
 * Spec: gdpr-baseline-design.md §4 ("Restore window").
 */
@Injectable()
export class AnonymizationAuditService {
  constructor(private readonly db: DbService) {}

  /**
   * Snapshot the originals for a batch of refs into anonymization_audit.
   * Caller passes a fetcher that knows how to query the source table.
   *
   * Multiple snapshots per ref are intentional: each represents a distinct
   * anonymization event (e.g. anonymize → admin restore → re-anonymize).
   * The 7-day expires_at + nightly purge keeps growth bounded.
   */
  async snapshot(input: SnapshotInput): Promise<void> {
    if (input.refs.length === 0) return;

    const originals = await input.fetchOriginals(input.refs);
    if (originals.length === 0) return;

    await this.db.query(
      this.buildInsertSql(originals.length),
      this.buildInsertParams(input, originals),
    );
  }

  /**
   * Tx-scoped variant — used when the snapshot must commit/rollback with the
   * surrounding anonymization UPDATE in a single transaction (recommended).
   */
  async snapshotTx(client: PoolClient, input: SnapshotInput): Promise<void> {
    if (input.refs.length === 0) return;

    const originals = await input.fetchOriginals(input.refs);
    if (originals.length === 0) return;

    await client.query(
      this.buildInsertSql(originals.length),
      this.buildInsertParams(input, originals),
    );
  }

  private buildInsertSql(rowCount: number): string {
    const values: string[] = [];
    let i = 1;
    for (let n = 0; n < rowCount; n += 1) {
      values.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++}::jsonb, $${i++}, $${i++})`);
    }
    return `insert into anonymization_audit
              (tenant_id, data_category, resource_type, resource_id, payload, reason, initiated_by_user_id)
            values ${values.join(', ')}`;
  }

  private buildInsertParams(input: SnapshotInput, originals: OriginalRow[]): unknown[] {
    const tenantId = input.refs[0].tenantId;
    const params: unknown[] = [];
    for (const o of originals) {
      params.push(
        tenantId,
        input.dataCategory,
        o.resourceType,
        o.resourceId,
        JSON.stringify(o.payload),
        input.reason,
        input.initiatedByUserId ?? null,
      );
    }
    return params;
  }
}

export interface SnapshotInput {
  dataCategory: string;
  refs: EntityRef[];
  reason: 'retention' | 'erasure_request' | 'departure_cleanup';
  initiatedByUserId?: string | null;
  /** Adapter-specific row fetcher. Returns the original payloads to snapshot. */
  fetchOriginals: (refs: EntityRef[]) => Promise<OriginalRow[]>;
}

export interface OriginalRow {
  resourceType: string;
  resourceId: string;
  /** Whatever the adapter wants captured. JSON-serializable. */
  payload: Record<string, unknown>;
}

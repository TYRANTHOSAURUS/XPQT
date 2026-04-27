import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DbService } from '../../common/db/db.service';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { AuditOutboxService } from './audit-outbox.service';
import { DataCategoryRegistry } from './data-category-registry.service';
import { GdprEventType } from './event-types';

/**
 * Fulfilment of GDPR Art. 15 (access) + Art. 20 (portability).
 *
 * Sprint 3 ships:
 *   - createAccessRequest()    — DSR row + audit
 *   - fulfillAccessRequest()  — runs every adapter's exportForPerson, builds
 *                                a single JSON bundle, uploads to Supabase
 *                                Storage, mints a 30-day signed URL.
 *
 * Sprint 4 will add the erasure endpoint that mirrors this surface.
 *
 * Spec: docs/superpowers/specs/2026-04-27-gdpr-baseline-design.md §6.
 */
@Injectable()
export class DataSubjectService {
  private readonly log = new Logger(DataSubjectService.name);

  /** Storage bucket from migration 00166. */
  private static readonly EXPORT_BUCKET = 'gdpr-exports';
  /** Signed URL TTL in seconds — 30 days per spec §6. */
  private static readonly SIGNED_URL_TTL_SECONDS = 30 * 24 * 60 * 60;

  constructor(
    private readonly db: DbService,
    private readonly supabase: SupabaseService,
    private readonly registry: DataCategoryRegistry,
    private readonly auditOutbox: AuditOutboxService,
  ) {}

  /**
   * Create the DSR row and emit the initiation audit. Returns the request
   * id; the caller (controller) typically immediately calls fulfill in the
   * same request — the two are split so future async pipelines can swap in.
   */
  async createAccessRequest(input: CreateAccessRequestInput): Promise<DsrRow> {
    const subject = await this.db.queryOne<{ id: string }>(
      `select id from persons where tenant_id = $1 and id = $2`,
      [input.tenantId, input.subjectPersonId],
    );
    if (!subject) {
      throw new NotFoundException(`Person ${input.subjectPersonId} not found in tenant ${input.tenantId}`);
    }

    const dsr = await this.db.queryOne<DsrRow>(
      `insert into data_subject_requests
         (tenant_id, request_type, subject_person_id, initiated_by_user_id, status)
       values ($1, 'access', $2, $3, 'in_progress')
       returning *`,
      [input.tenantId, input.subjectPersonId, input.initiatedByUserId],
    );
    if (!dsr) {
      throw new BadRequestException('Failed to create DSR row');
    }

    await this.auditOutbox.emit({
      tenantId: input.tenantId,
      eventType: GdprEventType.AccessRequestInitiated,
      entityType: 'data_subject_requests',
      entityId: dsr.id,
      actorUserId: input.initiatedByUserId,
      details: { subject_person_id: input.subjectPersonId },
    });

    return dsr;
  }

  /**
   * Run every registered adapter's exportForPerson, aggregate to a single
   * JSON bundle, upload to Supabase Storage, mark the DSR fulfilled.
   *
   * Returns the signed URL the admin can share with the data subject.
   */
  async fulfillAccessRequest(input: FulfillAccessRequestInput): Promise<FulfillAccessResult> {
    const dsr = await this.db.queryOne<DsrRow>(
      `select * from data_subject_requests
        where tenant_id = $1 and id = $2`,
      [input.tenantId, input.requestId],
    );
    if (!dsr) throw new NotFoundException('DSR not found');
    if (dsr.status === 'completed') {
      throw new BadRequestException('DSR already completed');
    }

    const adapters = this.registry.all();
    const sections: Record<string, unknown> = {};
    const breakdown: Record<string, { count: number; description: string }> = {};

    for (const adapter of adapters) {
      try {
        const section = await adapter.exportForPerson(input.tenantId, dsr.subject_person_id);
        sections[adapter.category] = section.records;
        breakdown[adapter.category] = {
          count: section.totalCount,
          description: section.description,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn(`adapter ${adapter.category} export failed: ${message}`);
        breakdown[adapter.category] = { count: 0, description: `export failed: ${message}` };
      }
    }

    const bundle = {
      request: {
        id: dsr.id,
        tenant_id: dsr.tenant_id,
        subject_person_id: dsr.subject_person_id,
        request_type: dsr.request_type,
        initiated_at: dsr.initiated_at,
        fulfilled_at: new Date().toISOString(),
        gdpr_reference: 'GDPR Art. 15 (access) / Art. 20 (portability)',
      },
      breakdown,
      data: sections,
    };

    const path = `${input.tenantId}/${dsr.id}/bundle.json`;
    const buf = Buffer.from(JSON.stringify(bundle, null, 2), 'utf8');

    const { error: uploadErr } = await this.supabase.admin.storage
      .from(DataSubjectService.EXPORT_BUCKET)
      .upload(path, buf, {
        contentType: 'application/json',
        upsert: true,
      });
    if (uploadErr) {
      throw new BadRequestException(`Bundle upload failed: ${uploadErr.message}`);
    }

    const { data: signed, error: signErr } = await this.supabase.admin.storage
      .from(DataSubjectService.EXPORT_BUCKET)
      .createSignedUrl(path, DataSubjectService.SIGNED_URL_TTL_SECONDS);
    if (signErr || !signed) {
      throw new BadRequestException(`Signed URL mint failed: ${signErr?.message ?? 'unknown'}`);
    }

    const expiresAt = new Date(Date.now() + DataSubjectService.SIGNED_URL_TTL_SECONDS * 1000);

    const updated = await this.db.queryOne<DsrRow>(
      `update data_subject_requests
          set status                = 'completed',
              completed_at          = now(),
              scope_breakdown       = $3::jsonb,
              output_storage_path   = $4,
              output_url_expires_at = $5
        where tenant_id = $1 and id = $2
        returning *`,
      [input.tenantId, input.requestId, JSON.stringify(breakdown), path, expiresAt.toISOString()],
    );

    await this.auditOutbox.emit({
      tenantId: input.tenantId,
      eventType: GdprEventType.AccessRequestFulfilled,
      entityType: 'data_subject_requests',
      entityId: input.requestId,
      actorUserId: input.actorUserId,
      details: {
        subject_person_id: dsr.subject_person_id,
        section_count: Object.keys(sections).length,
        record_total: Object.values(breakdown).reduce((sum, b) => sum + b.count, 0),
      },
    });

    return {
      request: updated ?? dsr,
      signedUrl: signed.signedUrl,
      expiresAt: expiresAt.toISOString(),
      path,
      breakdown,
    };
  }

  async getRequest(tenantId: string, requestId: string): Promise<DsrRow | null> {
    return this.db.queryOne<DsrRow>(
      `select * from data_subject_requests where tenant_id = $1 and id = $2`,
      [tenantId, requestId],
    );
  }

  async listRequests(tenantId: string, opts: { subjectPersonId?: string; status?: string } = {}): Promise<DsrRow[]> {
    const filters: string[] = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    if (opts.subjectPersonId) {
      params.push(opts.subjectPersonId);
      filters.push(`subject_person_id = $${params.length}`);
    }
    if (opts.status) {
      params.push(opts.status);
      filters.push(`status = $${params.length}`);
    }
    return this.db.queryMany<DsrRow>(
      `select * from data_subject_requests
        where ${filters.join(' and ')}
        order by initiated_at desc
        limit 200`,
      params,
    );
  }
}

export interface CreateAccessRequestInput {
  tenantId: string;
  subjectPersonId: string;
  initiatedByUserId: string;
}

export interface FulfillAccessRequestInput {
  tenantId: string;
  requestId: string;
  actorUserId: string;
}

export interface FulfillAccessResult {
  request: DsrRow;
  signedUrl: string;
  expiresAt: string;
  path: string;
  breakdown: Record<string, { count: number; description: string }>;
}

export interface DsrRow {
  id: string;
  tenant_id: string;
  request_type: string;
  subject_person_id: string;
  initiated_by_user_id: string | null;
  initiated_at: string;
  completed_at: string | null;
  status: string;
  decision_reason: string | null;
  scope_breakdown: unknown;
  output_storage_path: string | null;
  output_url_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

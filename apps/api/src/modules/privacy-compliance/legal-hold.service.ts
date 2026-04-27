import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DbService } from '../../common/db/db.service';
import { AuditOutboxService } from './audit-outbox.service';
import { GdprEventType } from './event-types';

/**
 * Active legal-hold management. The retention worker queries this table
 * directly via RetentionService.refTouchesHeldPerson — this service is
 * the admin-facing surface for placing + releasing holds with audit.
 *
 * Spec: docs/superpowers/specs/2026-04-27-gdpr-baseline-design.md §3 + §6.
 */
@Injectable()
export class LegalHoldService {
  constructor(
    private readonly db: DbService,
    private readonly auditOutbox: AuditOutboxService,
  ) {}

  async place(input: PlaceHoldInput): Promise<LegalHoldRow> {
    if (!input.reason || input.reason.trim().length < 8) {
      throw new BadRequestException('Reason required (>=8 chars) for placing a legal hold.');
    }

    // Enforce scope rules at the app layer too (DB also has a CHECK constraint
    // but we want a clean 400 not a 500 on invalid input).
    if (input.holdType === 'person' && !input.subjectPersonId) {
      throw new BadRequestException('subject_person_id required for person-level hold.');
    }
    if (input.holdType === 'category' && !input.dataCategory) {
      throw new BadRequestException('data_category required for category-level hold.');
    }
    if (input.holdType === 'tenant_wide' && (input.subjectPersonId || input.dataCategory)) {
      throw new BadRequestException('tenant_wide hold cannot specify subject or category.');
    }
    if (input.holdType === 'person' && input.dataCategory) {
      throw new BadRequestException('person hold cannot specify data_category.');
    }
    if (input.holdType === 'category' && input.subjectPersonId) {
      throw new BadRequestException('category hold cannot specify subject_person_id.');
    }

    const row = await this.db.queryOne<LegalHoldRow>(
      `insert into legal_holds
         (tenant_id, hold_type, subject_person_id, data_category,
          reason, initiated_by_user_id, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning *`,
      [
        input.tenantId,
        input.holdType,
        input.subjectPersonId ?? null,
        input.dataCategory ?? null,
        input.reason,
        input.initiatedByUserId,
        input.expiresAt ?? null,
      ],
    );
    if (!row) throw new BadRequestException('Failed to create legal hold');

    await this.auditOutbox.emit({
      tenantId: input.tenantId,
      eventType: GdprEventType.LegalHoldPlaced,
      entityType: 'legal_holds',
      entityId: row.id,
      actorUserId: input.initiatedByUserId,
      details: {
        hold_type: input.holdType,
        subject_person_id: input.subjectPersonId,
        data_category: input.dataCategory,
        reason: input.reason,
        expires_at: input.expiresAt,
      },
    });

    return row;
  }

  async release(input: ReleaseHoldInput): Promise<LegalHoldRow> {
    if (!input.reason || input.reason.trim().length < 8) {
      throw new BadRequestException('Reason required (>=8 chars) for releasing a legal hold.');
    }

    const row = await this.db.queryOne<LegalHoldRow>(
      `update legal_holds
          set released_at         = now(),
              released_by_user_id = $3
        where tenant_id = $1 and id = $2 and released_at is null
        returning *`,
      [input.tenantId, input.holdId, input.releasedByUserId],
    );
    if (!row) throw new NotFoundException('Active hold not found (already released?)');

    await this.auditOutbox.emit({
      tenantId: input.tenantId,
      eventType: GdprEventType.LegalHoldReleased,
      entityType: 'legal_holds',
      entityId: row.id,
      actorUserId: input.releasedByUserId,
      details: {
        hold_type: row.hold_type,
        subject_person_id: row.subject_person_id,
        data_category: row.data_category,
        reason: input.reason,
      },
    });

    return row;
  }

  async listActive(tenantId: string): Promise<LegalHoldRow[]> {
    return this.db.queryMany<LegalHoldRow>(
      `select * from legal_holds
        where tenant_id = $1
          and released_at is null
          and (expires_at is null or expires_at > now())
        order by initiated_at desc`,
      [tenantId],
    );
  }

  async listAll(tenantId: string, opts: { includeReleased?: boolean } = {}): Promise<LegalHoldRow[]> {
    if (opts.includeReleased) {
      return this.db.queryMany<LegalHoldRow>(
        `select * from legal_holds
          where tenant_id = $1
          order by initiated_at desc
          limit 500`,
        [tenantId],
      );
    }
    return this.listActive(tenantId);
  }

  async getById(tenantId: string, id: string): Promise<LegalHoldRow | null> {
    return this.db.queryOne<LegalHoldRow>(
      `select * from legal_holds where tenant_id = $1 and id = $2`,
      [tenantId, id],
    );
  }
}

export interface PlaceHoldInput {
  tenantId: string;
  holdType: 'person' | 'category' | 'tenant_wide';
  subjectPersonId?: string | null;
  dataCategory?: string | null;
  reason: string;
  initiatedByUserId: string;
  expiresAt?: string | null;            // ISO date string
}

export interface ReleaseHoldInput {
  tenantId: string;
  holdId: string;
  releasedByUserId: string;
  reason: string;
}

export interface LegalHoldRow {
  id: string;
  tenant_id: string;
  hold_type: 'person' | 'category' | 'tenant_wide';
  subject_person_id: string | null;
  data_category: string | null;
  reason: string;
  initiated_by_user_id: string;
  initiated_at: string;
  expires_at: string | null;
  released_at: string | null;
  released_by_user_id: string | null;
}

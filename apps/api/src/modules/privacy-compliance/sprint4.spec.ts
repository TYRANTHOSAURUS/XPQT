import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AuditOutboxService } from './audit-outbox.service';
import { LegalHoldService } from './legal-hold.service';

const TENANT = 'a1b2c3d4-e5f6-4789-9abc-def012345678';
const USER = 'b2c3d4e5-f6a7-4b89-8cde-f0123456789a';
const HOLD_ID = 'c3d4e5f6-a7b8-4c9d-9ef0-123456789abc';

function makeFakeDb(canned: { row?: Record<string, unknown> | null } = {}) {
  const captured: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    captured,
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }),
    queryOne: jest.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      return canned.row ?? null;
    }),
    queryMany: jest.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      return [];
    }),
    rpc: jest.fn(),
    tx: jest.fn(),
  };
}

describe('LegalHoldService.place', () => {
  function build(insertReturns: Record<string, unknown> | null = { id: HOLD_ID, hold_type: 'person' }) {
    const db = makeFakeDb({ row: insertReturns });
    const audit = new AuditOutboxService(db as any);
    return { db, audit, svc: new LegalHoldService(db as any, audit) };
  }

  it('rejects short reasons', async () => {
    const { svc } = build();
    await expect(
      svc.place({ tenantId: TENANT, holdType: 'person', subjectPersonId: USER, reason: 'short', initiatedByUserId: USER }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects person hold without subject_person_id', async () => {
    const { svc } = build();
    await expect(
      svc.place({ tenantId: TENANT, holdType: 'person', reason: 'reasonably long', initiatedByUserId: USER }),
    ).rejects.toThrow(/subject_person_id required/);
  });

  it('rejects category hold without data_category', async () => {
    const { svc } = build();
    await expect(
      svc.place({ tenantId: TENANT, holdType: 'category', reason: 'reasonably long', initiatedByUserId: USER }),
    ).rejects.toThrow(/data_category required/);
  });

  it('rejects tenant_wide hold with subject', async () => {
    const { svc } = build();
    await expect(
      svc.place({ tenantId: TENANT, holdType: 'tenant_wide', subjectPersonId: USER, reason: 'reasonably long', initiatedByUserId: USER }),
    ).rejects.toThrow(/cannot specify subject/);
  });

  it('places a person hold and emits audit', async () => {
    const { svc, db } = build();
    const r = await svc.place({
      tenantId: TENANT, holdType: 'person', subjectPersonId: USER,
      reason: 'pending litigation', initiatedByUserId: USER,
    });
    expect(r.id).toBe(HOLD_ID);
    // 2 inserts captured: legal_holds insert + audit_outbox emit
    const inserts = db.captured.filter((c) => c.sql.includes('insert into'));
    expect(inserts.some((c) => c.sql.includes('legal_holds'))).toBe(true);
    expect(inserts.some((c) => c.sql.includes('audit_outbox'))).toBe(true);
  });
});

describe('LegalHoldService.release', () => {
  it('throws NotFoundException when no active hold matches', async () => {
    const db = makeFakeDb({ row: null });
    const svc = new LegalHoldService(db as any, new AuditOutboxService(db as any));
    await expect(
      svc.release({ tenantId: TENANT, holdId: HOLD_ID, releasedByUserId: USER, reason: 'dispute resolved' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects short reasons', async () => {
    const db = makeFakeDb({ row: { id: HOLD_ID } });
    const svc = new LegalHoldService(db as any, new AuditOutboxService(db as any));
    await expect(
      svc.release({ tenantId: TENANT, holdId: HOLD_ID, releasedByUserId: USER, reason: 'x' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('emits release audit when successful', async () => {
    const db = makeFakeDb({ row: { id: HOLD_ID, hold_type: 'person', subject_person_id: USER, data_category: null } });
    const svc = new LegalHoldService(db as any, new AuditOutboxService(db as any));
    const r = await svc.release({
      tenantId: TENANT, holdId: HOLD_ID, releasedByUserId: USER,
      reason: 'dispute resolved',
    });
    expect(r.id).toBe(HOLD_ID);
    const audited = db.captured.some((c) => c.sql.includes('insert into audit_outbox'));
    expect(audited).toBe(true);
  });
});

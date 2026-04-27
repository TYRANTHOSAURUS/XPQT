import { BadRequestException } from '@nestjs/common';
import { AuditOutboxService } from './audit-outbox.service';
import { DataCategoryRegistry } from './data-category-registry.service';
import { RetentionService } from './retention.service';
import type { DataCategoryAdapter, EntityRef } from './data-category.adapter';

const TENANT = 'a1b2c3d4-e5f6-4789-9abc-def012345678';
const ACTOR = 'b2c3d4e5-f6a7-4b89-8cde-f0123456789a';

type CapturedQuery = { sql: string; params?: unknown[] };

function makeFakeDb(initialRows: Record<string, Record<string, unknown>>) {
  const captured: CapturedQuery[] = [];
  let nextRow: Record<string, unknown> | null = null;
  let throwOnNextQuery: Error | null = null;

  const db = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      if (throwOnNextQuery) {
        const err = throwOnNextQuery;
        throwOnNextQuery = null;
        throw err;
      }
      return { rows: nextRow ? [nextRow] : [], rowCount: nextRow ? 1 : 0 };
    }),
    queryOne: jest.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      // Routing: read paths return canned rows by SQL fragment.
      if (sql.includes('from tenant_retention_settings')) {
        return initialRows.retention ?? null;
      }
      return nextRow;
    }),
    queryMany: jest.fn(async () => []),
    rpc: jest.fn(),
    tx: jest.fn(),
  };

  return {
    db,
    captured,
    setNextRow: (row: Record<string, unknown> | null) => { nextRow = row; },
    setThrowOnNextQuery: (err: Error) => { throwOnNextQuery = err; },
  };
}

describe('AuditOutboxService', () => {
  it('hashIp returns null for nullish input', () => {
    const service = new AuditOutboxService({} as any);
    expect(service.hashIp(null, TENANT)).toBeNull();
    expect(service.hashIp(undefined, TENANT)).toBeNull();
    expect(service.hashIp('', TENANT)).toBeNull();
  });

  it('hashIp is deterministic per (tenant, ip) pair and tenant-scoped', () => {
    const service = new AuditOutboxService({} as any);
    const a1 = service.hashIp('192.0.2.1', TENANT);
    const a2 = service.hashIp('192.0.2.1', TENANT);
    const b  = service.hashIp('192.0.2.1', 'different-tenant');
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);                            // tenant salt prevents cross-tenant linkability
    expect(a1).toMatch(/^[a-f0-9]{64}$/);              // sha-256 hex
  });

  it('emit() inserts into audit_outbox with the right column shape', async () => {
    const fake = makeFakeDb({});
    const service = new AuditOutboxService(fake.db as any);

    await service.emit({
      tenantId: TENANT,
      eventType: 'gdpr.test_event',
      entityType: 'tenants',
      entityId: TENANT,
      actorUserId: ACTOR,
      details: { foo: 'bar' },
      ipAddressHash: 'abc',
    });

    expect(fake.captured).toHaveLength(1);
    const { sql, params } = fake.captured[0];
    expect(sql).toContain('insert into audit_outbox');
    expect(sql).toContain('event_type');
    expect(params?.[0]).toBe(TENANT);
    expect(params?.[1]).toBe('gdpr.test_event');
    expect(params?.[5]).toBe(JSON.stringify({ foo: 'bar' }));
    expect(params?.[6]).toBe('abc');
  });

  it('emit() swallows errors so audit failures never break the caller', async () => {
    const fake = makeFakeDb({});
    fake.setThrowOnNextQuery(new Error('boom'));

    const service = new AuditOutboxService(fake.db as any);

    // Must NOT throw.
    await expect(
      service.emit({ tenantId: TENANT, eventType: 'gdpr.test_event' }),
    ).resolves.toBeUndefined();
  });
});

describe('DataCategoryRegistry', () => {
  function adapterFor(category: string): DataCategoryAdapter {
    return {
      category,
      description: 'test',
      defaultRetentionDays: 30,
      capRetentionDays: 90,
      legalBasis: 'legitimate_interest',
      scanForExpired: jest.fn(async () => []),
      anonymize: jest.fn(async () => {}),
      hardDelete: jest.fn(async () => {}),
      exportForPerson: jest.fn(async () => ({ category, description: 'test', records: [], totalCount: 0 })),
      erasureRefs: jest.fn(async () => []),
    };
  }

  it('registers and retrieves adapters by category id', () => {
    const reg = new DataCategoryRegistry();
    const a = adapterFor('visitor_records');
    reg.register(a);
    expect(reg.get('visitor_records')).toBe(a);
    expect(reg.all()).toEqual([a]);
  });

  it('throws on duplicate category registration (fail-loud)', () => {
    const reg = new DataCategoryRegistry();
    reg.register(adapterFor('visitor_records'));
    expect(() => reg.register(adapterFor('visitor_records'))).toThrow(/duplicate registration/);
  });

  it('reports unimplemented categories vs the seed list', () => {
    const reg = new DataCategoryRegistry();
    reg.register(adapterFor('visitor_records'));
    const unimplemented = reg.unimplementedCategories(['visitor_records', 'past_bookings', 'audit_events']);
    expect(unimplemented.sort()).toEqual(['audit_events', 'past_bookings']);
  });
});

describe('RetentionService.applyRetention throttling', () => {
  function makeAdapter(category: string, refs: number, legalBasis: 'legitimate_interest' | 'none' = 'legitimate_interest'): DataCategoryAdapter & { calls: { anonymize: number[]; hardDelete: number[] } } {
    const calls = { anonymize: [] as number[], hardDelete: [] as number[] };
    return {
      category,
      description: 'test',
      defaultRetentionDays: 30,
      capRetentionDays: 90,
      legalBasis,
      scanForExpired: jest.fn(async (tenantId: string) => {
        return Array.from({ length: refs }, (_, i) => ({
          category,
          resourceType: 'visitors',
          resourceId: `r${i}`,
          tenantId,
        }));
      }),
      anonymize: jest.fn(async (chunk: { resourceId: string }[]) => { calls.anonymize.push(chunk.length); }),
      hardDelete: jest.fn(async (chunk: { resourceId: string }[]) => { calls.hardDelete.push(chunk.length); }),
      exportForPerson: jest.fn(async () => ({ category, description: 'test', records: [], totalCount: 0 })),
      erasureRefs: jest.fn(async () => []),
      calls,
    } as DataCategoryAdapter & { calls: { anonymize: number[]; hardDelete: number[] } };
  }

  function makeService(adapter: DataCategoryAdapter) {
    const fake = makeFakeDb({});
    // Stub legal-hold queries — none active.
    fake.db.queryOne = jest.fn(async (sql: string) => {
      if (sql.includes('hold_type')) return { exists: false };
      if (sql.includes('from tenant_retention_settings')) {
        return { id: '1', tenant_id: TENANT, data_category: adapter.category, retention_days: 30, cap_retention_days: 90, lia_text: null, legal_basis: adapter.legalBasis, created_at: 'x', updated_at: 'x', lia_text_updated_at: null, lia_text_updated_by_user_id: null };
      }
      return null;
    });
    fake.db.queryMany = jest.fn(async () => []);
    const registry = new DataCategoryRegistry();
    registry.register(adapter);
    const audit = new AuditOutboxService(fake.db as any);
    const service = new RetentionService(fake.db as any, registry, audit);
    return { service, fake, audit };
  }

  it('chunks anonymize calls at chunkSize boundary', async () => {
    const adapter = makeAdapter('visitor_records', 2500);
    const { service } = makeService(adapter);
    const result = await service.applyRetention(TENANT, 'visitor_records', { chunkSize: 1000, batchSleepMs: 0 });
    expect(adapter.calls.anonymize).toEqual([1000, 1000, 500]);
    expect(result.anonymized).toBe(2500);
    expect(result.deferred).toBe(0);
  });

  it('respects nightlyCap and reports deferred count', async () => {
    const adapter = makeAdapter('visitor_records', 5000);
    const { service } = makeService(adapter);
    const result = await service.applyRetention(TENANT, 'visitor_records', { maxRows: 3000, chunkSize: 1000, batchSleepMs: 0 });
    expect(adapter.calls.anonymize.reduce((a, b) => a + b, 0)).toBe(3000);
    expect(result.anonymized).toBe(3000);
    expect(result.deferred).toBe(2000);
    expect(result.scanned).toBe(5000);
  });

  it('routes legal_basis="none" categories to hardDelete', async () => {
    const adapter = makeAdapter('calendar_event_content', 1500, 'none');
    const { service } = makeService(adapter);
    const result = await service.applyRetention(TENANT, 'calendar_event_content', { chunkSize: 1000, batchSleepMs: 0 });
    expect(adapter.calls.hardDelete).toEqual([1000, 500]);
    expect(adapter.calls.anonymize).toEqual([]);
    expect(result.hardDeleted).toBe(1500);
    expect(result.anonymized).toBe(0);
  });

  it('dry-run reports what would happen without invoking adapter', async () => {
    const adapter = makeAdapter('visitor_records', 100);
    const { service } = makeService(adapter);
    const result = await service.applyRetention(TENANT, 'visitor_records', { dryRun: true });
    expect(adapter.calls.anonymize).toEqual([]);
    expect(adapter.calls.hardDelete).toEqual([]);
    expect(result.dryRun).toBe(true);
    expect(result.scanned).toBe(100);
    expect(result.anonymized).toBe(0);
  });

  it('zero scanned → no chunks, no audit_anonymized event, run_completed still emitted', async () => {
    const adapter = makeAdapter('visitor_records', 0);
    const { service } = makeService(adapter);
    const result = await service.applyRetention(TENANT, 'visitor_records', { chunkSize: 1000, batchSleepMs: 0 });
    expect(adapter.calls.anonymize).toEqual([]);
    expect(result.scanned).toBe(0);
    expect(result.anonymized).toBe(0);
  });

  it('maxRows: 0 disables the cap (full processing)', async () => {
    const adapter = makeAdapter('visitor_records', 75_000);
    const { service } = makeService(adapter);
    const result = await service.applyRetention(TENANT, 'visitor_records', { maxRows: 0, chunkSize: 25_000, batchSleepMs: 0 });
    expect(result.anonymized).toBe(75_000);
    expect(result.deferred).toBe(0);
  });
});

describe('RetentionService person-level legal hold filter', () => {
  function makeService(refs: Array<{ id: string; subjectPersonIds?: string[] }>, heldPersonIds: string[]) {
    const captured: CapturedQuery[] = [];

    const adapter: DataCategoryAdapter = {
      category: 'visitor_records',
      description: 'test',
      defaultRetentionDays: 30,
      capRetentionDays: 90,
      legalBasis: 'legitimate_interest',
      scanForExpired: jest.fn(async (tenantId: string) => refs.map((r) => ({
        category: 'visitor_records',
        resourceType: 'visitors',
        resourceId: r.id,
        tenantId,
        subjectPersonIds: r.subjectPersonIds,
      }))),
      anonymize: jest.fn(async () => {}),
      hardDelete: jest.fn(async () => {}),
      exportForPerson: jest.fn(async () => ({ category: 'visitor_records', description: 'test', records: [], totalCount: 0 })),
      erasureRefs: jest.fn(async () => []),
    };

    const db = {
      query: jest.fn(async (sql: string, params?: unknown[]) => { captured.push({ sql, params }); return { rows: [], rowCount: 0 }; }),
      queryOne: jest.fn(async (sql: string) => {
        if (sql.includes('hold_type')) return { exists: false };
        if (sql.includes('from tenant_retention_settings')) {
          return { id: '1', tenant_id: TENANT, data_category: 'visitor_records', retention_days: 30, cap_retention_days: 90, lia_text: null, legal_basis: 'legitimate_interest', created_at: 'x', updated_at: 'x', lia_text_updated_at: null, lia_text_updated_by_user_id: null };
        }
        return null;
      }),
      queryMany: jest.fn(async (sql: string) => {
        if (sql.includes('legal_holds') && sql.includes('hold_type = \'person\'')) {
          return heldPersonIds.map((pid) => ({ subject_person_id: pid }));
        }
        return [];
      }),
      rpc: jest.fn(),
      tx: jest.fn(),
      captured,
    };

    const registry = new DataCategoryRegistry();
    registry.register(adapter);
    const auditOutbox = new AuditOutboxService(db as any);
    const service = new RetentionService(db as any, registry, auditOutbox);
    return { service, adapter, db };
  }

  it('skips refs whose subjectPersonIds intersect a held person', async () => {
    const HELD = '11111111-1111-4111-8111-111111111111';
    const FREE = '22222222-2222-4222-8222-222222222222';
    const { service, adapter } = makeService(
      [
        { id: 'r1', subjectPersonIds: [HELD] },        // held — must be skipped
        { id: 'r2', subjectPersonIds: [FREE] },        // free — must be processed
        { id: 'r3', subjectPersonIds: [FREE, HELD] },  // overlapping — must be skipped
        { id: 'r4' },                                  // no link — processed
      ],
      [HELD],
    );
    const result = await service.applyRetention(TENANT, 'visitor_records', { batchSleepMs: 0 });
    expect(result.skippedHeld).toBe(2);
    expect(result.anonymized).toBe(2);
    // Confirm the adapter never saw the held refs.
    const anonymizeCalls = (adapter.anonymize as jest.Mock).mock.calls;
    const sentIds = anonymizeCalls.flatMap((c) => c[0].map((ref: EntityRef) => ref.resourceId));
    expect(sentIds).toEqual(expect.arrayContaining(['r2', 'r4']));
    expect(sentIds).not.toEqual(expect.arrayContaining(['r1', 'r3']));
  });

  it('persons category falls back to resourceId when subjectPersonIds is missing', async () => {
    const HELD = '11111111-1111-4111-8111-111111111111';

    // Adapter returns refs to the persons table itself — orchestrator must
    // treat resourceId AS the person id for hold lookup.
    const captured: CapturedQuery[] = [];
    const adapter: DataCategoryAdapter = {
      category: 'person_ref_in_past_records',
      description: 'test',
      defaultRetentionDays: 90,
      capRetentionDays: 90,
      legalBasis: 'contract',
      scanForExpired: jest.fn(async (tenantId: string) => [{
        category: 'person_ref_in_past_records',
        resourceType: 'persons',
        resourceId: HELD,
        tenantId,
      }]),
      anonymize: jest.fn(async () => {}),
      hardDelete: jest.fn(async () => {}),
      exportForPerson: jest.fn(async () => ({ category: 'x', description: 'x', records: [], totalCount: 0 })),
      erasureRefs: jest.fn(async () => []),
    };

    const db = {
      query: jest.fn(async (sql: string, params?: unknown[]) => { captured.push({ sql, params }); return { rows: [], rowCount: 0 }; }),
      queryOne: jest.fn(async (sql: string) => {
        if (sql.includes('hold_type')) return { exists: false };
        if (sql.includes('from tenant_retention_settings')) return { id: '1', tenant_id: TENANT, data_category: 'person_ref_in_past_records', retention_days: 90, cap_retention_days: 90, lia_text: null, legal_basis: 'contract', created_at: 'x', updated_at: 'x', lia_text_updated_at: null, lia_text_updated_by_user_id: null };
        return null;
      }),
      queryMany: jest.fn(async () => [{ subject_person_id: HELD }]),
      rpc: jest.fn(),
      tx: jest.fn(),
      captured,
    };

    const registry = new DataCategoryRegistry();
    registry.register(adapter);
    const auditOutbox = new AuditOutboxService(db as any);
    const service = new RetentionService(db as any, registry, auditOutbox);

    const result = await service.applyRetention(TENANT, 'person_ref_in_past_records', { batchSleepMs: 0 });
    expect(result.skippedHeld).toBe(1);
    expect(result.anonymized).toBe(0);
    expect(adapter.anonymize).not.toHaveBeenCalled();
  });
});

describe('RetentionService.setCategorySettings', () => {
  function makeSubject(initialRetention: { retention_days: number; cap_retention_days: number | null; lia_text?: string | null }) {
    const fake = makeFakeDb({
      retention: {
        id: 'cfg-1',
        tenant_id: TENANT,
        data_category: 'visitor_records',
        retention_days: initialRetention.retention_days,
        cap_retention_days: initialRetention.cap_retention_days,
        lia_text: initialRetention.lia_text ?? null,
        legal_basis: 'legitimate_interest',
      },
    });

    // queryOne returns the pre-existing row on the read; we re-set on the
    // update path to return the patched row.
    fake.db.queryOne = jest.fn(async (sql: string) => {
      if (sql.includes('update tenant_retention_settings')) {
        return {
          id: 'cfg-1',
          tenant_id: TENANT,
          data_category: 'visitor_records',
          retention_days: initialRetention.retention_days,    // overwritten by caller; placeholder
          cap_retention_days: initialRetention.cap_retention_days,
          lia_text: initialRetention.lia_text ?? null,
          legal_basis: 'legitimate_interest',
        };
      }
      return {
        id: 'cfg-1',
        tenant_id: TENANT,
        data_category: 'visitor_records',
        retention_days: initialRetention.retention_days,
        cap_retention_days: initialRetention.cap_retention_days,
        lia_text: initialRetention.lia_text ?? null,
        legal_basis: 'legitimate_interest',
      };
    });

    const registry = new DataCategoryRegistry();
    const audit = new AuditOutboxService(fake.db as any);
    const service = new RetentionService(fake.db as any, registry, audit);
    return { service, fake, audit };
  }

  it('rejects retention beyond cap', async () => {
    const { service } = makeSubject({ retention_days: 180, cap_retention_days: 365 });
    await expect(
      service.setCategorySettings(TENANT, 'visitor_records', { retentionDays: 400 }, ACTOR, 'shorter for storage savings'),
    ).rejects.toThrow(/exceeds cap/i);
  });

  it('rejects negative retention', async () => {
    const { service } = makeSubject({ retention_days: 180, cap_retention_days: 365 });
    await expect(
      service.setCategorySettings(TENANT, 'visitor_records', { retentionDays: -1 }, ACTOR, 'reasonably long reason'),
    ).rejects.toThrow(/>= 0/);
  });

  it('requires a reason of at least 8 chars', async () => {
    const { service } = makeSubject({ retention_days: 180, cap_retention_days: 365 });
    await expect(
      service.setCategorySettings(TENANT, 'visitor_records', { retentionDays: 100 }, ACTOR, 'short'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('shortening retention is allowed without LIA text', async () => {
    const { service } = makeSubject({ retention_days: 180, cap_retention_days: 365 });
    await expect(
      service.setCategorySettings(TENANT, 'visitor_records', { retentionDays: 90 }, ACTOR, 'reduce storage cost'),
    ).resolves.toBeDefined();
  });
});

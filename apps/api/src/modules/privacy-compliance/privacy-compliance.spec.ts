import { BadRequestException } from '@nestjs/common';
import { AuditOutboxService } from './audit-outbox.service';
import { DataCategoryRegistry } from './data-category-registry.service';
import { RetentionService } from './retention.service';
import type { DataCategoryAdapter } from './data-category.adapter';

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

import { AnonymizationAuditService } from '../anonymization-audit.service';
import type { EntityRef } from '../data-category.adapter';
import { AuditEventsAdapter } from './audit-events.adapter';
import {
  makeHardDeleteByDateAdapter,
  makeNoOpAdapter,
  makePendingSpecAdapter,
} from './factory';
import { PersonsAdapter } from './persons.adapter';
import { VisitorRecordsAdapter } from './visitor-records.adapter';

const TENANT = 'a1b2c3d4-e5f6-4789-9abc-def012345678';

type CapturedQuery = { sql: string; params?: unknown[] };

interface FakeDb {
  query: jest.Mock;
  queryOne: jest.Mock;
  queryMany: jest.Mock;
  rpc: jest.Mock;
  tx: jest.Mock;
  captured: CapturedQuery[];
}

function makeFakeDb(): FakeDb {
  const captured: CapturedQuery[] = [];

  const txClient = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql: `[tx]${sql}`, params });
      // SELECT-originals shape: return one populated row so snapshot proceeds.
      // Other shapes (INSERT, UPDATE) — empty result is fine.
      if (sql.trim().startsWith('select')) {
        return { rows: [{ id: 'v1', badge_id: 'B1', person_id: 'p1', host_person_id: 'p2', status: 'checked_out', visit_date: '2025-01-01', first_name: 'A', last_name: 'B', email: 'e', phone: 'p', avatar_url: null, details: {}, ip_address: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };

  const fake: FakeDb = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }),
    queryOne: jest.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      return null;
    }),
    queryMany: jest.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      return [];
    }),
    rpc: jest.fn(),
    tx: jest.fn(async (fn: (client: typeof txClient) => Promise<unknown>) => fn(txClient)),
    captured,
  };
  return fake;
}

describe('makeHardDeleteByDateAdapter', () => {
  it('scanForExpired returns refs from a date-filter query', async () => {
    const db = makeFakeDb();
    db.queryMany = jest.fn(async () => [{ id: 'r1' }, { id: 'r2' }]);
    const adapter = makeHardDeleteByDateAdapter(
      {
        category: 'webhook_notifications',
        description: 'test',
        defaultRetentionDays: 30,
        capRetentionDays: 365,
        table: 'webhook_events',
        dateColumn: 'received_at',
      },
      db as any,
    );
    const refs = await adapter.scanForExpired(TENANT, 30);
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({ category: 'webhook_notifications', resourceType: 'webhook_events', resourceId: 'r1', tenantId: TENANT });
    expect(db.queryMany.mock.calls[0][0]).toContain('webhook_events');
    expect(db.queryMany.mock.calls[0][0]).toContain('received_at');
  });

  it('scanForExpired returns empty when retentionDays <= 0 (no warehousing)', async () => {
    const db = makeFakeDb();
    const adapter = makeHardDeleteByDateAdapter(
      {
        category: 'x', description: 'x',
        defaultRetentionDays: 0, capRetentionDays: 0,
        table: 't', dateColumn: 'd',
      },
      db as any,
    );
    expect(await adapter.scanForExpired(TENANT, 0)).toEqual([]);
    expect(db.queryMany).not.toHaveBeenCalled();
  });

  it('hardDelete is no-op for empty refs', async () => {
    const db = makeFakeDb();
    const adapter = makeHardDeleteByDateAdapter(
      { category: 'x', description: 'x', defaultRetentionDays: 30, capRetentionDays: null, table: 't', dateColumn: 'd' },
      db as any,
    );
    await adapter.hardDelete([]);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('hardDelete fires DELETE with tenant + id-array params', async () => {
    const db = makeFakeDb();
    const adapter = makeHardDeleteByDateAdapter(
      { category: 'x', description: 'x', defaultRetentionDays: 30, capRetentionDays: null, table: 'webhook_events', dateColumn: 'received_at' },
      db as any,
    );
    const refs: EntityRef[] = [
      { category: 'x', resourceType: 'webhook_events', resourceId: 'r1', tenantId: TENANT },
      { category: 'x', resourceType: 'webhook_events', resourceId: 'r2', tenantId: TENANT },
    ];
    await adapter.hardDelete(refs);
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('delete from webhook_events');
    expect(params[0]).toBe(TENANT);
    expect(params[1]).toEqual(['r1', 'r2']);
  });
});

describe('makeNoOpAdapter', () => {
  it('reports no-op rationale in description', async () => {
    const adapter = makeNoOpAdapter({
      category: 'past_bookings',
      description: 'historical bookings',
      defaultRetentionDays: 2555,
      capRetentionDays: null,
      legalBasis: 'legal_obligation',
      rationale: 'PII via FK',
    });
    expect(adapter.description).toContain('no-op');
    expect(adapter.description).toContain('PII via FK');
    expect(await adapter.scanForExpired(TENANT, 2555)).toEqual([]);
    expect((await adapter.exportForPerson(TENANT, 'p1')).records).toEqual([]);
  });
});

describe('makePendingSpecAdapter', () => {
  it('returns a no-op adapter that surfaces the pending spec name', async () => {
    const adapter = makePendingSpecAdapter({
      category: 'visitor_photos_ids',
      description: 'visitor photos',
      defaultRetentionDays: 90,
      capRetentionDays: 180,
      legalBasis: 'legitimate_interest',
      pendingSpec: 'visitor management spec',
    });
    expect(adapter.description).toContain('visitor management spec');
    expect(await adapter.scanForExpired(TENANT, 90)).toEqual([]);
  });
});

describe('VisitorRecordsAdapter', () => {
  function build() {
    const db = makeFakeDb();
    const anon = new AnonymizationAuditService(db as any);
    return { db, adapter: new VisitorRecordsAdapter(db as any, anon) };
  }

  it('scanForExpired filters by anonymized_at IS NULL + terminal status + visit_date', async () => {
    const { db, adapter } = build();
    db.queryMany = jest.fn(async () => [{ id: 'v1' }]);
    const refs = await adapter.scanForExpired(TENANT, 180);
    expect(refs).toEqual([{ category: 'visitor_records', resourceType: 'visitors', resourceId: 'v1', tenantId: TENANT }]);
    const sql = db.queryMany.mock.calls[0][0];
    expect(sql).toContain('anonymized_at is null');
    expect(sql).toContain('checked_out');
  });

  it('anonymize is a no-op for empty refs', async () => {
    const { db, adapter } = build();
    await adapter.anonymize([]);
    expect(db.tx).not.toHaveBeenCalled();
  });

  it('anonymize captures snapshot then fires UPDATE', async () => {
    const { db, adapter } = build();
    const refs: EntityRef[] = [{ category: 'visitor_records', resourceType: 'visitors', resourceId: 'v1', tenantId: TENANT }];
    await adapter.anonymize(refs);
    expect(db.tx).toHaveBeenCalledTimes(1);
    // Inside the tx, both fetch + insert + update must have run.
    const txSqls = db.captured.filter((c) => c.sql.startsWith('[tx]')).map((c) => c.sql);
    expect(txSqls.some((s) => s.includes('select id, badge_id'))).toBe(true);
    expect(txSqls.some((s) => s.includes('insert into anonymization_audit'))).toBe(true);
    expect(txSqls.some((s) => s.includes('update visitors'))).toBe(true);
  });
});

describe('PersonsAdapter', () => {
  function build() {
    const db = makeFakeDb();
    const anon = new AnonymizationAuditService(db as any);
    return { db, adapter: new PersonsAdapter(db as any, anon) };
  }

  it('scanForExpired requires left_at + retention elapsed', async () => {
    const { db, adapter } = build();
    db.queryMany = jest.fn(async () => [{ id: 'p1' }]);
    const refs = await adapter.scanForExpired(TENANT, 90);
    expect(refs[0].resourceId).toBe('p1');
    const sql = db.queryMany.mock.calls[0][0];
    expect(sql).toContain('left_at is not null');
    expect(sql).toContain('anonymized_at is null');
  });

  it('anonymize sets stable hash placeholder per person id', async () => {
    const { db, adapter } = build();
    const refs: EntityRef[] = [
      { category: 'person_ref_in_past_records', resourceType: 'persons', resourceId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', tenantId: TENANT },
    ];
    await adapter.anonymize(refs);
    const updates = db.captured.filter((c) => c.sql.startsWith('[tx]') && c.sql.includes('update persons'));
    expect(updates).toHaveLength(1);
    // Placeholder is "Former employee" (first_name) + "#<hash8>" (last_name).
    expect(updates[0].params?.[2]).toBe('Former employee');
    expect(updates[0].params?.[3]).toMatch(/^#[a-f0-9]{8}$/);
  });
});

describe('AuditEventsAdapter', () => {
  function build() {
    const db = makeFakeDb();
    const anon = new AnonymizationAuditService(db as any);
    return { db, adapter: new AuditEventsAdapter(db as any, anon) };
  }

  it('scanForExpired skips already-anonymized rows', async () => {
    const { db, adapter } = build();
    db.queryMany = jest.fn(async () => []);
    await adapter.scanForExpired(TENANT, 2555);
    const sql = db.queryMany.mock.calls[0][0];
    expect(sql).toContain("(details->>'anonymized')::boolean");
  });

  it('anonymize redacts each known PII key + sets anonymized flag', async () => {
    const { db, adapter } = build();
    const refs: EntityRef[] = [{ category: 'audit_events', resourceType: 'audit_events', resourceId: 'e1', tenantId: TENANT }];
    await adapter.anonymize(refs);
    const updates = db.captured.filter((c) => c.sql.startsWith('[tx]') && c.sql.includes('update audit_events'));
    expect(updates).toHaveLength(1);
    const sql = updates[0].sql;
    // Each redacted key gets a jsonb_set + ?-membership guard.
    for (const key of ['actor_email', 'subject_email', 'ip_address', 'ip_hash']) {
      expect(sql).toContain(`'${key}'`);
    }
    expect(sql).toContain("'{anonymized}'");
  });
});

describe('AnonymizationAuditService', () => {
  it('snapshot is a no-op when refs is empty', async () => {
    const db = makeFakeDb();
    const svc = new AnonymizationAuditService(db as any);
    await svc.snapshot({ dataCategory: 'x', refs: [], reason: 'retention', fetchOriginals: async () => [] });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('snapshot inserts one row per fetched original with shared tenant + reason', async () => {
    const db = makeFakeDb();
    const svc = new AnonymizationAuditService(db as any);
    await svc.snapshot({
      dataCategory: 'visitor_records',
      reason: 'retention',
      refs: [
        { category: 'visitor_records', resourceType: 'visitors', resourceId: 'v1', tenantId: TENANT },
        { category: 'visitor_records', resourceType: 'visitors', resourceId: 'v2', tenantId: TENANT },
      ],
      fetchOriginals: async () => [
        { resourceType: 'visitors', resourceId: 'v1', payload: { badge_id: 'B1' } },
        { resourceType: 'visitors', resourceId: 'v2', payload: { badge_id: 'B2' } },
      ],
    });
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('insert into anonymization_audit');
    // 7 params per row × 2 rows = 14 params.
    expect((params as unknown[]).length).toBe(14);
    expect(params[0]).toBe(TENANT);
    expect(params[1]).toBe('visitor_records');
    expect(params[5]).toBe('retention');
  });
});

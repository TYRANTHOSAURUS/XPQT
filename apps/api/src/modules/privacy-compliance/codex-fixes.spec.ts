import { AnonymizationAuditService } from './anonymization-audit.service';

const TENANT = 'a1b2c3d4-e5f6-4789-9abc-def012345678';

function makeFakeDb() {
  const captured: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    captured,
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }),
    queryOne: jest.fn(async () => null),
    queryMany: jest.fn(async () => []),
    rpc: jest.fn(),
    tx: jest.fn(),
  };
}

describe('AnonymizationAuditService.snapshot — erasure short-circuit (codex fix #6)', () => {
  it('reason=retention writes a snapshot row', async () => {
    const db = makeFakeDb();
    const svc = new AnonymizationAuditService(db as any);

    let fetcherCalled = false;
    await svc.snapshot({
      dataCategory: 'visitor_records',
      reason: 'retention',
      refs: [{ category: 'visitor_records', resourceType: 'visitors', resourceId: 'v1', tenantId: TENANT }],
      fetchOriginals: async () => {
        fetcherCalled = true;
        return [{ resourceType: 'visitors', resourceId: 'v1', payload: { badge_id: 'B1' } }];
      },
    });

    expect(fetcherCalled).toBe(true);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0][0]).toContain('insert into anonymization_audit');
  });

  it('reason=erasure_request short-circuits BEFORE the fetcher runs', async () => {
    const db = makeFakeDb();
    const svc = new AnonymizationAuditService(db as any);

    let fetcherCalled = false;
    await svc.snapshot({
      dataCategory: 'persons',
      reason: 'erasure_request',
      refs: [{ category: 'persons', resourceType: 'persons', resourceId: 'p1', tenantId: TENANT }],
      fetchOriginals: async () => {
        fetcherCalled = true;
        return [{ resourceType: 'persons', resourceId: 'p1', payload: { first_name: 'X', email: 'y@z' } }];
      },
    });

    // Erasure must NOT touch the restore-window table — defeats Art. 17.
    // We also check the fetcher is skipped: avoids redundantly resolving
    // the original row when we know it's not going anywhere.
    expect(db.query).not.toHaveBeenCalled();
    expect(fetcherCalled).toBe(false);
  });

  it('snapshotTx applies the same erasure short-circuit inside a tx', async () => {
    const txClient = { query: jest.fn(async () => ({ rows: [], rowCount: 0 })) };
    const db = makeFakeDb();
    const svc = new AnonymizationAuditService(db as any);

    await svc.snapshotTx(txClient as any, {
      dataCategory: 'persons',
      reason: 'erasure_request',
      refs: [{ category: 'persons', resourceType: 'persons', resourceId: 'p1', tenantId: TENANT }],
      fetchOriginals: async () => [{ resourceType: 'persons', resourceId: 'p1', payload: {} }],
    });

    expect(txClient.query).not.toHaveBeenCalled();
  });
});

describe('VisitorRecordsAdapter — NULL person_id on anonymize (codex fix #3)', () => {
  it('UPDATE statement nulls badge_id, person_id, and sets anonymized_at', async () => {
    const captured: Array<{ sql: string; params?: unknown[] }> = [];
    const txClient = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        captured.push({ sql, params });
        if (sql.trim().startsWith('select id, badge_id')) {
          return { rows: [{ id: 'v1', badge_id: 'B1', person_id: 'p1', host_person_id: 'h1', status: 'checked_out', visit_date: '2025-01-01' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    const fakeDb = {
      ...makeFakeDb(),
      tx: jest.fn(async (fn: (c: typeof txClient) => Promise<unknown>) => fn(txClient)),
    };

    const { VisitorRecordsAdapter } = await import('./adapters/visitor-records.adapter');
    const adapter = new VisitorRecordsAdapter(fakeDb as any, new AnonymizationAuditService(fakeDb as any));

    await adapter.anonymize([
      { category: 'visitor_records', resourceType: 'visitors', resourceId: 'v1', tenantId: TENANT },
    ]);

    const updates = captured.filter((c) => c.sql.includes('update visitors'));
    expect(updates).toHaveLength(1);
    const sql = updates[0].sql;
    expect(sql).toMatch(/badge_id\s*=\s*null/);
    expect(sql).toMatch(/person_id\s*=\s*null/);                     // ← codex fix
    expect(sql).toMatch(/anonymized_at\s*=\s*now\(\)/);
    // host_person_id intentionally NOT touched — handled by PersonsAdapter.
    expect(sql).not.toMatch(/host_person_id\s*=/);
  });
});

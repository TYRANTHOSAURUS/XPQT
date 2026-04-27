import { PersonalDataAccessLogService } from './personal-data-access-log.service';

const TENANT = 'a1b2c3d4-e5f6-4789-9abc-def012345678';

function makeFakeDb() {
  const captured: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }),
    queryOne: jest.fn(async () => null),
    queryMany: jest.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      // Resolve auth uids → users.id for the flush path.
      if (sql.includes('from users') && sql.includes('auth_uid')) {
        const uids = (params?.[1] ?? []) as string[];
        return uids.map((uid) => ({ id: `usr-${uid}`, auth_uid: uid }));
      }
      return [];
    }),
    rpc: jest.fn(),
    tx: jest.fn(),
    captured,
  };
}

describe('PersonalDataAccessLogService', () => {
  beforeAll(() => {
    process.env.PDAL_WORKER_ENABLED = 'true';
  });

  it('hashIdentifier returns null for nullish; hex for value; tenant-scoped', () => {
    const db = makeFakeDb();
    const svc = new PersonalDataAccessLogService(db as any);
    expect(svc.hashIdentifier(null, TENANT)).toBeNull();
    expect(svc.hashIdentifier('', TENANT)).toBeNull();
    const a = svc.hashIdentifier('192.0.2.1', TENANT);
    const b = svc.hashIdentifier('192.0.2.1', 'other-tenant');
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).not.toBe(b);
  });

  it('hashQuery is stable regardless of property order', () => {
    const db = makeFakeDb();
    const svc = new PersonalDataAccessLogService(db as any);
    const a = svc.hashQuery({ status: 'open', priority: 'high' });
    const b = svc.hashQuery({ priority: 'high', status: 'open' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{32}$/);
  });

  it('enqueue dedups within the dedup window for the same key', () => {
    const db = makeFakeDb();
    const svc = new PersonalDataAccessLogService(db as any);
    const entry = {
      tenantId: TENANT,
      actorAuthUid: 'auth-1',
      dataCategory: 'past_bookings',
      resourceType: 'reservations',
      resourceId: 'r1',
      accessMethod: 'detail_view' as const,
    };
    expect(svc.enqueue(entry)).toBe(true);
    expect(svc.enqueue(entry)).toBe(false);                  // immediate retry → deduped
  });

  it('flush resolves auth_uid → users.id and bulk-inserts', async () => {
    const db = makeFakeDb();
    const svc = new PersonalDataAccessLogService(db as any);
    svc.enqueue({
      tenantId: TENANT, actorAuthUid: 'auth-1',
      dataCategory: 'past_bookings', resourceType: 'reservations', resourceId: 'r1',
      accessMethod: 'detail_view',
    });
    svc.enqueue({
      tenantId: TENANT, actorAuthUid: 'auth-2',
      dataCategory: 'past_bookings', resourceType: 'reservations', resourceId: 'r2',
      accessMethod: 'detail_view',
    });

    await svc.flush();

    const inserts = db.captured.filter((c) => c.sql.includes('insert into personal_data_access_logs'));
    expect(inserts).toHaveLength(1);
    const insertParams = inserts[0].params as unknown[];
    // 12 params per row × 2 rows = 24
    expect(insertParams).toHaveLength(24);
    // actor_user_id (col 3) of first row should be 'usr-auth-1' from the fake.
    expect(insertParams[2]).toBe('usr-auth-1');
    expect(insertParams[14]).toBe('usr-auth-2');
  });

  it('flush is a no-op for empty buffer', async () => {
    const db = makeFakeDb();
    const svc = new PersonalDataAccessLogService(db as any);
    await svc.flush();
    expect(db.query).not.toHaveBeenCalled();
  });

  it('different actors with same resource generate distinct entries', () => {
    const db = makeFakeDb();
    const svc = new PersonalDataAccessLogService(db as any);
    const base = {
      tenantId: TENANT,
      dataCategory: 'past_bookings',
      resourceType: 'reservations',
      resourceId: 'r1',
      accessMethod: 'detail_view' as const,
    };
    expect(svc.enqueue({ ...base, actorAuthUid: 'auth-1' })).toBe(true);
    expect(svc.enqueue({ ...base, actorAuthUid: 'auth-2' })).toBe(true);
  });
});

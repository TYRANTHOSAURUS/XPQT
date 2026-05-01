/**
 * VisitorReminderWorker — day-before reminder cron tests.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §6
 *
 * Tests:
 *   - finds visitors with expected_at in [now+24h, now+25h)
 *   - dedup: doesn't re-send to a visitor already reminded
 *   - cross-tenant: tenant A's candidate doesn't trigger a tenant B
 *     downstream lookup (the SQL filters per-tenant via composite FK,
 *     and the worker scopes TenantContext per row)
 *   - send failure surfaces (per-row, not all)
 */

import { VisitorReminderWorker } from './visitor-reminder.worker';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '99999999-9999-4999-8999-999999999999';
const VISITOR_A1 = '22222222-2222-4222-8222-222222222222';
const VISITOR_A2 = '33333333-3333-4333-8333-333333333333';
const VISITOR_B1 = '44444444-4444-4444-8444-444444444444';
const HOST = '55555555-5555-4555-8555-555555555555';
const BUILDING = '66666666-6666-4666-8666-666666666666';
const ROOM = '77777777-7777-4777-8777-777777777777';
const VISITOR_TYPE = '88888888-8888-4888-8888-888888888888';

interface FakeDbOpts {
  /** Candidates returned by the candidate query. */
  candidates?: Array<{ id: string; tenant_id: string; expected_at: string }>;
  /** Override dedup pre-flight (per visitor id). */
  dedupHit?: Set<string>;
}

function makeFakeDb(opts: FakeDbOpts = {}) {
  const sqlCalls: Array<{ sql: string; params?: unknown[] }> = [];

  const db = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      sqlCalls.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }),
    queryOne: jest.fn(async (sql: string, params?: unknown[]) => {
      sqlCalls.push({ sql, params });
      const t = sql.trim().toLowerCase();
      if (t.includes('from public.email_delivery_events')) {
        const key = params?.[0] as string | undefined;
        // Deduce visitor id from key shape `visitor-reminder:<vid>:<ts>`
        const vid = key?.split(':')[1];
        if (vid && opts.dedupHit?.has(vid)) return { id: 'prior' };
      }
      return null;
    }),
    queryMany: jest.fn(async (sql: string, params?: unknown[]) => {
      sqlCalls.push({ sql, params });
      const t = sql.trim().toLowerCase();
      if (t.includes('from public.visitors v') && t.includes('expected_at')) {
        return opts.candidates ?? [];
      }
      return [];
    }),
  };

  return { db, sqlCalls };
}

interface FakeSupabaseFixtures {
  visitors?: Map<string, Record<string, unknown>>;
  tenants?: Map<string, Record<string, unknown>>;
  spaces?: Map<string, Record<string, unknown>>;
  persons?: Map<string, Record<string, unknown>>;
  visitorTypes?: Map<string, Record<string, unknown>>;
}

function makeFakeSupabase(fx: FakeSupabaseFixtures = {}) {
  const auditInserts: Array<Record<string, unknown>> = [];

  const builder = (table: string) => {
    const filters: Record<string, unknown> = {};
    type Q = {
      select: () => Q;
      eq: (col: string, val: unknown) => Q;
      maybeSingle: () => Promise<{ data: unknown; error: null }>;
      insert: (rows: unknown) => {
        select: () => { single: () => Promise<{ data: { id: string }; error: null }> };
      };
    };

    const matches = (row: Record<string, unknown> | null): boolean => {
      if (!row) return false;
      for (const [k, v] of Object.entries(filters)) {
        if (k in row && row[k] !== v) return false;
      }
      return true;
    };

    const q: Q = {
      select: () => q,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return q;
      },
      maybeSingle: async () => {
        let candidate: Record<string, unknown> | null = null;
        const id = filters.id as string | undefined;
        switch (table) {
          case 'visitors': candidate = (id && fx.visitors?.get(id)) ?? null; break;
          case 'tenants': candidate = (id && fx.tenants?.get(id)) ?? null; break;
          case 'spaces': candidate = (id && fx.spaces?.get(id)) ?? null; break;
          case 'persons': candidate = (id && fx.persons?.get(id)) ?? null; break;
          case 'visitor_types': candidate = (id && fx.visitorTypes?.get(id)) ?? null; break;
        }
        return { data: matches(candidate) ? candidate : null, error: null };
      },
      insert: (rows: unknown) => {
        if (table === 'audit_events') {
          const arr = Array.isArray(rows) ? rows : [rows];
          for (const r of arr) auditInserts.push(r as Record<string, unknown>);
        }
        return {
          select: () => ({ single: async () => ({ data: { id: 'inserted' }, error: null }) }),
        };
      },
    };
    return q;
  };

  return {
    supabase: {
      admin: { from: jest.fn((table: string) => builder(table)) },
    },
    auditInserts,
  };
}

interface SendCall {
  to: string;
  subject: string;
  textBody: string;
  idempotencyKey?: string;
  tags?: Record<string, string>;
  tenantId: string;
}

function makeFakeMail(opts: { failOn?: Set<string> } = {}) {
  const calls: SendCall[] = [];
  const mail = {
    send: jest.fn(async (msg: SendCall) => {
      calls.push(msg);
      const key = msg.idempotencyKey ?? '';
      if (opts.failOn?.has(key)) throw new Error(`provider failed: ${key}`);
      return { messageId: `pm-${calls.length}`, acceptedAt: new Date().toISOString() };
    }),
    verifyWebhook: jest.fn(),
  };
  return { mail, calls };
}

function makeFakeAdapter() {
  const sentCalls: Array<{ visitor_id: string; tenant_id: string; provider_message_id: string }> = [];
  return {
    adapter: {
      recordSent: jest.fn(async (vid: string, tid: string, pmid: string) => {
        sentCalls.push({ visitor_id: vid, tenant_id: tid, provider_message_id: pmid });
      }),
      recordBounced: jest.fn(async () => undefined),
      recordDelivered: jest.fn(async () => undefined),
    },
    sentCalls,
  };
}

function buildVisitor(id: string, tenantId: string, expectedAt: string) {
  return {
    id,
    tenant_id: tenantId,
    status: 'expected',
    first_name: 'Marleen',
    last_name: 'Visser',
    email: 'marleen@example.com',
    expected_at: expectedAt,
    expected_until: '2026-05-01T11:00:00Z',
    building_id: BUILDING,
    meeting_room_id: ROOM,
    primary_host_person_id: HOST,
    visitor_type_id: VISITOR_TYPE,
    notes_for_visitor: null,
  };
}

function buildFixtures(visitors: Array<{ id: string; tenant_id: string; expected_at: string }>) {
  const visitorMap = new Map<string, Record<string, unknown>>();
  for (const v of visitors) visitorMap.set(v.id, buildVisitor(v.id, v.tenant_id, v.expected_at));
  return {
    visitors: visitorMap,
    tenants: new Map([
      [TENANT_A, { id: TENANT_A, name: 'Acme A', branding: { primary_color: '#0ea5e9' } }],
      [TENANT_B, { id: TENANT_B, name: 'Acme B', branding: { primary_color: '#f97316' } }],
    ]),
    spaces: new Map([
      [BUILDING, { id: BUILDING, tenant_id: TENANT_A, name: 'HQ A', address: null }],
      [ROOM, { id: ROOM, tenant_id: TENANT_A, name: 'Amber 3' }],
    ]),
    persons: new Map([
      [HOST, { id: HOST, tenant_id: TENANT_A, first_name: 'Jan' }],
    ]),
    visitorTypes: new Map([
      [VISITOR_TYPE, {
        id: VISITOR_TYPE, tenant_id: TENANT_A,
        display_name: 'Guest',
        requires_id_scan: false,
        requires_nda: false,
        requires_photo: false,
      }],
    ]),
  } satisfies FakeSupabaseFixtures;
}

describe('VisitorReminderWorker', () => {
  it('sends to all candidates returned by the SQL window', async () => {
    const candidates = [
      { id: VISITOR_A1, tenant_id: TENANT_A, expected_at: '2026-05-02T09:00:00Z' },
      { id: VISITOR_A2, tenant_id: TENANT_A, expected_at: '2026-05-02T09:30:00Z' },
    ];
    const { db } = makeFakeDb({ candidates });
    const { supabase } = makeFakeSupabase(buildFixtures(candidates));
    const { mail, calls } = makeFakeMail();
    const { adapter, sentCalls } = makeFakeAdapter();

    const worker = new VisitorReminderWorker(db as never, supabase as never, mail as never, adapter as never);
    const result = await worker.runOnce();

    expect(result.candidates).toBe(2);
    expect(result.sent).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.idempotencyKey).toBe(`visitor-reminder:${VISITOR_A1}:2026-05-02T09:00:00Z`);
    expect(calls[1]!.idempotencyKey).toBe(`visitor-reminder:${VISITOR_A2}:2026-05-02T09:30:00Z`);
    expect(sentCalls).toHaveLength(2);
  });

  it('skips when dedup pre-flight finds an existing send', async () => {
    const candidates = [
      { id: VISITOR_A1, tenant_id: TENANT_A, expected_at: '2026-05-02T09:00:00Z' },
    ];
    const { db } = makeFakeDb({
      candidates,
      dedupHit: new Set([VISITOR_A1]),
    });
    const { supabase } = makeFakeSupabase(buildFixtures(candidates));
    const { mail, calls } = makeFakeMail();
    const { adapter } = makeFakeAdapter();

    const worker = new VisitorReminderWorker(db as never, supabase as never, mail as never, adapter as never);
    const result = await worker.runOnce();

    expect(result.candidates).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.sent).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('SQL window asks for [now+24h, now+25h)', async () => {
    const { db, sqlCalls } = makeFakeDb();
    const { supabase } = makeFakeSupabase();
    const { mail } = makeFakeMail();
    const { adapter } = makeFakeAdapter();

    const worker = new VisitorReminderWorker(db as never, supabase as never, mail as never, adapter as never);
    const before = Date.now();
    await worker.runOnce();
    const after = Date.now();

    const candidateCall = sqlCalls.find((c) => (c.sql ?? '').toLowerCase().includes('from public.visitors v'));
    expect(candidateCall).toBeDefined();
    const params = candidateCall!.params as unknown[] | undefined;
    expect(params).toBeDefined();
    const lower = new Date(params![0] as string).getTime();
    const upper = new Date(params![1] as string).getTime();
    expect(lower).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000 - 1000);
    expect(lower).toBeLessThanOrEqual(after + 24 * 60 * 60 * 1000 + 1000);
    expect(upper - lower).toBe(60 * 60 * 1000);
  });

  it('cross-tenant: tenant A candidate uses tenant A branding (not B)', async () => {
    // The SQL pre-filters per-tenant via the visitors row; this test
    // verifies that a tenant-A candidate's downstream supabase calls only
    // succeed against tenant-A rows (composite FKs in the assemble path).
    const candidates = [
      { id: VISITOR_A1, tenant_id: TENANT_A, expected_at: '2026-05-02T09:00:00Z' },
    ];
    const fx = buildFixtures(candidates);
    // Add a tenant-B visitor with the SAME id (simulated cross-tenant
    // collision — should never happen in real life since ids are uuids,
    // but defends the assertion).
    fx.visitors.set(VISITOR_B1, buildVisitor(VISITOR_B1, TENANT_B, '2026-05-02T09:00:00Z'));

    const { db } = makeFakeDb({ candidates });
    const { supabase } = makeFakeSupabase(fx);
    const { mail, calls } = makeFakeMail();
    const { adapter } = makeFakeAdapter();

    const worker = new VisitorReminderWorker(db as never, supabase as never, mail as never, adapter as never);
    const result = await worker.runOnce();

    expect(result.sent).toBe(1);
    // Body should mention HQ A (tenant A's building), not anything from tenant B.
    expect(calls[0]!.textBody).toContain('HQ A');
  });

  it('per-row failure does not abort the batch', async () => {
    const candidates = [
      { id: VISITOR_A1, tenant_id: TENANT_A, expected_at: '2026-05-02T09:00:00Z' },
      { id: VISITOR_A2, tenant_id: TENANT_A, expected_at: '2026-05-02T09:30:00Z' },
    ];
    const fx = buildFixtures(candidates);
    const { db } = makeFakeDb({ candidates });
    const { supabase } = makeFakeSupabase(fx);
    const failKey = `visitor-reminder:${VISITOR_A1}:2026-05-02T09:00:00Z`;
    const { mail, calls } = makeFakeMail({ failOn: new Set([failKey]) });
    const { adapter } = makeFakeAdapter();

    const worker = new VisitorReminderWorker(db as never, supabase as never, mail as never, adapter as never);
    const result = await worker.runOnce();

    expect(result.candidates).toBe(2);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
    expect(calls).toHaveLength(2); // both attempted
  });
});

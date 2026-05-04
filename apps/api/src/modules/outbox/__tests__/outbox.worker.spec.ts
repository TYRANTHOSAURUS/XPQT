import { DeadLetterError } from '../dead-letter.error';
import { OutboxHandlerRegistry } from '../outbox-handler.registry';
import { OutboxWorker } from '../outbox.worker';
import { TenantContext } from '../../../common/tenant-context';
import type { OutboxEvent } from '../outbox.types';

/**
 * OutboxWorker unit tests.
 *
 * Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md
 *       §4.1 (drain), §4.2 (state machine — 4 transitions), §4.3 (tenant
 *       context wrapping), §4.5 (DeadLetterError), §10.2 #3 (no_handler).
 *
 * These are pure unit tests — no DB. The DbService is mocked with a
 * captured-call fake. The registry is exercised via its public
 * registerForTest path so we don't need to spin up DiscoveryService.
 */

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const AGGR_ID = '33333333-3333-4333-8333-333333333333';

function makeEvent(overrides: Partial<OutboxEvent> = {}): OutboxEvent {
  return {
    id: EVENT_ID,
    tenant_id: TENANT_ID,
    event_type: 'booking.create_attempted',
    event_version: 1,
    aggregate_type: 'booking',
    aggregate_id: AGGR_ID,
    payload: {},
    payload_hash: 'hash',
    idempotency_key: 'booking.create_attempted:agg',
    enqueued_at: new Date().toISOString(),
    available_at: new Date().toISOString(),
    processed_at: null,
    processed_reason: null,
    claim_token: null,
    claimed_at: null,
    attempts: 0,
    last_error: null,
    dead_lettered_at: null,
    ...overrides,
  };
}

interface FakeDb {
  query: jest.Mock;
  queryOne: jest.Mock;
  queryMany: jest.Mock;
  rpc: jest.Mock;
  tx: jest.Mock;
  capturedSql: string[];
  capturedTxSql: string[];
}

function makeDb(): FakeDb {
  const capturedSql: string[] = [];
  const capturedTxSql: string[] = [];
  const query = jest.fn(async (sql: string, _params?: unknown[]) => {
    capturedSql.push(sql);
    // Default: empty result. Specific tests override per-call.
    return { rows: [], rowCount: 0 };
  });
  const tx = jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    const client = {
      query: jest.fn(async (sql: string, _params?: unknown[]) => {
        capturedTxSql.push(sql);
        return { rows: [], rowCount: 1 };
      }),
    };
    return await fn(client);
  });
  return {
    query,
    queryOne: jest.fn(async () => null),
    queryMany: jest.fn(async () => []),
    rpc: jest.fn(),
    tx,
    capturedSql,
    capturedTxSql,
  };
}

function makeRegistry() {
  // Bypass DiscoveryService — registerForTest accepts arbitrary handlers.
  const reg = new OutboxHandlerRegistry({ getProviders: () => [] } as never);
  reg.onModuleInit();
  return reg;
}

function makeWorker(opts: { db: FakeDb; registry: OutboxHandlerRegistry; envOverrides?: Record<string, string> }) {
  // Worker reads env at construction. Restore after.
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(opts.envOverrides ?? {})) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  const worker = new OutboxWorker(opts.db as never, opts.registry);
  // Stub the tenant cache to "found" by default — most tests don't care.
  // Tests that want tenant_not_found install their own cache contents.
  worker.clearTenantCacheForTest();
  // Restore env.
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return worker;
}

describe('OutboxWorker', () => {
  beforeEach(() => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5); // no-jitter for determinism
  });
  afterEach(() => jest.restoreAllMocks());

  describe('drainOnce — claim batch', () => {
    it('returns 0 when claim returns no rows (idle DB)', async () => {
      const db = makeDb();
      const reg = makeRegistry();
      const worker = makeWorker({ db, registry: reg });

      // First query is the claim. Default empty result → no work.
      const result = await worker.drainOnce();
      expect(result).toBe(0);
      expect(db.query).toHaveBeenCalledTimes(1);
      expect(db.capturedSql[0]).toMatch(/with cte as/i);
      expect(db.capturedSql[0]).toMatch(/for update skip locked/i);
      expect(db.capturedSql[0]).toMatch(/processed_at is null/);
      expect(db.capturedSql[0]).toMatch(/dead_lettered_at is null/);
      expect(db.capturedSql[0]).toMatch(/claim_token is null/);
      expect(db.capturedSql[0]).toMatch(/available_at <= now\(\)/);
    });

    it('claim does NOT increment attempts in the SQL (spec §4.2 / I1)', async () => {
      const db = makeDb();
      const reg = makeRegistry();
      const worker = makeWorker({ db, registry: reg });
      await worker.drainOnce();

      // Claim SQL must NOT have `attempts = attempts + 1` — that's the I1 fix.
      // (Audit-outbox v1 incremented on claim; the new worker does not.)
      expect(db.capturedSql[0]).not.toMatch(/attempts\s*=\s*o?\.?attempts\s*\+\s*1/);
    });
  });

  describe('§4.2 transition (1) — Success', () => {
    it('marks the row processed_at + handler_ok + claim_token=null + attempts++ on clean handler return', async () => {
      const db = makeDb();
      const event = makeEvent({ attempts: 0 });
      // 1st call = claim → returns this event. Subsequent = success update.
      db.query.mockImplementationOnce(async (sql: string) => {
        db.capturedSql.push(sql);
        return { rows: [event], rowCount: 1 };
      });

      const handler = { handle: jest.fn(async () => undefined) };
      const reg = makeRegistry();
      reg.registerForTest('booking.create_attempted', 1, handler);

      // Tenant cache: prime via cache flush + queryOne returning a row.
      db.queryOne.mockResolvedValueOnce({ id: TENANT_ID, slug: 't', tier: 'standard' });

      const worker = makeWorker({ db, registry: reg });
      const handled = await worker.drainOnce();

      expect(handled).toBe(1);
      expect(handler.handle).toHaveBeenCalledTimes(1);
      // 2nd db.query is the success update.
      expect(db.capturedSql[1]).toMatch(/processed_at = now\(\)/);
      expect(db.capturedSql[1]).toMatch(/processed_reason = 'handler_ok'/);
      expect(db.capturedSql[1]).toMatch(/attempts = attempts \+ 1/);
      expect(db.capturedSql[1]).toMatch(/claim_token = null/);
    });

    it('runs the handler inside TenantContext.run with the cached tenant info', async () => {
      const db = makeDb();
      const event = makeEvent();
      db.query.mockImplementationOnce(async (sql: string) => {
        db.capturedSql.push(sql);
        return { rows: [event], rowCount: 1 };
      });
      db.queryOne.mockResolvedValueOnce({ id: TENANT_ID, slug: 'acme', tier: 'enterprise' });

      let observed: { id: string; slug: string; tier: string } | null = null;
      const handler = {
        handle: jest.fn(async () => {
          observed = TenantContext.current() as never;
        }),
      };
      const reg = makeRegistry();
      reg.registerForTest('booking.create_attempted', 1, handler);

      const worker = makeWorker({ db, registry: reg });
      await worker.drainOnce();

      expect(observed).toEqual({ id: TENANT_ID, slug: 'acme', tier: 'enterprise' });
    });
  });

  describe('§4.2 transition (2) — Retry', () => {
    it('schedules retry with backoff when handler throws and attempts+1 < max', async () => {
      const db = makeDb();
      const event = makeEvent({ attempts: 1 }); // → would be 2 < 5
      db.query.mockImplementationOnce(async (sql: string) => {
        db.capturedSql.push(sql);
        return { rows: [event], rowCount: 1 };
      });
      db.queryOne.mockResolvedValueOnce({ id: TENANT_ID, slug: 't', tier: 'standard' });

      const handler = {
        handle: jest.fn(async () => {
          throw new Error('transient supabase outage');
        }),
      };
      const reg = makeRegistry();
      reg.registerForTest('booking.create_attempted', 1, handler);

      const worker = makeWorker({ db, registry: reg, envOverrides: { OUTBOX_MAX_ATTEMPTS: '5' } });
      await worker.drainOnce();

      expect(db.capturedSql[1]).toMatch(/last_error = \$3/);
      expect(db.capturedSql[1]).toMatch(/attempts = \$4/);
      expect(db.capturedSql[1]).toMatch(/available_at = now\(\) \+/);
      expect(db.capturedSql[1]).toMatch(/claim_token = null/);
      // Verify the params that were passed (last_error message + nextAttempts).
      const retryCall = db.query.mock.calls.find((c) => /available_at = now\(\)/.test(c[0]));
      expect(retryCall?.[1]).toBeDefined();
      const params = retryCall![1] as unknown[];
      expect(params[2]).toBe('transient supabase outage'); // last_error
      expect(params[3]).toBe(2);                            // nextAttempts
    });
  });

  describe('§4.2 transition (3) — Dead-letter', () => {
    it('dead-letters when attempts+1 >= max (max_attempts reason)', async () => {
      const db = makeDb();
      // attempts=4, max=5 → next would be 5 == max → DL
      const event = makeEvent({ attempts: 4 });
      db.query.mockImplementationOnce(async (sql: string) => {
        db.capturedSql.push(sql);
        return { rows: [event], rowCount: 1 };
      });
      db.queryOne.mockResolvedValueOnce({ id: TENANT_ID, slug: 't', tier: 'standard' });

      const handler = {
        handle: jest.fn(async () => {
          throw new Error('still failing');
        }),
      };
      const reg = makeRegistry();
      reg.registerForTest('booking.create_attempted', 1, handler);

      const worker = makeWorker({ db, registry: reg, envOverrides: { OUTBOX_MAX_ATTEMPTS: '5' } });
      await worker.drainOnce();

      // DL path uses tx → tx was called once.
      expect(db.tx).toHaveBeenCalledTimes(1);
      // tx body issued INSERT into events_dead_letter and UPDATE on events
      // (with dead_lettered_at = now() — the §4.2.3 flag the drain index uses).
      expect(db.capturedTxSql.some((s) => /insert into outbox\.events_dead_letter/i.test(s))).toBe(true);
      expect(db.capturedTxSql.some((s) => /update outbox\.events/i.test(s) && /dead_lettered_at = now\(\)/.test(s))).toBe(true);
    });

    it('dead-letters immediately on DeadLetterError (dead_letter_error reason; no retry)', async () => {
      const db = makeDb();
      const event = makeEvent({ attempts: 0 }); // would normally retry
      db.query.mockImplementationOnce(async (sql: string) => {
        db.capturedSql.push(sql);
        return { rows: [event], rowCount: 1 };
      });
      db.queryOne.mockResolvedValueOnce({ id: TENANT_ID, slug: 't', tier: 'standard' });

      const handler = {
        handle: jest.fn(async () => {
          throw new DeadLetterError('tenant mismatch: event=A agg=B');
        }),
      };
      const reg = makeRegistry();
      reg.registerForTest('booking.create_attempted', 1, handler);

      const worker = makeWorker({ db, registry: reg });
      await worker.drainOnce();

      // Dead-letter path even though attempts < max.
      expect(db.tx).toHaveBeenCalledTimes(1);
      // No retry update should have happened (would have available_at = now() + …).
      expect(db.capturedSql.some((s) => /available_at = now\(\) \+/.test(s))).toBe(false);
    });

    it('dead-letters with no_handler_registered when no handler matches event_type@version', async () => {
      const db = makeDb();
      const event = makeEvent({ event_type: 'unknown.event' });
      db.query.mockImplementationOnce(async (sql: string) => {
        db.capturedSql.push(sql);
        return { rows: [event], rowCount: 1 };
      });

      const reg = makeRegistry(); // empty
      const worker = makeWorker({ db, registry: reg });
      await worker.drainOnce();

      // No tenant lookup needed — registry miss happens BEFORE tenant load.
      expect(db.queryOne).not.toHaveBeenCalled();
      // DL path (tx) fired.
      expect(db.tx).toHaveBeenCalledTimes(1);
    });

    it('dead-letters with tenant_not_found when the tenants registry lookup is null', async () => {
      const db = makeDb();
      const event = makeEvent();
      db.query.mockImplementationOnce(async (sql: string) => {
        db.capturedSql.push(sql);
        return { rows: [event], rowCount: 1 };
      });
      // queryOne returns null → tenant not found.
      db.queryOne.mockResolvedValueOnce(null);

      const handler = { handle: jest.fn(async () => undefined) };
      const reg = makeRegistry();
      reg.registerForTest('booking.create_attempted', 1, handler);

      const worker = makeWorker({ db, registry: reg });
      await worker.drainOnce();

      // Handler must NOT have been called.
      expect(handler.handle).not.toHaveBeenCalled();
      expect(db.tx).toHaveBeenCalledTimes(1);
    });
  });

  describe('§4.2 transition (4) — Stale-claim recovery (separate cron)', () => {
    it('clears stale claim_token without incrementing attempts', async () => {
      const db = makeDb();
      const reg = makeRegistry();
      const worker = makeWorker({ db, registry: reg });

      await worker.sweepStaleClaims();

      // Sweep SQL doesn't increment attempts (spec §4.2.4 / I2).
      const calls = db.query.mock.calls;
      const sweep = calls.find((c) => /update outbox\.events/i.test(c[0]) && /claim_token = null/.test(c[0]));
      expect(sweep).toBeDefined();
      expect(sweep![0]).not.toMatch(/attempts\s*=\s*attempts\s*\+\s*1/);
      expect(sweep![0]).toMatch(/claimed_at < now\(\)/);
      expect(sweep![0]).toMatch(/processed_at is null/);
      expect(sweep![0]).toMatch(/dead_lettered_at is null/);
    });
  });

  describe('purgeProcessed (spec §13.1)', () => {
    it('runs on its own cron; deletes events older than OUTBOX_PURGE_AFTER_DAYS', async () => {
      const db = makeDb();
      const reg = makeRegistry();
      const worker = makeWorker({ db, registry: reg });

      await worker.purgeProcessed();

      const calls = db.query.mock.calls;
      const purge = calls.find((c) => /delete from outbox\.events/i.test(c[0]));
      expect(purge).toBeDefined();
      expect(purge![0]).toMatch(/processed_at is not null/);
      expect(purge![0]).toMatch(/processed_at < now\(\) -/);
    });
  });

  describe('Tenant cache (spec §4.3 / N2)', () => {
    it('reuses a cached tenant within the TTL window (no second queryOne)', async () => {
      const db = makeDb();
      const event1 = makeEvent({ id: 'event-1' });
      const event2 = makeEvent({ id: 'event-2' });
      db.query.mockImplementationOnce(async (sql: string) => {
        db.capturedSql.push(sql);
        return { rows: [event1, event2], rowCount: 2 };
      });
      db.queryOne.mockResolvedValueOnce({ id: TENANT_ID, slug: 't', tier: 'standard' });

      const handler = { handle: jest.fn(async () => undefined) };
      const reg = makeRegistry();
      reg.registerForTest('booking.create_attempted', 1, handler);

      const worker = makeWorker({ db, registry: reg });
      await worker.drainOnce();

      expect(handler.handle).toHaveBeenCalledTimes(2);
      // Tenant lookup happened only once even though 2 events for same tenant.
      expect(db.queryOne).toHaveBeenCalledTimes(1);
    });
  });
});

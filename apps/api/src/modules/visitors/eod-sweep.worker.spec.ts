/**
 * EodSweepWorker — building-local 18:00 sweep with lease + idempotency.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §12
 *
 * Tests:
 *   - status='expected' & expected_until < now → no_show
 *   - status='arrived' & expected_until < now → checked_out + auto_checked_out
 *   - pass marked missing when checked_out had a pass
 *   - lease blocks concurrent re-runs (idempotent)
 *   - long-meeting (expected_until in future) preserved
 *   - cross-tenant: lease for tenant A doesn't run for tenant B
 *   - terminal-state visitors are not swept (cancelled/denied filtered out by SQL)
 */

import { TenantContext } from '../../common/tenant-context';
import { EodSweepWorker } from './eod-sweep.worker';
import type { VisitorStatus } from './dto/transition-status.dto';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '99999999-9999-4999-8999-999999999999';
const BUILDING_A = '22222222-2222-4222-8222-222222222222';
const BUILDING_B = '88888888-8888-4888-8888-888888888888';
const VISITOR_A1 = '33333333-3333-4333-8333-333333333333';
const VISITOR_A2 = '44444444-4444-4444-8444-444444444444';
const PASS_ID = '55555555-5555-4555-8555-555555555555';

interface CandidateRow {
  id: string;
  status: VisitorStatus;
  visitor_pass_id: string | null;
  expected_until: string | null;
}

interface FakeOpts {
  /** Lease acquisition outcomes per leaseKey — defaults to "no row exists, acquire". */
  leaseAcquired?: Record<string, boolean>;
  /** Visitors returned for (tenant, building). Keyed by `${tenant}|${building}`. */
  candidates?: Record<string, CandidateRow[]>;
  /** Buildings returned for the in-window query (the cron path). */
  buildingsInWindow?: Array<{ id: string; tenant_id: string; timezone: string }>;
}

function makeHarness(opts: FakeOpts = {}) {
  const sqlCalls: Array<{ sql: string; params?: unknown[] }> = [];
  const leaseAcquires: string[] = [];
  const leaseReleases: string[] = [];
  const transitionCalls: Array<{
    visitor_id: string;
    to: VisitorStatus;
    txOpts?: Record<string, unknown>;
  }> = [];
  const passCalls: Array<{ method: string; pass_id: string; tenant_id: string; reason?: string }> = [];

  const db = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      sqlCalls.push({ sql, params });
      const trimmed = sql.trim().toLowerCase();
      if (trimmed.startsWith('insert into public.task_leases')) {
        const leaseKey = params?.[1] as string;
        leaseAcquires.push(leaseKey);
        const got = opts.leaseAcquired?.[leaseKey];
        // default true — first run acquires.
        if (got === false) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [{ id: 'lease-1' }], rowCount: 1 };
      }
      if (trimmed.startsWith('update public.task_leases')) {
        const leaseKey = params?.[0] as string;
        leaseReleases.push(leaseKey);
        return { rows: [], rowCount: 1 };
      }
      if (trimmed.startsWith('insert into public.audit_events')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    queryMany: jest.fn(async (sql: string, params?: unknown[]) => {
      sqlCalls.push({ sql, params });
      const trimmed = sql.trim().toLowerCase();
      if (trimmed.includes('extract(hour from')) {
        return opts.buildingsInWindow ?? [];
      }
      if (trimmed.includes('select id, status, visitor_pass_id, expected_until')) {
        const tenantId = params?.[0] as string;
        const buildingId = params?.[1] as string;
        return opts.candidates?.[`${tenantId}|${buildingId}`] ?? [];
      }
      return [];
    }),
    queryOne: jest.fn(async (_sql: string, _params?: unknown[]) => null),
  };

  const visitors = {
    transitionStatus: jest.fn(
      async (
        visitor_id: string,
        to: VisitorStatus,
        _actor: { user_id: string; person_id: string | null },
        txOpts?: Record<string, unknown>,
      ) => {
        transitionCalls.push({ visitor_id, to, txOpts });
      },
    ),
  };

  const passPool = {
    markPassMissing: jest.fn(async (pass_id: string, tenant_id: string, reason?: string) => {
      passCalls.push({ method: 'markPassMissing', pass_id, tenant_id, reason });
    }),
  };

  const worker = new EodSweepWorker(
    db as never,
    visitors as never,
    passPool as never,
  );

  return {
    worker,
    db,
    visitors,
    passPool,
    sqlCalls,
    leaseAcquires,
    leaseReleases,
    transitionCalls,
    passCalls,
  };
}

describe('EodSweepWorker', () => {
  beforeEach(() => {
    // Provide a real TenantContext.run via AsyncLocalStorage.
    jest.spyOn(TenantContext, 'currentOrNull').mockReturnValue(undefined);
    // Spy on `current` so the visitor pass-pool / transition layer (mocked
    // here) doesn't blow up if it asks for the tenant. Default to TENANT_A.
    jest.spyOn(TenantContext, 'current').mockReturnValue({ id: TENANT_A } as never);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─── runSweepForBuilding direct ─────────────────────────────────────────

  describe('runSweepForBuilding', () => {
    it('flips expected → no_show', async () => {
      const { worker, transitionCalls } = makeHarness({
        candidates: {
          [`${TENANT_A}|${BUILDING_A}`]: [
            {
              id: VISITOR_A1,
              status: 'expected',
              visitor_pass_id: null,
              expected_until: '2026-04-30T10:00:00Z',
            },
          ],
        },
      });
      const result = await worker.runSweepForBuilding(BUILDING_A, TENANT_A);
      expect(result.skipped).toBe(false);
      expect(result.no_show_count).toBe(1);
      expect(result.auto_checked_out_count).toBe(0);
      expect(transitionCalls).toEqual([
        expect.objectContaining({ visitor_id: VISITOR_A1, to: 'no_show' }),
      ]);
    });

    it('flips arrived → checked_out with checkout_source=eod_sweep', async () => {
      const { worker, transitionCalls } = makeHarness({
        candidates: {
          [`${TENANT_A}|${BUILDING_A}`]: [
            {
              id: VISITOR_A1,
              status: 'arrived',
              visitor_pass_id: null,
              expected_until: '2026-04-30T10:00:00Z',
            },
          ],
        },
      });
      const result = await worker.runSweepForBuilding(BUILDING_A, TENANT_A);
      expect(result.auto_checked_out_count).toBe(1);
      const call = transitionCalls[0]!;
      expect(call.to).toBe('checked_out');
      expect(call.txOpts?.checkout_source).toBe('eod_sweep');
    });

    it('also flips in_meeting → checked_out', async () => {
      const { worker, transitionCalls } = makeHarness({
        candidates: {
          [`${TENANT_A}|${BUILDING_A}`]: [
            {
              id: VISITOR_A1,
              status: 'in_meeting',
              visitor_pass_id: null,
              expected_until: '2026-04-30T10:00:00Z',
            },
          ],
        },
      });
      await worker.runSweepForBuilding(BUILDING_A, TENANT_A);
      expect(transitionCalls[0]!.to).toBe('checked_out');
    });

    it('marks pass missing when checked_out had a pass', async () => {
      const { worker, passCalls } = makeHarness({
        candidates: {
          [`${TENANT_A}|${BUILDING_A}`]: [
            {
              id: VISITOR_A1,
              status: 'arrived',
              visitor_pass_id: PASS_ID,
              expected_until: '2026-04-30T10:00:00Z',
            },
          ],
        },
      });
      const result = await worker.runSweepForBuilding(BUILDING_A, TENANT_A);
      expect(result.passes_flagged_count).toBe(1);
      expect(passCalls).toEqual([
        {
          method: 'markPassMissing',
          pass_id: PASS_ID,
          tenant_id: TENANT_A,
          reason: 'unreturned via eod sweep',
        },
      ]);
    });

    it('handles a multi-visitor batch (mix of expected + arrived)', async () => {
      const { worker, transitionCalls } = makeHarness({
        candidates: {
          [`${TENANT_A}|${BUILDING_A}`]: [
            {
              id: VISITOR_A1,
              status: 'expected',
              visitor_pass_id: null,
              expected_until: '2026-04-30T10:00:00Z',
            },
            {
              id: VISITOR_A2,
              status: 'arrived',
              visitor_pass_id: null,
              expected_until: '2026-04-30T10:00:00Z',
            },
          ],
        },
      });
      const result = await worker.runSweepForBuilding(BUILDING_A, TENANT_A);
      expect(result.no_show_count).toBe(1);
      expect(result.auto_checked_out_count).toBe(1);
      expect(transitionCalls).toHaveLength(2);
      expect(transitionCalls.find((c) => c.visitor_id === VISITOR_A1)?.to).toBe('no_show');
      expect(transitionCalls.find((c) => c.visitor_id === VISITOR_A2)?.to).toBe('checked_out');
    });
  });

  // ─── lease / idempotency ────────────────────────────────────────────────

  describe('lease', () => {
    it('skips when lease cannot be acquired', async () => {
      const sweepDate = new Date().toISOString().slice(0, 10);
      const leaseKey = `visitor.eod.${BUILDING_A}.${sweepDate}`;
      const { worker, transitionCalls } = makeHarness({
        leaseAcquired: { [leaseKey]: false },
        candidates: {
          [`${TENANT_A}|${BUILDING_A}`]: [
            {
              id: VISITOR_A1,
              status: 'expected',
              visitor_pass_id: null,
              expected_until: '2026-04-30T10:00:00Z',
            },
          ],
        },
      });
      const result = await worker.runSweepForBuilding(BUILDING_A, TENANT_A);
      expect(result.skipped).toBe(true);
      // Visitors are not transitioned when the lease is held.
      expect(transitionCalls).toHaveLength(0);
    });

    it('uses a deterministic lease key per (building, date)', async () => {
      const sweepDate = new Date().toISOString().slice(0, 10);
      const expected = `visitor.eod.${BUILDING_A}.${sweepDate}`;
      const { worker, leaseAcquires } = makeHarness();
      await worker.runSweepForBuilding(BUILDING_A, TENANT_A);
      expect(leaseAcquires).toContain(expected);
    });

    it('marks the lease released after a successful run', async () => {
      const { worker, leaseReleases } = makeHarness();
      await worker.runSweepForBuilding(BUILDING_A, TENANT_A);
      expect(leaseReleases).toHaveLength(1);
    });
  });

  // ─── cross-tenant ───────────────────────────────────────────────────────

  describe('cross-tenant', () => {
    it('only transitions visitors whose tenant matches the call', async () => {
      const { worker, transitionCalls } = makeHarness({
        candidates: {
          [`${TENANT_A}|${BUILDING_A}`]: [
            {
              id: VISITOR_A1,
              status: 'expected',
              visitor_pass_id: null,
              expected_until: '2026-04-30T10:00:00Z',
            },
          ],
          // tenant B has a candidate row in its own dataset; the call for
          // tenant A should NEVER touch it because the SELECT params are
          // (TENANT_A, BUILDING_A).
          [`${TENANT_B}|${BUILDING_B}`]: [
            {
              id: 'tenant-b-visitor',
              status: 'expected',
              visitor_pass_id: null,
              expected_until: '2026-04-30T10:00:00Z',
            },
          ],
        },
      });
      await worker.runSweepForBuilding(BUILDING_A, TENANT_A);
      expect(transitionCalls).toHaveLength(1);
      expect(transitionCalls[0]!.visitor_id).toBe(VISITOR_A1);
    });
  });

  // ─── candidate filter (proven via SQL params + harness) ─────────────────

  describe('candidate filter', () => {
    it('queries only expected/arrived/in_meeting with expected_until < now', async () => {
      const { worker, sqlCalls } = makeHarness();
      await worker.runSweepForBuilding(BUILDING_A, TENANT_A);
      const candidateSql = sqlCalls.find((c) =>
        c.sql.includes('select id, status, visitor_pass_id, expected_until'),
      );
      expect(candidateSql).toBeTruthy();
      const lower = candidateSql!.sql.toLowerCase();
      expect(lower).toContain("status in ('expected', 'arrived', 'in_meeting')");
      expect(lower).toContain('expected_until < now()');
    });

    it('does not transition visitors when no candidates returned', async () => {
      const { worker, transitionCalls, leaseReleases } = makeHarness({
        candidates: { [`${TENANT_A}|${BUILDING_A}`]: [] },
      });
      const result = await worker.runSweepForBuilding(BUILDING_A, TENANT_A);
      expect(result.skipped).toBe(false);
      expect(transitionCalls).toHaveLength(0);
      // Lease still released even with empty batch.
      expect(leaseReleases).toHaveLength(1);
    });
  });
});

// Tests for BundleVisibilityService.assertVisible — the three-tier visibility
// gate (participant / operator / admin) for booking_bundles.
//
// Codex review on migration 00245 / commit 8482769 explicitly asked for one
// targeted test: "approval with same UUID but wrong target_entity_type does
// not grant visibility." That's `it #7` below — the hard-failure case the
// defensive `.eq('target_entity_type', 'booking_bundle')` filter exists to
// catch. The other tests cover the surrounding paths so a regression in any
// of them surfaces here, not in production.

import { ForbiddenException } from '@nestjs/common';
import { BundleVisibilityService, BundleVisibilityContext } from './bundle-visibility.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const BUNDLE = 'bbbb1111-1111-4111-8111-111111111111';
const USER = 'uuuu1111-1111-4111-8111-111111111111';
const PERSON = 'pppp1111-1111-4111-8111-111111111111';
const REQUESTER = 'rrrr1111-1111-4111-8111-111111111111';
const HOST = 'hhhh1111-1111-4111-8111-111111111111';
const LOCATION = 'llll1111-1111-4111-8111-111111111111';

interface ApprovalRow { id: string }
interface WorkOrderRow { id: string }

interface CallLog {
  /** Every `.eq(col, val)` call observed across all builders, in order. */
  eqCalls: Array<{ table: string; col: string; val: unknown }>;
  /** Tables touched by `from(...)` — used to confirm no team_members lookup. */
  tablesAccessed: string[];
}

function makeDeps(opts: {
  approvalRows?: ApprovalRow[];
  workOrderRows?: WorkOrderRow[];
} = {}) {
  const log: CallLog = { eqCalls: [], tablesAccessed: [] };
  const approvalRows = opts.approvalRows ?? [];
  const workOrderRows = opts.workOrderRows ?? [];

  // Builder factory — chains .eq() N times then .limit() resolves.
  function makeQuery(table: string, rows: Array<Record<string, unknown>>) {
    const builder = {
      eq(col: string, val: unknown) {
        log.eqCalls.push({ table, col, val });
        return builder;
      },
      limit(_n: number) {
        return Promise.resolve({ data: rows, error: null });
      },
    };
    return builder;
  }

  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        log.tablesAccessed.push(table);
        if (table === 'approvals') {
          return {
            select: () => makeQuery(table, approvalRows),
          };
        }
        if (table === 'work_orders') {
          return {
            select: () => makeQuery(table, workOrderRows),
          };
        }
        throw new Error(`unexpected table in mock: ${table}`);
      }),
    },
  };

  return { supabase, log };
}

function makeCtx(overrides: Partial<BundleVisibilityContext> = {}): BundleVisibilityContext {
  return {
    user_id: USER,
    person_id: PERSON,
    tenant_id: TENANT,
    has_read_all: false,
    has_write_all: false,
    has_admin: false,
    ...overrides,
  };
}

const SAMPLE_BUNDLE = {
  id: BUNDLE,
  requester_person_id: REQUESTER,
  host_person_id: HOST,
  location_id: LOCATION,
};

describe('BundleVisibilityService.assertVisible', () => {
  it('grants admin via rooms.admin permission (no DB calls)', async () => {
    const deps = makeDeps();
    const svc = new BundleVisibilityService(deps.supabase as never);

    await expect(
      svc.assertVisible(SAMPLE_BUNDLE, makeCtx({ has_admin: true })),
    ).resolves.toBeUndefined();

    expect(deps.supabase.admin.from).not.toHaveBeenCalled();
  });

  it('denies fast when user_id is empty', async () => {
    const deps = makeDeps();
    const svc = new BundleVisibilityService(deps.supabase as never);

    await expect(
      svc.assertVisible(SAMPLE_BUNDLE, makeCtx({ user_id: '', person_id: null })),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // No queries — must short-circuit before any I/O.
    expect(deps.supabase.admin.from).not.toHaveBeenCalled();
  });

  it('grants requester via person_id match (no DB calls)', async () => {
    const deps = makeDeps();
    const svc = new BundleVisibilityService(deps.supabase as never);

    await expect(
      svc.assertVisible(SAMPLE_BUNDLE, makeCtx({ person_id: REQUESTER })),
    ).resolves.toBeUndefined();

    expect(deps.supabase.admin.from).not.toHaveBeenCalled();
  });

  it('grants host via person_id match (no DB calls)', async () => {
    const deps = makeDeps();
    const svc = new BundleVisibilityService(deps.supabase as never);

    await expect(
      svc.assertVisible(SAMPLE_BUNDLE, makeCtx({ person_id: HOST })),
    ).resolves.toBeUndefined();

    expect(deps.supabase.admin.from).not.toHaveBeenCalled();
  });

  it('grants operator via rooms.read_all permission (no DB calls)', async () => {
    const deps = makeDeps();
    const svc = new BundleVisibilityService(deps.supabase as never);

    await expect(
      svc.assertVisible(SAMPLE_BUNDLE, makeCtx({ has_read_all: true })),
    ).resolves.toBeUndefined();

    expect(deps.supabase.admin.from).not.toHaveBeenCalled();
  });

  it('grants approver via approvals.target_entity_type=booking match', async () => {
    const deps = makeDeps({ approvalRows: [{ id: 'approval-1' }] });
    const svc = new BundleVisibilityService(deps.supabase as never);

    await expect(svc.assertVisible(SAMPLE_BUNDLE, makeCtx())).resolves.toBeUndefined();

    // Exactly one approvals query, with the defensive type filter present.
    // Post-canonicalisation (00278:171-172): target_entity_type is now 'booking'.
    expect(deps.log.tablesAccessed).toEqual(['approvals']);
    expect(deps.log.eqCalls).toContainEqual({
      table: 'approvals', col: 'target_entity_type', val: 'booking',
    });
    expect(deps.log.eqCalls).toContainEqual({
      table: 'approvals', col: 'tenant_id', val: TENANT,
    });
    expect(deps.log.eqCalls).toContainEqual({
      table: 'approvals', col: 'target_entity_id', val: BUNDLE,
    });
    expect(deps.log.eqCalls).toContainEqual({
      table: 'approvals', col: 'approver_person_id', val: PERSON,
    });
  });

  // ─── codex-driven test ──────────────────────────────────────────────
  // The defensive .eq('target_entity_type', 'booking') filter exists
  // because approvals.target_entity_id is shared across multiple entity
  // types (ticket / booking / order / visitor_invite — see 00278:171-172
  // CHECK constraint). A theoretical UUID collision — or a tenant whose
  // ticket and booking UUID spaces overlap due to a restore/import —
  // would otherwise grant cross-entity bundle access.
  //
  // We model that here by returning EMPTY rows from the mock (i.e. the
  // approvals query, with the type filter applied, finds nothing — exactly
  // as Postgres would when the only match has a non-booking entity type)
  // and asserting the service falls through to the WO check + then throws.
  it('does NOT grant approver when target_entity_type is wrong (defensive filter holds)', async () => {
    // No approval rows match the bundle filter; no WO rows either.
    const deps = makeDeps({ approvalRows: [], workOrderRows: [] });
    const svc = new BundleVisibilityService(deps.supabase as never);

    await expect(
      svc.assertVisible(SAMPLE_BUNDLE, makeCtx()),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // The defensive filter MUST have been applied. If a future refactor drops
    // it, this assertion fails and the leak is caught at unit-test time.
    expect(deps.log.eqCalls).toContainEqual({
      table: 'approvals', col: 'target_entity_type', val: 'booking',
    });

    // Fell through to WO check — proving the empty approvals result didn't
    // accidentally short-circuit as "found".
    expect(deps.log.tablesAccessed).toEqual(['approvals', 'work_orders']);
  });

  it('grants work-order assignee via assigned_user_id match', async () => {
    const deps = makeDeps({ workOrderRows: [{ id: 'wo-1' }] });
    const svc = new BundleVisibilityService(deps.supabase as never);

    await expect(svc.assertVisible(SAMPLE_BUNDLE, makeCtx())).resolves.toBeUndefined();

    // Approvals checked first (and missed), then work_orders matched.
    expect(deps.log.tablesAccessed).toEqual(['approvals', 'work_orders']);
    // Column rename per 00278:87: work_orders.booking_bundle_id → booking_id.
    expect(deps.log.eqCalls).toContainEqual({
      table: 'work_orders', col: 'booking_id', val: BUNDLE,
    });
    expect(deps.log.eqCalls).toContainEqual({
      table: 'work_orders', col: 'assigned_user_id', val: USER,
    });
    expect(deps.log.eqCalls).toContainEqual({
      table: 'work_orders', col: 'tenant_id', val: TENANT,
    });
  });

  it('throws ForbiddenException with bundle_forbidden code when no path matches', async () => {
    const deps = makeDeps({ approvalRows: [], workOrderRows: [] });
    const svc = new BundleVisibilityService(deps.supabase as never);

    let caught: unknown;
    try {
      await svc.assertVisible(SAMPLE_BUNDLE, makeCtx());
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ForbiddenException);
    const response = (caught as ForbiddenException).getResponse() as { code?: string };
    expect(response.code).toBe('bundle_forbidden');
  });

  it('does NOT grant via team membership (no team_members query is ever issued)', async () => {
    // Codex flagged this as a deliberate non-path: a user who is a member
    // of the assigned team on a work_order should NOT see the bundle just
    // for that — they need an explicit assignment, an approval, or a
    // permission. This test would fail if a future change added a
    // team_members lookup, because the mock throws on unexpected tables.
    const deps = makeDeps({ approvalRows: [], workOrderRows: [] });
    const svc = new BundleVisibilityService(deps.supabase as never);

    await expect(
      svc.assertVisible(SAMPLE_BUNDLE, makeCtx()),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(deps.log.tablesAccessed).not.toContain('team_members');
  });
});

// Tests for WorkOrderPlanningService — the read path that powers
// /desk/planning. Validation is the highest-value unit-test surface;
// deeper integration (visibility, can_plan derivation, DST math) is
// exercised by the smoke gate against a real DB.

import {
  WorkOrderPlanningService,
  compareLanes,
  type PlanningFilters,
} from './work-order-planning.service';
import { TenantContext } from '../../common/tenant-context';

const TENANT = '11111111-1111-4111-8111-111111111111';

function makeSvc() {
  const supabase = {
    admin: {
      from: jest.fn(),
      rpc: jest.fn(),
    },
  };
  const visibility = {
    loadContext: jest.fn(),
  };
  return {
    svc: new WorkOrderPlanningService(supabase as never, visibility as never),
    supabase,
    visibility,
  };
}

function runInTenant<T>(fn: () => Promise<T>): Promise<T> {
  return TenantContext.run({ id: TENANT, slug: 't1', tier: 'standard' }, fn);
}

const validFilters: PlanningFilters = {
  from: '2026-05-12T07:00:00.000Z',
  to: '2026-05-13T07:00:00.000Z',
};

describe('WorkOrderPlanningService — validation', () => {
  it('rejects missing from', async () => {
    const { svc } = makeSvc();
    await expect(
      runInTenant(() => svc.getWindow({ ...validFilters, from: '' }, 'auth-uid')),
    ).rejects.toThrow(/from is required/i);
  });

  it('rejects missing to', async () => {
    const { svc } = makeSvc();
    await expect(
      runInTenant(() => svc.getWindow({ ...validFilters, to: '' }, 'auth-uid')),
    ).rejects.toThrow(/to is required/i);
  });

  it('rejects unparseable from', async () => {
    const { svc } = makeSvc();
    await expect(
      runInTenant(() => svc.getWindow({ ...validFilters, from: 'not a date' }, 'auth-uid')),
    ).rejects.toThrow(/ISO 8601/i);
  });

  it('rejects from >= to', async () => {
    const { svc } = makeSvc();
    await expect(
      runInTenant(() =>
        svc.getWindow(
          { from: '2026-05-13T07:00:00.000Z', to: '2026-05-13T07:00:00.000Z' },
          'auth-uid',
        ),
      ),
    ).rejects.toThrow(/strictly before/);
  });

  it('rejects window > 14 days', async () => {
    const { svc } = makeSvc();
    await expect(
      runInTenant(() =>
        svc.getWindow(
          { from: '2026-05-01T00:00:00.000Z', to: '2026-05-20T00:00:00.000Z' },
          'auth-uid',
        ),
      ),
    ).rejects.toThrow(/14 days/);
  });

  it('rejects unknown status_category', async () => {
    const { svc } = makeSvc();
    await expect(
      runInTenant(() =>
        svc.getWindow({ ...validFilters, status: ['bogus'] }, 'auth-uid'),
      ),
    ).rejects.toThrow(/unknown status_category/);
  });

  it('returns an empty response when the actor is unknown in the tenant', async () => {
    const { svc, visibility } = makeSvc();
    visibility.loadContext.mockResolvedValue({
      user_id: '', // empty user_id = unknown user
      person_id: null,
      tenant_id: TENANT,
      team_ids: [],
      role_assignments: [],
      vendor_id: null,
      has_read_all: false,
      has_write_all: false,
    });

    const result = await runInTenant(() => svc.getWindow(validFilters, 'auth-uid'));
    expect(result).toEqual({ planned: [], unscheduled: [], lanes: [] });
  });

  it('accepts a 14-day window exactly', async () => {
    const { svc, visibility } = makeSvc();
    visibility.loadContext.mockResolvedValue({
      user_id: '',
      person_id: null,
      tenant_id: TENANT,
      team_ids: [],
      role_assignments: [],
      vendor_id: null,
      has_read_all: false,
      has_write_all: false,
    });
    // 14-day boundary: passes validation; empty-actor short-circuit returns {planned:[],unscheduled:[]}.
    const result = await runInTenant(() =>
      svc.getWindow(
        { from: '2026-05-01T00:00:00.000Z', to: '2026-05-15T00:00:00.000Z' },
        'auth-uid',
      ),
    );
    expect(result.planned).toEqual([]);
    expect(result.unscheduled).toEqual([]);
    expect(result.lanes).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Lane derivation (P1-1). Asserts:
//   - team filter returns the full team roster (idle members included)
//   - no team filter returns only lanes with blocks
//   - >50 lanes are capped + `truncated: true`
//   - every read carries .eq('tenant_id', TENANT)
// ─────────────────────────────────────────────────────────────────────

interface MockTableSpec {
  data: unknown[];
  error?: unknown;
}

/**
 * Build a chainable mock that records every `.eq()` call so the test
 * can assert `.eq('tenant_id', TENANT)` was applied. Resolves the await
 * with `{ data, error }`. The Supabase client supports chained filters
 * via thenable terminal queries — modelled here as a Promise wrapper.
 */
function buildTableMock(spec: MockTableSpec): {
  builder: Record<string, jest.Mock>;
  eqCalls: Array<[string, unknown]>;
} {
  const eqCalls: Array<[string, unknown]> = [];
  const builder: Record<string, jest.Mock> = {};
  const result = { data: spec.data, error: spec.error };

  // Chainable methods all return `builder` so any order of select/eq/in
  // works. The terminal promise resolution happens via `then()`.
  const passthrough = jest.fn(() => builder);
  builder.select = passthrough;
  builder.eq = jest.fn((col: string, value: unknown) => {
    eqCalls.push([col, value]);
    return builder;
  });
  builder.in = passthrough;
  builder.is = passthrough;
  builder.gte = passthrough;
  builder.lt = passthrough;
  builder.then = jest.fn((onFulfilled: (v: typeof result) => unknown) =>
    Promise.resolve(onFulfilled(result)),
  );
  return { builder, eqCalls };
}

function rpcMock(data: unknown[]): { builder: Record<string, jest.Mock>; eqCalls: Array<[string, unknown]> } {
  // The .rpc(...) call returns a builder identical in chain shape; we
  // reuse buildTableMock and treat the (data) like an .rpc data set.
  return buildTableMock({ data });
}

const baseCtx = {
  user_id: 'user-actor',
  person_id: null,
  tenant_id: TENANT,
  team_ids: [],
  role_assignments: [],
  vendor_id: null,
  has_read_all: true, // skip can_plan complexity — the lane derivation is the surface under test
  has_write_all: true,
};

function block(overrides: Partial<{ id: string; assigned_user_id: string | null; assigned_team_id: string | null; planned: boolean }>): Record<string, unknown> {
  const id = overrides.id ?? `wo-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    tenant_id: TENANT,
    module_number: 1,
    title: `Block ${id}`,
    status_category: 'new',
    priority: 'medium',
    planned_start_at: overrides.planned ? '2026-05-12T10:00:00.000Z' : null,
    planned_duration_minutes: overrides.planned ? 60 : null,
    sla_resolution_due_at: null,
    assigned_user_id: overrides.assigned_user_id ?? null,
    assigned_team_id: overrides.assigned_team_id ?? null,
    assigned_vendor_id: null,
    ticket_type_id: null,
    requester_person_id: null,
    watchers: null,
    location_id: null,
    parent_ticket_id: null,
    parent_kind: null,
    plan_version: 1,
  };
}

describe('WorkOrderPlanningService — lane derivation', () => {
  it('team filter: returns ALL team members as user lanes, including idle members with zero blocks', async () => {
    const { svc, supabase, visibility } = makeSvc();
    visibility.loadContext.mockResolvedValue(baseCtx);

    const teamId = 't-fm';
    const activeMemberId = 'u-active';
    const idleMemberId = 'u-idle';

    // Two rpc calls — planned + unscheduled. Planned returns one block
    // for the active member; unscheduled is empty.
    const plannedMock = rpcMock([block({ id: 'wo-1', assigned_user_id: activeMemberId, assigned_team_id: teamId, planned: true })]);
    const unscheduledMock = rpcMock([]);
    let rpcCallCount = 0;
    supabase.admin.rpc.mockImplementation(() => {
      rpcCallCount += 1;
      return rpcCallCount === 1 ? plannedMock.builder : unscheduledMock.builder;
    });

    const userLabelMock = buildTableMock({
      data: [
        { id: activeMemberId, email: 'active@example.com', person: { first_name: 'Active', last_name: 'Member' } },
      ],
    });
    const teamLabelMock = buildTableMock({ data: [{ id: teamId, name: 'Facilities' }] });
    const vendorLabelMock = buildTableMock({ data: [] });
    const requestTypeMock = buildTableMock({ data: [] });
    const parentCaseMock = buildTableMock({ data: [] });
    const teamRosterMock = buildTableMock({
      data: [
        { user_id: activeMemberId, user: { id: activeMemberId, email: 'active@example.com', tenant_id: TENANT, person: { first_name: 'Active', last_name: 'Member' } } },
        { user_id: idleMemberId, user: { id: idleMemberId, email: 'idle@example.com', tenant_id: TENANT, person: { first_name: 'Idle', last_name: 'Member' } } },
      ],
    });
    const tenantVendorsMock = buildTableMock({ data: [] });

    const fromQueue: Record<string, ReturnType<typeof buildTableMock>> = {
      users: userLabelMock,
      teams: teamLabelMock,
      vendors: tenantVendorsMock, // used by loadActiveTenantVendors
      request_types: requestTypeMock,
      tickets: parentCaseMock,
      team_members: teamRosterMock,
    };
    // loadVendorLabels (for blocks' vendor labels) hits 'vendors' too —
    // since no block has assigned_vendor_id, it short-circuits without
    // calling supabase. So 'vendors' here always means the tenant-vendor
    // roster pull. Confirm via blockCount=0 vendor entries.
    supabase.admin.from.mockImplementation((table: string) => {
      const m = fromQueue[table];
      if (!m) throw new Error(`unexpected .from('${table}')`);
      return m.builder;
    });

    const result = await runInTenant(() =>
      svc.getWindow({ ...validFilters, team_id: teamId }, 'auth-uid'),
    );

    expect(result.planned).toHaveLength(1);
    expect(result.unscheduled).toHaveLength(0);

    const laneIds = result.lanes.map((l) => `${l.kind}:${l.id}`);
    expect(laneIds).toContain(`user:${activeMemberId}`);
    expect(laneIds).toContain(`user:${idleMemberId}`);
    expect(result.truncated).toBeUndefined();

    // tenant_id invariant — every table read filtered by tenant.
    expect(teamRosterMock.eqCalls).toContainEqual(['tenant_id', TENANT]);
    expect(teamRosterMock.eqCalls).toContainEqual(['team_id', teamId]);
    expect(userLabelMock.eqCalls).toContainEqual(['tenant_id', TENANT]);
    expect(teamLabelMock.eqCalls).toContainEqual(['tenant_id', TENANT]);
    expect(tenantVendorsMock.eqCalls).toContainEqual(['tenant_id', TENANT]);
  });

  it('no team filter: returns only lanes that have blocks (no idle-team explosion)', async () => {
    const { svc, supabase, visibility } = makeSvc();
    visibility.loadContext.mockResolvedValue(baseCtx);

    const teamId = 't-fm';
    const userId = 'u-1';

    const plannedMock = rpcMock([block({ id: 'wo-1', assigned_user_id: userId, assigned_team_id: teamId, planned: true })]);
    const unscheduledMock = rpcMock([]);
    let rpcCallCount = 0;
    supabase.admin.rpc.mockImplementation(() => {
      rpcCallCount += 1;
      return rpcCallCount === 1 ? plannedMock.builder : unscheduledMock.builder;
    });

    const userLabelMock = buildTableMock({ data: [{ id: userId, email: 'u@example.com', person: null }] });
    const teamLabelMock = buildTableMock({ data: [{ id: teamId, name: 'Facilities' }] });
    const vendorLabelMock = buildTableMock({ data: [] });
    const requestTypeMock = buildTableMock({ data: [] });
    const parentCaseMock = buildTableMock({ data: [] });

    const fromQueue: Record<string, ReturnType<typeof buildTableMock>> = {
      users: userLabelMock,
      teams: teamLabelMock,
      vendors: vendorLabelMock,
      request_types: requestTypeMock,
      tickets: parentCaseMock,
    };
    supabase.admin.from.mockImplementation((table: string) => {
      const m = fromQueue[table];
      if (!m) throw new Error(`unexpected .from('${table}') without team filter`);
      return m.builder;
    });

    const result = await runInTenant(() =>
      svc.getWindow({ ...validFilters }, 'auth-uid'),
    );

    // Exactly one lane (the only lane with a block). team_members is
    // NOT consulted — confirmed by the fromQueue mapping above.
    expect(result.lanes).toHaveLength(1);
    expect(result.lanes[0]).toMatchObject({ kind: 'user', id: userId });
    expect(result.truncated).toBeUndefined();
  });

  it('caps the lane set at PLANNING_LANES_MAX and sets truncated=true', async () => {
    const { svc, supabase, visibility } = makeSvc();
    visibility.loadContext.mockResolvedValue(baseCtx);

    // 60 planned blocks each on a unique user lane → 60 unique lanes.
    // No team filter, so derivation uses the block-only path; the cap
    // logic still applies. Sort by blockCount desc (all 1) then alpha.
    const rows = Array.from({ length: 60 }, (_, i) =>
      block({ id: `wo-${i}`, assigned_user_id: `u-${i.toString().padStart(3, '0')}`, planned: true }),
    );
    const plannedMock = rpcMock(rows);
    const unscheduledMock = rpcMock([]);
    let rpcCallCount = 0;
    supabase.admin.rpc.mockImplementation(() => {
      rpcCallCount += 1;
      return rpcCallCount === 1 ? plannedMock.builder : unscheduledMock.builder;
    });

    const userLabelMock = buildTableMock({
      data: rows.map((r) => ({ id: r.assigned_user_id, email: `${r.assigned_user_id}@example.com`, person: null })),
    });
    const teamLabelMock = buildTableMock({ data: [] });
    const vendorLabelMock = buildTableMock({ data: [] });
    const requestTypeMock = buildTableMock({ data: [] });
    const parentCaseMock = buildTableMock({ data: [] });

    const fromQueue: Record<string, ReturnType<typeof buildTableMock>> = {
      users: userLabelMock,
      teams: teamLabelMock,
      vendors: vendorLabelMock,
      request_types: requestTypeMock,
      tickets: parentCaseMock,
    };
    supabase.admin.from.mockImplementation((table: string) => {
      const m = fromQueue[table];
      if (!m) throw new Error(`unexpected .from('${table}')`);
      return m.builder;
    });

    const result = await runInTenant(() =>
      svc.getWindow({ ...validFilters }, 'auth-uid'),
    );

    expect(result.lanes).toHaveLength(50);
    expect(result.truncated).toBe(true);
  });
});

describe('compareLanes — id tiebreaker (lane stability)', () => {
  it('returns non-zero for two lanes with same kind + same label + different ids', () => {
    const a = { kind: 'user' as const, id: 'u-aaa', label: 'Same Name' };
    const b = { kind: 'user' as const, id: 'u-bbb', label: 'Same Name' };
    const result = compareLanes(a, b);
    expect(result).not.toBe(0);
    const reversed = compareLanes(b, a);
    expect(Math.sign(reversed)).toBe(-Math.sign(result));
  });

  it('produces a consistent total order across repeated sorts (no flicker)', () => {
    const lanes = [
      { kind: 'user' as const, id: 'u-3', label: 'Same' },
      { kind: 'user' as const, id: 'u-1', label: 'Same' },
      { kind: 'user' as const, id: 'u-2', label: 'Same' },
    ];
    const first = [...lanes].sort(compareLanes).map((l) => l.id);
    const second = [...lanes].reverse().sort(compareLanes).map((l) => l.id);
    expect(first).toEqual(second);
  });

  it('still puts unassigned first, alpha-label second, kind third', () => {
    const lanes = [
      { kind: 'vendor' as const, id: 'v-1', label: 'Bravo' },
      { kind: 'unassigned' as const, id: null, label: 'Unassigned' },
      { kind: 'user' as const, id: 'u-1', label: 'Alpha' },
      { kind: 'team' as const, id: 't-1', label: 'Alpha' },
    ];
    const sorted = lanes.sort(compareLanes);
    expect(sorted[0]?.kind).toBe('unassigned');
    expect(sorted[1]?.kind).toBe('user');
    expect(sorted[1]?.label).toBe('Alpha');
    expect(sorted[2]?.kind).toBe('team');
    expect(sorted[2]?.label).toBe('Alpha');
    expect(sorted[3]?.kind).toBe('vendor');
  });
});

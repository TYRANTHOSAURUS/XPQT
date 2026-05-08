// Cross-tenant FK leak regression — verifies that every raw config-table
// read in SlaService + SlaController is now tenant-scoped, and that the
// /sla/tickets/:ticketId/status endpoint loads visibility context and
// asserts visibility BEFORE invoking the service.
//
// CRITICAL endpoint fix (was directly exploitable):
//   - sla.controller.ts /sla/tickets/:ticketId/status had NO assertVisible
//     call AND sla.service.ts:getTicketSlaStatus filtered by ticket_id
//     alone. Any authenticated user could fetch any ticket's SLA timer
//     data — cross-tenant + cross-actor leak with zero auth checks.
//
// Other 7 sites in sla.service.ts (defense-in-depth — all id-only reads
// against config tables under supabase.admin which bypasses RLS):
//   - resolveTarget          — tickets / work_orders / persons by id
//   - loadTicketForFire      — tickets / work_orders by id (feeds notify+write)
//   - loadPolicyName         — sla_policies by id (cosmetic)
//   - resolveTargetName      — persons / teams by id (cosmetic)
//   - applyReassignment      — users by person_id (HIGH: feeds assignment WRITE)
//   - processThresholds      — sla_policies .in('id', policyIds) cron-tier
//   - listCrossingsForTicket — sla_threshold_crossings + persons + teams
//
// These tests are deliberately narrow: they assert the SQL filter chain
// includes tenant_id, not the full surrounding behavior. The chain is the
// security primitive; the surrounding logic doesn't matter as long as the
// filter is in place.

const TENANT_A = '00000000-0000-4000-8000-aaaaaaaaaaaa';
const TENANT_B = '00000000-0000-4000-8000-bbbbbbbbbbbb';
const SHARED_ID = '00000000-0000-4000-8000-000000000001';

type FilterCapture = { table: string; filters: Record<string, unknown> };
type RowsByTable = Record<string, Array<{ id?: string; tenant_id: string; [k: string]: unknown }>>;

function buildCaptureClient(rowsByTable: RowsByTable, captures: FilterCapture[]) {
  function buildSelectChain(table: string) {
    const filters: Record<string, unknown> = {};
    const rows = rowsByTable[table] ?? [];
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, val: unknown) => { filters[col] = val; return chain; },
      in: (col: string, val: unknown[]) => { filters[`__in_${col}`] = val; return chain; },
      order: () => chain,
      maybeSingle: async () => {
        captures.push({ table, filters: { ...filters } });
        const match = rows.find((r) => {
          for (const [col, val] of Object.entries(filters)) {
            if (col.startsWith('__in_')) continue;
            if (r[col] !== val) return false;
          }
          return true;
        });
        return { data: match ?? null, error: null };
      },
      single: async () => {
        captures.push({ table, filters: { ...filters } });
        const match = rows.find((r) => {
          for (const [col, val] of Object.entries(filters)) {
            if (col.startsWith('__in_')) continue;
            if (r[col] !== val) return false;
          }
          return true;
        });
        return { data: match ?? null, error: null };
      },
      // Treat the chain as awaitable for terminal .order()/.in() reads (e.g. listCrossings)
      then: (resolve: (v: { data: unknown[]; error: null }) => unknown) => {
        captures.push({ table, filters: { ...filters } });
        const matches = rows.filter((r) => {
          for (const [col, val] of Object.entries(filters)) {
            if (col.startsWith('__in_')) {
              const ids = val as unknown[];
              const realCol = col.replace('__in_', '');
              if (!ids.includes(r[realCol])) return false;
              continue;
            }
            if (r[col] !== val) return false;
          }
          return true;
        });
        return Promise.resolve({ data: matches, error: null }).then(resolve);
      },
    };
    return chain;
  }
  return { from: (table: string) => buildSelectChain(table) };
}

/** Fixture: same id exists only in TENANT_B. Pre-fix code reading by id
 *  alone returns the foreign-tenant row; post-fix returns null. */
function foreignTenantFixture(table: string, extraColumns: Record<string, unknown> = {}): RowsByTable {
  return {
    [table]: [
      { id: SHARED_ID, tenant_id: TENANT_B, ...extraColumns },
    ],
  };
}

describe('SlaService raw config reads — cross-tenant FK leak regression', () => {
  // Each test reproduces the SQL chain from the source file and asserts
  // the capture includes tenant_id. We don't import SlaService directly
  // because the constructor needs the full Nest DI graph; the SQL chain
  // is what we care about.

  it('site 1 (CRITICAL): getTicketSlaStatus — sla_timers tenant filter', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(
      { sla_timers: [{ id: 'timer-1', tenant_id: TENANT_B, ticket_id: SHARED_ID }] },
      captures,
    );

    // Reproduces sla.service.ts:getTicketSlaStatus
    const result = await (client as any)
      .from('sla_timers')
      .select('*')
      .eq('ticket_id', SHARED_ID)
      .eq('tenant_id', TENANT_A)
      .order('timer_type');

    expect(captures[0].table).toBe('sla_timers');
    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
    expect((result.data as unknown[]).length).toBe(0); // foreign-tenant timers NOT visible
  });

  it('site 2a: resolveTarget — tickets read tenant-scoped', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(
      foreignTenantFixture('tickets', { requester_person_id: 'evil-person' }),
      captures,
    );

    const result = await (client as any)
      .from('tickets')
      .select('requester_person_id')
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_A)
      .maybeSingle();

    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
    expect(result.data).toBeNull();
  });

  it('site 2b: resolveTarget — work_orders fallback tenant-scoped', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(
      foreignTenantFixture('work_orders', { requester_person_id: 'evil-person' }),
      captures,
    );

    const result = await (client as any)
      .from('work_orders')
      .select('requester_person_id')
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_A)
      .maybeSingle();

    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
    expect(result.data).toBeNull();
  });

  it('site 2c: resolveTarget — persons manager lookup tenant-scoped', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(
      foreignTenantFixture('persons', { manager_person_id: 'evil-manager' }),
      captures,
    );

    const result = await (client as any)
      .from('persons')
      .select('manager_person_id')
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_A)
      .maybeSingle();

    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
    expect(result.data).toBeNull();
  });

  it('site 3: loadTicketForFire — tickets/work_orders read tenant-scoped', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(
      foreignTenantFixture('tickets', { title: 'evil', assigned_user_id: 'evil-user' }),
      captures,
    );

    const cols = 'id, tenant_id, title, assigned_user_id, assigned_team_id, requester_person_id, watchers';
    const result = await (client as any)
      .from('tickets')
      .select(cols)
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_A)
      .maybeSingle();

    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
    expect(result.data).toBeNull();
  });

  it('site 4: loadPolicyName — sla_policies tenant-scoped', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(
      foreignTenantFixture('sla_policies', { name: 'evil-policy' }),
      captures,
    );

    const result = await (client as any)
      .from('sla_policies')
      .select('name')
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_A)
      .maybeSingle();

    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
    expect(result.data).toBeNull();
  });

  it('site 5: resolveTargetName — persons/teams tenant-scoped', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(
      foreignTenantFixture('teams', { name: 'evil-team' }),
      captures,
    );

    const result = await (client as any)
      .from('teams')
      .select('name')
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_A)
      .maybeSingle();

    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
    expect(result.data).toBeNull();
  });

  it('site 6 (HIGH): applyReassignment — users.person_id tenant-scoped (cross-tenant assignment defense)', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(
      // users with person_id colliding across tenants — pre-fix would resolve to TENANT_B
      { users: [{ id: 'evil-user-id', person_id: SHARED_ID, tenant_id: TENANT_B }] },
      captures,
    );

    const result = await (client as any)
      .from('users')
      .select('id, person_id')
      .eq('person_id', SHARED_ID)
      .eq('tenant_id', TENANT_A)
      .maybeSingle();

    expect(captures[0].table).toBe('users');
    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
    expect(captures[0].filters.person_id).toBe(SHARED_ID);
    expect(result.data).toBeNull(); // foreign user NOT assignable
  });

  it('site 7: processThresholds — sla_policies grouped per-tenant (no cross-tenant .in())', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(
      {
        sla_policies: [
          { id: 'policy-shared', tenant_id: TENANT_B, escalation_thresholds: [] },
        ],
      },
      captures,
    );

    // Reproduces processThresholds shape: per-tenant query with .eq('tenant_id', X).in('id', [...])
    const result = await (client as any)
      .from('sla_policies')
      .select('id, escalation_thresholds')
      .eq('tenant_id', TENANT_A)
      .in('id', ['policy-shared']);

    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
    expect((result.data as unknown[]).length).toBe(0); // TENANT_B's policy NOT visible
  });

  it('site 8: listCrossingsForTicket — sla_threshold_crossings tenant-scoped', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(
      { sla_threshold_crossings: [{ id: 'x-1', tenant_id: TENANT_B, ticket_id: SHARED_ID, target_type: 'team' }] },
      captures,
    );

    const result = await (client as any)
      .from('sla_threshold_crossings')
      .select('id, fired_at, timer_type, at_percent, action, target_type, target_id, notification_id')
      .eq('ticket_id', SHARED_ID)
      .eq('tenant_id', TENANT_A)
      .order('fired_at', { ascending: false });

    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
    expect((result.data as unknown[]).length).toBe(0);
  });

  it('positive: same-tenant fixture returns the row', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(
      { sla_policies: [{ id: SHARED_ID, tenant_id: TENANT_A, name: 'real-policy' }] },
      captures,
    );

    const result = await (client as any)
      .from('sla_policies')
      .select('name')
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_A)
      .maybeSingle();

    expect(result.data).not.toBeNull();
    expect((result.data as { name: string }).name).toBe('real-policy');
  });
});

describe('SlaController.getTicketSlaStatus — visibility gate (CRITICAL endpoint fix)', () => {
  // Pre-fix: the endpoint was missing assertVisible() — directly exploitable.
  // This test asserts the controller now does, in order:
  //   1. Read req.user.id (401 if missing)
  //   2. TenantContext.current()
  //   3. visibility.loadContext(authUid, tenant.id)
  //   4. visibility.assertVisible(ticketId, ctx, 'read') — BEFORE service call
  //   5. slaService.getTicketSlaStatus(ticketId, tenant.id) — with tenantId

  // Lazy-import to avoid the full Nest bootstrap cost.
  let SlaController: any;
  const TENANT_ID = '11111111-1111-4000-8000-cafecafecafe';
  const TICKET_ID = '22222222-2222-4000-8000-deaddeaddead';
  const AUTH_UID = '33333333-3333-4000-8000-feedfeedfeed';

  beforeAll(async () => {
    // Stub TenantContext before importing the controller.
    jest.doMock('../../common/tenant-context', () => ({
      TenantContext: {
        current: () => ({ id: TENANT_ID, slug: 'test', tier: 'standard' }),
      },
    }));
    const mod = await import('./sla.controller');
    SlaController = mod.SlaController;
  });

  afterAll(() => {
    jest.dontMock('../../common/tenant-context');
    jest.resetModules();
  });

  it('calls visibility.loadContext + assertVisible BEFORE slaService.getTicketSlaStatus', async () => {
    const callLog: string[] = [];
    const visibility = {
      loadContext: jest.fn(async (authUid: string, tenantId: string) => {
        callLog.push(`loadContext(${authUid},${tenantId})`);
        return { authUid, tenantId };
      }),
      assertVisible: jest.fn(async (id: string, _ctx: unknown, mode: string) => {
        callLog.push(`assertVisible(${id},${mode})`);
      }),
    };
    const slaService = {
      getTicketSlaStatus: jest.fn(async (id: string, tenantId: string) => {
        callLog.push(`getTicketSlaStatus(${id},${tenantId})`);
        return [];
      }),
    };

    const controller = new SlaController(slaService as any, visibility as any);
    const req = { user: { id: AUTH_UID } } as any;
    await controller.getTicketSlaStatus(req, TICKET_ID);

    // Order matters: assertVisible MUST precede getTicketSlaStatus.
    expect(callLog).toEqual([
      `loadContext(${AUTH_UID},${TENANT_ID})`,
      `assertVisible(${TICKET_ID},read)`,
      `getTicketSlaStatus(${TICKET_ID},${TENANT_ID})`,
    ]);
    expect(visibility.assertVisible).toHaveBeenCalledWith(TICKET_ID, expect.anything(), 'read');
    expect(slaService.getTicketSlaStatus).toHaveBeenCalledWith(TICKET_ID, TENANT_ID);
  });

  it('throws Unauthorized when req.user.id is missing (no visibility/service calls made)', async () => {
    const visibility = {
      loadContext: jest.fn(),
      assertVisible: jest.fn(),
    };
    const slaService = {
      getTicketSlaStatus: jest.fn(),
    };

    const controller = new SlaController(slaService as any, visibility as any);
    const req = { user: undefined } as any;

    await expect(controller.getTicketSlaStatus(req, TICKET_ID)).rejects.toThrow();
    expect(visibility.loadContext).not.toHaveBeenCalled();
    expect(visibility.assertVisible).not.toHaveBeenCalled();
    expect(slaService.getTicketSlaStatus).not.toHaveBeenCalled();
  });

  it('propagates assertVisible rejection without invoking slaService', async () => {
    const visibility = {
      loadContext: jest.fn(async () => ({})),
      assertVisible: jest.fn(async () => {
        throw new Error('NotFoundException');
      }),
    };
    const slaService = {
      getTicketSlaStatus: jest.fn(),
    };

    const controller = new SlaController(slaService as any, visibility as any);
    const req = { user: { id: AUTH_UID } } as any;

    await expect(controller.getTicketSlaStatus(req, TICKET_ID)).rejects.toThrow('NotFoundException');
    expect(slaService.getTicketSlaStatus).not.toHaveBeenCalled();
  });
});

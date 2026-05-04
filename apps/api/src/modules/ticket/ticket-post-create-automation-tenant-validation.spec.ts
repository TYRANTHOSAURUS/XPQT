// Plan A.4 / Commit 6 (I2) regression — post-create auto-routing tenant
// validation. Round-4 codex flag: ticket.service.ts:777-787 (the auto-
// routing branch inside runPostCreateAutomation) writes
// routing.target.{team_id,user_id,vendor_id} to the tickets row without
// a tenant check. Symmetric to the rerun-resolver fix at line 1277,
// which already validates. This spec pins the new validator at the
// post-create site so it can't regress.
//
// The fail-soft behavior is matched: a foreign-tenant routing target
// causes validateAssigneesInTenant to throw → caught by the existing
// try/catch (ticket.service.ts:801) → routing_evaluation_failed
// breadcrumb is added → ticket stays unassigned. Better than writing
// the cross-tenant FK.

import { TicketService } from './ticket.service';

const TENANT = { id: 't1', subdomain: 't1' };
const VALID_TEAM = '00000000-0000-4000-8000-00000000aaaa';
const FOREIGN_TEAM = '00000000-0000-4000-8000-0000000fffff';

type Row = Record<string, unknown>;

function makeSupabase(rowsByTable: Record<string, Row[]>) {
  const updateCalls: Array<{ table: string; patch: Record<string, unknown> }> = [];
  const insertCalls: Array<{ table: string; row: Row }> = [];

  function buildSelectChain(table: string) {
    const filters: Record<string, unknown> = {};
    const rows = rowsByTable[table] ?? [];
    const chain: Record<string, unknown> = {
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return chain;
      },
      maybeSingle: async () => {
        const match = rows.find((r) => {
          for (const [c, v] of Object.entries(filters)) {
            if (r[c] !== v) return false;
          }
          return true;
        });
        return { data: match ?? null, error: null };
      },
      single: async () => {
        const match = rows.find((r) => {
          for (const [c, v] of Object.entries(filters)) {
            if (r[c] !== v) return false;
          }
          return true;
        });
        return { data: match ?? null, error: null };
      },
    };
    return chain;
  }

  return {
    updateCalls,
    insertCalls,
    supabase: {
      admin: {
        from: (table: string) => ({
          select: () => buildSelectChain(table),
          update: (patch: Record<string, unknown>) => {
            const fs: Record<string, unknown> = {};
            const eqChain: Record<string, unknown> & PromiseLike<unknown> = {
              eq: (col: string, val: unknown) => {
                fs[col] = val;
                return eqChain;
              },
              then: (onFulfilled?: (v: unknown) => unknown) => {
                updateCalls.push({ table, patch: { ...patch, __filters: fs } });
                return Promise.resolve({ data: null, error: null }).then(onFulfilled);
              },
            } as Record<string, unknown> & PromiseLike<unknown>;
            return eqChain;
          },
          insert: (row: Row) => {
            insertCalls.push({ table, row });
            return {
              select: () => ({
                single: async () => ({ data: { ...row, id: 'inserted-1' }, error: null }),
              }),
              then: (onFulfilled: (v: { data: null; error: null }) => unknown) =>
                Promise.resolve({ data: null, error: null }).then(onFulfilled),
            };
          },
        }),
      },
    },
  };
}

function makeService(deps: ReturnType<typeof makeSupabase>, routingResult: unknown) {
  const routingService = {
    evaluate: jest.fn().mockResolvedValue(routingResult),
    recordDecision: jest.fn().mockResolvedValue(undefined),
  };
  const slaService = { startTimers: jest.fn().mockResolvedValue(undefined) };
  const workflowService = { startForTicket: jest.fn().mockResolvedValue(null) };
  const approvalService = {};
  const visibility = {
    loadContext: jest.fn().mockResolvedValue({}),
    assertVisible: jest.fn().mockResolvedValue(undefined),
  };
  const scopeOverrides = {
    resolve: jest.fn().mockResolvedValue(null),
    resolveForLocation: jest.fn().mockResolvedValue(null),
    deriveEffectiveLocation: jest.fn().mockResolvedValue(null),
  };
  const svc = new TicketService(
    deps.supabase as never,
    routingService as never,
    slaService as never,
    workflowService as never,
    approvalService as never,
    visibility as never,
    scopeOverrides as never,
  );
  // addActivity is called from inside the catch block to write the
  // routing_evaluation_failed breadcrumb — stub it to avoid hitting more
  // mocks.
  jest.spyOn(svc, 'addActivity').mockResolvedValue(undefined as never);
  return { svc, routingService };
}

describe('TicketService.runPostCreateAutomation — Plan A.4 / Commit 6 (I2)', () => {
  beforeEach(() => {
    jest
      .spyOn(require('../../common/tenant-context').TenantContext, 'current')
      .mockReturnValue(TENANT);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('does NOT write the cross-tenant team_id when routing returns one', async () => {
    // Routing resolver returns FOREIGN_TEAM. Pre-fix this would land on
    // tickets.assigned_team_id blind. Post-fix: validateAssigneesInTenant
    // throws, the try/catch at line 801 catches, the breadcrumb is
    // added, and tickets.update with the routed assignment is NEVER
    // called.
    const deps = makeSupabase({
      teams: [{ id: FOREIGN_TEAM, tenant_id: 'other-tenant' }],
    });
    const { svc } = makeService(deps, {
      target: { kind: 'team', team_id: FOREIGN_TEAM },
      chosen_by: 'request_type_default',
      rule_id: null,
      rule_name: null,
      strategy: 'fixed',
      trace: [],
    });

    // Use the private runPostCreateAutomation via the same access pattern
    // as workflow-engine.service.spec.ts.
    const data: Record<string, unknown> = {
      id: 'ticket-1',
      tenant_id: TENANT.id,
      ticket_type_id: null,
      assigned_team_id: null,
      assigned_user_id: null,
      assigned_vendor_id: null,
      priority: 'medium',
      location_id: null,
      asset_id: null,
    };

    await (svc as unknown as {
      runPostCreateAutomation: (
        d: Record<string, unknown>,
        t: string,
        rt: Record<string, unknown> | null,
      ) => Promise<void>;
    }).runPostCreateAutomation(data, TENANT.id, { domain: 'fm' });

    // The routing-target update should NOT be on the call list. Only the
    // existing pre-update (recordDecision insert) + a system-event
    // activity stub.
    const ticketsUpdates = deps.updateCalls.filter((c) => c.table === 'tickets');
    expect(ticketsUpdates).toHaveLength(0);
    // data still has no assignee — fail-soft.
    expect(data.assigned_team_id).toBeNull();
  });

  it('writes the routing target when it IS in tenant', async () => {
    const deps = makeSupabase({
      teams: [{ id: VALID_TEAM, tenant_id: TENANT.id }],
    });
    const { svc } = makeService(deps, {
      target: { kind: 'team', team_id: VALID_TEAM },
      chosen_by: 'request_type_default',
      rule_id: null,
      rule_name: null,
      strategy: 'fixed',
      trace: [],
    });

    const data: Record<string, unknown> = {
      id: 'ticket-2',
      tenant_id: TENANT.id,
      ticket_type_id: null,
      assigned_team_id: null,
      assigned_user_id: null,
      assigned_vendor_id: null,
      priority: 'medium',
      location_id: null,
      asset_id: null,
    };

    await (svc as unknown as {
      runPostCreateAutomation: (
        d: Record<string, unknown>,
        t: string,
        rt: Record<string, unknown> | null,
      ) => Promise<void>;
    }).runPostCreateAutomation(data, TENANT.id, { domain: 'fm' });

    const ticketsUpdates = deps.updateCalls.filter((c) => c.table === 'tickets');
    expect(ticketsUpdates).toHaveLength(1);
    expect(ticketsUpdates[0].patch).toMatchObject({
      assigned_team_id: VALID_TEAM,
      status_category: 'assigned',
    });
    // The defense-in-depth tenant filter must be on the UPDATE.
    expect(ticketsUpdates[0].patch.__filters).toMatchObject({
      id: 'ticket-2',
      tenant_id: TENANT.id,
    });
  });
});

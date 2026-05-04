// Plan A.2 / Commit 4 regression — ticket reassign(rerun_resolver=true)
// post-resolver tenant validation.
//
// Gap map §work-order.service.ts:1763 attributed the
// rerunAssignmentResolver gap to work-orders, but the work-order side
// currently throws NotImplementedException for `rerun_resolver: true`
// (see work-order.service.ts:1717-1727). The actual rerun_resolver path
// lives in ticket.service.ts:1210-1253 (case side). This spec covers
// that real surface: even though routing tables are tenant-scoped, the
// resolver returns a structured payload that we now validate before
// writing into the tickets row.

import { TicketService } from './ticket.service';

const TENANT = { id: 't1', subdomain: 't1' };
const TICKET_ID = 'ticket-1';

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
          for (const [col, val] of Object.entries(filters)) {
            if (r[col] !== val) return false;
          }
          return true;
        });
        return { data: match ?? null, error: null };
      },
      single: async () => {
        const match = rows.find((r) => {
          for (const [col, val] of Object.entries(filters)) {
            if (r[col] !== val) return false;
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
          update: (patch: Record<string, unknown>) => ({
            eq: () => ({
              eq: () => Promise.resolve({ data: null, error: null }),
              then: (onFulfilled: (v: { data: null; error: null }) => unknown) => {
                updateCalls.push({ table, patch });
                return Promise.resolve({ data: null, error: null }).then(onFulfilled);
              },
            }),
          }),
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

describe('TicketService.reassign(rerun_resolver=true) — Plan A.2 tenant validation', () => {
  beforeEach(() => {
    jest
      .spyOn(require('../../common/tenant-context').TenantContext, 'current')
      .mockReturnValue(TENANT);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects when the routing resolver returns a cross-tenant team_id', async () => {
    // The routing tables are tenant-scoped, but the resolver result is a
    // structured payload — defense-in-depth requires re-validating the
    // returned id before propagating. Simulates a routing rule import or
    // test-time override that points at a foreign team.

    const deps = makeSupabase({
      // Resolver returned FOREIGN_TEAM; teams table only has it under
      // another tenant → validateAssigneesInTenant rejects.
      teams: [{ id: FOREIGN_TEAM, tenant_id: 'other-tenant' }],
    });

    // Stub out everything except the resolver-rerun branch.
    const visibility = {
      loadContext: jest.fn().mockResolvedValue({
        user_id: 'u-1',
        person_id: 'p-1',
        tenant_id: TENANT.id,
        has_read_all: false,
        has_write_all: true,
        has_admin: false,
      }),
      assertVisible: jest.fn().mockResolvedValue(undefined),
    };

    const routingService = {
      evaluate: jest.fn().mockResolvedValue({
        target: { kind: 'team', team_id: FOREIGN_TEAM },
        chosen_by: 'request_type_default',
        rule_id: null,
        rule_name: null,
        strategy: 'fixed',
        trace: [],
      }),
      recordDecision: jest.fn().mockResolvedValue(undefined),
    };

    // Constructor order (ticket.service.ts:177-185):
    //   supabase, routing, sla, workflow, approval, visibility, scopeOverrides
    const svc = new TicketService(
      deps.supabase as never,
      routingService as never,
      {} as never, // sla
      {} as never, // workflow
      {} as never, // approval
      visibility as never,
      {} as never, // scopeOverrides
    );

    // Stub getById to return the current case state.
    jest
      .spyOn(svc, 'getById')
      .mockResolvedValue({
        id: TICKET_ID,
        tenant_id: TENANT.id,
        ticket_kind: 'case',
        ticket_type_id: null,
        location_id: null,
        asset_id: null,
        priority: 'medium',
        assigned_team_id: VALID_TEAM,
        assigned_user_id: null,
        assigned_vendor_id: null,
        status_category: 'assigned',
      } as never);

    // Stub addActivity (called once after the routing-decision insert).
    jest.spyOn(svc, 'addActivity').mockResolvedValue(undefined as never);

    let caught: unknown = null;
    try {
      await svc.reassign(
        TICKET_ID,
        {
          rerun_resolver: true,
          reason: 'try again',
          actor_person_id: 'p-1',
        },
        'auth-uid',
      );
    } catch (e) {
      caught = e;
    }
    // The validator throws BadRequestException — message names the field
    // since validateAssigneesInTenant uses its own error wording.
    expect(caught).toBeTruthy();
    expect((caught as Error).message).toEqual(
      expect.stringContaining('assigned_team_id'),
    );
  });
});

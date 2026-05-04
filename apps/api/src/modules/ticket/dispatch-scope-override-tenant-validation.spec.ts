// Plan A.2 / Commit 7 regression — scope-override executor_sla_policy_id
// defensive tenant validation. The resolver IS tenant-scoped today, but
// this test pins the defense-in-depth so a future regression in the
// resolver can't silently re-introduce a cross-tenant FK write.

import { DispatchService, DispatchDto } from './dispatch.service';

const TENANT = { id: 't1', subdomain: 't1' };
const PARENT_ID = 'parent-1';
const ACTOR = 'actor-uid';
const VALID_RT = '00000000-0000-4000-8000-00000000aaaa';
const FOREIGN_SLA = '00000000-0000-4000-8000-0000000fffff';

type Row = Record<string, unknown>;

function makeSupabase(rowsByTable: Record<string, Row[]>) {
  const captured: Array<{ table: string; filters: Record<string, unknown> }> = [];

  function buildSelectChain(table: string) {
    const filters: Record<string, unknown> = {};
    const rows = rowsByTable[table] ?? [];
    const chain: Record<string, unknown> = {
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return chain;
      },
      maybeSingle: async () => {
        captured.push({ table, filters: { ...filters } });
        const match = rows.find((r) => {
          for (const [c, v] of Object.entries(filters)) if (r[c] !== v) return false;
          return true;
        });
        return { data: match ?? null, error: null };
      },
    };
    return chain;
  }
  return {
    captured,
    supabase: {
      admin: {
        from: (table: string) => ({
          select: () => buildSelectChain(table),
          insert: () => ({
            select: () => ({
              single: async () => ({ data: { id: 'inserted' }, error: null }),
            }),
          }),
        }),
      },
    },
  };
}

describe('DispatchService.resolveChildSla — Plan A.2 override tenant validation', () => {
  beforeEach(() => {
    jest
      .spyOn(require('../../common/tenant-context').TenantContext, 'current')
      .mockReturnValue(TENANT);
  });

  it('rejects when scope override returns a foreign-tenant executor_sla_policy_id (non-system actor)', async () => {
    const deps = makeSupabase({
      // request_types row IS in tenant — passes validation at the dispatch
      // entry point, so we proceed to the override path.
      request_types: [{ id: VALID_RT, tenant_id: TENANT.id, domain: 'fm' }],
      // The foreign sla_policies row is owned by another tenant — the
      // assertTenantOwned probe inside resolveChildSla rejects it.
      sla_policies: [{ id: FOREIGN_SLA, tenant_id: 'other-tenant' }],
    });

    const ticketService = {
      getById: jest.fn().mockResolvedValue({
        id: PARENT_ID,
        tenant_id: TENANT.id,
        ticket_type_id: VALID_RT,
        ticket_kind: 'case',
        status_category: 'assigned',
        title: 'parent',
        priority: 'medium',
        requester_person_id: null,
        location_id: null,
        asset_id: null,
      }),
      addActivity: jest.fn().mockResolvedValue(undefined),
    };

    const visibility = {
      loadContext: jest.fn().mockResolvedValue({}),
      assertVisible: jest.fn().mockResolvedValue(undefined),
    };

    const routingService = {
      evaluate: jest.fn().mockResolvedValue({
        target: null,
        chosen_by: null,
        rule_id: null,
        rule_name: null,
        strategy: 'fixed',
        trace: [],
      }),
      recordDecision: jest.fn().mockResolvedValue(undefined),
    };

    const slaService = { startTimers: jest.fn().mockResolvedValue(undefined) };

    const scopeOverrides = {
      resolve: jest.fn().mockResolvedValue({
        executor_sla_policy_id: FOREIGN_SLA, // ← the foreign uuid
        precedence: 'exact_space',
      }),
      resolveForLocation: jest.fn().mockResolvedValue(null),
      deriveEffectiveLocation: jest.fn().mockResolvedValue(null),
    };

    const svc = new DispatchService(
      deps.supabase as never,
      ticketService as never,
      routingService as never,
      slaService as never,
      visibility as never,
      scopeOverrides as never,
    );

    const dto: DispatchDto = { title: 'do x' };
    await expect(svc.dispatch(PARENT_ID, dto, ACTOR)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'reference.not_in_tenant',
        reference_table: 'sla_policies',
        reference_id: FOREIGN_SLA,
      }),
    });
  });

  it('does NOT validate the override sla_policy_id for SYSTEM_ACTOR (resolver trust boundary)', async () => {
    // Same shape as above, but with the system actor. The override
    // probe is skipped — we trust system-driven dispatches because
    // every other id on the row was already validated at the entry
    // point. This pins the existing behavior of dispatch-scope-override.spec.ts
    // so refactoring doesn't accidentally cause a tenant lookup with a
    // mocked-non-uuid like 'sla-executor'.
    const deps = makeSupabase({
      request_types: [{ id: VALID_RT, tenant_id: TENANT.id, domain: 'fm' }],
    });

    const ticketService = {
      getById: jest.fn().mockResolvedValue({
        id: PARENT_ID,
        tenant_id: TENANT.id,
        ticket_type_id: VALID_RT,
        ticket_kind: 'case',
        status_category: 'assigned',
        title: 'parent',
        priority: 'medium',
        requester_person_id: null,
        location_id: null,
        asset_id: null,
      }),
      addActivity: jest.fn().mockResolvedValue(undefined),
    };

    const routingService = {
      evaluate: jest.fn().mockResolvedValue({
        target: null,
        chosen_by: null,
        rule_id: null,
        rule_name: null,
        strategy: 'fixed',
        trace: [],
      }),
      recordDecision: jest.fn().mockResolvedValue(undefined),
    };

    const slaService = { startTimers: jest.fn().mockResolvedValue(undefined) };

    const scopeOverrides = {
      resolve: jest.fn().mockResolvedValue({
        // Intentionally a foreign uuid — system actor must not validate.
        executor_sla_policy_id: FOREIGN_SLA,
        precedence: 'exact_space',
      }),
      resolveForLocation: jest.fn().mockResolvedValue(null),
      deriveEffectiveLocation: jest.fn().mockResolvedValue(null),
    };

    const visibility = {
      loadContext: jest.fn().mockResolvedValue({}),
      assertVisible: jest.fn().mockResolvedValue(undefined),
    };

    const svc = new DispatchService(
      deps.supabase as never,
      ticketService as never,
      routingService as never,
      slaService as never,
      visibility as never,
      scopeOverrides as never,
    );

    await expect(svc.dispatch(PARENT_ID, { title: 'x' }, '__system__')).resolves.toBeTruthy();
  });
});

// Plan A.2 / Commit 2 regression spec — dispatch FK tenant validation.
//
// Before Commit 2, dispatch wrote ticket_type_id, assigned_*_id, and
// dto.sla_id straight through to the work_orders insert without proving
// each uuid belonged to the caller's tenant. The DB FK only proves
// existence globally; supabase.admin bypasses RLS. Cross-tenant id
// smuggling was possible.
//
// These tests assert the validation now fires BEFORE the row insert by
// passing a non-system actor (the existing dispatch.service.spec.ts uses
// '__system__' which intentionally short-circuits the validators). The
// dispatch flow is mocked enough to reach the validation; the asserts
// check that the BadRequestException carries a `reference.not_in_tenant`
// code.

import { BadRequestException } from '@nestjs/common';
import { DispatchService, DispatchDto } from './dispatch.service';

const TENANT = { id: 't1', subdomain: 't1' };
const PARENT_ID = 'parent-1';
const ACTOR = 'actor-uid';

const VALID_UUID_A = '00000000-0000-4000-8000-00000000aaaa';
const VALID_UUID_B = '00000000-0000-4000-8000-00000000bbbb';
const FOREIGN_UUID = '00000000-0000-4000-8000-0000000fffff';

type RowsByTable = Record<string, Array<{ id: string; tenant_id: string; [k: string]: unknown }>>;

function makeDeps(rowsByTable: RowsByTable) {
  // Hand-rolled supabase.admin mock that supports both the chained
  // .eq().eq().maybeSingle() shape (used by the new validators) and the
  // dispatch service's own table reads. Returns null for any uuid not in
  // the configured rowsByTable for the current tenant.
  const captures: Array<{ table: string; filters: Record<string, unknown> }> = [];
  // Plan A.4 / Commit 8 (I4) — track work_orders inserts so the
  // rejection cases can assert the row insert NEVER fires. Pre-A.4
  // these tests only asserted the throw — leaving open the bug-class
  // where the validator throws but the row had already been written.
  const insertCalls: Array<{ table: string; row: Record<string, unknown> }> = [];

  function buildSelectChain(table: string, _cols: string) {
    const filters: Record<string, unknown> = {};
    const rows = rowsByTable[table] ?? [];
    const chain: Record<string, unknown> = {
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return chain;
      },
      in: (col: string, val: string[]) => {
        filters[`__in_${col}`] = val;
        return chain;
      },
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
    };
    return chain;
  }

  const supabase = {
    admin: {
      from: (table: string) => ({
        select: (cols: string) => buildSelectChain(table, cols),
        insert: (row: Record<string, unknown>) => {
          insertCalls.push({ table, row });
          return {
            select: () => ({
              single: async () => ({ data: { id: 'child-1', ...row }, error: null }),
            }),
          };
        },
      }),
    },
  };

  const ticketService = {
    getById: jest.fn(async () => ({
      id: PARENT_ID,
      tenant_id: TENANT.id,
      ticket_type_id: VALID_UUID_A,
      ticket_kind: 'case',
      status_category: 'assigned',
      title: 'parent',
      priority: 'medium',
      requester_person_id: null,
      location_id: null,
      asset_id: null,
    })),
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

  const visibilityService = {
    loadContext: jest.fn().mockResolvedValue({}),
    assertVisible: jest.fn().mockResolvedValue(undefined),
  };

  const scopeOverrides = {
    resolve: jest.fn().mockResolvedValue(null),
    resolveForLocation: jest.fn().mockResolvedValue(null),
    deriveEffectiveLocation: jest.fn().mockResolvedValue(null),
  };

  return { supabase, ticketService, routingService, slaService, visibilityService, scopeOverrides, captures, insertCalls };
}

function makeService(deps: ReturnType<typeof makeDeps>) {
  return new DispatchService(
    deps.supabase as never,
    deps.ticketService as never,
    deps.routingService as never,
    deps.slaService as never,
    deps.visibilityService as never,
    deps.scopeOverrides as never,
  );
}

describe('DispatchService — Plan A.2 tenant validation', () => {
  beforeEach(() => {
    jest
      .spyOn(require('../../common/tenant-context').TenantContext, 'current')
      .mockReturnValue(TENANT);
  });

  it('rejects dispatch with a cross-tenant ticket_type_id (DTO override)', async () => {
    // request_types table has the foreign id under another tenant — FK satisfied
    // globally, but assertTenantOwned must reject because tenant_id !== t1.
    const deps = makeDeps({
      request_types: [{ id: FOREIGN_UUID, tenant_id: 'other-tenant' }],
    });
    const svc = makeService(deps);
    const dto: DispatchDto = { title: 'do x', ticket_type_id: FOREIGN_UUID };
    await expect(svc.dispatch(PARENT_ID, dto, ACTOR)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'reference.not_in_tenant',
        reference_table: 'request_types',
        reference_id: FOREIGN_UUID,
      }),
    });
    // Plan A.4 / Commit 8 (I4): the rejected validation must NOT have
    // reached the work_orders insert. Pre-A.4 only the throw was
    // asserted; nothing pinned that the row write was actually skipped.
    expect(deps.insertCalls.filter((c) => c.table === 'work_orders')).toEqual([]);
  });

  it('rejects dispatch with a cross-tenant assigned_user_id', async () => {
    const deps = makeDeps({
      users: [{ id: FOREIGN_UUID, tenant_id: 'other-tenant' }],
    });
    const svc = makeService(deps);
    const dto: DispatchDto = { title: 'do x', assigned_user_id: FOREIGN_UUID };
    await expect(svc.dispatch(PARENT_ID, dto, ACTOR)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.dispatch(PARENT_ID, dto, ACTOR)).rejects.toMatchObject({
      message: expect.stringContaining('assigned_user_id'),
    });
    expect(deps.insertCalls.filter((c) => c.table === 'work_orders')).toEqual([]);
  });

  it('rejects dispatch with a cross-tenant assigned_team_id', async () => {
    const deps = makeDeps({
      teams: [{ id: FOREIGN_UUID, tenant_id: 'other-tenant' }],
    });
    const svc = makeService(deps);
    const dto: DispatchDto = { title: 'do x', assigned_team_id: FOREIGN_UUID };
    await expect(svc.dispatch(PARENT_ID, dto, ACTOR)).rejects.toMatchObject({
      message: expect.stringContaining('assigned_team_id'),
    });
    expect(deps.insertCalls.filter((c) => c.table === 'work_orders')).toEqual([]);
  });

  it('rejects dispatch with a cross-tenant assigned_vendor_id', async () => {
    const deps = makeDeps({
      vendors: [{ id: FOREIGN_UUID, tenant_id: 'other-tenant' }],
    });
    const svc = makeService(deps);
    const dto: DispatchDto = { title: 'do x', assigned_vendor_id: FOREIGN_UUID };
    await expect(svc.dispatch(PARENT_ID, dto, ACTOR)).rejects.toMatchObject({
      message: expect.stringContaining('assigned_vendor_id'),
    });
    expect(deps.insertCalls.filter((c) => c.table === 'work_orders')).toEqual([]);
  });

  it('rejects dispatch with a cross-tenant explicit dto.sla_id', async () => {
    // valid in-tenant team so the assignee validation passes; sla_id is the
    // gap under test.
    const deps = makeDeps({
      teams: [{ id: VALID_UUID_A, tenant_id: TENANT.id }],
      sla_policies: [{ id: FOREIGN_UUID, tenant_id: 'other-tenant' }],
    });
    const svc = makeService(deps);
    const dto: DispatchDto = {
      title: 'do x',
      assigned_team_id: VALID_UUID_A,
      sla_id: FOREIGN_UUID,
    };
    await expect(svc.dispatch(PARENT_ID, dto, ACTOR)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'reference.not_in_tenant',
        reference_table: 'sla_policies',
        reference_id: FOREIGN_UUID,
      }),
    });
    expect(deps.insertCalls.filter((c) => c.table === 'work_orders')).toEqual([]);
  });

  it('rejects dispatch with a malformed ticket_type_id uuid', async () => {
    const deps = makeDeps({});
    const svc = makeService(deps);
    const dto: DispatchDto = { title: 'do x', ticket_type_id: 'not-a-uuid' };
    await expect(svc.dispatch(PARENT_ID, dto, ACTOR)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'reference.invalid_uuid' }),
    });
    expect(deps.insertCalls.filter((c) => c.table === 'work_orders')).toEqual([]);
  });

  it('accepts a fully in-tenant DTO and reaches the row insert', async () => {
    // All references in t1 — validation passes.
    const deps = makeDeps({
      request_types: [{ id: VALID_UUID_A, tenant_id: TENANT.id, domain: 'fm' }],
      teams: [{ id: VALID_UUID_B, tenant_id: TENANT.id }],
      sla_policies: [{ id: VALID_UUID_A, tenant_id: TENANT.id }],
    });
    const svc = makeService(deps);
    const dto: DispatchDto = {
      title: 'do x',
      ticket_type_id: VALID_UUID_A,
      assigned_team_id: VALID_UUID_B,
      sla_id: VALID_UUID_A,
    };
    await expect(svc.dispatch(PARENT_ID, dto, ACTOR)).resolves.toBeTruthy();
  });

  // Plan A.4 / Commit 5 (I1) — DTO location_id + asset_id pre-flight.
  describe('Plan A.4 / Commit 5 (I1) — dispatch DTO location_id + asset_id', () => {
    it('rejects dispatch with a cross-tenant DTO location_id', async () => {
      const deps = makeDeps({
        spaces: [{ id: FOREIGN_UUID, tenant_id: 'other-tenant' }],
      });
      const svc = makeService(deps);
      const dto: DispatchDto = { title: 'do x', location_id: FOREIGN_UUID };
      await expect(svc.dispatch(PARENT_ID, dto, ACTOR)).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'reference.not_in_tenant',
          reference_table: 'spaces',
          reference_id: FOREIGN_UUID,
        }),
      });
      expect(deps.insertCalls.filter((c) => c.table === 'work_orders')).toEqual([]);
    });

    it('rejects dispatch with a cross-tenant DTO asset_id', async () => {
      const deps = makeDeps({
        assets: [{ id: FOREIGN_UUID, tenant_id: 'other-tenant' }],
      });
      const svc = makeService(deps);
      const dto: DispatchDto = { title: 'do x', asset_id: FOREIGN_UUID };
      await expect(svc.dispatch(PARENT_ID, dto, ACTOR)).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'reference.not_in_tenant',
          reference_table: 'assets',
          reference_id: FOREIGN_UUID,
        }),
      });
      expect(deps.insertCalls.filter((c) => c.table === 'work_orders')).toEqual([]);
    });

    it('does NOT pre-flight when DTO omits location_id (inherits from parent)', async () => {
      // Empty rowsByTable — if the validator fired with the parent's
      // location_id, it would not find a tenant-owned row and reject.
      // The point: inherited values were tenant-loaded via getById; we
      // skip the redundant pre-flight to keep the hot path lean.
      const deps = makeDeps({});
      const svc = makeService(deps);
      const dto: DispatchDto = { title: 'do x' };
      await expect(svc.dispatch(PARENT_ID, dto, ACTOR)).resolves.toBeTruthy();
    });
  });

  // Plan A.4 / Commit 2 (C1) — system actor MUST validate FK refs.
  // Pre-A.4 the tests asserted the bypass; the bypass was wrong.
  // Workflow create_child_tasks (workflow-engine.service.ts:267) calls
  // dispatch with '__system__' and passes node.config-sourced uuids; if
  // the workflow definition is forged or imported, the system actor was
  // the path that wrote the cross-tenant FK. Validation now fires for
  // both actors uniformly.
  describe('Plan A.4 / Commit 2 (C1) — system actor validates FK refs', () => {
    it('rejects system-actor dispatch with cross-tenant ticket_type_id', async () => {
      const deps = makeDeps({
        request_types: [{ id: FOREIGN_UUID, tenant_id: 'other-tenant' }],
      });
      const svc = makeService(deps);
      const dto: DispatchDto = { title: 'do x', ticket_type_id: FOREIGN_UUID };
      await expect(svc.dispatch(PARENT_ID, dto, '__system__')).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'reference.not_in_tenant',
          reference_table: 'request_types',
          reference_id: FOREIGN_UUID,
        }),
      });
      expect(deps.insertCalls.filter((c) => c.table === 'work_orders')).toEqual([]);
    });

    it('rejects system-actor dispatch with cross-tenant assigned_team_id', async () => {
      const deps = makeDeps({
        teams: [{ id: FOREIGN_UUID, tenant_id: 'other-tenant' }],
      });
      const svc = makeService(deps);
      const dto: DispatchDto = { title: 'do x', assigned_team_id: FOREIGN_UUID };
      await expect(svc.dispatch(PARENT_ID, dto, '__system__')).rejects.toMatchObject({
        message: expect.stringContaining('assigned_team_id'),
      });
      expect(deps.insertCalls.filter((c) => c.table === 'work_orders')).toEqual([]);
    });

    it('rejects system-actor dispatch with cross-tenant assigned_user_id', async () => {
      const deps = makeDeps({
        users: [{ id: FOREIGN_UUID, tenant_id: 'other-tenant' }],
      });
      const svc = makeService(deps);
      const dto: DispatchDto = { title: 'do x', assigned_user_id: FOREIGN_UUID };
      await expect(svc.dispatch(PARENT_ID, dto, '__system__')).rejects.toMatchObject({
        message: expect.stringContaining('assigned_user_id'),
      });
      expect(deps.insertCalls.filter((c) => c.table === 'work_orders')).toEqual([]);
    });

    it('rejects system-actor dispatch with cross-tenant assigned_vendor_id', async () => {
      const deps = makeDeps({
        vendors: [{ id: FOREIGN_UUID, tenant_id: 'other-tenant' }],
      });
      const svc = makeService(deps);
      const dto: DispatchDto = { title: 'do x', assigned_vendor_id: FOREIGN_UUID };
      await expect(svc.dispatch(PARENT_ID, dto, '__system__')).rejects.toMatchObject({
        message: expect.stringContaining('assigned_vendor_id'),
      });
      expect(deps.insertCalls.filter((c) => c.table === 'work_orders')).toEqual([]);
    });

    it('rejects system-actor dispatch with cross-tenant explicit dto.sla_id', async () => {
      const deps = makeDeps({
        sla_policies: [{ id: FOREIGN_UUID, tenant_id: 'other-tenant' }],
      });
      const svc = makeService(deps);
      const dto: DispatchDto = { title: 'do x', sla_id: FOREIGN_UUID };
      await expect(svc.dispatch(PARENT_ID, dto, '__system__')).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'reference.not_in_tenant',
          reference_table: 'sla_policies',
          reference_id: FOREIGN_UUID,
        }),
      });
      expect(deps.insertCalls.filter((c) => c.table === 'work_orders')).toEqual([]);
    });

    it('still passes system-actor dispatch when refs are in-tenant', async () => {
      const deps = makeDeps({
        request_types: [{ id: VALID_UUID_A, tenant_id: TENANT.id, domain: 'fm' }],
        teams: [{ id: VALID_UUID_B, tenant_id: TENANT.id }],
      });
      const svc = makeService(deps);
      const dto: DispatchDto = {
        title: 'do x',
        ticket_type_id: VALID_UUID_A,
        assigned_team_id: VALID_UUID_B,
      };
      await expect(svc.dispatch(PARENT_ID, dto, '__system__')).resolves.toBeTruthy();
    });
  });
});

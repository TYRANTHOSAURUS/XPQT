// Plan A.4 / Commit 10 (I6) regression — OrderService.createOrder (the
// private standalone path) validates every DTO-sourced FK at the
// single entry point. Pre-A.4 only the recurrence-clone path was
// guarded (commit 6ed719d / Plan A.2 Commit 5); the standalone path
// had 6 internal call sites (line 777, 826, 957, 1029, 1054, 1062 in
// order.service.ts) and any of them could pass a foreign uuid blind.
//
// Validating at createOrder() — a single point of entry — covers every
// caller in one shot. Tests cover bundle_id, requester_person_id,
// delivery_space_id, and cost_center_id.

import { OrderService } from './order.service';
import { TenantContext } from '../../common/tenant-context';

const TENANT_ID = 't1';
const TENANT = { id: TENANT_ID, slug: 't', tier: 'standard' as const };

const VALID_BOOKING = '00000000-0000-4000-8000-00000000bbbb';
const VALID_PERSON = '00000000-0000-4000-8000-00000000cccc';
const VALID_SPACE = '00000000-0000-4000-8000-00000000dddd';
const VALID_COST_CENTER = '00000000-0000-4000-8000-00000000eeee';
const FOREIGN_UUID = '00000000-0000-4000-8000-0000000fffff';

type Row = Record<string, unknown>;

function makeSupabase(rowsByTable: Record<string, Row[]>) {
  const inserts: Array<{ table: string; row: Row }> = [];

  function buildSelectChain(table: string) {
    const filters: Record<string, unknown> = {};
    const isNullCols: string[] = [];
    const rows = rowsByTable[table] ?? [];
    const chain: Record<string, unknown> = {
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return chain;
      },
      is: (col: string, val: unknown) => {
        if (val === null) isNullCols.push(col);
        return chain;
      },
      maybeSingle: async () => {
        const match = rows.find((r) => {
          for (const [c, v] of Object.entries(filters)) {
            if (r[c] !== v) return false;
          }
          for (const col of isNullCols) {
            if (r[col] != null) return false;
          }
          return true;
        });
        return { data: match ? { id: match.id } : null, error: null };
      },
    };
    return chain;
  }

  return {
    inserts,
    supabase: {
      admin: {
        from: (table: string) => ({
          select: () => buildSelectChain(table),
          insert: (row: Row) => {
            inserts.push({ table, row });
            // Default success — caller can override per test.
            return {
              select: () => ({
                single: async () => ({ data: { ...row, id: 'inserted' }, error: null }),
              }),
            };
          },
        }),
      },
    },
  };
}

describe('OrderService.createOrder — Plan A.4 / Commit 10 (I6) tenant validation', () => {
  // The private createOrder is reached via the public createStandaloneOrder.
  // We invoke it directly via the (svc as any).createOrder pattern to test
  // the validator in isolation — exercising the public path would require
  // mocking the resolver + approval router + setupTrigger services, none of
  // which are relevant here.
  type CreateOrderInternals = {
    createOrder: (a: {
      tenantId: string;
      bundle_id: string;
      args: {
        requester_person_id: string;
        delivery_space_id: string;
        requested_for_start_at: string;
        requested_for_end_at: string;
        cost_center_id?: string | null;
        lines: unknown[];
      };
    }) => Promise<{ id: string }>;
  };

  function callCreateOrder(
    svc: OrderService,
    args: Parameters<CreateOrderInternals['createOrder']>[0],
  ) {
    return TenantContext.run(TENANT, () =>
      (svc as unknown as CreateOrderInternals).createOrder(args),
    );
  }

  function makeService(rowsByTable: Record<string, Row[]>) {
    const deps = makeSupabase(rowsByTable);
    const svc = new OrderService(
      deps.supabase as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { svc, deps };
  }

  it('rejects when bundle_id is cross-tenant', async () => {
    const { svc, deps } = makeService({
      bookings: [{ id: FOREIGN_UUID, tenant_id: 'other-tenant' }],
      persons: [{ id: VALID_PERSON, tenant_id: TENANT_ID, active: true, anonymized_at: null, left_at: null }],
      spaces: [{ id: VALID_SPACE, tenant_id: TENANT_ID }],
    });

    let caught: unknown = null;
    try {
      await callCreateOrder(svc, {
        tenantId: TENANT_ID,
        bundle_id: FOREIGN_UUID,
        args: {
          requester_person_id: VALID_PERSON,
          delivery_space_id: VALID_SPACE,
          requested_for_start_at: '2026-05-01T09:00:00Z',
          requested_for_end_at: '2026-05-01T10:00:00Z',
          lines: [],
        },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect((caught as Error & { response?: Record<string, unknown> }).response).toMatchObject({
      code: 'reference.not_in_tenant',
      reference_table: 'bookings',
      reference_id: FOREIGN_UUID,
    });
    expect(deps.inserts.filter((i) => i.table === 'orders')).toEqual([]);
  });

  it('rejects when requester_person_id is cross-tenant', async () => {
    const { svc, deps } = makeService({
      bookings: [{ id: VALID_BOOKING, tenant_id: TENANT_ID }],
      // Foreign person — wrong tenant.
      persons: [{ id: FOREIGN_UUID, tenant_id: 'other-tenant', active: true, anonymized_at: null, left_at: null }],
      spaces: [{ id: VALID_SPACE, tenant_id: TENANT_ID }],
    });

    let caught: unknown = null;
    try {
      await callCreateOrder(svc, {
        tenantId: TENANT_ID,
        bundle_id: VALID_BOOKING,
        args: {
          requester_person_id: FOREIGN_UUID,
          delivery_space_id: VALID_SPACE,
          requested_for_start_at: '2026-05-01T09:00:00Z',
          requested_for_end_at: '2026-05-01T10:00:00Z',
          lines: [],
        },
      });
    } catch (e) {
      caught = e;
    }
    expect((caught as Error & { response?: Record<string, unknown> }).response).toMatchObject({
      code: 'reference.not_in_tenant',
      reference_table: 'persons',
      reference_id: FOREIGN_UUID,
    });
    expect(deps.inserts.filter((i) => i.table === 'orders')).toEqual([]);
  });

  it('rejects when requester_person_id IS in-tenant but deactivated', async () => {
    // personState='active' rejects deactivated persons even if tenant matches.
    const { svc, deps } = makeService({
      bookings: [{ id: VALID_BOOKING, tenant_id: TENANT_ID }],
      persons: [
        {
          id: VALID_PERSON,
          tenant_id: TENANT_ID,
          active: false, // deactivated
          anonymized_at: null,
          left_at: null,
        },
      ],
      spaces: [{ id: VALID_SPACE, tenant_id: TENANT_ID }],
    });

    let caught: unknown = null;
    try {
      await callCreateOrder(svc, {
        tenantId: TENANT_ID,
        bundle_id: VALID_BOOKING,
        args: {
          requester_person_id: VALID_PERSON,
          delivery_space_id: VALID_SPACE,
          requested_for_start_at: '2026-05-01T09:00:00Z',
          requested_for_end_at: '2026-05-01T10:00:00Z',
          lines: [],
        },
      });
    } catch (e) {
      caught = e;
    }
    expect((caught as Error & { response?: Record<string, unknown> }).response).toMatchObject({
      code: 'reference.not_in_tenant',
      reference_table: 'persons',
    });
    expect(deps.inserts.filter((i) => i.table === 'orders')).toEqual([]);
  });

  it('rejects when delivery_space_id is cross-tenant', async () => {
    const { svc, deps } = makeService({
      bookings: [{ id: VALID_BOOKING, tenant_id: TENANT_ID }],
      persons: [{ id: VALID_PERSON, tenant_id: TENANT_ID, active: true, anonymized_at: null, left_at: null }],
      spaces: [{ id: FOREIGN_UUID, tenant_id: 'other-tenant' }],
    });

    let caught: unknown = null;
    try {
      await callCreateOrder(svc, {
        tenantId: TENANT_ID,
        bundle_id: VALID_BOOKING,
        args: {
          requester_person_id: VALID_PERSON,
          delivery_space_id: FOREIGN_UUID,
          requested_for_start_at: '2026-05-01T09:00:00Z',
          requested_for_end_at: '2026-05-01T10:00:00Z',
          lines: [],
        },
      });
    } catch (e) {
      caught = e;
    }
    expect((caught as Error & { response?: Record<string, unknown> }).response).toMatchObject({
      code: 'reference.not_in_tenant',
      reference_table: 'spaces',
      reference_id: FOREIGN_UUID,
    });
    expect(deps.inserts.filter((i) => i.table === 'orders')).toEqual([]);
  });

  it('rejects when cost_center_id is cross-tenant', async () => {
    const { svc, deps } = makeService({
      bookings: [{ id: VALID_BOOKING, tenant_id: TENANT_ID }],
      persons: [{ id: VALID_PERSON, tenant_id: TENANT_ID, active: true, anonymized_at: null, left_at: null }],
      spaces: [{ id: VALID_SPACE, tenant_id: TENANT_ID }],
      cost_centers: [{ id: FOREIGN_UUID, tenant_id: 'other-tenant' }],
    });

    let caught: unknown = null;
    try {
      await callCreateOrder(svc, {
        tenantId: TENANT_ID,
        bundle_id: VALID_BOOKING,
        args: {
          requester_person_id: VALID_PERSON,
          delivery_space_id: VALID_SPACE,
          requested_for_start_at: '2026-05-01T09:00:00Z',
          requested_for_end_at: '2026-05-01T10:00:00Z',
          cost_center_id: FOREIGN_UUID,
          lines: [],
        },
      });
    } catch (e) {
      caught = e;
    }
    expect((caught as Error & { response?: Record<string, unknown> }).response).toMatchObject({
      code: 'reference.not_in_tenant',
      reference_table: 'cost_centers',
      reference_id: FOREIGN_UUID,
    });
    expect(deps.inserts.filter((i) => i.table === 'orders')).toEqual([]);
  });

  it('passes when all FKs are in-tenant + requester is active', async () => {
    const { svc, deps } = makeService({
      bookings: [{ id: VALID_BOOKING, tenant_id: TENANT_ID }],
      persons: [{ id: VALID_PERSON, tenant_id: TENANT_ID, active: true, anonymized_at: null, left_at: null }],
      spaces: [{ id: VALID_SPACE, tenant_id: TENANT_ID }],
      cost_centers: [{ id: VALID_COST_CENTER, tenant_id: TENANT_ID }],
    });

    const out = await callCreateOrder(svc, {
      tenantId: TENANT_ID,
      bundle_id: VALID_BOOKING,
      args: {
        requester_person_id: VALID_PERSON,
        delivery_space_id: VALID_SPACE,
        requested_for_start_at: '2026-05-01T09:00:00Z',
        requested_for_end_at: '2026-05-01T10:00:00Z',
        cost_center_id: VALID_COST_CENTER,
        lines: [],
      },
    });
    expect(out.id).toBe('inserted');
    const orderInserts = deps.inserts.filter((i) => i.table === 'orders');
    expect(orderInserts).toHaveLength(1);
    expect(orderInserts[0].row).toMatchObject({
      booking_id: VALID_BOOKING,
      requester_person_id: VALID_PERSON,
      delivery_location_id: VALID_SPACE,
    });
  });
});

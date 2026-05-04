// Plan A.2 / Commit 5 regression — OrderService.cloneOrderForOccurrence
// validates args.bundleId belongs to the caller's tenant before the
// clone insert.
//
// Pre-fix, args.bundleId was passed straight into
// `.insert({ booking_id: args.bundleId, ... })`. The FK on
// orders.booking_id → bookings.id only proves global existence; a
// malicious / buggy recurrence materializer or webhook could pass a
// foreign-tenant booking id and the clone would land cross-tenant.

import { OrderService } from './order.service';
import { TenantContext } from '../../common/tenant-context';

const TENANT_ID = 't1';
const TENANT = { id: TENANT_ID, slug: 't', tier: 'standard' as const };
const VALID_MASTER = '00000000-0000-4000-8000-00000000aaaa';
const VALID_BOOKING = '00000000-0000-4000-8000-00000000bbbb';
const FOREIGN_BOOKING = '00000000-0000-4000-8000-0000000fffff';

type Row = Record<string, unknown>;

function makeSupabase(rowsByTable: Record<string, Row[]>) {
  const inserts: Array<{ table: string; row: Row }> = [];
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

describe('OrderService.cloneOrderForOccurrence — Plan A.2 tenant validation', () => {
  it('rejects when args.bundleId is from another tenant', async () => {
    const deps = makeSupabase({
      orders: [
        {
          id: VALID_MASTER,
          tenant_id: TENANT_ID,
          requester_person_id: 'p',
          delivery_location_id: null,
          policy_snapshot: {},
          recurrence_rule: null,
        },
      ],
      bookings: [
        // Foreign booking exists globally but not under TENANT_ID — FK
        // would be satisfied today, validation must reject it.
        { id: FOREIGN_BOOKING, tenant_id: 'other-tenant' },
      ],
    });
    const svc = new OrderService(
      deps.supabase as never,
      {} as never, // resolver
      {} as never, // approval router
      {} as never, // setup trigger
    );

    let caught: unknown = null;
    try {
      await TenantContext.run(TENANT, () =>
        svc.cloneOrderForOccurrence({
          masterOrderId: VALID_MASTER,
          masterReservationStartAt: '2026-05-01T09:00:00Z',
          newReservation: {
            id: 'new-res',
            start_at: '2026-05-08T09:00:00Z',
            end_at: '2026-05-08T10:00:00Z',
          },
          bundleId: FOREIGN_BOOKING,
          requesterPersonId: 'p',
          recurrenceSeriesId: 'series-1',
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect((caught as Error & { response?: Record<string, unknown> }).response).toMatchObject({
      code: 'reference.not_in_tenant',
      reference_table: 'bookings',
      reference_id: FOREIGN_BOOKING,
    });
    // Insert MUST NOT have run.
    const orderInserts = deps.inserts.filter((i) => i.table === 'orders');
    expect(orderInserts).toEqual([]);
  });

  it('reaches the orders insert when args.bundleId IS in the caller tenant', async () => {
    // Mocks intentionally minimal — the clone has a deep call chain
    // (line-item iteration, asset reservations, status re-evaluation)
    // that's covered end-to-end by recurrence-materialize.service.spec.ts.
    // Here we ONLY want to prove validation passes when the bundle is
    // in-tenant; we abort on the first orders insert by throwing a
    // sentinel error and asserting the call shape on the way out.
    class StopHere extends Error {}
    const deps = makeSupabase({
      orders: [
        {
          id: VALID_MASTER,
          tenant_id: TENANT_ID,
          requester_person_id: 'p',
          delivery_location_id: null,
          policy_snapshot: {},
          recurrence_rule: null,
        },
      ],
      bookings: [{ id: VALID_BOOKING, tenant_id: TENANT_ID }],
    });
    const baseFrom = deps.supabase.admin.from;
    deps.supabase.admin.from = (table: string) => {
      if (table === 'orders') {
        return {
          select: () => baseFrom(table).select(),
          insert: (row: Row) => {
            deps.inserts.push({ table, row });
            // Throw to abort the rest of the clone path; we've already
            // proven the validator passed.
            throw new StopHere('reached orders insert');
          },
        };
      }
      return baseFrom(table);
    };
    const svc = new OrderService(
      deps.supabase as never,
      {} as never,
      {} as never,
      {} as never,
    );

    let caught: unknown = null;
    try {
      await TenantContext.run(TENANT, () =>
        svc.cloneOrderForOccurrence({
          masterOrderId: VALID_MASTER,
          masterReservationStartAt: '2026-05-01T09:00:00Z',
          newReservation: {
            id: 'new-res',
            start_at: '2026-05-08T09:00:00Z',
            end_at: '2026-05-08T10:00:00Z',
          },
          bundleId: VALID_BOOKING,
          requesterPersonId: 'p',
          recurrenceSeriesId: 'series-1',
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StopHere);
    // The orders insert fired with our in-tenant booking id.
    const orderInserts = deps.inserts.filter((i) => i.table === 'orders');
    expect(orderInserts).toHaveLength(1);
    expect(orderInserts[0].row).toMatchObject({
      booking_id: VALID_BOOKING,
      tenant_id: TENANT_ID,
    });
  });
});

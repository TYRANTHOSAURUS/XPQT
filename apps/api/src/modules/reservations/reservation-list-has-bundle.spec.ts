import { ReservationService } from './reservation.service';
import { TenantContext } from '../../common/tenant-context';

// B.3.3 — has_bundle filter goes through bookings_with_orders_for_tenant
// (00298) instead of the .from('orders').select('booking_id') N+1 shape.
// Pre-fix the service pulled every orders row for the tenant (one row
// per order — 10 000 orders → 10 000 wire rows for ~3 000 distinct
// booking_ids), deduped in memory, then fed the dedup'd id list back
// through .in('booking_id', ids) — past ~1 000 ids the URL exceeds
// PostgREST/CDN limits and the request 414s.
//
// Fix: a single .rpc('bookings_with_orders_for_tenant') call returns
// the deduped set in one round-trip (DISTINCT subquery on the partial
// idx_orders_booking index). This spec exercises three properties of
// the new shape:
//   1. The RPC IS called (no fallback to the old .from('orders') path).
//   2. has_bundle=true with EMPTY rpc result returns [] without ever
//      issuing the booking_slots query (the .in() filter would have
//      sent an empty list = match nothing, but we short-circuit for
//      clarity + to skip the round-trip).
//   3. has_bundle=true with N booking_ids passes EXACTLY those ids to
//      the slots .in() filter (no in-memory dedup needed because the
//      RPC already returned DISTINCT values).

describe('ReservationService.listForOperator — has_bundle via 00298 RPC', () => {
  const TENANT = { id: 'T', slug: 't', tier: 'standard' as const };
  const BOOKINGS_WITH_ORDERS = [
    'b1111111-1111-1111-1111-111111111111',
    'b2222222-2222-2222-2222-222222222222',
    'b3333333-3333-3333-3333-333333333333',
  ];

  function makeSupabase(opts: {
    rpcResult?: unknown[];
    rpcError?: { message: string } | null;
    slotRows?: unknown[];
  }) {
    const calls = {
      rpc: [] as Array<{ name: string; args: Record<string, unknown> }>,
      from: [] as string[],
      slotsIn: [] as Array<{ column: string; ids: unknown[] }>,
      slotsAwaited: 0,
    };

    const slotsChain: any = {
      select: () => slotsChain,
      eq: () => slotsChain,
      order: () => slotsChain,
      limit: () => slotsChain,
      gte: () => slotsChain,
      lt: () => slotsChain,
      not: () => slotsChain,
      in: (column: string, ids: unknown[]) => {
        calls.slotsIn.push({ column, ids });
        return slotsChain;
      },
      then: (resolve: (v: unknown) => unknown) => {
        calls.slotsAwaited += 1;
        return Promise.resolve({
          data: opts.slotRows ?? [],
          error: null,
        }).then(resolve);
      },
    };

    return {
      admin: {
        rpc: jest.fn(async (name: string, args: Record<string, unknown>) => {
          calls.rpc.push({ name, args });
          return {
            data: opts.rpcResult ?? null,
            error: opts.rpcError ?? null,
          };
        }),
        from: (table: string) => {
          calls.from.push(table);
          if (table === 'booking_slots') return slotsChain;
          // No other table should be touched on the has_bundle path now
          // that the orders fan-out RPC owns the dedup.
          throw new Error(`unexpected from('${table}') on has_bundle path`);
        },
      },
      calls,
    };
  }

  function makeVisibility() {
    return {
      loadContext: jest.fn(async () => ({
        user_id: 'U',
        person_id: 'P',
        tenant_id: TENANT.id,
        has_read_all: true,
        has_write_all: false,
        has_admin: false,
      })),
      assertVisible: jest.fn(),
      canEdit: jest.fn(() => false),
      assertOperatorOrAdmin: jest.fn(),
    };
  }

  function makeConflictGuard() {
    return { isExclusionViolation: jest.fn(() => false) };
  }

  function buildService(opts: Parameters<typeof makeSupabase>[0]) {
    const supabase = makeSupabase(opts);
    const visibility = makeVisibility();
    const conflict = makeConflictGuard();
    const svc = new ReservationService(
      supabase as never,
      conflict as never,
      visibility as never,
    );
    return { svc, supabase };
  }

  it('calls bookings_with_orders_for_tenant and forwards the deduped ids to the slots filter', async () => {
    const { svc, supabase } = buildService({
      rpcResult: BOOKINGS_WITH_ORDERS.map((id) => ({
        bookings_with_orders_for_tenant: id,
      })),
      slotRows: [],
    });

    const out = await TenantContext.run(TENANT, () =>
      svc.listForOperator('auth-uid', { has_bundle: true, scope: 'all' }),
    );
    expect(out.items).toEqual([]);

    // Exactly ONE RPC call, with the right name + tenant arg.
    expect(supabase.calls.rpc).toHaveLength(1);
    expect(supabase.calls.rpc[0].name).toBe('bookings_with_orders_for_tenant');
    expect(supabase.calls.rpc[0].args).toEqual({ p_tenant_id: TENANT.id });

    // The slots query MUST have been invoked with .in('booking_id', [...])
    // carrying exactly the 3 ids the RPC returned (no extra dedup pass
    // needed — the RPC already returns DISTINCT).
    expect(supabase.calls.slotsIn).toHaveLength(1);
    expect(supabase.calls.slotsIn[0].column).toBe('booking_id');
    expect(supabase.calls.slotsIn[0].ids).toEqual(BOOKINGS_WITH_ORDERS);

    // The legacy .from('orders').select('booking_id') path must NOT
    // have been touched — that's the regression this fix is preventing.
    expect(supabase.calls.from).not.toContain('orders');
  });

  it('short-circuits to [] without querying booking_slots when no booking has orders', async () => {
    const { svc, supabase } = buildService({
      rpcResult: [],
      slotRows: [],
    });

    const out = await TenantContext.run(TENANT, () =>
      svc.listForOperator('auth-uid', { has_bundle: true, scope: 'all' }),
    );
    expect(out.items).toEqual([]);

    // RPC was called but the slots query was never AWAITED — the
    // builder is constructed early in the method, but .then() is what
    // actually issues the request. Empty id list short-circuits before
    // we await, saving ~80 ms on a wide tenant where the query would
    // otherwise return zero rows anyway.
    expect(supabase.calls.rpc).toHaveLength(1);
    expect(supabase.calls.slotsAwaited).toBe(0);
  });

  it('handles plain string array RPC results (driver shape variability)', async () => {
    // PostgREST / supabase-js can return setof-uuid as either string[]
    // OR Array<{ <function_name>: string }> depending on driver shape.
    // The TS layer normalizes both — this spec proves the string[] path.
    const { svc, supabase } = buildService({
      rpcResult: BOOKINGS_WITH_ORDERS,
      slotRows: [],
    });
    await TenantContext.run(TENANT, () =>
      svc.listForOperator('auth-uid', { has_bundle: true, scope: 'all' }),
    );
    expect(supabase.calls.slotsIn[0].ids).toEqual(BOOKINGS_WITH_ORDERS);
  });

  it('does not invoke the RPC when has_bundle is unset', async () => {
    const { svc, supabase } = buildService({ slotRows: [] });
    await TenantContext.run(TENANT, () =>
      svc.listForOperator('auth-uid', { scope: 'upcoming' }),
    );
    expect(supabase.calls.rpc).toHaveLength(0);
    expect(supabase.calls.from).toContain('booking_slots');
  });
});

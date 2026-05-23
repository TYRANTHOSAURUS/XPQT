// audit-02 P1-5 regression — TicketService.getChildTasks must filter
// child work_orders through work_order_visibility_ids (00374), NOT inherit
// parent-case visibility. Before the fix a case-visible actor saw EVERY
// child WO (incl. one dispatched to a sensitive vendor). This spec proves:
//   1. non-privileged actor → only WO-visible children
//   2. tickets:read_all → bypasses the per-child filter (admin override)
//   3. empty visible set → parent visible but ZERO children
//   4. parent NOT visible → throws (not an empty list)
//   5. SYSTEM_ACTOR → unfiltered (internal)
// Without these, a regression reverting `.in('id', visibleWoIds)` is green.

import { TicketService, SYSTEM_ACTOR } from './ticket.service';

const TENANT = { id: 't1', subdomain: 't1' };
const PARENT = 'case-1';
const ALL_CHILDREN = [
  { id: 'wo-1', title: 'A', parent_ticket_id: PARENT, tenant_id: TENANT.id },
  { id: 'wo-2', title: 'B', parent_ticket_id: PARENT, tenant_id: TENANT.id },
  { id: 'wo-3', title: 'C', parent_ticket_id: PARENT, tenant_id: TENANT.id },
];

/**
 * Minimal supabase mock: `.from('work_orders').select().eq().eq()[.in()]
 * .order()` returns the parent's children, narrowed by an optional `.in`
 * id filter; `.rpc('work_order_visibility_ids', …)` returns a configurable
 * visible-id set and records the call.
 */
function makeSupabase(visibleWoIds: string[] | 'NOT_CALLED') {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  return {
    rpcCalls,
    supabase: {
      admin: {
        rpc: async (fn: string, args: Record<string, unknown>) => {
          rpcCalls.push({ fn, args });
          if (fn === 'work_order_visibility_ids') {
            if (visibleWoIds === 'NOT_CALLED') {
              throw new Error('work_order_visibility_ids must NOT be called on this path');
            }
            return { data: visibleWoIds.map((id) => ({ id })), error: null };
          }
          return { data: null, error: null };
        },
        from: (table: string) => {
          let inIds: string[] | null = null;
          const chain: Record<string, unknown> = {
            select: () => chain,
            eq: () => chain,
            in: (_col: string, ids: string[]) => {
              inIds = ids;
              return chain;
            },
            order: async () => {
              if (table !== 'work_orders') return { data: [], error: null };
              let rows = ALL_CHILDREN.filter(
                (r) => r.parent_ticket_id === PARENT && r.tenant_id === TENANT.id,
              );
              if (inIds !== null) {
                const set = new Set(inIds);
                rows = rows.filter((r) => set.has(r.id));
              }
              return { data: rows, error: null };
            },
          };
          return chain;
        },
      },
    },
  };
}

function buildService(
  deps: ReturnType<typeof makeSupabase>,
  visibility: Record<string, unknown>,
) {
  // ctor order (ticket.service.ts): supabase, routing, sla, workflow,
  // approval, visibility, scopeOverrides
  return new TicketService(
    deps.supabase as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    visibility as never,
    {} as never,
  );
}

describe('TicketService.getChildTasks — audit-02 P1-5 per-child WO visibility', () => {
  beforeEach(() => {
    jest
      .spyOn(require('../../common/tenant-context').TenantContext, 'current')
      .mockReturnValue(TENANT);
  });
  afterEach(() => jest.restoreAllMocks());

  it('non-privileged actor: returns ONLY children visible via work_order_visibility_ids', async () => {
    const deps = makeSupabase(['wo-2']); // only wo-2 individually visible
    const visibility = {
      loadContext: jest.fn().mockResolvedValue({
        user_id: 'u-1',
        tenant_id: TENANT.id,
        has_read_all: false,
      }),
      assertVisible: jest.fn().mockResolvedValue(undefined),
    };
    const svc = buildService(deps, visibility);

    const rows = await svc.getChildTasks(PARENT, 'auth-uid');

    expect(rows.map((r: { id: string }) => r.id)).toEqual(['wo-2']);
    // parent-case read precondition was checked
    expect(visibility.assertVisible).toHaveBeenCalledWith(
      PARENT,
      expect.anything(),
      'read',
    );
    // per-child WO predicate was consulted with the actor + tenant
    const visCall = deps.rpcCalls.find(
      (c) => c.fn === 'work_order_visibility_ids',
    );
    expect(visCall).toBeTruthy();
    expect(visCall!.args).toMatchObject({ p_user_id: 'u-1', p_tenant_id: TENANT.id });
  });

  it('tickets:read_all → bypasses the per-child filter (admin override, RPC NOT called)', async () => {
    const deps = makeSupabase('NOT_CALLED');
    const visibility = {
      loadContext: jest.fn().mockResolvedValue({
        user_id: 'admin-1',
        tenant_id: TENANT.id,
        has_read_all: true,
      }),
      assertVisible: jest.fn().mockResolvedValue(undefined),
    };
    const svc = buildService(deps, visibility);

    const rows = await svc.getChildTasks(PARENT, 'admin-uid');

    expect(rows.map((r: { id: string }) => r.id)).toEqual(['wo-1', 'wo-2', 'wo-3']);
    expect(
      deps.rpcCalls.find((c) => c.fn === 'work_order_visibility_ids'),
    ).toBeUndefined();
  });

  it('empty visible set → parent visible but ZERO children (no leak via parent)', async () => {
    const deps = makeSupabase([]); // actor can see the case, none of its WOs
    const visibility = {
      loadContext: jest.fn().mockResolvedValue({
        user_id: 'requester-1',
        tenant_id: TENANT.id,
        has_read_all: false,
      }),
      assertVisible: jest.fn().mockResolvedValue(undefined),
    };
    const svc = buildService(deps, visibility);

    const rows = await svc.getChildTasks(PARENT, 'req-uid');

    expect(rows).toEqual([]);
  });

  it('parent NOT visible → throws (not an empty list)', async () => {
    const deps = makeSupabase('NOT_CALLED');
    const visibility = {
      loadContext: jest.fn().mockResolvedValue({
        user_id: 'stranger-1',
        tenant_id: TENANT.id,
        has_read_all: false,
      }),
      assertVisible: jest.fn().mockRejectedValue(new Error('ticket.read_forbidden')),
    };
    const svc = buildService(deps, visibility);

    await expect(svc.getChildTasks(PARENT, 'stranger-uid')).rejects.toThrow(
      'ticket.read_forbidden',
    );
    expect(
      deps.rpcCalls.find((c) => c.fn === 'work_order_visibility_ids'),
    ).toBeUndefined();
  });

  it('SYSTEM_ACTOR → unfiltered (internal; no loadContext/assertVisible/RPC)', async () => {
    const deps = makeSupabase('NOT_CALLED');
    const visibility = {
      loadContext: jest.fn(),
      assertVisible: jest.fn(),
    };
    const svc = buildService(deps, visibility);

    const rows = await svc.getChildTasks(PARENT, SYSTEM_ACTOR);

    expect(rows.map((r: { id: string }) => r.id)).toEqual(['wo-1', 'wo-2', 'wo-3']);
    expect(visibility.loadContext).not.toHaveBeenCalled();
    expect(visibility.assertVisible).not.toHaveBeenCalled();
    expect(
      deps.rpcCalls.find((c) => c.fn === 'work_order_visibility_ids'),
    ).toBeUndefined();
  });
});

// Tests for the case-side parent-close guard on TicketService.update.
//
// Post-§3.0 cutover (Commit B), the multi-table write path moved into the
// `update_entity_combined` RPC (00333) and the DB trigger
// `enforce_ticket_parent_close_invariant`. The API-layer precheck remains
// in ticket.service.ts:1062-1075 as a friendlier 400 before paying the
// RPC round-trip. This spec covers ONLY that API-layer precheck — the
// authoritative trigger-level check is exercised by integration harness
// `apps/api/test/concurrency/update_entity_combined.spec.ts`.
//
// Mock shape: see ticket-permissions.spec.ts. The RPC + refetch are
// stubbed so the test focuses on the close-guard path; the orchestrator
// call shape is asserted in the broader update specs.
import { TicketService, UpdateTicketDto, SYSTEM_ACTOR } from './ticket.service';
import { AppError } from '../../common/errors';

type Row = {
  id: string;
  tenant_id: string;
  ticket_kind: 'case' | 'work_order';
  status_category: string;
  sla_id: string | null;
};

function makeDeps(parent: Row, openChildren: string[]) {
  let row = { ...parent };
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];

  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        if (table === 'tickets') {
          // Two read shapes hit `tickets`:
          //   1. getById(): .select('*').eq('id').eq('tenant_id').single()
          //   2. (none here — write path goes through .rpc)
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  single: async () => ({ data: row, error: null }),
                  maybeSingle: async () => ({ data: row, error: null }),
                }),
              }),
            }),
            update: (patch: Record<string, unknown>) => {
              // Satisfaction-only fast path uses this; tests here don't
              // exercise it. Stubbed for shape parity.
              row = { ...row, ...patch };
              return {
                eq: () => ({ eq: async () => ({ data: null, error: null }) }),
              };
            },
          } as unknown;
        }
        if (table === 'work_orders') {
          // Parent close-guard probe:
          //   .select('id').eq('parent_ticket_id').eq('tenant_id').not(status_category, in, (resolved,closed))
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  not: () => ({
                    async then(
                      cb: (v: {
                        data: Array<{ id: string }>;
                        error: null;
                      }) => unknown,
                    ) {
                      return cb({
                        data: openChildren.map((id) => ({ id })),
                        error: null,
                      });
                    },
                  }),
                }),
              }),
            }),
          } as unknown;
        }
        return {} as unknown;
      }),
      rpc: jest.fn(async (fn: string, args: unknown) => {
        rpcCalls.push({ fn, args });
        // Simulate orchestrator success — the test fixtures all run with
        // an empty open-children list so the RPC actually fires. The
        // refetch in getById sees the patched row, so we mutate `row`
        // here per the patches.
        const a = args as { p_patches?: Record<string, unknown> };
        if (a?.p_patches?.status_category) {
          row = {
            ...row,
            status_category: a.p_patches.status_category as string,
          };
        }
        return { data: null, error: null };
      }),
    },
  };

  const visibility = {
    loadContext: jest.fn().mockResolvedValue({}),
    assertVisible: jest.fn().mockResolvedValue(undefined),
  };
  const slaService = {
    pauseTimers: jest.fn(),
    resumeTimers: jest.fn(),
    completeTimers: jest.fn(),
    restartTimers: jest.fn(),
    applyWaitingStateTransition: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new TicketService(
    supabase as never,
    {} as never,
    slaService as never,
    {} as never,
    {} as never,
    visibility as never,
    {
      resolve: jest.fn().mockResolvedValue(null),
      resolveForLocation: jest.fn().mockResolvedValue(null),
      deriveEffectiveLocation: jest.fn().mockResolvedValue(null),
    } as never,
  );
  return { svc, row: () => row, rpcCalls };
}

describe('TicketService.update — parent close guard (API-layer precheck)', () => {
  beforeEach(() => {
    jest
      .spyOn(
        require('../../common/tenant-context').TenantContext,
        'current',
      )
      .mockReturnValue({ id: 't1', subdomain: 't1' });
  });

  afterEach(() => jest.restoreAllMocks());

  it('refuses to resolve a case while it has open children', async () => {
    const { svc, rpcCalls } = makeDeps(
      {
        id: 'c1',
        tenant_id: 't1',
        ticket_kind: 'case',
        status_category: 'assigned',
        sla_id: null,
      },
      ['wo-a', 'wo-b'],
    );
    // SYSTEM_ACTOR + close-guard rejection: clientRequestId is not needed
    // because the API-layer precheck throws BEFORE the RPC is reached
    // (which is where the client_request_id_required guard lives).
    await expect(
      svc.update(
        'c1',
        { status_category: 'resolved' } as UpdateTicketDto,
        SYSTEM_ACTOR,
      ),
    ).rejects.toThrow(AppError);
    await expect(
      svc.update(
        'c1',
        { status_category: 'resolved' } as UpdateTicketDto,
        SYSTEM_ACTOR,
      ),
    ).rejects.toMatchObject({
      code: 'ticket.children_open_cannot_close',
      status: 400,
    });
    // No RPC was issued — the precheck short-circuits before write.
    expect(rpcCalls.find((c) => c.fn === 'update_entity_combined')).toBeUndefined();
  });

  it('allows resolving a case with no open children (issues the RPC)', async () => {
    const { svc, rpcCalls } = makeDeps(
      {
        id: 'c1',
        tenant_id: 't1',
        ticket_kind: 'case',
        status_category: 'assigned',
        sla_id: null,
      },
      [],
    );
    await svc.update(
      'c1',
      { status_category: 'resolved' } as UpdateTicketDto,
      SYSTEM_ACTOR,
      'cri-close-1',
    );

    // RPC was issued with the close patch.
    const combined = rpcCalls.find((c) => c.fn === 'update_entity_combined');
    expect(combined).toBeDefined();
    expect(combined!.args).toMatchObject({
      p_entity_kind: 'case',
      p_entity_id: 'c1',
      p_tenant_id: 't1',
      p_idempotency_key: 'patch:case:c1:cri-close-1',
      p_patches: { status_category: 'resolved' },
    });
  });

  // Step 1c.10c: ticket.service.update is case-only post-cutover. Work-order
  // updates go through dispatch/work-order paths. The "resolve a child WO
  // through ticket.service.update" scenario no longer applies.
  it.skip('OBSOLETE post-1c.10c: allows resolving a child work_order regardless of its siblings', async () => {
    // Test scenario removed — ticket.service.update is case-only now.
  });
});

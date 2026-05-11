// Tests for the per-action permission gates on TicketService.update +
// TicketService.reassign. Layered ON TOP of the existing assertVisible('write')
// floor — case-side now mirrors WorkOrderService for assign + priority
// changes.
//
// Post-§3.0 cutover (Commit B), the case-side update path commits via the
// `update_entity_combined` RPC. The TS layer still owns the per-action
// permission preflight; this spec asserts the gate shape using the
// `user_has_permission` RPC. The combined RPC call shape is asserted in
// `apps/api/test/concurrency/update_entity_combined.spec.ts` (integration).
//
// What changed vs. the pre-cutover spec:
//   - Updates now go through `supabase.admin.rpc('update_entity_combined', …)`,
//     not `.from('tickets').update(...)`. Positive-path assertions verify
//     `rpcCalls` carries the orchestrator call with the expected `p_patches`.
//   - clientRequestId is threaded through every positive-path call; the
//     service throws `command_operations.client_request_id_required` when
//     omitted on a path that wants to write.
//   - The watchers tenant-validation now reads from `persons`. The mock
//     covers a permissive shape (returns the ids back).

import { AppError } from '../../common/errors';
import { TicketService, SYSTEM_ACTOR } from './ticket.service';

type Row = {
  id: string;
  tenant_id: string;
  ticket_kind: 'case' | 'work_order';
  status_category: string;
  priority: string;
  assigned_team_id: string | null;
  assigned_user_id: string | null;
  assigned_vendor_id: string | null;
  sla_id: string | null;
  title: string;
};

const TENANT = 't1';

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

function makeDeps(
  initial: Row,
  options: { hasPermission?: boolean; has_write_all?: boolean } = {},
) {
  let row = { ...initial };
  const rpcCalls: RpcCall[] = [];
  const permissionChecks: Array<{ user_id: string; permission: string }> = [];

  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        if (table === 'tickets') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  single: async () => ({ data: row, error: null }),
                  maybeSingle: async () => ({ data: row, error: null }),
                }),
              }),
            }),
            // Satisfaction-only direct UPDATE path. Not exercised by the
            // permission-gate tests but stubbed for shape parity.
            update: (patch: Record<string, unknown>) => {
              row = { ...row, ...patch };
              return {
                eq: () => ({ eq: async () => ({ data: null, error: null }) }),
              };
            },
          } as unknown;
        }
        if (table === 'work_orders') {
          // Parent close-guard query path — return empty children list.
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
                      return cb({ data: [], error: null });
                    },
                  }),
                }),
              }),
            }),
          } as unknown;
        }
        if (table === 'routing_decisions') {
          return {
            insert: jest.fn().mockResolvedValue({ data: null, error: null }),
          } as unknown;
        }
        if (
          table === 'users' ||
          table === 'teams' ||
          table === 'vendors' ||
          table === 'sla_policies'
        ) {
          // validateAssigneesInTenant + assertTenantOwned probe path:
          //   `.select('id').eq('id', X).eq('tenant_id', Y).maybeSingle()` —
          // returns a found-shape row so validation clears. `users` is also
          // hit by `resolveAuthorPersonId` via .eq('auth_uid'), which can't
          // be distinguished from the assignee probe by chained-.eq column
          // name; returning null there is fine (resolveAuthorPersonId tolerates
          // null with a system-attribution fallback).
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: table === 'users' ? null : { id: 'mocked' },
                    error: null,
                  }),
                }),
              }),
            }),
          } as unknown;
        }
        if (table === 'persons') {
          // Resilient chain mock — every filter (.eq, .is) returns the
          // chain; .in resolves with the requested ids (so validation
          // clears). See work-order-update-metadata.spec.ts for the
          // canonical version.
          const chain: Record<string, unknown> = {};
          chain.select = () => chain;
          chain.eq = () => chain;
          chain.is = () => chain;
          chain.in = (_col: string, ids: string[]) => ({
            then: (
              resolve: (v: {
                data: Array<{ id: string }>;
                error: null;
              }) => unknown,
              reject: (e: unknown) => unknown,
            ) =>
              Promise.resolve({
                data: ids.map((id) => ({ id })),
                error: null,
              }).then(resolve, reject),
          });
          return chain as unknown;
        }
        // Catch-all (ticket_activities, domain_events, etc.).
        return {
          insert: () => ({
            select: () => ({
              single: async () => ({ data: null, error: null }),
            }),
          }),
        } as unknown;
      }),
      rpc: jest.fn(
        async (
          fn: string,
          args: { p_user_id?: string; p_permission?: string } & Record<
            string,
            unknown
          >,
        ) => {
          rpcCalls.push({ fn, args });
          if (fn === 'user_has_permission') {
            permissionChecks.push({
              user_id: args.p_user_id as string,
              permission: args.p_permission as string,
            });
            return { data: !!options.hasPermission, error: null };
          }
          if (fn === 'update_entity_combined') {
            // Simulate the orchestrator applying the patch to `row` so
            // post-RPC refetch reflects the write.
            const patches = (args as { p_patches?: Record<string, unknown> })
              .p_patches;
            if (patches) {
              const flat: Record<string, unknown> = {};
              for (const [k, v] of Object.entries(patches)) {
                if (k === 'assignment' && v && typeof v === 'object') {
                  Object.assign(flat, v);
                } else if (k === 'metadata' && v && typeof v === 'object') {
                  Object.assign(flat, v);
                } else if (k === 'plan' && v && typeof v === 'object') {
                  Object.assign(flat, v);
                } else if (k === 'sla' && v && typeof v === 'object') {
                  // skip (case rejects sla)
                } else {
                  flat[k] = v;
                }
              }
              row = { ...row, ...flat } as Row;
            }
            return { data: null, error: null };
          }
          throw new Error(`unexpected rpc in mock: ${fn}`);
        },
      ),
    },
  };

  const slaService = {
    restartTimers: jest.fn().mockResolvedValue(undefined),
    pauseTimers: jest.fn().mockResolvedValue(undefined),
    resumeTimers: jest.fn().mockResolvedValue(undefined),
    completeTimers: jest.fn().mockResolvedValue(undefined),
    applyWaitingStateTransition: jest.fn().mockResolvedValue(undefined),
    buildTimersForRpc: jest.fn().mockResolvedValue([]),
  };

  const visibility = {
    loadContext: jest.fn().mockResolvedValue({
      user_id: 'u1',
      person_id: 'p1',
      tenant_id: TENANT,
      team_ids: [],
      role_assignments: [],
      vendor_id: null,
      has_read_all: false,
      has_write_all: !!options.has_write_all,
    }),
    assertVisible: jest.fn().mockResolvedValue(undefined),
  };

  return {
    row: () => row,
    rpcCalls,
    permissionChecks,
    supabase,
    slaService,
    visibility,
  };
}

function makeSvc(deps: ReturnType<typeof makeDeps>) {
  return new TicketService(
    deps.supabase as never,
    {} as never, // RoutingService — unused on these gate paths
    deps.slaService as never,
    {} as never, // WorkflowEngineService — unused
    {} as never, // ApprovalService — unused
    deps.visibility as never,
    {
      resolve: jest.fn().mockResolvedValue(null),
      resolveForLocation: jest.fn().mockResolvedValue(null),
      deriveEffectiveLocation: jest.fn().mockResolvedValue(null),
    } as never, // ScopeOverrideResolverService
  );
}

function baseRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'c1',
    tenant_id: TENANT,
    ticket_kind: 'case',
    status_category: 'assigned',
    priority: 'medium',
    assigned_team_id: 'team-old',
    assigned_user_id: null,
    assigned_vendor_id: null,
    sla_id: null,
    title: 'old title',
    ...overrides,
  };
}

/** Convenience: pluck `update_entity_combined` calls only. */
function combinedCalls(
  rpcCalls: RpcCall[],
): Array<Record<string, unknown>> {
  return rpcCalls
    .filter((c) => c.fn === 'update_entity_combined')
    .map((c) => c.args);
}

describe('TicketService — per-action permission gates', () => {
  beforeEach(() => {
    jest
      .spyOn(
        require('../../common/tenant-context').TenantContext,
        'current',
      )
      .mockReturnValue({ id: TENANT, subdomain: TENANT });
  });

  // C-remediation alignment (2026-05-11, F-IMP-B): match the pattern used
  // by every other migrated spec in this commit (work-order-update.spec
  // :231-233, ticket-close-guard.spec:137, ticket-watcher-validation
  // .spec:214). Without `restoreAllMocks`, `jest.spyOn(TenantContext)`
  // from beforeEach leaks across tests in the same worker.
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('update', () => {
    it('throws Forbidden when caller lacks tickets.change_priority and write_all', async () => {
      const deps = makeDeps(baseRow(), {
        hasPermission: false,
        has_write_all: false,
      });
      const svc = makeSvc(deps);

      await expect(
        svc.update('c1', { priority: 'high' }, 'auth-uid-non-admin', 'cri-1'),
      ).rejects.toThrow(AppError);
      await expect(
        svc.update('c1', { priority: 'high' }, 'auth-uid-non-admin', 'cri-2'),
      ).rejects.toMatchObject({
        code: 'ticket.priority_change_forbidden',
        status: 403,
      });
      await expect(
        svc.update('c1', { priority: 'high' }, 'auth-uid-non-admin', 'cri-3'),
      ).rejects.toThrow(/tickets\.change_priority permission required/);

      // First check is for tickets.change_priority (priority change is the
      // only mutation requested).
      expect(deps.permissionChecks[0]).toEqual({
        user_id: 'u1',
        permission: 'tickets.change_priority',
      });
      // No combined RPC was issued — the gate rejected before write.
      expect(combinedCalls(deps.rpcCalls)).toHaveLength(0);
    });

    it('throws Forbidden when caller lacks tickets.assign and write_all (assigned_team_id)', async () => {
      const deps = makeDeps(baseRow(), {
        hasPermission: false,
        has_write_all: false,
      });
      const svc = makeSvc(deps);

      await expect(
        svc.update(
          'c1',
          { assigned_team_id: '33333333-3333-3333-3333-333333333333' },
          'auth-uid-non-admin',
          'cri-a1',
        ),
      ).rejects.toThrow(/tickets\.assign permission required/);

      expect(deps.permissionChecks[0]).toEqual({
        user_id: 'u1',
        permission: 'tickets.assign',
      });
      expect(combinedCalls(deps.rpcCalls)).toHaveLength(0);
    });

    it('throws Forbidden when caller lacks tickets.assign and write_all (assigned_user_id)', async () => {
      const deps = makeDeps(baseRow(), {
        hasPermission: false,
        has_write_all: false,
      });
      const svc = makeSvc(deps);

      await expect(
        svc.update(
          'c1',
          { assigned_user_id: '44444444-4444-4444-4444-444444444444' },
          'auth-uid-non-admin',
          'cri-a2',
        ),
      ).rejects.toThrow(/tickets\.assign permission required/);
      expect(combinedCalls(deps.rpcCalls)).toHaveLength(0);
    });

    it('throws Forbidden when caller lacks tickets.assign and write_all (assigned_vendor_id)', async () => {
      const deps = makeDeps(baseRow(), {
        hasPermission: false,
        has_write_all: false,
      });
      const svc = makeSvc(deps);

      await expect(
        svc.update(
          'c1',
          { assigned_vendor_id: '55555555-5555-5555-5555-555555555555' },
          'auth-uid-non-admin',
          'cri-a3',
        ),
      ).rejects.toThrow(/tickets\.assign permission required/);
      expect(combinedCalls(deps.rpcCalls)).toHaveLength(0);
    });

    it('does NOT trigger a permission gate when only updating title', async () => {
      const deps = makeDeps(baseRow(), {
        hasPermission: false,
        has_write_all: false,
      });
      const svc = makeSvc(deps);

      await svc.update(
        'c1',
        { title: 'new title' },
        'auth-uid-non-admin',
        'cri-t1',
      );

      // No user_has_permission RPC fired — the gate is fully skipped when
      // the DTO carries only fields that don't trigger assign or priority.
      expect(deps.permissionChecks).toHaveLength(0);
      const combined = combinedCalls(deps.rpcCalls);
      expect(combined).toHaveLength(1);
      // title is grouped under `metadata` in the §3.0 payload schema
      // (00333:187, 505-732).
      expect(combined[0]).toMatchObject({
        p_entity_kind: 'case',
        p_entity_id: 'c1',
        p_tenant_id: TENANT,
        p_idempotency_key: 'patch:case:c1:cri-t1',
        p_patches: { metadata: { title: 'new title' } },
      });
    });

    it('skips permission checks entirely when caller has tickets.write_all override', async () => {
      const deps = makeDeps(baseRow(), {
        hasPermission: false,
        has_write_all: true,
      });
      const svc = makeSvc(deps);

      await svc.update(
        'c1',
        {
          priority: 'high',
          assigned_team_id: '33333333-3333-3333-3333-333333333333',
        },
        'auth-uid-admin',
        'cri-wa',
      );

      // write_all short-circuits both per-action RPCs.
      expect(deps.permissionChecks).toHaveLength(0);
      const combined = combinedCalls(deps.rpcCalls);
      expect(combined).toHaveLength(1);
      expect(combined[0]).toMatchObject({
        p_patches: {
          priority: 'high',
          assignment: {
            assigned_team_id: '33333333-3333-3333-3333-333333333333',
          },
        },
      });
    });

    it('SYSTEM_ACTOR bypasses all gates', async () => {
      const deps = makeDeps(baseRow(), {
        hasPermission: false,
        has_write_all: false,
      });
      const svc = makeSvc(deps);

      await svc.update(
        'c1',
        {
          priority: 'high',
          assigned_team_id: '33333333-3333-3333-3333-333333333333',
        },
        SYSTEM_ACTOR,
        'cri-sys',
      );

      // No visibility loadContext, no permission RPC, no assertVisible.
      expect(deps.visibility.loadContext).not.toHaveBeenCalled();
      expect(deps.visibility.assertVisible).not.toHaveBeenCalled();
      expect(deps.permissionChecks).toHaveLength(0);
      // SYSTEM_ACTOR collapses `p_actor_user_id` to null per 00325:89-94.
      const combined = combinedCalls(deps.rpcCalls);
      expect(combined).toHaveLength(1);
      expect(combined[0]).toMatchObject({ p_actor_user_id: null });
    });

    it('passes the gate when caller has tickets.change_priority granted', async () => {
      const deps = makeDeps(baseRow(), {
        hasPermission: true,
        has_write_all: false,
      });
      const svc = makeSvc(deps);

      await svc.update('c1', { priority: 'high' }, 'auth-uid-agent', 'cri-p1');

      expect(deps.permissionChecks).toEqual([
        { user_id: 'u1', permission: 'tickets.change_priority' },
      ]);
      const combined = combinedCalls(deps.rpcCalls);
      expect(combined).toHaveLength(1);
      expect(combined[0]).toMatchObject({
        p_actor_user_id: 'auth-uid-agent',
        p_patches: { priority: 'high' },
      });
    });

    it('passes the gate when caller has tickets.assign granted', async () => {
      const deps = makeDeps(baseRow(), {
        hasPermission: true,
        has_write_all: false,
      });
      const svc = makeSvc(deps);

      await svc.update(
        'c1',
        { assigned_team_id: '33333333-3333-3333-3333-333333333333' },
        'auth-uid-agent',
        'cri-a1',
      );

      expect(deps.permissionChecks).toEqual([
        { user_id: 'u1', permission: 'tickets.assign' },
      ]);
      const combined = combinedCalls(deps.rpcCalls);
      expect(combined).toHaveLength(1);
      expect(combined[0]).toMatchObject({
        p_patches: {
          assignment: {
            assigned_team_id: '33333333-3333-3333-3333-333333333333',
          },
        },
      });
    });

    it('runs both permission checks when DTO carries both priority + assignment changes', async () => {
      const deps = makeDeps(baseRow(), {
        hasPermission: true,
        has_write_all: false,
      });
      const svc = makeSvc(deps);

      await svc.update(
        'c1',
        {
          priority: 'high',
          assigned_team_id: '33333333-3333-3333-3333-333333333333',
        },
        'auth-uid-agent',
        'cri-both',
      );

      // Both RPCs fire; order: change_priority then assign.
      const kinds = deps.permissionChecks.map((c) => c.permission).sort();
      expect(kinds).toEqual(['tickets.assign', 'tickets.change_priority']);
    });
  });

  describe('reassign', () => {
    it('throws Forbidden when caller lacks tickets.assign and write_all', async () => {
      const deps = makeDeps(baseRow(), {
        hasPermission: false,
        has_write_all: false,
      });
      const svc = makeSvc(deps);

      await expect(
        svc.reassign(
          'c1',
          {
            assigned_team_id: '33333333-3333-3333-3333-333333333333',
            reason: 'team handover',
          },
          'auth-uid-non-admin',
        ),
      ).rejects.toThrow(/tickets\.assign permission required/);

      expect(deps.permissionChecks).toEqual([
        { user_id: 'u1', permission: 'tickets.assign' },
      ]);
      // No combined RPC was issued.
      expect(combinedCalls(deps.rpcCalls)).toHaveLength(0);
    });

    it('skips the permission RPC when caller has tickets.write_all', async () => {
      const deps = makeDeps(baseRow(), {
        hasPermission: false,
        has_write_all: true,
      });
      const svc = makeSvc(deps);

      await svc.reassign(
        'c1',
        {
          assigned_team_id: '33333333-3333-3333-3333-333333333333',
          reason: 'team handover',
        },
        'auth-uid-admin',
      );

      expect(deps.permissionChecks).toHaveLength(0);
      // C-remediation strengthening (2026-05-11, F-IMP-A): the prior
      // assertion (`visibility.loadContext was called`) was a weak proxy
      // for "the mutation ran". `loadContext` fires during the gate even
      // when the subsequent write is short-circuited, so it cannot
      // distinguish "permission cleared, write happened" from "permission
      // cleared, write threw". Reassign writes via `.from('tickets')
      // .update(...)` (ticket.service.ts:1431) — its mock at the top of
      // this file applies the patch onto `row`, so the row state IS the
      // write proof.
      expect(deps.row().assigned_team_id).toBe(
        '33333333-3333-3333-3333-333333333333',
      );
    });

    it('SYSTEM_ACTOR bypasses the gate', async () => {
      const deps = makeDeps(baseRow(), {
        hasPermission: false,
        has_write_all: false,
      });
      const svc = makeSvc(deps);

      await svc.reassign(
        'c1',
        {
          assigned_team_id: '33333333-3333-3333-3333-333333333333',
          reason: 'workflow auto-route',
        },
        SYSTEM_ACTOR,
      );

      expect(deps.visibility.loadContext).not.toHaveBeenCalled();
      expect(deps.visibility.assertVisible).not.toHaveBeenCalled();
      expect(deps.permissionChecks).toHaveLength(0);
      // codex-C-I1 (2026-05-11): also assert the write LANDED — gate-bypass
      // tests previously only proved "permission path skipped", which would
      // pass even if the reassign short-circuited before the
      // `.from('tickets').update(...)` write at ticket.service.ts:1431. The
      // supabase mock at the top of this file applies the patch onto `row`,
      // so the row state IS the write proof.
      expect(deps.row().assigned_team_id).toBe(
        '33333333-3333-3333-3333-333333333333',
      );
    });

    it('passes the gate when caller has tickets.assign granted', async () => {
      const deps = makeDeps(baseRow(), {
        hasPermission: true,
        has_write_all: false,
      });
      const svc = makeSvc(deps);

      await svc.reassign(
        'c1',
        {
          assigned_team_id: '33333333-3333-3333-3333-333333333333',
          reason: 'team handover',
        },
        'auth-uid-agent',
      );

      expect(deps.permissionChecks).toEqual([
        { user_id: 'u1', permission: 'tickets.assign' },
      ]);
      // C-remediation strengthening (2026-05-11, F-IMP-A): assert that
      // the write actually landed, not just that the gate was traversed
      // (`loadContext` alone proves nothing about the write outcome).
      // See the sibling `skips the permission RPC` test for the same
      // pattern.
      expect(deps.row().assigned_team_id).toBe(
        '33333333-3333-3333-3333-333333333333',
      );
    });
  });
});

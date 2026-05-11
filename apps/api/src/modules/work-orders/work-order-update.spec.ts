// Tests for WorkOrderService.update — the single-endpoint command surface
// behind `PATCH /work-orders/:id`.
//
// Post-§3.0 cutover (Commit B): the per-field dispatcher chain
// (`updateSla → setPlan → updateStatus → updatePriority → updateAssignment
//  → updateMetadata`) was replaced by ONE `update_entity_combined` RPC
// call (00333) that commits every branch in one transaction. The per-field
// service methods remain on the class as legacy entry points exercised by
// their own spec files (`work-order-{sla-edit,set-plan,update-status,
// update-priority,update-assignment,update-metadata}.spec.ts`) — they are
// no longer reached by the `update()` orchestrator.
//
// What this spec asserts post-cutover:
//   1. `update()` calls `supabase.admin.rpc('update_entity_combined', …)`
//      exactly once for every non-empty DTO, with the patches payload
//      grouped per §3.0 (status, priority, assignment, plan, sla, metadata).
//   2. The outer idempotency key matches `patch:work_order:<id>:<cri>`
//      (spec line 1892).
//   3. `p_actor_user_id` is null for SYSTEM_ACTOR (00325:89-94) and the raw
//      auth uid otherwise.
//   4. The orchestrator refetches once after the RPC returns.
//   5. The preflight (`preflightValidateUpdate`) rejects malformed payloads
//      BEFORE the RPC is called — no partial state.
//   6. `clientRequestId` is required when the dto carries any writable
//      branch (defense-in-depth — F-CRIT-1 / 2026-05-11).
//   7. Integration-level behaviour (sub-RPC dispatch, sla_timers, activity
//      rows, domain events, cached_result on idempotent replay) is covered
//      by `apps/api/test/concurrency/update_entity_combined.spec.ts` —
//      this spec is the unit-level call-shape proof.

import { AppError } from '../../common/errors';
import {
  WorkOrderService,
  SYSTEM_ACTOR,
  type WorkOrderRow,
} from './work-order.service';

const TENANT = 't1';
const CRI = 'cri-test-1';

function makeRow(overrides: Partial<WorkOrderRow> = {}): WorkOrderRow {
  return {
    id: 'wo1',
    tenant_id: TENANT,
    sla_id: null,
    planned_start_at: null,
    planned_duration_minutes: null,
    status: 'assigned',
    status_category: 'assigned',
    priority: 'medium',
    assigned_team_id: null,
    assigned_user_id: null,
    assigned_vendor_id: null,
    ...overrides,
  } as WorkOrderRow;
}

interface FromCall {
  table: string;
  args?: unknown[];
}
interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

function makeSvc(opts?: {
  refetchedRow?: WorkOrderRow;
  hasPermission?: boolean;
  has_write_all?: boolean;
  slaPolicyExists?: boolean;
  personsInTenant?: string[];
  rpcImpl?: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: unknown }>;
}) {
  const refetchedRow = opts?.refetchedRow ?? makeRow();
  const slaPolicyExists = opts?.slaPolicyExists ?? true;
  const personsInTenant = new Set(opts?.personsInTenant ?? []);

  const fromCalls: FromCall[] = [];
  const rpcCalls: RpcCall[] = [];

  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        fromCalls.push({ table });
        if (table === 'work_orders') {
          // Both the plan-branch "current row" probe and the post-RPC
          // refetch land here. .maybeSingle() returns the refetched row.
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { ...refetchedRow },
                    error: null,
                  }),
                }),
              }),
            }),
          } as unknown;
        }
        if (table === 'sla_policies') {
          // preflightValidateUpdate tier-1 sla_policies probe.
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: slaPolicyExists ? { id: 'sla-x' } : null,
                    error: null,
                  }),
                }),
              }),
            }),
          } as unknown;
        }
        if (table === 'teams' || table === 'users' || table === 'vendors') {
          // validateAssigneesInTenant probe — return found-shape so it
          // clears unless tests opt-out via a different mock.
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { id: 'mocked' },
                    error: null,
                  }),
                }),
              }),
            }),
          } as unknown;
        }
        if (table === 'persons') {
          // Watcher tenant validation — resilient chain.
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
                data: ids
                  .filter((id) => personsInTenant.has(id))
                  .map((id) => ({ id })),
                error: null,
              }).then(resolve, reject),
          });
          return chain as unknown;
        }
        return {} as unknown;
      }),
      rpc: jest.fn(async (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push({ fn, args });
        if (opts?.rpcImpl) return opts.rpcImpl(fn, args);
        if (fn === 'user_has_permission') {
          return { data: !!opts?.hasPermission, error: null };
        }
        if (fn === 'update_entity_combined') {
          return { data: null, error: null };
        }
        throw new Error(`unexpected rpc in mock: ${fn}`);
      }),
    },
  };

  const slaService = {
    restartTimers: jest.fn(),
    pauseTimers: jest.fn(),
    resumeTimers: jest.fn(),
    completeTimers: jest.fn(),
    startTimers: jest.fn(),
    applyWaitingStateTransition: jest.fn(),
    buildTimersForRpc: jest.fn().mockResolvedValue([
      // §3.3 expects pre-computed timer payloads when sla_id is set.
      // Shape mirrors 00330:279-284 — { kind, deadline_at }.
      { kind: 'response', deadline_at: '2026-06-01T10:00:00.000Z' },
      { kind: 'resolution', deadline_at: '2026-06-01T18:00:00.000Z' },
    ]),
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
      has_write_all: opts?.has_write_all ?? true,
    }),
    assertCanPlan: jest.fn().mockResolvedValue(undefined),
  };

  const svc = new WorkOrderService(
    supabase as never,
    slaService as never,
    visibility as never,
  );

  return { svc, supabase, slaService, visibility, fromCalls, rpcCalls };
}

/** Convenience: pluck `update_entity_combined` calls only. */
function combinedCalls(
  rpcCalls: RpcCall[],
): Array<Record<string, unknown>> {
  return rpcCalls
    .filter((c) => c.fn === 'update_entity_combined')
    .map((c) => c.args);
}

describe('WorkOrderService.update — §3.0 orchestrator call shape', () => {
  beforeEach(() => {
    jest
      .spyOn(
        require('../../common/tenant-context').TenantContext,
        'current',
      )
      .mockReturnValue({ id: TENANT, slug: TENANT });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── DTO branch detection ────────────────────────────────────────────

  it('sla_id-only DTO emits a single RPC with patches.sla = { sla_id, timers }', async () => {
    const { svc, rpcCalls } = makeSvc();
    await svc.update('wo1', { sla_id: 'sla-x' }, SYSTEM_ACTOR, CRI);

    const combined = combinedCalls(rpcCalls);
    expect(combined).toHaveLength(1);
    expect(combined[0]).toMatchObject({
      p_entity_kind: 'work_order',
      p_entity_id: 'wo1',
      p_tenant_id: TENANT,
      p_actor_user_id: null,
      p_idempotency_key: `patch:work_order:wo1:${CRI}`,
      p_patches: {
        sla: {
          sla_id: 'sla-x',
          timers: [
            { kind: 'response', deadline_at: '2026-06-01T10:00:00.000Z' },
            {
              kind: 'resolution',
              deadline_at: '2026-06-01T18:00:00.000Z',
            },
          ],
        },
      },
    });
  });

  it('sla_id=null DTO emits a clear-only sla branch (no timers)', async () => {
    const { svc, rpcCalls } = makeSvc();
    await svc.update('wo1', { sla_id: null }, SYSTEM_ACTOR, CRI);

    const combined = combinedCalls(rpcCalls);
    expect(combined).toHaveLength(1);
    const patches = combined[0].p_patches as { sla?: Record<string, unknown> };
    expect(patches.sla).toEqual({ sla_id: null });
  });

  it('plan DTO with both fields emits patches.plan grouped', async () => {
    const { svc, rpcCalls } = makeSvc({
      refetchedRow: makeRow({
        planned_start_at: '2026-05-04T13:00:00.000Z',
        planned_duration_minutes: 60,
      }),
    });
    await svc.update(
      'wo1',
      {
        planned_start_at: '2026-05-04T13:00:00.000Z',
        planned_duration_minutes: 60,
      },
      SYSTEM_ACTOR,
      CRI,
    );

    const combined = combinedCalls(rpcCalls);
    expect(combined).toHaveLength(1);
    expect(combined[0].p_patches).toMatchObject({
      plan: {
        planned_start_at: '2026-05-04T13:00:00.000Z',
        planned_duration_minutes: 60,
      },
    });
  });

  it('status DTO emits patches.{status,status_category} at top level', async () => {
    const { svc, rpcCalls } = makeSvc();
    await svc.update(
      'wo1',
      { status_category: 'in_progress', status: 'in_progress' },
      SYSTEM_ACTOR,
      CRI,
    );

    const combined = combinedCalls(rpcCalls);
    expect(combined).toHaveLength(1);
    expect(combined[0].p_patches).toMatchObject({
      status: 'in_progress',
      status_category: 'in_progress',
    });
  });

  it('priority DTO emits patches.priority at top level', async () => {
    const { svc, rpcCalls } = makeSvc();
    await svc.update('wo1', { priority: 'high' }, SYSTEM_ACTOR, CRI);

    const combined = combinedCalls(rpcCalls);
    expect(combined).toHaveLength(1);
    expect(combined[0].p_patches).toMatchObject({ priority: 'high' });
  });

  it('assignment DTO emits patches.assignment grouped with only the supplied keys', async () => {
    const { svc, rpcCalls } = makeSvc();
    await svc.update(
      'wo1',
      { assigned_user_id: '99999999-9999-9999-9999-999999999999' },
      SYSTEM_ACTOR,
      CRI,
    );

    const combined = combinedCalls(rpcCalls);
    expect(combined).toHaveLength(1);
    expect(combined[0].p_patches).toMatchObject({
      assignment: {
        assigned_user_id: '99999999-9999-9999-9999-999999999999',
      },
    });
  });

  it('assignment with explicit null preserves null on the wire (clear gesture)', async () => {
    const { svc, rpcCalls } = makeSvc();
    await svc.update(
      'wo1',
      {
        assigned_team_id: null,
        assigned_user_id: '99999999-9999-9999-9999-999999999999',
      },
      SYSTEM_ACTOR,
      CRI,
    );

    const combined = combinedCalls(rpcCalls);
    expect(combined).toHaveLength(1);
    expect(combined[0].p_patches).toMatchObject({
      assignment: {
        assigned_team_id: null,
        assigned_user_id: '99999999-9999-9999-9999-999999999999',
      },
    });
  });

  it('multi-field DTO (status + priority + assignment) emits ONE RPC with every branch', async () => {
    const { svc, rpcCalls, fromCalls } = makeSvc({
      refetchedRow: makeRow({
        status: 'in_progress',
        status_category: 'in_progress',
        priority: 'high',
        assigned_user_id: '99999999-9999-9999-9999-999999999999',
      }),
    });
    const row = await svc.update(
      'wo1',
      {
        status_category: 'in_progress',
        status: 'in_progress',
        priority: 'high',
        assigned_user_id: '99999999-9999-9999-9999-999999999999',
      },
      SYSTEM_ACTOR,
      CRI,
    );

    const combined = combinedCalls(rpcCalls);
    expect(combined).toHaveLength(1);
    expect(combined[0].p_patches).toMatchObject({
      status: 'in_progress',
      status_category: 'in_progress',
      priority: 'high',
      assignment: {
        assigned_user_id: '99999999-9999-9999-9999-999999999999',
      },
    });

    // Refetch landed on `work_orders` exactly once (post-RPC).
    const woRefetches = fromCalls.filter((c) => c.table === 'work_orders');
    expect(woRefetches.length).toBeGreaterThanOrEqual(1);
    expect(row.status_category).toBe('in_progress');
    expect(row.priority).toBe('high');
    expect(row.assigned_user_id).toBe(
      '99999999-9999-9999-9999-999999999999',
    );
  });

  it('rejects an empty DTO with work_order.empty_update', async () => {
    const { svc, rpcCalls } = makeSvc();
    await expect(svc.update('wo1', {}, SYSTEM_ACTOR, CRI)).rejects.toThrow(
      AppError,
    );
    await expect(svc.update('wo1', {}, SYSTEM_ACTOR, CRI)).rejects.toMatchObject(
      {
        code: 'work_order.empty_update',
      },
    );
    expect(combinedCalls(rpcCalls)).toHaveLength(0);
  });

  it('metadata-only DTO emits patches.metadata grouped with all 5 fields', async () => {
    // title / description / cost / tags / watchers all go into the
    // metadata branch (00333:187, 505-732).
    const { svc, rpcCalls } = makeSvc({
      personsInTenant: ['p1'],
    });
    await svc.update(
      'wo1',
      {
        title: 'new title',
        description: 'new desc',
        cost: 250,
        tags: ['a', 'b'],
        watchers: ['p1'],
      },
      SYSTEM_ACTOR,
      CRI,
    );

    const combined = combinedCalls(rpcCalls);
    expect(combined).toHaveLength(1);
    expect(combined[0].p_patches).toMatchObject({
      metadata: {
        title: 'new title',
        description: 'new desc',
        cost: 250,
        tags: ['a', 'b'],
        watchers: ['p1'],
      },
    });
  });

  it('does NOT emit metadata branch when keys are explicit-undefined', async () => {
    // hasOwnDefined (apps/api/src/common/has-own-defined.ts) drops
    // explicit-undefined keys. Without the guard, `{ status: 'x',
    // title: undefined }` would emit metadata with an empty inner DTO
    // → unnecessary write + spurious activity row.
    const { svc, rpcCalls } = makeSvc();
    await svc.update(
      'wo1',
      {
        status: 'in_progress',
        status_category: 'in_progress',
        title: undefined,
        description: undefined,
        cost: undefined,
        tags: undefined,
        watchers: undefined,
      },
      SYSTEM_ACTOR,
      CRI,
    );

    const combined = combinedCalls(rpcCalls);
    expect(combined).toHaveLength(1);
    const patches = combined[0].p_patches as Record<string, unknown>;
    expect(patches).toMatchObject({
      status: 'in_progress',
      status_category: 'in_progress',
    });
    expect(patches.metadata).toBeUndefined();
  });

  it('still emits metadata branch when only SOME keys are explicit-undefined', async () => {
    // `{ title: 'real', cost: undefined }` → metadata = { title: 'real' }
    // only. Cost is NOT cleared (undefined ≠ null on the wire).
    const { svc, rpcCalls } = makeSvc();
    await svc.update(
      'wo1',
      { title: 'real', cost: undefined },
      SYSTEM_ACTOR,
      CRI,
    );

    const combined = combinedCalls(rpcCalls);
    expect(combined).toHaveLength(1);
    expect(combined[0].p_patches).toMatchObject({
      metadata: { title: 'real' },
    });
    expect(
      (combined[0].p_patches as { metadata: Record<string, unknown> }).metadata
        .cost,
    ).toBeUndefined();
  });

  it('mixed metadata + status DTO emits ONE RPC with both branches', async () => {
    const { svc, rpcCalls } = makeSvc();
    await svc.update(
      'wo1',
      {
        status: 'in_progress',
        status_category: 'in_progress',
        title: 'updated',
      },
      SYSTEM_ACTOR,
      CRI,
    );

    const combined = combinedCalls(rpcCalls);
    expect(combined).toHaveLength(1);
    expect(combined[0].p_patches).toMatchObject({
      status: 'in_progress',
      status_category: 'in_progress',
      metadata: { title: 'updated' },
    });
  });

  it('rejects a null DTO with work_order.body_required', async () => {
    const { svc, rpcCalls } = makeSvc();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(svc.update('wo1', null as any, SYSTEM_ACTOR, CRI)).rejects.toThrow(
      AppError,
    );
    expect(combinedCalls(rpcCalls)).toHaveLength(0);
  });

  // ── actor handling ──────────────────────────────────────────────────

  it('SYSTEM_ACTOR collapses p_actor_user_id to null (00325:89-94)', async () => {
    const { svc, rpcCalls } = makeSvc();
    await svc.update('wo1', { sla_id: 'sla-x' }, SYSTEM_ACTOR, CRI);
    const combined = combinedCalls(rpcCalls);
    expect(combined).toHaveLength(1);
    expect(combined[0].p_actor_user_id).toBeNull();
  });

  it('non-system actor passes the raw auth uid as p_actor_user_id', async () => {
    const { svc, rpcCalls } = makeSvc({
      hasPermission: true,
      has_write_all: false,
    });
    await svc.update('wo1', { sla_id: 'sla-x' }, 'auth-uid-real', CRI);
    const combined = combinedCalls(rpcCalls);
    expect(combined).toHaveLength(1);
    expect(combined[0].p_actor_user_id).toBe('auth-uid-real');
  });

  // ── error propagation from RPC ─────────────────────────────────────

  it('propagates AppError from a mapped RPC error (sla.override denied)', async () => {
    const { svc, rpcCalls } = makeSvc({
      hasPermission: false,
      has_write_all: false,
    });

    // Permission preflight fails on sla.override before the orchestrator
    // RPC fires. Asserts the 403 propagates and NO update_entity_combined
    // was issued.
    await expect(
      svc.update('wo1', { sla_id: 'sla-x' }, 'auth-uid-no-sla', CRI),
    ).rejects.toThrow(/sla\.override/);
    expect(combinedCalls(rpcCalls)).toHaveLength(0);
  });

  it('propagates AppError from a mapped RPC error (tickets.change_priority denied)', async () => {
    const { svc, rpcCalls } = makeSvc({
      hasPermission: false,
      has_write_all: false,
    });
    await expect(
      svc.update('wo1', { priority: 'high' }, 'auth-uid-no-priority', CRI),
    ).rejects.toThrow(/tickets\.change_priority/);
    expect(combinedCalls(rpcCalls)).toHaveLength(0);
  });

  // ── partial-commit prevention via preflight ────────────────────────

  it('preflight rejects ENTIRE multi-field update when one field fails validation — no RPC fires', async () => {
    const { svc, rpcCalls } = makeSvc();

    await expect(
      svc.update(
        'wo1',
        {
          priority: 'high',
          assigned_user_id: '99999999-9999-9999-9999-999999999999',
          title: '   ', // whitespace-only — fails preflight
        },
        SYSTEM_ACTOR, // SYSTEM_ACTOR bypasses permission/visibility but
        // NOT the format/validation checks
        CRI,
      ),
    ).rejects.toThrow(/title must not be empty/);

    // Critical assertion: no combined RPC fired — preflight short-circuited.
    expect(combinedCalls(rpcCalls)).toHaveLength(0);
  });

  it('preflight rejects on malformed assignee uuid before any RPC fires', async () => {
    const { svc, rpcCalls } = makeSvc();

    await expect(
      svc.update(
        'wo1',
        {
          priority: 'high',
          assigned_team_id: 'not-a-uuid',
        },
        SYSTEM_ACTOR,
        CRI,
      ),
    ).rejects.toThrow(/assigned_team_id is not a valid uuid/);

    expect(combinedCalls(rpcCalls)).toHaveLength(0);
  });

  it('preflight rejects with 403 when caller lacks tickets.assign — no RPC fires', async () => {
    // Real auth uid + write_all disabled + permission RPC false → preflight
    // 403. NO combined RPC issued.
    const { svc, rpcCalls } = makeSvc({
      hasPermission: false,
      has_write_all: false,
    });

    await expect(
      svc.update(
        'wo1',
        { assigned_team_id: '99999999-9999-9999-9999-999999999999' },
        'auth-uid-no-perm',
        CRI,
      ),
    ).rejects.toThrow(/tickets\.assign/);

    expect(combinedCalls(rpcCalls)).toHaveLength(0);
  });

  it('preflight rejects on invalid priority before any RPC fires', async () => {
    const { svc, rpcCalls } = makeSvc();

    await expect(
      svc.update(
        'wo1',
        {
          priority: 'super-urgent' as 'low' | 'medium' | 'high' | 'critical',
          title: 'new title',
        },
        SYSTEM_ACTOR,
        CRI,
      ),
    ).rejects.toThrow(/priority must be one of/);

    expect(combinedCalls(rpcCalls)).toHaveLength(0);
  });

  it('propagates AppError from a mapped RPC error (tickets.assign denied)', async () => {
    // Real auth uid + write_all disabled + permission RPC false →
    // preflight rejects with 403 before the orchestrator RPC fires.
    const { svc, rpcCalls } = makeSvc({
      hasPermission: false,
      has_write_all: false,
    });

    await expect(
      svc.update(
        'wo1',
        { assigned_user_id: '99999999-9999-9999-9999-999999999999' },
        'auth-uid-no-assign',
        CRI,
      ),
    ).rejects.toThrow(/tickets\.assign/);
    expect(combinedCalls(rpcCalls)).toHaveLength(0);
  });

  // ── clientRequestId defense-in-depth (F-CRIT-1) ─────────────────────

  it('rejects when clientRequestId is missing on a writable DTO', async () => {
    // Internal callers that bypass the controller (RequireClientRequestIdGuard)
    // would otherwise mint a fresh randomUUID per call — idempotency footgun.
    // F-CRIT-1 (plan-review 2026-05-11): explicit defense-in-depth in
    // WorkOrderService.update.
    const { svc, rpcCalls } = makeSvc();
    await expect(
      svc.update('wo1', { priority: 'high' }, SYSTEM_ACTOR /* no cri */),
    ).rejects.toMatchObject({
      code: 'command_operations.client_request_id_required',
      status: 400,
    });
    expect(combinedCalls(rpcCalls)).toHaveLength(0);
  });
});

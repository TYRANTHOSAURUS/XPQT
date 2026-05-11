import { WorkflowEngineService } from './workflow-engine.service';
import { TenantContext } from '../../common/tenant-context';

function makeDeps() {
  // B.2.A.Step8 — workflow create_child_tasks now goes through the batch
  // RPC (dispatch_child_work_orders_batch / 00337). The dispatchService
  // mock captures BOTH legacy `dispatch()` (for any not-yet-migrated
  // call sites) AND the new `dispatchBatch()` and projects per-task
  // entries into `dispatchCalls` so the existing assertions still work.
  const dispatchCalls: Array<{ parentId: string; dto: Record<string, unknown> }> = [];

  const dispatchService = {
    dispatch: jest.fn(async (parentId: string, dto: Record<string, unknown>, _actorAuthUid: string) => {
      dispatchCalls.push({ parentId, dto });
      return { id: `child-${dispatchCalls.length}` };
    }),
    dispatchBatch: jest.fn(async (
      parentId: string,
      tasks: Array<Record<string, unknown>>,
      _actorAuthUid: string,
      _clientRequestId: string,
    ) => {
      for (const dto of tasks) {
        dispatchCalls.push({ parentId, dto });
      }
      return tasks.map((_t, i) => ({ id: `child-${dispatchCalls.length - tasks.length + i + 1}` }));
    }),
  };

  // Only needs `admin.from` for the single "load parent ticket" call the node does.
  // After the refactor, the node does NOT insert rows itself — all inserts flow through dispatch.
  // Codex-S8-I3 (F-IMP-3): the create_child_tasks node now also writes
  // `status='failed'` on the workflow_instances row when dispatch batch
  // raises. Mock the chain so the .from('workflow_instances').update(...)
  // .eq().eq() call succeeds.
  const workflowInstanceUpdates: Array<{ patch: Record<string, unknown>; filters: Record<string, unknown> }> = [];
  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        if (table === 'tickets') {
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({
                  data: { tenant_id: 't1', requester_person_id: 'p1', location_id: 'l1' },
                  error: null,
                }),
              }),
            }),
          } as unknown;
        }
        if (table === 'workflow_instances') {
          return {
            update: (patch: Record<string, unknown>) => {
              const filters: Record<string, unknown> = {};
              return {
                eq: (col1: string, val1: unknown) => {
                  filters[col1] = val1;
                  return {
                    eq: async (col2: string, val2: unknown) => {
                      filters[col2] = val2;
                      workflowInstanceUpdates.push({ patch, filters });
                      return { error: null };
                    },
                  };
                },
              };
            },
          } as unknown;
        }
        return {} as unknown;
      }),
      // B.2.A.Step9 — RPC mock captured per-call so create_child_tasks
      // tests still work (they don't exercise the RPC layer, but the
      // shape is shared with assign + update_ticket tests below).
      rpc: jest.fn(async () => ({ data: null, error: null })),
    },
  };

  const slaService = {
    buildTimersForRpc: jest.fn(async () => []),
  };

  return { dispatchService, supabase, dispatchCalls, workflowInstanceUpdates, slaService };
}

describe('WorkflowEngineService.create_child_tasks', () => {
  beforeEach(() => {
    jest.spyOn(TenantContext, 'current').mockReturnValue({ id: 't1', subdomain: 't1' } as never);
  });

  it('routes each task through DispatchService with copied context', async () => {
    const { dispatchService, supabase, dispatchCalls, slaService } = makeDeps();
    const engine = new WorkflowEngineService(supabase as never, dispatchService as never, slaService as never);

    const advance = jest.spyOn(engine as never, 'advance').mockResolvedValue(undefined as never);
    jest.spyOn(engine as never, 'emit').mockResolvedValue(undefined as never);

    const graph = { nodes: [], edges: [] };
    const node = {
      id: 'n1',
      type: 'create_child_tasks',
      config: {
        tasks: [
          { title: 'Replace pane', assigned_team_id: 'glaziers', priority: 'high' },
          { title: '', assigned_team_id: 'janitorial' }, // empty title → falls back
        ],
      },
    };

    await (engine as unknown as {
      executeNode: (i: string, g: unknown, n: unknown, t: string, c: unknown) => Promise<void>;
    }).executeNode('inst-1', graph, node, 'parent-1', undefined);

    expect(dispatchCalls).toHaveLength(2);
    expect(dispatchCalls[0]).toMatchObject({
      parentId: 'parent-1',
      dto: {
        title: 'Replace pane',
        assigned_team_id: 'glaziers',
        priority: 'high',
      },
    });
    // Task with no sla_policy_id key in source should NOT have sla_id in the DTO.
    expect('sla_id' in dispatchCalls[0].dto).toBe(false);
    expect(dispatchCalls[1].dto.title).toBe('Subtask 2'); // empty-title fallback
    expect(advance).toHaveBeenCalled();
  });

  it('forwards sla_policy_id, assigned_user_id, and assigned_vendor_id per task', async () => {
    const { dispatchService, supabase, dispatchCalls, slaService } = makeDeps();
    const engine = new WorkflowEngineService(supabase as never, dispatchService as never, slaService as never);

    jest.spyOn(engine as never, 'advance').mockResolvedValue(undefined as never);
    jest.spyOn(engine as never, 'emit').mockResolvedValue(undefined as never);

    const node = {
      id: 'n1',
      type: 'create_child_tasks',
      config: {
        tasks: [
          { title: 'Glazier', sla_policy_id: 'sla-glaze', assigned_vendor_id: 'v-glaze' },
          { title: 'Janitor', sla_policy_id: null, assigned_team_id: 't-jan' },
          { title: 'Inspector', assigned_user_id: 'u1' }, // no sla_policy_id key → falls through to defaults
        ],
      },
    };

    await (engine as unknown as {
      executeNode: (i: string, g: unknown, n: unknown, t: string, c: unknown) => Promise<void>;
    }).executeNode('inst-1', { nodes: [], edges: [] }, node, 'parent-1', undefined);

    expect(dispatchCalls).toHaveLength(3);
    expect(dispatchCalls[0].dto.sla_id).toBe('sla-glaze');
    expect(dispatchCalls[0].dto.assigned_vendor_id).toBe('v-glaze');
    expect(dispatchCalls[1].dto.sla_id).toBeNull();
    expect(dispatchCalls[1].dto.assigned_team_id).toBe('t-jan');
    expect('sla_id' in dispatchCalls[2].dto).toBe(false); // not set in task → omitted from DTO
    expect(dispatchCalls[2].dto.assigned_user_id).toBe('u1');
  });

  it('halts the workflow when batch dispatch fails (Codex-S8-I3 / F-IMP-3)', async () => {
    // Pre-remediation this test asserted swallow+advance. That was the
    // exact bug Codex flagged: the batch is all-or-nothing, so a
    // dispatch failure leaves ZERO children committed, but the
    // workflow's audit log used to claim the node executed
    // successfully. The new contract is HALT: instance flips to
    // status='failed', a node_failed event is emitted, advance() is
    // NOT called.
    const { supabase, workflowInstanceUpdates, slaService } = makeDeps();
    const dispatchService = {
      dispatch: jest.fn(),
      dispatchBatch: jest.fn().mockRejectedValue(new Error('dispatch_child_work_orders_batch failed')),
    };
    const engine = new WorkflowEngineService(supabase as never, dispatchService as never, slaService as never);
    const advance = jest.spyOn(engine as never, 'advance').mockResolvedValue(undefined as never);
    const emit = jest.spyOn(engine as never, 'emit').mockResolvedValue(undefined as never);
    const logSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const node = {
      id: 'n1',
      type: 'create_child_tasks',
      config: { tasks: [{ title: 'Replace pane' }] },
    };

    await (engine as unknown as {
      executeNode: (i: string, g: unknown, n: unknown, t: string, c: unknown) => Promise<void>;
    }).executeNode('inst-1', { nodes: [], edges: [] }, node, 'parent-1', undefined);

    expect(dispatchService.dispatchBatch).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();
    // HALT: the workflow MUST NOT advance after a batch failure.
    expect(advance).not.toHaveBeenCalled();
    // workflow_instances flips to status='failed' (filtered by id +
    // tenant_id, both required by the cross-tenant write fix).
    expect(workflowInstanceUpdates).toHaveLength(1);
    expect(workflowInstanceUpdates[0].patch).toEqual({ status: 'failed' });
    expect(workflowInstanceUpdates[0].filters).toEqual({ id: 'inst-1', tenant_id: 't1' });
    // node_failed audit event surfaces the dispatch failure with the
    // reason + task count so ops can triage from the audit feed.
    const emitCalls = (emit.mock.calls as Array<[string, string, Record<string, unknown>, unknown?]>);
    const nodeFailed = emitCalls.find((c) => c[1] === 'node_failed');
    expect(nodeFailed).toBeDefined();
    const payload = nodeFailed?.[2] as { node_id: string; payload: { reason: string; task_count: number } };
    expect(payload.node_id).toBe('n1');
    expect(payload.payload.reason).toBe('dispatch_batch_failed');
    expect(payload.payload.task_count).toBe(1);

    logSpy.mockRestore();
  });
});

// ─── B.2.A.Step9 — assign node cutover to set_entity_assignment RPC ────────

describe('WorkflowEngineService.executeNode (assign) — B.2.A.Step9 RPC cutover', () => {
  // Spec lines 1870-1873: workflow engine `assign` node MUST go through
  // §3.2 set_entity_assignment (00327 v2). Pre-Step 9 it wrote directly
  // to tickets bypassing the orchestrator's idempotency / activity /
  // domain_event emission. The Step 9 cutover replaces the
  // .from('tickets').update(...) write with a .rpc(...) call gated by
  // a stable idempotency key per (instance, node, entity).
  beforeEach(() => {
    jest.spyOn(TenantContext, 'current').mockReturnValue({ id: 't1', subdomain: 't1' } as never);
  });

  function makeAssignDeps(opts?: { rpcError?: { message: string } | null }) {
    const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const supabase = {
      admin: {
        from: jest.fn(() => ({}) as unknown),
        rpc: jest.fn(async (fn: string, args: Record<string, unknown>) => {
          rpcCalls.push({ fn, args });
          if (opts?.rpcError) return { data: null, error: opts.rpcError };
          return { data: null, error: null };
        }),
      },
    };
    const slaService = { buildTimersForRpc: jest.fn(async () => []) };
    return { supabase, rpcCalls, slaService };
  }

  it('calls set_entity_assignment with a stable idempotency key (team_id only)', async () => {
    const TEAM = '00000000-0000-4000-8000-00000000aaaa';
    const { supabase, rpcCalls, slaService } = makeAssignDeps();
    const engine = new WorkflowEngineService(
      supabase as never,
      { dispatch: jest.fn() } as never,
      slaService as never,
    );
    jest.spyOn(engine as never, 'advance').mockResolvedValue(undefined as never);
    jest.spyOn(engine as never, 'emit').mockResolvedValue(undefined as never);

    const node = { id: 'n1', type: 'assign', config: { team_id: TEAM } };
    await (engine as unknown as {
      executeNode: (i: string, g: unknown, n: unknown, t: string, c: unknown) => Promise<void>;
    }).executeNode('inst-1', { nodes: [], edges: [] }, node, 'ticket-1', undefined);

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe('set_entity_assignment');
    expect(rpcCalls[0].args).toMatchObject({
      p_entity_id: 'ticket-1',
      p_entity_kind: 'case',
      p_tenant_id: 't1',
      p_actor_user_id: null,
      p_idempotency_key: 'workflow:assignment:inst-1:n1:ticket-1',
      p_payload: { assigned_team_id: TEAM },
    });
  });

  it('passes both team_id and user_id when both are configured', async () => {
    const TEAM = '00000000-0000-4000-8000-00000000aaaa';
    const USER = '00000000-0000-4000-8000-00000000bbbb';
    const { supabase, rpcCalls, slaService } = makeAssignDeps();
    const engine = new WorkflowEngineService(
      supabase as never,
      { dispatch: jest.fn() } as never,
      slaService as never,
    );
    jest.spyOn(engine as never, 'advance').mockResolvedValue(undefined as never);
    jest.spyOn(engine as never, 'emit').mockResolvedValue(undefined as never);

    const node = { id: 'n1', type: 'assign', config: { team_id: TEAM, user_id: USER } };
    await (engine as unknown as {
      executeNode: (i: string, g: unknown, n: unknown, t: string, c: unknown) => Promise<void>;
    }).executeNode('inst-1', { nodes: [], edges: [] }, node, 'ticket-1', undefined);

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].args.p_payload).toEqual({
      assigned_team_id: TEAM,
      assigned_user_id: USER,
    });
  });

  it('skips the RPC entirely when neither team_id nor user_id is configured', async () => {
    const { supabase, rpcCalls, slaService } = makeAssignDeps();
    const engine = new WorkflowEngineService(
      supabase as never,
      { dispatch: jest.fn() } as never,
      slaService as never,
    );
    const advance = jest.spyOn(engine as never, 'advance').mockResolvedValue(undefined as never);
    jest.spyOn(engine as never, 'emit').mockResolvedValue(undefined as never);

    const node = { id: 'n1', type: 'assign', config: {} };
    await (engine as unknown as {
      executeNode: (i: string, g: unknown, n: unknown, t: string, c: unknown) => Promise<void>;
    }).executeNode('inst-1', { nodes: [], edges: [] }, node, 'ticket-1', undefined);

    expect(rpcCalls).toHaveLength(0);
    expect(advance).toHaveBeenCalled();
  });

  it('maps an RPC error to AppError via mapRpcErrorToAppError', async () => {
    // Defense-in-depth: a cross-tenant team_id raised by the RPC layer
    // (validate_assignees_in_tenant.assigned_team_id_not_in_tenant)
    // must bubble as AppError(422), not as a raw PostgrestError.
    const FOREIGN_TEAM = '00000000-0000-4000-8000-0000000fffff';
    const { supabase, slaService } = makeAssignDeps({
      rpcError: {
        message:
          'validate_assignees_in_tenant.assigned_team_id_not_in_tenant: team is not in tenant',
      },
    });
    const engine = new WorkflowEngineService(
      supabase as never,
      { dispatch: jest.fn() } as never,
      slaService as never,
    );
    jest.spyOn(engine as never, 'advance').mockResolvedValue(undefined as never);
    jest.spyOn(engine as never, 'emit').mockResolvedValue(undefined as never);

    const node = { id: 'n1', type: 'assign', config: { team_id: FOREIGN_TEAM } };
    let caught: unknown = null;
    try {
      await (engine as unknown as {
        executeNode: (i: string, g: unknown, n: unknown, t: string, c: unknown) => Promise<void>;
      }).executeNode('inst-1', { nodes: [], edges: [] }, node, 'ticket-1', undefined);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect((caught as { code?: string }).code).toBe(
      'validate_assignees_in_tenant.assigned_team_id_not_in_tenant',
    );
    expect((caught as { status?: number }).status).toBe(422);
  });
});

describe('WorkflowEngineService.executeNode (approval) — Plan A.4 / Commit 3 (C2)', () => {
  // node.config.approver_person_id + approver_team_id come from user-
  // authored workflow JSONB. A forged / imported definition could carry
  // a foreign-tenant uuid that lands in the approvals row blind. Validate
  // before insert.
  beforeEach(() => {
    jest.spyOn(TenantContext, 'current').mockReturnValue({ id: 't1', subdomain: 't1' } as never);
  });

  function makeApprovalDeps(rowsByTable: Record<string, Array<{ id: string; tenant_id: string }>>) {
    const inserts: Array<Record<string, unknown>> = [];
    const updates: Array<Record<string, unknown>> = [];
    const supabase = {
      admin: {
        from: jest.fn((table: string) => {
          if (rowsByTable[table]) {
            const filters: Record<string, unknown> = {};
            const chain: Record<string, unknown> = {
              eq: (col: string, val: unknown) => {
                filters[col] = val;
                return chain;
              },
              maybeSingle: async () => {
                const match = rowsByTable[table].find((r) => {
                  for (const [c, v] of Object.entries(filters)) {
                    if ((r as Record<string, unknown>)[c] !== v) return false;
                  }
                  return true;
                });
                return { data: match ?? null, error: null };
              },
            };
            return { select: () => chain };
          }
          if (table === 'approvals') {
            return {
              insert: (row: Record<string, unknown>) => {
                inserts.push(row);
                return Promise.resolve({ error: null });
              },
            } as unknown;
          }
          if (table === 'workflow_instances') {
            return {
              update: (patch: Record<string, unknown>) => {
                const fs: Record<string, unknown> = {};
                const eqChain: Record<string, unknown> & PromiseLike<unknown> = {
                  eq: (col: string, val: unknown) => {
                    fs[col] = val;
                    return eqChain;
                  },
                  then: (onFulfilled?: (v: unknown) => unknown) => {
                    updates.push({ ...patch, __filters: fs });
                    return Promise.resolve({ error: null }).then(onFulfilled);
                  },
                } as Record<string, unknown> & PromiseLike<unknown>;
                return eqChain;
              },
            } as unknown;
          }
          return {} as unknown;
        }),
        rpc: jest.fn(async () => ({ data: null, error: null })),
      },
    };
    const slaService = { buildTimersForRpc: jest.fn(async () => []) };
    return { supabase, inserts, updates, slaService };
  }

  it('rejects an approval node with a cross-tenant approver_person_id', async () => {
    const FOREIGN_PERSON = '00000000-0000-4000-8000-0000000fffff';
    const { supabase, inserts, slaService } = makeApprovalDeps({
      persons: [{ id: FOREIGN_PERSON, tenant_id: 'other-tenant' }],
    });
    const engine = new WorkflowEngineService(supabase as never, { dispatch: jest.fn() } as never, slaService as never);
    jest.spyOn(engine as never, 'emit').mockResolvedValue(undefined as never);

    const node = {
      id: 'n1',
      type: 'approval',
      config: { approver_person_id: FOREIGN_PERSON },
    };

    let caught: unknown = null;
    try {
      await (engine as unknown as {
        executeNode: (i: string, g: unknown, n: unknown, t: string, c: unknown) => Promise<void>;
      }).executeNode('inst-1', { nodes: [], edges: [] }, node, 'ticket-1', undefined);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect((caught as { code?: string }).code).toBe(
      'reference.not_in_tenant',
    );
    // No approvals row should have been inserted.
    expect(inserts).toEqual([]);
  });

  it('rejects an approval node with a cross-tenant approver_team_id', async () => {
    const FOREIGN_TEAM = '00000000-0000-4000-8000-0000000fffff';
    const { supabase, inserts, slaService } = makeApprovalDeps({
      teams: [{ id: FOREIGN_TEAM, tenant_id: 'other-tenant' }],
    });
    const engine = new WorkflowEngineService(supabase as never, { dispatch: jest.fn() } as never, slaService as never);
    jest.spyOn(engine as never, 'emit').mockResolvedValue(undefined as never);

    const node = {
      id: 'n1',
      type: 'approval',
      config: { approver_team_id: FOREIGN_TEAM },
    };

    let caught: unknown = null;
    try {
      await (engine as unknown as {
        executeNode: (i: string, g: unknown, n: unknown, t: string, c: unknown) => Promise<void>;
      }).executeNode('inst-1', { nodes: [], edges: [] }, node, 'ticket-1', undefined);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect((caught as { code?: string }).code).toBe(
      'reference.not_in_tenant',
    );
    expect(inserts).toEqual([]);
  });

  it('lets an approval node through when both approvers are in-tenant', async () => {
    const VALID_PERSON = '00000000-0000-4000-8000-00000000aaaa';
    const VALID_TEAM = '00000000-0000-4000-8000-00000000bbbb';
    const { supabase, inserts, updates, slaService } = makeApprovalDeps({
      persons: [{ id: VALID_PERSON, tenant_id: 't1' }],
      teams: [{ id: VALID_TEAM, tenant_id: 't1' }],
    });
    const engine = new WorkflowEngineService(supabase as never, { dispatch: jest.fn() } as never, slaService as never);
    jest.spyOn(engine as never, 'emit').mockResolvedValue(undefined as never);

    const node = {
      id: 'n1',
      type: 'approval',
      config: { approver_person_id: VALID_PERSON, approver_team_id: VALID_TEAM },
    };

    await (engine as unknown as {
      executeNode: (i: string, g: unknown, n: unknown, t: string, c: unknown) => Promise<void>;
    }).executeNode('inst-1', { nodes: [], edges: [] }, node, 'ticket-1', undefined);

    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      target_entity_id: 'ticket-1',
      approver_person_id: VALID_PERSON,
      approver_team_id: VALID_TEAM,
      status: 'pending',
    });
    // Cross-tenant write fix (codex post-fix review 2026-05-08): the
    // workflow_instances waiting/approval transition must filter by
    // tenant_id, not just by id.
    expect(updates).toHaveLength(1);
    expect((updates[0] as { __filters: Record<string, unknown> }).__filters).toMatchObject({
      id: 'inst-1',
      tenant_id: 't1',
    });
  });

  it('skips validation for null/undefined approver fields (some shapes are unset)', async () => {
    const { supabase, inserts, slaService } = makeApprovalDeps({});
    const engine = new WorkflowEngineService(supabase as never, { dispatch: jest.fn() } as never, slaService as never);
    jest.spyOn(engine as never, 'emit').mockResolvedValue(undefined as never);

    // No approver_person_id / approver_team_id set — should still insert.
    const node = { id: 'n1', type: 'approval', config: {} };

    await (engine as unknown as {
      executeNode: (i: string, g: unknown, n: unknown, t: string, c: unknown) => Promise<void>;
    }).executeNode('inst-1', { nodes: [], edges: [] }, node, 'ticket-1', undefined);

    expect(inserts).toHaveLength(1);
  });
});

// ─── B.2.A.Step9 — update_ticket node cutover to update_entity_combined RPC ──

describe('WorkflowEngineService.executeNode (update_ticket) — B.2.A.Step9 RPC cutover', () => {
  // Spec lines 1870-1873: workflow engine `update_ticket` node MUST go
  // through §3.0 update_entity_combined (00335 v5). Step 9 tightens the
  // pre-cutover 29-field allowlist to the orchestrator's 14-field surface
  // (option 2) and routes ALL writes through the RPC. The 17 orphan
  // fields are documented in docs/follow-ups/b2-followups.md.
  beforeEach(() => {
    jest.spyOn(TenantContext, 'current').mockReturnValue({ id: 't1', subdomain: 't1' } as never);
  });

  function makeUpdateDeps(opts?: { rpcError?: { message: string } | null; timers?: unknown[] }) {
    const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const supabase = {
      admin: {
        from: jest.fn(() => ({}) as unknown),
        rpc: jest.fn(async (fn: string, args: Record<string, unknown>) => {
          rpcCalls.push({ fn, args });
          if (opts?.rpcError) return { data: null, error: opts.rpcError };
          return { data: null, error: null };
        }),
      },
    };
    const slaService = {
      buildTimersForRpc: jest.fn(async () => opts?.timers ?? []),
    };
    return { supabase, rpcCalls, slaService };
  }

  it('passes status / priority / metadata branches through update_entity_combined', async () => {
    const { supabase, rpcCalls, slaService } = makeUpdateDeps();
    const engine = new WorkflowEngineService(
      supabase as never,
      { dispatch: jest.fn() } as never,
      slaService as never,
    );
    jest.spyOn(engine as never, 'advance').mockResolvedValue(undefined as never);
    jest.spyOn(engine as never, 'emit').mockResolvedValue(undefined as never);

    const node = {
      id: 'n1',
      type: 'update_ticket',
      config: {
        fields: {
          priority: 'high',
          status_category: 'in_progress',
          tags: ['urgent', 'after-hours'],
          title: 'New title',
        },
      },
    };

    await (engine as unknown as {
      executeNode: (i: string, g: unknown, n: unknown, t: string, c: unknown) => Promise<void>;
    }).executeNode('inst-1', { nodes: [], edges: [] }, node, 'ticket-1', undefined);

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe('update_entity_combined');
    expect(rpcCalls[0].args).toMatchObject({
      p_entity_kind: 'case',
      p_entity_id: 'ticket-1',
      p_tenant_id: 't1',
      p_actor_user_id: null,
      p_idempotency_key: 'workflow:update_ticket:inst-1:n1:ticket-1',
    });
    expect(rpcCalls[0].args.p_patches).toEqual({
      priority: 'high',
      status_category: 'in_progress',
      metadata: {
        title: 'New title',
        tags: ['urgent', 'after-hours'],
      },
    });
  });

  it('groups assignment keys under `assignment` branch', async () => {
    const TEAM = '00000000-0000-4000-8000-00000000aaaa';
    const USER = '00000000-0000-4000-8000-00000000bbbb';
    const { supabase, rpcCalls, slaService } = makeUpdateDeps();
    const engine = new WorkflowEngineService(
      supabase as never,
      { dispatch: jest.fn() } as never,
      slaService as never,
    );
    jest.spyOn(engine as never, 'advance').mockResolvedValue(undefined as never);
    jest.spyOn(engine as never, 'emit').mockResolvedValue(undefined as never);

    const node = {
      id: 'n1',
      type: 'update_ticket',
      config: {
        fields: { assigned_team_id: TEAM, assigned_user_id: USER },
      },
    };

    await (engine as unknown as {
      executeNode: (i: string, g: unknown, n: unknown, t: string, c: unknown) => Promise<void>;
    }).executeNode('inst-1', { nodes: [], edges: [] }, node, 'ticket-1', undefined);

    expect(rpcCalls[0].args.p_patches).toEqual({
      assignment: {
        assigned_team_id: TEAM,
        assigned_user_id: USER,
      },
    });
  });

  it('precomputes sla.timers via SlaService.buildTimersForRpc when sla_id is non-null', async () => {
    const SLA = '00000000-0000-4000-8000-00000000cccc';
    const fakeTimers = [
      { timer_type: 'response', target_minutes: 60, due_at: '2026-09-01T10:00:00Z', business_hours_calendar_id: null },
    ];
    const { supabase, rpcCalls, slaService } = makeUpdateDeps({ timers: fakeTimers });
    const engine = new WorkflowEngineService(
      supabase as never,
      { dispatch: jest.fn() } as never,
      slaService as never,
    );
    jest.spyOn(engine as never, 'advance').mockResolvedValue(undefined as never);
    jest.spyOn(engine as never, 'emit').mockResolvedValue(undefined as never);

    const node = {
      id: 'n1',
      type: 'update_ticket',
      config: { fields: { sla_id: SLA } },
    };

    await (engine as unknown as {
      executeNode: (i: string, g: unknown, n: unknown, t: string, c: unknown) => Promise<void>;
    }).executeNode('inst-1', { nodes: [], edges: [] }, node, 'ticket-1', undefined);

    expect(slaService.buildTimersForRpc).toHaveBeenCalledWith(SLA, 't1');
    expect(rpcCalls[0].args.p_patches).toEqual({
      sla: { sla_id: SLA, timers: fakeTimers },
    });
  });

  it('omits sla.timers when sla_id is null (clear-only path)', async () => {
    const { supabase, rpcCalls, slaService } = makeUpdateDeps();
    const engine = new WorkflowEngineService(
      supabase as never,
      { dispatch: jest.fn() } as never,
      slaService as never,
    );
    jest.spyOn(engine as never, 'advance').mockResolvedValue(undefined as never);
    jest.spyOn(engine as never, 'emit').mockResolvedValue(undefined as never);

    const node = {
      id: 'n1',
      type: 'update_ticket',
      config: { fields: { sla_id: null } },
    };

    await (engine as unknown as {
      executeNode: (i: string, g: unknown, n: unknown, t: string, c: unknown) => Promise<void>;
    }).executeNode('inst-1', { nodes: [], edges: [] }, node, 'ticket-1', undefined);

    expect(slaService.buildTimersForRpc).not.toHaveBeenCalled();
    expect(rpcCalls[0].args.p_patches).toEqual({
      sla: { sla_id: null },
    });
  });

  it('rejects orphan field (impact) with workflow.update_ticket_field_not_allowed @ 422', async () => {
    // `impact` is one of the 17 orphan fields removed from the allowlist
    // (priority signals — needs a v6 orchestrator branch extension if it
    // becomes needed). The cutover MUST fail loudly so workflow authors
    // notice; silent drop would hide the misconfiguration in production.
    const { supabase, rpcCalls, slaService } = makeUpdateDeps();
    const engine = new WorkflowEngineService(
      supabase as never,
      { dispatch: jest.fn() } as never,
      slaService as never,
    );
    jest.spyOn(engine as never, 'advance').mockResolvedValue(undefined as never);
    jest.spyOn(engine as never, 'emit').mockResolvedValue(undefined as never);

    const node = {
      id: 'n1',
      type: 'update_ticket',
      config: { fields: { impact: 'high', priority: 'critical' } },
    };

    let caught: unknown = null;
    try {
      await (engine as unknown as {
        executeNode: (i: string, g: unknown, n: unknown, t: string, c: unknown) => Promise<void>;
      }).executeNode('inst-1', { nodes: [], edges: [] }, node, 'ticket-1', undefined);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect((caught as { code?: string }).code).toBe(
      'workflow.update_ticket_field_not_allowed',
    );
    expect((caught as { status?: number }).status).toBe(422);
    expect((caught as { detail?: string }).detail).toContain('impact');
    // Critical: the RPC must NOT have been called when the allowlist
    // rejects the payload.
    expect(rpcCalls).toEqual([]);
  });

  it('rejects orphan field (close_reason) — status-transition reasons removed', async () => {
    const { supabase, rpcCalls, slaService } = makeUpdateDeps();
    const engine = new WorkflowEngineService(
      supabase as never,
      { dispatch: jest.fn() } as never,
      slaService as never,
    );
    jest.spyOn(engine as never, 'advance').mockResolvedValue(undefined as never);
    jest.spyOn(engine as never, 'emit').mockResolvedValue(undefined as never);

    const node = {
      id: 'n1',
      type: 'update_ticket',
      config: { fields: { close_reason: 'duplicate' } },
    };

    let caught: unknown = null;
    try {
      await (engine as unknown as {
        executeNode: (i: string, g: unknown, n: unknown, t: string, c: unknown) => Promise<void>;
      }).executeNode('inst-1', { nodes: [], edges: [] }, node, 'ticket-1', undefined);
    } catch (e) {
      caught = e;
    }
    expect((caught as { code?: string }).code).toBe(
      'workflow.update_ticket_field_not_allowed',
    );
    expect((caught as { detail?: string }).detail).toContain('close_reason');
    expect(rpcCalls).toEqual([]);
  });

  it('rejects orphan field (workflow_id) — structurally unsafe self-mutation', async () => {
    const { supabase, rpcCalls, slaService } = makeUpdateDeps();
    const engine = new WorkflowEngineService(
      supabase as never,
      { dispatch: jest.fn() } as never,
      slaService as never,
    );
    jest.spyOn(engine as never, 'advance').mockResolvedValue(undefined as never);
    jest.spyOn(engine as never, 'emit').mockResolvedValue(undefined as never);

    const node = {
      id: 'n1',
      type: 'update_ticket',
      config: { fields: { workflow_id: 'some-uuid' } },
    };

    let caught: unknown = null;
    try {
      await (engine as unknown as {
        executeNode: (i: string, g: unknown, n: unknown, t: string, c: unknown) => Promise<void>;
      }).executeNode('inst-1', { nodes: [], edges: [] }, node, 'ticket-1', undefined);
    } catch (e) {
      caught = e;
    }
    expect((caught as { code?: string }).code).toBe(
      'workflow.update_ticket_field_not_allowed',
    );
    expect(rpcCalls).toEqual([]);
  });

  it('rejects unknown / typo fields (catches workflow-author mistakes)', async () => {
    const { supabase, rpcCalls, slaService } = makeUpdateDeps();
    const engine = new WorkflowEngineService(
      supabase as never,
      { dispatch: jest.fn() } as never,
      slaService as never,
    );
    jest.spyOn(engine as never, 'advance').mockResolvedValue(undefined as never);
    jest.spyOn(engine as never, 'emit').mockResolvedValue(undefined as never);

    const node = {
      id: 'n1',
      type: 'update_ticket',
      config: { fields: { priorty: 'high' } }, // typo
    };

    let caught: unknown = null;
    try {
      await (engine as unknown as {
        executeNode: (i: string, g: unknown, n: unknown, t: string, c: unknown) => Promise<void>;
      }).executeNode('inst-1', { nodes: [], edges: [] }, node, 'ticket-1', undefined);
    } catch (e) {
      caught = e;
    }
    expect((caught as { code?: string }).code).toBe(
      'workflow.update_ticket_field_not_allowed',
    );
    expect((caught as { detail?: string }).detail).toContain('priorty');
    expect(rpcCalls).toEqual([]);
  });

  it('rejects tenant_id mutation attempt (system-managed column)', async () => {
    // tenant_id was never in the pre-cutover allowlist either; this test
    // documents that the tightened allowlist still rejects it cleanly.
    const { supabase, rpcCalls, slaService } = makeUpdateDeps();
    const engine = new WorkflowEngineService(
      supabase as never,
      { dispatch: jest.fn() } as never,
      slaService as never,
    );
    jest.spyOn(engine as never, 'advance').mockResolvedValue(undefined as never);
    jest.spyOn(engine as never, 'emit').mockResolvedValue(undefined as never);

    const node = {
      id: 'n1',
      type: 'update_ticket',
      config: { fields: { tenant_id: 'attacker-tenant', priority: 'high' } },
    };

    let caught: unknown = null;
    try {
      await (engine as unknown as {
        executeNode: (i: string, g: unknown, n: unknown, t: string, c: unknown) => Promise<void>;
      }).executeNode('inst-1', { nodes: [], edges: [] }, node, 'ticket-1', undefined);
    } catch (e) {
      caught = e;
    }
    expect((caught as { code?: string }).code).toBe(
      'workflow.update_ticket_field_not_allowed',
    );
    expect((caught as { detail?: string }).detail).toContain('tenant_id');
    expect(rpcCalls).toEqual([]);
  });

  it('forwards plan keys to the RPC (orchestrator rejects on case via plan_not_supported_on_case)', async () => {
    // plan is in the allowlist but the §3.0 orchestrator rejects plan
    // on case (00335:170-173). The engine intentionally forwards the
    // keys; the RPC fails fast with the registered code, which
    // mapRpcErrorToAppError surfaces as 422.
    const { supabase, rpcCalls, slaService } = makeUpdateDeps({
      rpcError: {
        message:
          'update_entity_combined.plan_not_supported_on_case: plan dates can only be set on work orders',
      },
    });
    const engine = new WorkflowEngineService(
      supabase as never,
      { dispatch: jest.fn() } as never,
      slaService as never,
    );
    jest.spyOn(engine as never, 'advance').mockResolvedValue(undefined as never);
    jest.spyOn(engine as never, 'emit').mockResolvedValue(undefined as never);

    const node = {
      id: 'n1',
      type: 'update_ticket',
      config: { fields: { planned_start_at: '2026-09-01T10:00:00Z' } },
    };

    let caught: unknown = null;
    try {
      await (engine as unknown as {
        executeNode: (i: string, g: unknown, n: unknown, t: string, c: unknown) => Promise<void>;
      }).executeNode('inst-1', { nodes: [], edges: [] }, node, 'ticket-1', undefined);
    } catch (e) {
      caught = e;
    }
    expect((caught as { code?: string }).code).toBe(
      'update_entity_combined.plan_not_supported_on_case',
    );
    // The engine MUST have called the RPC before the error — proving
    // the cutover went through the RPC layer rather than throwing
    // TS-side on the plan-on-case branch.
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe('update_entity_combined');
    expect(rpcCalls[0].args.p_patches).toEqual({
      plan: { planned_start_at: '2026-09-01T10:00:00Z' },
    });
  });

  it('skips the RPC entirely on an empty fields object', async () => {
    const { supabase, rpcCalls, slaService } = makeUpdateDeps();
    const engine = new WorkflowEngineService(
      supabase as never,
      { dispatch: jest.fn() } as never,
      slaService as never,
    );
    const advance = jest.spyOn(engine as never, 'advance').mockResolvedValue(undefined as never);
    jest.spyOn(engine as never, 'emit').mockResolvedValue(undefined as never);

    const node = { id: 'n1', type: 'update_ticket', config: { fields: {} } };
    await (engine as unknown as {
      executeNode: (i: string, g: unknown, n: unknown, t: string, c: unknown) => Promise<void>;
    }).executeNode('inst-1', { nodes: [], edges: [] }, node, 'ticket-1', undefined);

    expect(rpcCalls).toEqual([]);
    expect(advance).toHaveBeenCalled();
  });

  it('maps a cross-tenant assignment RPC error to AppError(422)', async () => {
    // The §3.0 orchestrator delegates assignment to set_entity_assignment
    // (00335:339-355), which gates on validate_assignees_in_tenant. A
    // forged team_id surfaces as the registered code via the RPC layer.
    const FOREIGN_TEAM = '00000000-0000-4000-8000-0000000fffff';
    const { supabase, slaService } = makeUpdateDeps({
      rpcError: {
        message:
          'validate_assignees_in_tenant.assigned_team_id_not_in_tenant: team is not in tenant',
      },
    });
    const engine = new WorkflowEngineService(
      supabase as never,
      { dispatch: jest.fn() } as never,
      slaService as never,
    );
    jest.spyOn(engine as never, 'advance').mockResolvedValue(undefined as never);
    jest.spyOn(engine as never, 'emit').mockResolvedValue(undefined as never);

    const node = {
      id: 'n1',
      type: 'update_ticket',
      config: { fields: { assigned_team_id: FOREIGN_TEAM } },
    };

    let caught: unknown = null;
    try {
      await (engine as unknown as {
        executeNode: (i: string, g: unknown, n: unknown, t: string, c: unknown) => Promise<void>;
      }).executeNode('inst-1', { nodes: [], edges: [] }, node, 'ticket-1', undefined);
    } catch (e) {
      caught = e;
    }
    expect((caught as { code?: string }).code).toBe(
      'validate_assignees_in_tenant.assigned_team_id_not_in_tenant',
    );
    expect((caught as { status?: number }).status).toBe(422);
  });
});

describe('WorkflowEngineService.cancelInstanceForTicket', () => {
  it('cancels active/waiting instances and returns their ids', async () => {
    const captured: Array<{ patch: Record<string, unknown>; filters: Record<string, unknown> }> = [];

    const supabase = {
      admin: {
        from: (table: string) => {
          expect(table).toBe('workflow_instances');
          return {
            update: (patch: Record<string, unknown>) => ({
              eq: (c1: string, v1: unknown) => ({
                eq: (c2: string, v2: unknown) => ({
                  in: (c3: string, v3: unknown[]) => ({
                    select: (_cols: string) => {
                      captured.push({ patch, filters: { [c1]: v1, [c2]: v2, [c3]: v3 } });
                      return Promise.resolve({
                        data: [{ id: 'wi-1' }, { id: 'wi-2' }],
                        error: null,
                      });
                    },
                  }),
                }),
              }),
            }),
          };
        },
      },
    };

    const svc = new WorkflowEngineService(supabase as never, {} as never, {} as never);
    const ids = await svc.cancelInstanceForTicket('t1', 'ten1', 'reclassified', 'user-1');

    expect(ids).toEqual(['wi-1', 'wi-2']);
    expect(captured[0].patch.status).toBe('cancelled');
    expect(captured[0].patch.cancelled_reason).toBe('reclassified');
    expect(captured[0].patch.cancelled_by).toBe('user-1');
    expect(captured[0].filters).toMatchObject({
      ticket_id: 't1',
      tenant_id: 'ten1',
      status: ['active', 'waiting'],
    });
  });
});

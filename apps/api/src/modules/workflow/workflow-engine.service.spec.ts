import { WorkflowEngineService } from './workflow-engine.service';
import { TenantContext } from '../../common/tenant-context';

function makeDeps() {
  const dispatchCalls: Array<{ parentId: string; dto: Record<string, unknown> }> = [];

  const dispatchService = {
    dispatch: jest.fn(async (parentId: string, dto: Record<string, unknown>, _actorAuthUid: string) => {
      dispatchCalls.push({ parentId, dto });
      return { id: `child-${dispatchCalls.length}` };
    }),
  };

  // Only needs `admin.from` for the single "load parent ticket" call the node does.
  // After the refactor, the node does NOT insert rows itself — all inserts flow through dispatch.
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
        return {} as unknown;
      }),
    },
  };

  return { dispatchService, supabase, dispatchCalls };
}

describe('WorkflowEngineService.create_child_tasks', () => {
  beforeEach(() => {
    jest.spyOn(TenantContext, 'current').mockReturnValue({ id: 't1', subdomain: 't1' } as never);
  });

  it('routes each task through DispatchService with copied context', async () => {
    const { dispatchService, supabase, dispatchCalls } = makeDeps();
    const engine = new WorkflowEngineService(supabase as never, dispatchService as never);

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
    const { dispatchService, supabase, dispatchCalls } = makeDeps();
    const engine = new WorkflowEngineService(supabase as never, dispatchService as never);

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

  it('catches dispatch errors and advances the workflow', async () => {
    const { supabase } = makeDeps();
    const dispatchService = {
      dispatch: jest.fn().mockRejectedValue(new Error('cannot dispatch while parent is pending approval')),
    };
    const engine = new WorkflowEngineService(supabase as never, dispatchService as never);
    const advance = jest.spyOn(engine as never, 'advance').mockResolvedValue(undefined as never);
    jest.spyOn(engine as never, 'emit').mockResolvedValue(undefined as never);
    const logSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const node = {
      id: 'n1',
      type: 'create_child_tasks',
      config: { tasks: [{ title: 'Replace pane' }] },
    };

    await (engine as unknown as {
      executeNode: (i: string, g: unknown, n: unknown, t: string, c: unknown) => Promise<void>;
    }).executeNode('inst-1', { nodes: [], edges: [] }, node, 'parent-1', undefined);

    expect(dispatchService.dispatch).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();
    expect(advance).toHaveBeenCalled();

    logSpy.mockRestore();
  });
});

describe('WorkflowEngineService.executeNode (assign) — Plan A.2 tenant validation', () => {
  // Plan A.2 / Commit 7 / gap map §MEDIUM workflow-engine.service.ts:148-154.
  // node.config.team_id / user_id are user-defined JSONB on the workflow
  // definition. A foreign-tenant uuid would land on tickets.assigned_*
  // blind without this validation.
  beforeEach(() => {
    jest.spyOn(TenantContext, 'current').mockReturnValue({ id: 't1', subdomain: 't1' } as never);
  });

  function makeAssignDeps(rowsByTable: Record<string, Array<{ id: string; tenant_id: string }>>) {
    const updates: Array<Record<string, unknown>> = [];
    const supabase = {
      admin: {
        from: jest.fn((table: string) => {
          // assertTenantOwned probe path on teams / users.
          if (rowsByTable[table]) {
            const filters: Record<string, unknown> = {};
            const chain: Record<string, unknown> = {
              eq: (col: string, val: unknown) => {
                filters[col] = val;
                return chain;
              },
              maybeSingle: async () => {
                const match = rowsByTable[table].find((r) => {
                  for (const [c, v] of Object.entries(filters)) if ((r as Record<string, unknown>)[c] !== v) return false;
                  return true;
                });
                return { data: match ?? null, error: null };
              },
            };
            return { select: () => chain };
          }
          if (table === 'tickets') {
            return {
              update: (patch: Record<string, unknown>) => ({
                eq: () => {
                  updates.push(patch);
                  return Promise.resolve({ error: null });
                },
              }),
            } as unknown;
          }
          return {} as unknown;
        }),
      },
    };
    return { supabase, updates };
  }

  it('rejects an assign node with a cross-tenant team_id', async () => {
    const FOREIGN_TEAM = '00000000-0000-4000-8000-0000000fffff';
    const { supabase, updates } = makeAssignDeps({
      teams: [{ id: FOREIGN_TEAM, tenant_id: 'other-tenant' }],
    });
    const dispatchService = { dispatch: jest.fn() };
    const engine = new WorkflowEngineService(supabase as never, dispatchService as never);
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
    expect((caught as Error).message).toEqual(
      expect.stringContaining('assigned_team_id'),
    );
    // No tickets.update should have fired.
    expect(updates).toEqual([]);
  });

  it('lets an assign node through when team_id IS in tenant', async () => {
    const VALID_TEAM = '00000000-0000-4000-8000-00000000aaaa';
    const { supabase, updates } = makeAssignDeps({
      teams: [{ id: VALID_TEAM, tenant_id: 't1' }],
    });
    const dispatchService = { dispatch: jest.fn() };
    const engine = new WorkflowEngineService(supabase as never, dispatchService as never);
    jest.spyOn(engine as never, 'advance').mockResolvedValue(undefined as never);
    jest.spyOn(engine as never, 'emit').mockResolvedValue(undefined as never);

    const node = { id: 'n1', type: 'assign', config: { team_id: VALID_TEAM } };
    await (engine as unknown as {
      executeNode: (i: string, g: unknown, n: unknown, t: string, c: unknown) => Promise<void>;
    }).executeNode('inst-1', { nodes: [], edges: [] }, node, 'ticket-1', undefined);

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      assigned_team_id: VALID_TEAM,
      status_category: 'assigned',
    });
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
              update: (patch: Record<string, unknown>) => ({
                eq: () => {
                  updates.push(patch);
                  return Promise.resolve({ error: null });
                },
              }),
            } as unknown;
          }
          return {} as unknown;
        }),
      },
    };
    return { supabase, inserts, updates };
  }

  it('rejects an approval node with a cross-tenant approver_person_id', async () => {
    const FOREIGN_PERSON = '00000000-0000-4000-8000-0000000fffff';
    const { supabase, inserts } = makeApprovalDeps({
      persons: [{ id: FOREIGN_PERSON, tenant_id: 'other-tenant' }],
    });
    const engine = new WorkflowEngineService(supabase as never, { dispatch: jest.fn() } as never);
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
    expect((caught as { response?: { code?: string } }).response?.code).toBe(
      'reference.not_in_tenant',
    );
    // No approvals row should have been inserted.
    expect(inserts).toEqual([]);
  });

  it('rejects an approval node with a cross-tenant approver_team_id', async () => {
    const FOREIGN_TEAM = '00000000-0000-4000-8000-0000000fffff';
    const { supabase, inserts } = makeApprovalDeps({
      teams: [{ id: FOREIGN_TEAM, tenant_id: 'other-tenant' }],
    });
    const engine = new WorkflowEngineService(supabase as never, { dispatch: jest.fn() } as never);
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
    expect((caught as { response?: { code?: string } }).response?.code).toBe(
      'reference.not_in_tenant',
    );
    expect(inserts).toEqual([]);
  });

  it('lets an approval node through when both approvers are in-tenant', async () => {
    const VALID_PERSON = '00000000-0000-4000-8000-00000000aaaa';
    const VALID_TEAM = '00000000-0000-4000-8000-00000000bbbb';
    const { supabase, inserts } = makeApprovalDeps({
      persons: [{ id: VALID_PERSON, tenant_id: 't1' }],
      teams: [{ id: VALID_TEAM, tenant_id: 't1' }],
    });
    const engine = new WorkflowEngineService(supabase as never, { dispatch: jest.fn() } as never);
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
  });

  it('skips validation for null/undefined approver fields (some shapes are unset)', async () => {
    const { supabase, inserts } = makeApprovalDeps({});
    const engine = new WorkflowEngineService(supabase as never, { dispatch: jest.fn() } as never);
    jest.spyOn(engine as never, 'emit').mockResolvedValue(undefined as never);

    // No approver_person_id / approver_team_id set — should still insert.
    const node = { id: 'n1', type: 'approval', config: {} };

    await (engine as unknown as {
      executeNode: (i: string, g: unknown, n: unknown, t: string, c: unknown) => Promise<void>;
    }).executeNode('inst-1', { nodes: [], edges: [] }, node, 'ticket-1', undefined);

    expect(inserts).toHaveLength(1);
  });
});

describe('WorkflowEngineService.executeNode (update_ticket) — Plan A.4 / Commit 4 (C3)', () => {
  // node.config.fields is user-authored JSONB. Pre-A.4 it was written
  // verbatim onto tickets — no allowlist, no FK validation, no tenant
  // filter. Refactor: split fields into safe-scalar / FK-validated /
  // forbidden, throw on forbidden, validate FKs, and add explicit
  // .eq('tenant_id', ...) on the UPDATE.
  beforeEach(() => {
    jest.spyOn(TenantContext, 'current').mockReturnValue({ id: 't1', subdomain: 't1' } as never);
  });

  function makeUpdateDeps(rowsByTable: Record<string, Array<{ id: string; tenant_id: string }>>) {
    const updateCalls: Array<{ patch: Record<string, unknown>; filters: Record<string, unknown> }> = [];
    const supabase = {
      admin: {
        from: jest.fn((table: string) => {
          if (rowsByTable[table]) {
            // assertTenantOwned + validateAssigneesInTenant probe paths.
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
          if (table === 'tickets') {
            return {
              update: (patch: Record<string, unknown>) => {
                const fs: Record<string, unknown> = {};
                // Make the chain promise-thenable; capture in then() so
                // the test sees BOTH .eq() calls (id + tenant_id).
                const eqChain: Record<string, unknown> & PromiseLike<unknown> = {
                  eq: (col: string, val: unknown) => {
                    fs[col] = val;
                    return eqChain;
                  },
                  then: (onFulfilled?: (v: unknown) => unknown) => {
                    updateCalls.push({ patch, filters: { ...fs } });
                    return Promise.resolve({ error: null }).then(onFulfilled);
                  },
                } as Record<string, unknown> & PromiseLike<unknown>;
                return eqChain;
              },
            } as unknown;
          }
          return {} as unknown;
        }),
      },
    };
    return { supabase, updateCalls };
  }

  it('writes safe scalar fields verbatim (priority + status_category + tags)', async () => {
    const { supabase, updateCalls } = makeUpdateDeps({});
    const engine = new WorkflowEngineService(supabase as never, { dispatch: jest.fn() } as never);
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
        },
      },
    };

    await (engine as unknown as {
      executeNode: (i: string, g: unknown, n: unknown, t: string, c: unknown) => Promise<void>;
    }).executeNode('inst-1', { nodes: [], edges: [] }, node, 'ticket-1', undefined);

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].patch).toEqual({
      priority: 'high',
      status_category: 'in_progress',
      tags: ['urgent', 'after-hours'],
    });
    // Defense-in-depth: explicit tenant filter.
    expect(updateCalls[0].filters).toMatchObject({ id: 'ticket-1', tenant_id: 't1' });
  });

  it('throws workflow.update_ticket_field_not_allowed on tenant_id mutation attempt', async () => {
    const { supabase, updateCalls } = makeUpdateDeps({});
    const engine = new WorkflowEngineService(supabase as never, { dispatch: jest.fn() } as never);
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
    expect(caught).toBeTruthy();
    expect((caught as { response?: { code?: string; forbidden_fields?: string[] } }).response).toMatchObject({
      code: 'workflow.update_ticket_field_not_allowed',
      forbidden_fields: ['tenant_id'],
    });
    // Critically: nothing should have hit tickets.update.
    expect(updateCalls).toEqual([]);
  });

  it('throws on unknown field (catches workflow-author typos)', async () => {
    const { supabase, updateCalls } = makeUpdateDeps({});
    const engine = new WorkflowEngineService(supabase as never, { dispatch: jest.fn() } as never);
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
    expect((caught as { response?: { forbidden_fields?: string[] } }).response?.forbidden_fields).toEqual([
      'priorty',
    ]);
    expect(updateCalls).toEqual([]);
  });

  it('rejects cross-tenant FK in allowlisted FK field (assigned_team_id)', async () => {
    const FOREIGN_TEAM = '00000000-0000-4000-8000-0000000fffff';
    const { supabase, updateCalls } = makeUpdateDeps({
      teams: [{ id: FOREIGN_TEAM, tenant_id: 'other-tenant' }],
    });
    const engine = new WorkflowEngineService(supabase as never, { dispatch: jest.fn() } as never);
    jest.spyOn(engine as never, 'advance').mockResolvedValue(undefined as never);
    jest.spyOn(engine as never, 'emit').mockResolvedValue(undefined as never);

    const node = {
      id: 'n1',
      type: 'update_ticket',
      config: { fields: { assigned_team_id: FOREIGN_TEAM, priority: 'high' } },
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
    expect((caught as Error).message).toEqual(
      expect.stringContaining('assigned_team_id'),
    );
    expect(updateCalls).toEqual([]);
  });

  it('rejects cross-tenant sla_id (FK validation via assertTenantOwned)', async () => {
    const FOREIGN_SLA = '00000000-0000-4000-8000-0000000fffff';
    const { supabase, updateCalls } = makeUpdateDeps({
      sla_policies: [{ id: FOREIGN_SLA, tenant_id: 'other-tenant' }],
    });
    const engine = new WorkflowEngineService(supabase as never, { dispatch: jest.fn() } as never);
    jest.spyOn(engine as never, 'advance').mockResolvedValue(undefined as never);
    jest.spyOn(engine as never, 'emit').mockResolvedValue(undefined as never);

    const node = {
      id: 'n1',
      type: 'update_ticket',
      config: { fields: { sla_id: FOREIGN_SLA } },
    };

    let caught: unknown = null;
    try {
      await (engine as unknown as {
        executeNode: (i: string, g: unknown, n: unknown, t: string, c: unknown) => Promise<void>;
      }).executeNode('inst-1', { nodes: [], edges: [] }, node, 'ticket-1', undefined);
    } catch (e) {
      caught = e;
    }
    expect((caught as { response?: { code?: string } }).response?.code).toBe(
      'reference.not_in_tenant',
    );
    expect(updateCalls).toEqual([]);
  });

  it('writes in-tenant FK + safe scalar in one update (mixed allowlisted)', async () => {
    const VALID_TEAM = '00000000-0000-4000-8000-00000000aaaa';
    const VALID_SLA = '00000000-0000-4000-8000-00000000bbbb';
    const { supabase, updateCalls } = makeUpdateDeps({
      teams: [{ id: VALID_TEAM, tenant_id: 't1' }],
      sla_policies: [{ id: VALID_SLA, tenant_id: 't1' }],
    });
    const engine = new WorkflowEngineService(supabase as never, { dispatch: jest.fn() } as never);
    jest.spyOn(engine as never, 'advance').mockResolvedValue(undefined as never);
    jest.spyOn(engine as never, 'emit').mockResolvedValue(undefined as never);

    const node = {
      id: 'n1',
      type: 'update_ticket',
      config: {
        fields: {
          assigned_team_id: VALID_TEAM,
          sla_id: VALID_SLA,
          priority: 'high',
          status_category: 'assigned',
        },
      },
    };

    await (engine as unknown as {
      executeNode: (i: string, g: unknown, n: unknown, t: string, c: unknown) => Promise<void>;
    }).executeNode('inst-1', { nodes: [], edges: [] }, node, 'ticket-1', undefined);

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].patch).toMatchObject({
      assigned_team_id: VALID_TEAM,
      sla_id: VALID_SLA,
      priority: 'high',
      status_category: 'assigned',
    });
    expect(updateCalls[0].filters).toMatchObject({ id: 'ticket-1', tenant_id: 't1' });
  });

  it('allows null FK clearing (assigned_team_id: null) without tenant lookup', async () => {
    const { supabase, updateCalls } = makeUpdateDeps({});
    const engine = new WorkflowEngineService(supabase as never, { dispatch: jest.fn() } as never);
    jest.spyOn(engine as never, 'advance').mockResolvedValue(undefined as never);
    jest.spyOn(engine as never, 'emit').mockResolvedValue(undefined as never);

    const node = {
      id: 'n1',
      type: 'update_ticket',
      config: { fields: { assigned_team_id: null } },
    };

    await (engine as unknown as {
      executeNode: (i: string, g: unknown, n: unknown, t: string, c: unknown) => Promise<void>;
    }).executeNode('inst-1', { nodes: [], edges: [] }, node, 'ticket-1', undefined);

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].patch).toEqual({ assigned_team_id: null });
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

    const svc = new WorkflowEngineService(supabase as never, {} as never);
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

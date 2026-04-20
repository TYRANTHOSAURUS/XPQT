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

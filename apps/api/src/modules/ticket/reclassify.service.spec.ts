import { ReclassifyService } from './reclassify.service';
import { TenantContext } from '../../common/tenant-context';

/**
 * Thin in-memory supabase mock tailored for reclassify tests. The
 * ReclassifyService uses .from(table).select(...).eq(...).maybeSingle() and
 * .from(table).select(...).in(...) shapes; this stub honours the ones it hits.
 */
function makeSupabase(tables: Record<string, unknown[]>) {
  const captured = {
    rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
    updates: [] as Array<{ table: string; patch: Record<string, unknown>; filters: Record<string, unknown> }>,
  };

  function selectQuery(rows: Record<string, unknown>[]) {
    const filters: Record<string, unknown> = {};
    const api: Record<string, unknown> = {
      eq: (col: string, val: unknown) => { filters[col] = val; return api; },
      in: (col: string, vals: unknown[]) => { filters[col] = vals; return api; },
      is: (col: string, val: unknown) => { filters[col] = val; return api; },
      limit: (_: number) => api,
      order: () => api,
      maybeSingle: async () => {
        const match = rows.find((r) =>
          Object.entries(filters).every(([k, v]) =>
            Array.isArray(v) ? (v as unknown[]).includes(r[k]) : r[k] === v || v === null,
          ),
        );
        return { data: match ?? null, error: null };
      },
      single: async () => {
        const match = rows.find((r) =>
          Object.entries(filters).every(([k, v]) => r[k] === v),
        );
        return match ? { data: match, error: null } : { data: null, error: { message: 'not found' } };
      },
      then: async (resolve: (v: unknown) => void) => {
        const matches = rows.filter((r) =>
          Object.entries(filters).every(([k, v]) =>
            Array.isArray(v) ? (v as unknown[]).includes(r[k]) : r[k] === v || v === null,
          ),
        );
        resolve({ data: matches, error: null });
      },
    };
    return api;
  }

  const supabase = {
    admin: {
      from: (table: string) => ({
        select: (_cols: string) => selectQuery((tables[table] as Record<string, unknown>[]) ?? []),
        update: (patch: Record<string, unknown>) => {
          const filters: Record<string, unknown> = {};
          const updateApi: Record<string, unknown> = {
            eq: (col: string, val: unknown) => { filters[col] = val; return updateApi; },
            is: (col: string, val: unknown) => { filters[col] = val; return updateApi; },
            in: (col: string, vals: unknown[]) => { filters[col] = vals; return updateApi; },
            select: () => ({
              single: async () => ({ data: null, error: null }),
            }),
            then: async (resolve: (v: unknown) => void) => {
              captured.updates.push({ table, patch, filters });
              resolve({ data: null, error: null });
            },
          };
          return updateApi;
        },
        insert: (_row: Record<string, unknown>) => ({
          select: () => ({ single: async () => ({ data: null, error: null }) }),
          then: async (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
        }),
      }),
      rpc: async (name: string, args: Record<string, unknown>) => {
        captured.rpcCalls.push({ name, args });
        // Default RPC response shape — B.2.A.Step11 reclassify_ticket
        // returns { ticket, follow_ups, concurrent_override_edit }. Tests
        // that need a specific shape override on individual calls.
        if (name === 'reclassify_ticket') {
          return {
            data: {
              ticket: { id: 'tk1', ticket_type_id: 'rt-new' },
              follow_ups: ['routing.evaluation_required'],
              concurrent_override_edit: false,
            },
            error: null,
          };
        }
        return { data: null, error: null };
      },
    },
  };

  return { supabase, captured };
}

describe('ReclassifyService.computeImpact', () => {
  beforeEach(() => {
    jest.spyOn(TenantContext, 'current').mockReturnValue({ id: 'ten1', subdomain: 'ten1' } as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function makeService(overrides: {
    ticket?: Record<string, unknown>;
    types?: Record<string, unknown>[];
    children?: Record<string, unknown>[];
    timers?: Record<string, unknown>[];
    workflowInstance?: Record<string, unknown>;
    policies?: Record<string, unknown>[];
    evaluation?: Record<string, unknown>;
  }) {
    const ticket = {
      id: 'tk1',
      tenant_id: 'ten1',
      ticket_type_id: 'rt-old',
      ticket_kind: 'case',
      status_category: 'assigned',
      assigned_team_id: 'team-old',
      assigned_user_id: 'user-old',
      assigned_vendor_id: null,
      location_id: 'loc1',
      asset_id: null,
      priority: 'medium',
      watchers: [],
      ...overrides.ticket,
    };

    const types = overrides.types ?? [
      { id: 'rt-old', tenant_id: 'ten1', name: 'HVAC', domain: 'fm', active: true, sla_policy_id: 'sp-old', workflow_definition_id: 'wd-old' },
      { id: 'rt-new', tenant_id: 'ten1', name: 'Plumbing', domain: 'fm', active: true, sla_policy_id: 'sp-new', workflow_definition_id: 'wd-new' },
    ];

    const { supabase, captured } = makeSupabase({
      tickets: [ticket, ...(overrides.children ?? [])],
      request_types: types,
      workflow_instances: overrides.workflowInstance ? [overrides.workflowInstance] : [],
      workflow_definitions: [
        { id: 'wd-old', tenant_id: 'ten1', name: 'HVAC v2' },
        { id: 'wd-new', tenant_id: 'ten1', name: 'Plumbing Standard' },
      ],
      sla_timers: overrides.timers ?? [],
      sla_policies: overrides.policies ?? [
        { id: 'sp-new', tenant_id: 'ten1', name: 'Plumbing Policy', response_time_minutes: 30, resolution_time_minutes: 240 },
      ],
      teams: [
        { id: 'team-old', tenant_id: 'ten1', name: 'HVAC Team' },
        { id: 'team-new', tenant_id: 'ten1', name: 'Plumbing Team' },
      ],
      users: [
        { id: 'user-old', tenant_id: 'ten1', email: 'john@example.com', auth_uid: 'auth-1' },
      ],
      vendors: [],
    });

    const routing = {
      evaluate: jest.fn(async () =>
        overrides.evaluation ?? {
          target: { kind: 'team', team_id: 'team-new' },
          chosen_by: 'rule',
          rule_id: 'r1',
          rule_name: 'plumbing-default',
          strategy: 'rule',
          trace: [],
        },
      ),
      recordDecision: jest.fn(async () => undefined),
    };
    const sla = { startTimers: jest.fn(async () => undefined), stopTimers: jest.fn(async () => undefined) };
    const workflow = { startForTicket: jest.fn(async () => undefined), cancelInstanceForTicket: jest.fn(async () => []) };
    const visibility = { loadContext: jest.fn(async () => ({} as never)), assertVisible: jest.fn(async () => undefined) };
    const tickets = { getById: jest.fn(async () => ({ id: 'tk1', ticket_type_id: 'rt-new' })) };

    const scopeOverrideResolver = {
      deriveEffectiveLocation: jest.fn(async () => null),
      resolveForLocation: jest.fn(async () => null),
      resolve: jest.fn(async () => null),
    };
    const service = new ReclassifyService(
      supabase as never,
      tickets as never,
      routing as never,
      sla as never,
      workflow as never,
      visibility as never,
      scopeOverrideResolver as never,
    );

    return { service, captured, routing, sla, workflow, tickets, visibility, scopeOverrideResolver };
  }

  it('returns an impact DTO for a typical reclassify', async () => {
    const { service } = makeService({
      children: [
        { id: 'c1', tenant_id: 'ten1', parent_ticket_id: 'tk1', title: 'Replace compressor', status_category: 'in_progress', assigned_user_id: null, assigned_team_id: null, assigned_vendor_id: null },
        { id: 'c2', tenant_id: 'ten1', parent_ticket_id: 'tk1', title: 'Inspect unit', status_category: 'assigned', assigned_user_id: null, assigned_team_id: null, assigned_vendor_id: null },
      ],
      timers: [
        { id: 'tm1', tenant_id: 'ten1', ticket_id: 'tk1', timer_type: 'response', target_minutes: 30, started_at: new Date(Date.now() - 60_000).toISOString(), stopped_at: null, completed_at: null },
      ],
      workflowInstance: { id: 'wi1', tenant_id: 'ten1', ticket_id: 'tk1', status: 'active', current_node_id: 'triage', workflow_definitions: { name: 'HVAC v2' } },
    });

    const impact = await service.computeImpact('tk1', 'rt-new', '__system__');

    expect(impact.ticket.new_request_type.name).toBe('Plumbing');
    expect(impact.workflow.will_be_cancelled).toBe(true);
    expect(impact.workflow.new_definition?.name).toBe('Plumbing Standard');
    expect(impact.children).toHaveLength(2);
    expect(impact.children[0].is_in_progress).toBe(true);
    expect(impact.sla.active_timers).toHaveLength(1);
    expect(impact.sla.new_policy?.metrics).toEqual([
      { name: 'response', target_minutes: 30 },
      { name: 'resolution', target_minutes: 240 },
    ]);
    expect(impact.routing.new_decision.team?.id).toBe('team-new');
    expect(impact.routing.current_user_will_become_watcher).toBe(true);
  });

  // Step 1c.10c: tickets is case-only post-cutover. loadTicket synthesizes
  // ticket_kind='case' unconditionally — work_orders are in a separate
  // table and aren't loadable via reclassify.service.loadTicket.
  it.skip('OBSOLETE post-1c.10c: throws when ticket is a child work order', () => {});

  it('throws when ticket is closed', async () => {
    const { service } = makeService({ ticket: { status_category: 'closed' } });
    await expect(service.computeImpact('tk1', 'rt-new', '__system__')).rejects.toThrow(/closed or resolved/i);
  });

  it('throws when new type equals current', async () => {
    const { service } = makeService({ ticket: { ticket_type_id: 'rt-new' } });
    await expect(service.computeImpact('tk1', 'rt-new', '__system__')).rejects.toThrow(/same as current/i);
  });

  it('throws when new type is inactive', async () => {
    const { service } = makeService({
      types: [
        { id: 'rt-old', tenant_id: 'ten1', name: 'HVAC', domain: 'fm', active: true, sla_policy_id: null, workflow_definition_id: null },
        { id: 'rt-new', tenant_id: 'ten1', name: 'Plumbing', domain: 'fm', active: false, sla_policy_id: null, workflow_definition_id: null },
      ],
    });
    await expect(service.computeImpact('tk1', 'rt-new', '__system__')).rejects.toThrow(/not active/i);
  });
});

describe('ReclassifyService.execute', () => {
  beforeEach(() => {
    jest.spyOn(TenantContext, 'current').mockReturnValue({ id: 'ten1', subdomain: 'ten1' } as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function harness() {
    const ticket = {
      id: 'tk1', tenant_id: 'ten1', ticket_type_id: 'rt-old', ticket_kind: 'case',
      status_category: 'assigned', assigned_team_id: 'team-old', assigned_user_id: null,
      assigned_vendor_id: null, location_id: null, asset_id: null, priority: 'medium', watchers: [],
    };
    const { supabase, captured } = makeSupabase({
      tickets: [ticket],
      request_types: [
        { id: 'rt-old', tenant_id: 'ten1', name: 'HVAC', domain: 'fm', active: true, sla_policy_id: null, workflow_definition_id: null },
        { id: 'rt-new', tenant_id: 'ten1', name: 'Plumbing', domain: 'fm', active: true, sla_policy_id: 'sp-new', workflow_definition_id: 'wd-new' },
      ],
      workflow_instances: [],
      workflow_definitions: [{ id: 'wd-new', tenant_id: 'ten1', name: 'Plumbing Standard' }],
      sla_timers: [],
      sla_policies: [{ id: 'sp-new', tenant_id: 'ten1', name: 'Plumbing Policy', response_time_minutes: 30, resolution_time_minutes: 240 }],
      teams: [{ id: 'team-new', tenant_id: 'ten1', name: 'Plumbing Team' }],
      users: [{ id: 'actor-user-id', tenant_id: 'ten1', auth_uid: 'auth-1', email: 'agent@example.com' }],
      vendors: [],
    });

    const routing = {
      evaluate: jest.fn(async () => ({
        target: { kind: 'team', team_id: 'team-new' },
        chosen_by: 'rule', rule_id: 'r1', rule_name: 'plumbing', strategy: 'rule', trace: [],
      })),
      recordDecision: jest.fn(async () => undefined),
    };
    const sla = { startTimers: jest.fn(async () => undefined) };
    const workflow = { startForTicket: jest.fn(async () => undefined) };
    const visibility = { loadContext: jest.fn(async () => ({} as never)), assertVisible: jest.fn(async () => undefined) };
    // Tickets.getById returns the enriched read shape post-RPC. Mock returns
    // the reclassified ticket so the wrapper's spread carries follow_ups +
    // concurrent_override_edit alongside the ticket payload.
    const tickets = { getById: jest.fn(async () => ({ id: 'tk1', ticket_type_id: 'rt-new' })) };

    const scopeOverrideResolver = {
      deriveEffectiveLocation: jest.fn(async () => null),
      resolveForLocation: jest.fn(async () => null),
      resolve: jest.fn(async () => null),
    };

    const service = new ReclassifyService(
      supabase as never,
      tickets as never,
      routing as never,
      sla as never,
      workflow as never,
      visibility as never,
      scopeOverrideResolver as never,
    );

    return { service, captured, routing, sla, workflow, visibility, tickets, scopeOverrideResolver };
  }

  it('calls reclassify_ticket RPC with payload + automation_plan + idempotency_key (auth_uid passed through)', async () => {
    const { service, captured, tickets } = harness();

    const result = await service.execute(
      'tk1',
      { newRequestTypeId: 'rt-new', reason: 'actually plumbing' },
      'auth-1',
      'crid-xyz', // B.2.A.Step11 client_request_id required
    );

    expect(captured.rpcCalls).toHaveLength(1);
    const args = captured.rpcCalls[0].args as Record<string, unknown>;
    expect(captured.rpcCalls[0].name).toBe('reclassify_ticket');
    expect(args.p_ticket_id).toBe('tk1');
    expect(args.p_tenant_id).toBe('ten1');
    // Service passes auth_uid through — RPC resolves to users.id internally
    // (F-CRIT-1 pattern from 00351).
    expect(args.p_actor_user_id).toBe('auth-1');
    expect(args.p_idempotency_key).toBe('reclassify:tk1:crid-xyz');
    expect(args.p_payload).toEqual({
      new_request_type_id: 'rt-new',
      reason: 'actually plumbing',
    });
    const plan = args.p_automation_plan as Record<string, unknown>;
    expect(plan).toEqual(
      expect.objectContaining({
        effective_location_id: null,
        scope_override_id: null,
        effective_workflow_definition_id: 'wd-new',
        effective_sla_policy_id: 'sp-new',
      }),
    );
    expect(plan._resolution_at).toEqual(expect.any(String));

    expect(tickets.getById).toHaveBeenCalledWith('tk1', expect.any(String));
    // result spreads the enriched ticket + follow_ups + concurrent_override_edit.
    expect(result).toEqual(
      expect.objectContaining({
        id: 'tk1',
        ticket_type_id: 'rt-new',
        follow_ups: expect.any(Array),
        concurrent_override_edit: expect.any(Boolean),
      }),
    );
  });

  it('does NOT call TS-side slaService.startTimers / workflowEngine.startForTicket / routingService.recordDecision (handlers own those)', async () => {
    const { service, sla, workflow, routing } = harness();

    await service.execute(
      'tk1',
      { newRequestTypeId: 'rt-new', reason: 'legit reason' },
      'auth-1',
      'crid-1',
    );

    // Post-Step 11: these execution paths live in the outbox handlers
    // (SlaTimerRepointHandler / WorkflowStartHandler / RoutingEvaluationHandler).
    // The service must NOT also fire them — would double-emit.
    expect(sla.startTimers).not.toHaveBeenCalled();
    expect(workflow.startForTicket).not.toHaveBeenCalled();
    expect(routing.recordDecision).not.toHaveBeenCalled();
  });

  it('rejects when reason is too short', async () => {
    const { service } = harness();
    await expect(service.execute('tk1', { newRequestTypeId: 'rt-new', reason: 'x' }, 'auth-1', 'crid-1'))
      .rejects.toThrow(/at least 3/i);
  });

  it('rejects when reason is too long', async () => {
    const { service } = harness();
    await expect(service.execute('tk1', { newRequestTypeId: 'rt-new', reason: 'x'.repeat(501) }, 'auth-1', 'crid-1'))
      .rejects.toThrow(/at most 500/i);
  });

  it('rejects when clientRequestId is missing (required by §3.0 / §3.10 RPC contract)', async () => {
    const { service } = harness();
    await expect(
      service.execute('tk1', { newRequestTypeId: 'rt-new', reason: 'legitimate reason' }, 'auth-1'),
    ).rejects.toThrow(/client_request_id/);
  });

  it('enforces visibility', async () => {
    const { service, visibility } = harness();
    (visibility.assertVisible as jest.Mock).mockRejectedValueOnce(new Error('denied'));
    await expect(service.execute('tk1', { newRequestTypeId: 'rt-new', reason: 'legitimate reason' }, 'auth-1', 'crid-1'))
      .rejects.toThrow('denied');
  });
});

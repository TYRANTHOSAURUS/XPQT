import { DispatchService, DispatchDto } from './dispatch.service';

type ParentRow = {
  id: string;
  tenant_id: string;
  ticket_type_id: string | null;
  location_id: string | null;
  asset_id: string | null;
  priority: string;
  title: string;
  ticket_kind: string;
  status_category: string;
  requester_person_id: string | null;
};

function makeParent(over: Partial<ParentRow> = {}): ParentRow {
  return {
    id: 'parent-1',
    tenant_id: 't1',
    ticket_type_id: 'rt-1',
    location_id: 'loc-1',
    asset_id: null,
    priority: 'medium',
    title: 'Broken window',
    ticket_kind: 'case',
    status_category: 'assigned',
    requester_person_id: 'person-1',
    ...over,
  };
}

function makeDeps(
  parent: ParentRow,
  defaults: {
    vendors?: Record<string, { default_sla_policy_id: string | null }>;
    teams?: Record<string, { default_sla_policy_id: string | null }>;
    users?: Record<string, { team_id: string | null }>;
  } = {},
) {
  const inserted: Array<Record<string, unknown>> = [];
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const activities: Array<Record<string, unknown>> = [];

  const ticketService = {
    getById: jest.fn(async (_id: string) => parent),
    addActivity: jest.fn(async (_id: string, act: Record<string, unknown>) => {
      activities.push(act);
    }),
  };

  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        if (table === 'tickets') {
          return {
            insert: (row: Record<string, unknown>) => {
              inserted.push(row);
              return {
                select: () => ({
                  single: async () => ({ data: { ...row, id: `child-${inserted.length}` }, error: null }),
                }),
              };
            },
            update: (patch: Record<string, unknown>) => ({
              eq: (_col: string, id: string) => {
                updates.push({ id, patch });
                return { select: () => ({ single: async () => ({ data: patch, error: null }) }) };
              },
            }),
          } as unknown;
        }
        if (table === 'request_types') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { domain: 'fm', sla_policy_id: 'sla-1' }, error: null }),
              }),
            }),
          } as unknown;
        }
        if (table === 'vendors') {
          return {
            select: () => ({
              eq: (_col: string, id: string) => ({
                maybeSingle: async () => ({ data: defaults.vendors?.[id] ?? null, error: null }),
              }),
            }),
          } as unknown;
        }
        if (table === 'teams') {
          return {
            select: () => ({
              eq: (_col: string, id: string) => ({
                maybeSingle: async () => ({ data: defaults.teams?.[id] ?? null, error: null }),
              }),
            }),
          } as unknown;
        }
        if (table === 'users') {
          return {
            select: () => ({
              eq: (_col: string, id: string) => ({
                maybeSingle: async () => ({ data: defaults.users?.[id] ?? null, error: null }),
              }),
            }),
          } as unknown;
        }
        return {} as unknown;
      }),
    },
  };

  const routingService = {
    evaluate: jest.fn().mockResolvedValue({
      target: { kind: 'vendor', vendor_id: 'vendor-X' },
      chosen_by: 'request_type_default',
      rule_id: null, rule_name: null, strategy: 'fixed', trace: [],
    }),
    recordDecision: jest.fn().mockResolvedValue(undefined),
  };

  const slaService = { startTimers: jest.fn().mockResolvedValue(undefined) };

  return { ticketService, supabase, routingService, slaService, inserted, updates, activities };
}

describe('DispatchService', () => {
  const tenantCtx = { id: 't1', subdomain: 't1' };
  beforeEach(() => {
    jest.spyOn(
      require('../../common/tenant-context').TenantContext,
      'current',
    ).mockReturnValue(tenantCtx);
  });

  it('creates a child work_order with parent context copied', async () => {
    const parent = makeParent();
    const { ticketService, supabase, routingService, slaService, inserted } = makeDeps(parent);
    const svc = new DispatchService(
      supabase as never,
      ticketService as never,
      routingService as never,
      slaService as never,
    );
    const dto: DispatchDto = { title: 'Install replacement glass', assigned_vendor_id: 'vendor-X' };
    const child = await svc.dispatch(parent.id, dto);

    expect(child.parent_ticket_id).toBe(parent.id);
    expect(child.ticket_kind).toBe('work_order');
    expect(inserted[0].location_id).toBe(parent.location_id);
    expect(inserted[0].ticket_type_id).toBe(parent.ticket_type_id);
    expect(inserted[0].priority).toBe(parent.priority);
    expect(inserted[0].assigned_vendor_id).toBe('vendor-X');
    expect(slaService.startTimers).not.toHaveBeenCalled();
  });

  it('runs resolver when no assignee given in DTO', async () => {
    const parent = makeParent();
    const { ticketService, supabase, routingService, slaService, inserted } = makeDeps(parent);
    const svc = new DispatchService(
      supabase as never,
      ticketService as never,
      routingService as never,
      slaService as never,
    );
    await svc.dispatch(parent.id, { title: 'Investigate' });
    expect(routingService.evaluate).toHaveBeenCalled();
    expect(inserted[0].assigned_vendor_id).toBe('vendor-X');
  });

  it('rejects dispatch on a ticket that is already a work_order', async () => {
    const parent = makeParent({ ticket_kind: 'work_order' });
    const deps = makeDeps(parent);
    const svc = new DispatchService(
      deps.supabase as never,
      deps.ticketService as never,
      deps.routingService as never,
      deps.slaService as never,
    );
    await expect(svc.dispatch(parent.id, { title: 'x' })).rejects.toThrow(/work_order/);
  });

  it('rejects dispatch on a ticket in pending_approval status', async () => {
    const parent = makeParent({ ticket_kind: 'case' });
    (parent as unknown as { status_category: string }).status_category = 'pending_approval';
    const deps = makeDeps(parent);
    const svc = new DispatchService(
      deps.supabase as never,
      deps.ticketService as never,
      deps.routingService as never,
      deps.slaService as never,
    );
    await expect(svc.dispatch(parent.id, { title: 'x' })).rejects.toThrow(/pending approval/);
  });

  it('supports multiple children on one parent (broken-window scenario)', async () => {
    const parent = makeParent({ title: 'Broken window in Building A' });
    const { ticketService, supabase, routingService, slaService, inserted } = makeDeps(parent);
    const svc = new DispatchService(
      supabase as never,
      ticketService as never,
      routingService as never,
      slaService as never,
    );
    await svc.dispatch(parent.id, { title: 'Replace window pane', assigned_vendor_id: 'glazier' });
    await svc.dispatch(parent.id, { title: 'Buy replacement glass', assigned_vendor_id: 'supplier' });
    await svc.dispatch(parent.id, { title: 'Clean up debris', assigned_vendor_id: 'janitorial' });
    expect(inserted).toHaveLength(3);
    expect(inserted.map((c) => c.assigned_vendor_id)).toEqual(['glazier', 'supplier', 'janitorial']);
    expect(inserted.every((c) => c.parent_ticket_id === parent.id)).toBe(true);
    expect(inserted.every((c) => c.ticket_kind === 'work_order')).toBe(true);
  });

  it('does NOT inherit sla_id from request_type (parent-vs-child SLA separation)', async () => {
    const parent = makeParent();
    const { ticketService, supabase, routingService, slaService, inserted } = makeDeps(parent);
    const svc = new DispatchService(
      supabase as never,
      ticketService as never,
      routingService as never,
      slaService as never,
    );
    // request_types mock returns sla_policy_id: 'sla-1' — that's the parent's desk SLA.
    // Child must NOT pick it up unless explicitly passed in DTO.
    await svc.dispatch(parent.id, { title: 'anything', assigned_vendor_id: 'v1' });
    expect(inserted[0].sla_id).toBeNull();
    expect(slaService.startTimers).not.toHaveBeenCalled();
  });

  // Fix 5 / new test: empty title must be rejected
  it('rejects an empty title', async () => {
    const parent = makeParent();
    const deps = makeDeps(parent);
    const svc = new DispatchService(
      deps.supabase as never,
      deps.ticketService as never,
      deps.routingService as never,
      deps.slaService as never,
    );
    await expect(svc.dispatch(parent.id, { title: '   ' })).rejects.toThrow(/title/);
  });

  it('uses dto.sla_id when provided explicitly', async () => {
    const parent = makeParent();
    const { ticketService, supabase, routingService, slaService, inserted } = makeDeps(parent);
    const svc = new DispatchService(
      supabase as never,
      ticketService as never,
      routingService as never,
      slaService as never,
    );
    await svc.dispatch(parent.id, { title: 'x', assigned_team_id: 't1', sla_id: 'sla-explicit' });
    expect(inserted[0].sla_id).toBe('sla-explicit');
    expect(slaService.startTimers).toHaveBeenCalledWith(expect.any(String), 't1', 'sla-explicit');
  });

  it('treats dto.sla_id === null as explicit "No SLA"', async () => {
    const parent = makeParent();
    const { ticketService, supabase, routingService, slaService, inserted } = makeDeps(parent, {
      vendors: { 'v1': { default_sla_policy_id: 'sla-vendor' } }, // would otherwise apply
    });
    const svc = new DispatchService(
      supabase as never,
      ticketService as never,
      routingService as never,
      slaService as never,
    );
    await svc.dispatch(parent.id, { title: 'x', assigned_vendor_id: 'v1', sla_id: null });
    expect(inserted[0].sla_id).toBeNull();
    expect(slaService.startTimers).not.toHaveBeenCalled();
  });

  it('falls back to vendor default_sla_policy_id', async () => {
    const parent = makeParent();
    const { ticketService, supabase, routingService, slaService, inserted } = makeDeps(parent, {
      vendors: { 'v1': { default_sla_policy_id: 'sla-vendor' } },
    });
    const svc = new DispatchService(
      supabase as never,
      ticketService as never,
      routingService as never,
      slaService as never,
    );
    await svc.dispatch(parent.id, { title: 'x', assigned_vendor_id: 'v1' });
    expect(inserted[0].sla_id).toBe('sla-vendor');
    expect(slaService.startTimers).toHaveBeenCalledWith(expect.any(String), 't1', 'sla-vendor');
  });

  it('falls back to team default_sla_policy_id when no vendor', async () => {
    const parent = makeParent();
    const { ticketService, supabase, routingService, slaService, inserted } = makeDeps(parent, {
      teams: { 't1': { default_sla_policy_id: 'sla-team' } },
    });
    const svc = new DispatchService(
      supabase as never,
      ticketService as never,
      routingService as never,
      slaService as never,
    );
    // override routing so no vendor is assigned
    routingService.evaluate.mockResolvedValueOnce({
      target: { kind: 'team', team_id: 't1' },
      chosen_by: 'request_type_default', rule_id: null, rule_name: null, strategy: 'fixed', trace: [],
    });
    await svc.dispatch(parent.id, { title: 'x' });
    expect(inserted[0].sla_id).toBe('sla-team');
    expect(slaService.startTimers).toHaveBeenCalledWith(expect.any(String), 't1', 'sla-team');
  });

  it('vendor default beats team default when both assignees set', async () => {
    const parent = makeParent();
    const { ticketService, supabase, routingService, slaService, inserted } = makeDeps(parent, {
      vendors: { 'v1': { default_sla_policy_id: 'sla-vendor' } },
      teams: { 't1': { default_sla_policy_id: 'sla-team' } },
    });
    const svc = new DispatchService(
      supabase as never,
      ticketService as never,
      routingService as never,
      slaService as never,
    );
    await svc.dispatch(parent.id, { title: 'x', assigned_team_id: 't1', assigned_vendor_id: 'v1' });
    expect(inserted[0].sla_id).toBe('sla-vendor');
  });

  it('falls back through user → user.team → team default', async () => {
    const parent = makeParent();
    const { ticketService, supabase, routingService, slaService, inserted } = makeDeps(parent, {
      users: { 'u1': { team_id: 'tA' } },
      teams: { 'tA': { default_sla_policy_id: 'sla-userteam' } },
    });
    const svc = new DispatchService(
      supabase as never,
      ticketService as never,
      routingService as never,
      slaService as never,
    );
    await svc.dispatch(parent.id, { title: 'x', assigned_user_id: 'u1' });
    expect(inserted[0].sla_id).toBe('sla-userteam');
  });

  it('resolves to null sla_id when no defaults available', async () => {
    const parent = makeParent();
    const { ticketService, supabase, routingService, slaService, inserted } = makeDeps(parent);
    const svc = new DispatchService(
      supabase as never,
      ticketService as never,
      routingService as never,
      slaService as never,
    );
    routingService.evaluate.mockResolvedValueOnce({
      target: { kind: 'team', team_id: 't1' },
      chosen_by: 'request_type_default', rule_id: null, rule_name: null, strategy: 'fixed', trace: [],
    });
    await svc.dispatch(parent.id, { title: 'x' });
    expect(inserted[0].sla_id).toBeNull();
    expect(slaService.startTimers).not.toHaveBeenCalled();
  });
});

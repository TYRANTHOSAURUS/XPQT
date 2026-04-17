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
    requester_person_id: 'person-1',
    ...over,
  };
}

function makeDeps(parent: ParentRow) {
  const inserted: Array<Record<string, unknown>> = [];
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
            update: (_row: Record<string, unknown>) => ({
              eq: () => ({ error: null }),
            }),
          } as unknown;
        }
        if (table === 'request_types') {
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({ data: { domain: 'fm', sla_policy_id: 'sla-1' }, error: null }),
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

  return { ticketService, supabase, routingService, slaService, inserted, activities };
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
    expect(slaService.startTimers).toHaveBeenCalledWith(expect.any(String), 't1', 'sla-1');
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
});

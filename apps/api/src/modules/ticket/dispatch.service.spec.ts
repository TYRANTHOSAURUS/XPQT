import { DispatchService, DispatchDto } from './dispatch.service';

// Plan A.4 / Commit 2 (C1) — system actor now validates DTO-sourced FK refs.
// Pre-A.4 these tests passed short string ids (e.g. 'v1', 't1', 'sla-explicit')
// because the bypass let them through. Post-A.4 the validator runs and rejects
// non-uuid strings with reference.invalid_uuid. Convert short ids to real
// uuids via this helper, and the supabase mock (`makeDeps`) now seeds matching
// tenant-owned rows so the validators pass and the SLA-fallback paths can
// continue to look up by the same uuid.
const UUID_PREFIX = '00000000-0000-4000-8000-';
function uuidFor(short: string): string {
  // Hex-encode the short id into the last 12 chars — deterministic + unique
  // per short id, valid v4-uuid shape so UUID_RE.test passes.
  const hex = Buffer.from(short).toString('hex').slice(0, 12).padEnd(12, '0');
  return UUID_PREFIX + hex;
}
const UUID = {
  parent: uuidFor('parent1'),
  rt: uuidFor('rt1'),
  loc: uuidFor('loc1'),
  person: uuidFor('person1'),
  vendorX: uuidFor('vendorX'),
  glazier: uuidFor('glazier'),
  supplier: uuidFor('supplier'),
  janitorial: uuidFor('janit'),
  v1: uuidFor('v1'),
  t1: uuidFor('t1'),
  tA: uuidFor('tA'),
  u1: uuidFor('u1'),
  slaExplicit: uuidFor('slaExpl'),
  slaVendor: uuidFor('slaVend'),
  slaTeam: uuidFor('slaTeam'),
  slaUserteam: uuidFor('slaUtm'),
  sla1: uuidFor('sla1'),
};

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
    id: UUID.parent,
    tenant_id: 't1',
    ticket_type_id: UUID.rt,
    location_id: UUID.loc,
    asset_id: null,
    priority: 'medium',
    title: 'Broken window',
    ticket_kind: 'case',
    status_category: 'assigned',
    requester_person_id: UUID.person,
    ...over,
  };
}

function makeDeps(
  parent: ParentRow,
  defaults: {
    vendors?: Record<string, { default_sla_policy_id: string | null }>;
    teams?: Record<string, { default_sla_policy_id: string | null }>;
    users?: Record<string, { team_id: string | null }>;
    // Plan A.4 / Commit 2 — list of uuids that should pass assertTenantOwned
    // for any table the validators touch (request_types / sla_policies /
    // assets / spaces). Default seeds every UUID.* used by these tests.
    knownTenantOwned?: Set<string>;
  } = {},
) {
  const knownIds =
    defaults.knownTenantOwned ??
    new Set([
      UUID.rt,
      UUID.loc,
      UUID.vendorX,
      UUID.glazier,
      UUID.supplier,
      UUID.janitorial,
      UUID.v1,
      UUID.t1,
      UUID.tA,
      UUID.u1,
      UUID.slaExplicit,
      UUID.slaVendor,
      UUID.slaTeam,
      UUID.slaUserteam,
      UUID.sla1,
    ]);
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
        // Step 1c.4 cutover: dispatch now writes to work_orders directly.
        // 'tickets' branch retained for any UPDATE paths still hitting tickets.
        if (table === 'work_orders' || table === 'tickets') {
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
          // Plan A.2: loadRequestTypeConfig now chains .eq('id').eq('tenant_id').
          // Mock supports both single-eq and double-eq call shapes for forward compat.
          const single = { data: { domain: 'fm', sla_policy_id: 'sla-1' }, error: null };
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => single,
                }),
                maybeSingle: async () => single,
              }),
            }),
          } as unknown;
        }
        if (table === 'vendors') {
          return {
            select: (cols: string) => ({
              eq: (_col: string, id: string) => ({
                eq: () => ({
                  maybeSingle: async () => {
                    // assertTenantOwned validator shape: select('id') only.
                    if (cols === 'id') {
                      return {
                        data: knownIds.has(id) ? { id } : null,
                        error: null,
                      };
                    }
                    return { data: defaults.vendors?.[id] ?? null, error: null };
                  },
                }),
                maybeSingle: async () => {
                  if (cols === 'id') {
                    return { data: knownIds.has(id) ? { id } : null, error: null };
                  }
                  return { data: defaults.vendors?.[id] ?? null, error: null };
                },
              }),
            }),
          } as unknown;
        }
        if (table === 'teams') {
          return {
            select: (cols: string) => ({
              eq: (_col: string, id: string) => ({
                eq: () => ({
                  maybeSingle: async () => {
                    if (cols === 'id') {
                      return { data: knownIds.has(id) ? { id } : null, error: null };
                    }
                    return { data: defaults.teams?.[id] ?? null, error: null };
                  },
                }),
                maybeSingle: async () => {
                  if (cols === 'id') {
                    return { data: knownIds.has(id) ? { id } : null, error: null };
                  }
                  return { data: defaults.teams?.[id] ?? null, error: null };
                },
              }),
            }),
          } as unknown;
        }
        if (table === 'users') {
          return {
            select: (cols: string) => ({
              eq: (_col: string, id: string) => ({
                eq: () => ({
                  maybeSingle: async () => {
                    if (cols === 'id') {
                      return { data: knownIds.has(id) ? { id } : null, error: null };
                    }
                    return { data: defaults.users?.[id] ?? null, error: null };
                  },
                }),
                maybeSingle: async () => {
                  if (cols === 'id') {
                    return { data: knownIds.has(id) ? { id } : null, error: null };
                  }
                  return { data: defaults.users?.[id] ?? null, error: null };
                },
              }),
            }),
          } as unknown;
        }
        // Plan A.4 / Commit 2 — generic validator-shape branch. The
        // validator path queries any of: sla_policies / spaces / assets /
        // request_types via assertTenantOwned. Matches `select('id')`
        // followed by .eq().eq().maybeSingle() and returns the row only
        // if the uuid is in knownIds.
        if (
          table === 'sla_policies' ||
          table === 'spaces' ||
          table === 'assets'
        ) {
          return {
            select: (cols: string) => ({
              eq: (_col: string, id: string) => ({
                eq: () => ({
                  maybeSingle: async () => {
                    if (cols === 'id') {
                      return { data: knownIds.has(id) ? { id } : null, error: null };
                    }
                    return { data: null, error: null };
                  },
                }),
                maybeSingle: async () => {
                  if (cols === 'id') {
                    return { data: knownIds.has(id) ? { id } : null, error: null };
                  }
                  return { data: null, error: null };
                },
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
      target: { kind: 'vendor', vendor_id: UUID.vendorX },
      chosen_by: 'request_type_default',
      rule_id: null, rule_name: null, strategy: 'fixed', trace: [],
    }),
    recordDecision: jest.fn().mockResolvedValue(undefined),
  };

  const slaService = { startTimers: jest.fn().mockResolvedValue(undefined) };

  const visibilityService = {
    loadContext: jest.fn().mockResolvedValue({}),
    assertVisible: jest.fn().mockResolvedValue(undefined),
  };

  const scopeOverrides = { resolve: jest.fn().mockResolvedValue(null), resolveForLocation: jest.fn().mockResolvedValue(null), deriveEffectiveLocation: jest.fn().mockResolvedValue(null) };

  return { ticketService, supabase, routingService, slaService, visibilityService, scopeOverrides, inserted, updates, activities };
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
    const { ticketService, supabase, routingService, slaService, visibilityService, inserted } = makeDeps(parent);
    const svc = new DispatchService(
      supabase as never,
      ticketService as never,
      routingService as never,
      slaService as never,
      visibilityService as never,
      { resolve: jest.fn().mockResolvedValue(null), resolveForLocation: jest.fn().mockResolvedValue(null), deriveEffectiveLocation: jest.fn().mockResolvedValue(null) } as never,
    );
    const dto: DispatchDto = { title: 'Install replacement glass', assigned_vendor_id: UUID.vendorX };
    const child = await svc.dispatch(parent.id, dto, '__system__');

    expect(child.parent_ticket_id).toBe(parent.id);
    // Step 1c.4: writes go to work_orders (single-kind), so the row no longer
    // carries ticket_kind. parent_kind is the new discriminator.
    expect(child.parent_kind).toBe('case');
    expect(inserted[0].location_id).toBe(parent.location_id);
    expect(inserted[0].ticket_type_id).toBe(parent.ticket_type_id);
    expect(inserted[0].priority).toBe(parent.priority);
    expect(inserted[0].assigned_vendor_id).toBe(UUID.vendorX);
    expect(slaService.startTimers).not.toHaveBeenCalled();
  });

  it('runs resolver when no assignee given in DTO', async () => {
    const parent = makeParent();
    const { ticketService, supabase, routingService, slaService, visibilityService, inserted } = makeDeps(parent);
    const svc = new DispatchService(
      supabase as never,
      ticketService as never,
      routingService as never,
      slaService as never,
      visibilityService as never,
      { resolve: jest.fn().mockResolvedValue(null), resolveForLocation: jest.fn().mockResolvedValue(null), deriveEffectiveLocation: jest.fn().mockResolvedValue(null) } as never,
    );
    await svc.dispatch(parent.id, { title: 'Investigate' }, '__system__');
    expect(routingService.evaluate).toHaveBeenCalled();
    expect(inserted[0].assigned_vendor_id).toBe(UUID.vendorX);
  });

  it('rejects dispatch on a ticket that is already a work_order', async () => {
    const parent = makeParent({ ticket_kind: 'work_order' });
    const deps = makeDeps(parent);
    const svc = new DispatchService(
      deps.supabase as never,
      deps.ticketService as never,
      deps.routingService as never,
      deps.slaService as never,
      deps.visibilityService as never,
      { resolve: jest.fn().mockResolvedValue(null), resolveForLocation: jest.fn().mockResolvedValue(null), deriveEffectiveLocation: jest.fn().mockResolvedValue(null) } as never,
    );
    await expect(svc.dispatch(parent.id, { title: 'x' }, '__system__')).rejects.toThrow(/work_order/);
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
      deps.visibilityService as never,
      { resolve: jest.fn().mockResolvedValue(null), resolveForLocation: jest.fn().mockResolvedValue(null), deriveEffectiveLocation: jest.fn().mockResolvedValue(null) } as never,
    );
    await expect(svc.dispatch(parent.id, { title: 'x' }, '__system__')).rejects.toThrow(/pending approval/);
  });

  it('supports multiple children on one parent (broken-window scenario)', async () => {
    const parent = makeParent({ title: 'Broken window in Building A' });
    const { ticketService, supabase, routingService, slaService, visibilityService, inserted } = makeDeps(parent);
    const svc = new DispatchService(
      supabase as never,
      ticketService as never,
      routingService as never,
      slaService as never,
      visibilityService as never,
      { resolve: jest.fn().mockResolvedValue(null), resolveForLocation: jest.fn().mockResolvedValue(null), deriveEffectiveLocation: jest.fn().mockResolvedValue(null) } as never,
    );
    await svc.dispatch(parent.id, { title: 'Replace window pane', assigned_vendor_id: UUID.glazier }, '__system__');
    await svc.dispatch(parent.id, { title: 'Buy replacement glass', assigned_vendor_id: UUID.supplier }, '__system__');
    await svc.dispatch(parent.id, { title: 'Clean up debris', assigned_vendor_id: UUID.janitorial }, '__system__');
    expect(inserted).toHaveLength(3);
    expect(inserted.map((c) => c.assigned_vendor_id)).toEqual([UUID.glazier, UUID.supplier, UUID.janitorial]);
    expect(inserted.every((c) => c.parent_ticket_id === parent.id)).toBe(true);
    // Step 1c.4: writes go to work_orders (single-kind), so ticket_kind is gone.
    // parent_kind is the new discriminator and is always 'case' for dispatch.
    expect(inserted.every((c) => c.parent_kind === 'case')).toBe(true);
  });

  it('does NOT inherit sla_id from request_type (parent-vs-child SLA separation)', async () => {
    const parent = makeParent();
    const { ticketService, supabase, routingService, slaService, visibilityService, inserted } = makeDeps(parent);
    const svc = new DispatchService(
      supabase as never,
      ticketService as never,
      routingService as never,
      slaService as never,
      visibilityService as never,
      { resolve: jest.fn().mockResolvedValue(null), resolveForLocation: jest.fn().mockResolvedValue(null), deriveEffectiveLocation: jest.fn().mockResolvedValue(null) } as never,
    );
    // request_types mock returns sla_policy_id: 'sla-1' — that's the parent's desk SLA.
    // Child must NOT pick it up unless explicitly passed in DTO.
    await svc.dispatch(parent.id, { title: 'anything', assigned_vendor_id: UUID.v1 }, '__system__');
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
      deps.visibilityService as never,
      { resolve: jest.fn().mockResolvedValue(null), resolveForLocation: jest.fn().mockResolvedValue(null), deriveEffectiveLocation: jest.fn().mockResolvedValue(null) } as never,
    );
    await expect(svc.dispatch(parent.id, { title: '   ' }, '__system__')).rejects.toThrow(/title/);
  });

  it('uses dto.sla_id when provided explicitly', async () => {
    const parent = makeParent();
    const { ticketService, supabase, routingService, slaService, visibilityService, inserted } = makeDeps(parent);
    const svc = new DispatchService(
      supabase as never,
      ticketService as never,
      routingService as never,
      slaService as never,
      visibilityService as never,
      { resolve: jest.fn().mockResolvedValue(null), resolveForLocation: jest.fn().mockResolvedValue(null), deriveEffectiveLocation: jest.fn().mockResolvedValue(null) } as never,
    );
    await svc.dispatch(parent.id, { title: 'x', assigned_team_id: UUID.t1, sla_id: UUID.slaExplicit }, '__system__');
    expect(inserted[0].sla_id).toBe(UUID.slaExplicit);
    expect(slaService.startTimers).toHaveBeenCalledWith(expect.any(String), 't1', UUID.slaExplicit);
  });

  it('treats dto.sla_id === null as explicit "No SLA"', async () => {
    const parent = makeParent();
    const { ticketService, supabase, routingService, slaService, visibilityService, inserted } = makeDeps(parent, {
      vendors: { [UUID.v1]: { default_sla_policy_id: UUID.slaVendor } }, // would otherwise apply
    });
    const svc = new DispatchService(
      supabase as never,
      ticketService as never,
      routingService as never,
      slaService as never,
      visibilityService as never,
      { resolve: jest.fn().mockResolvedValue(null), resolveForLocation: jest.fn().mockResolvedValue(null), deriveEffectiveLocation: jest.fn().mockResolvedValue(null) } as never,
    );
    await svc.dispatch(parent.id, { title: 'x', assigned_vendor_id: UUID.v1, sla_id: null }, '__system__');
    expect(inserted[0].sla_id).toBeNull();
    expect(slaService.startTimers).not.toHaveBeenCalled();
  });

  it('falls back to vendor default_sla_policy_id', async () => {
    const parent = makeParent();
    const { ticketService, supabase, routingService, slaService, visibilityService, inserted } = makeDeps(parent, {
      vendors: { [UUID.v1]: { default_sla_policy_id: UUID.slaVendor } },
    });
    const svc = new DispatchService(
      supabase as never,
      ticketService as never,
      routingService as never,
      slaService as never,
      visibilityService as never,
      { resolve: jest.fn().mockResolvedValue(null), resolveForLocation: jest.fn().mockResolvedValue(null), deriveEffectiveLocation: jest.fn().mockResolvedValue(null) } as never,
    );
    await svc.dispatch(parent.id, { title: 'x', assigned_vendor_id: UUID.v1 }, '__system__');
    expect(inserted[0].sla_id).toBe(UUID.slaVendor);
    expect(slaService.startTimers).toHaveBeenCalledWith(expect.any(String), 't1', UUID.slaVendor);
  });

  it('falls back to team default_sla_policy_id when no vendor', async () => {
    const parent = makeParent();
    const { ticketService, supabase, routingService, slaService, visibilityService, inserted } = makeDeps(parent, {
      teams: { [UUID.t1]: { default_sla_policy_id: UUID.slaTeam } },
    });
    const svc = new DispatchService(
      supabase as never,
      ticketService as never,
      routingService as never,
      slaService as never,
      visibilityService as never,
      { resolve: jest.fn().mockResolvedValue(null), resolveForLocation: jest.fn().mockResolvedValue(null), deriveEffectiveLocation: jest.fn().mockResolvedValue(null) } as never,
    );
    // override routing so no vendor is assigned
    routingService.evaluate.mockResolvedValueOnce({
      target: { kind: 'team', team_id: UUID.t1 },
      chosen_by: 'request_type_default', rule_id: null, rule_name: null, strategy: 'fixed', trace: [],
    });
    await svc.dispatch(parent.id, { title: 'x' }, '__system__');
    expect(inserted[0].sla_id).toBe(UUID.slaTeam);
    expect(slaService.startTimers).toHaveBeenCalledWith(expect.any(String), 't1', UUID.slaTeam);
  });

  it('vendor default beats team default when both assignees set', async () => {
    const parent = makeParent();
    const { ticketService, supabase, routingService, slaService, visibilityService, inserted } = makeDeps(parent, {
      vendors: { [UUID.v1]: { default_sla_policy_id: UUID.slaVendor } },
      teams: { [UUID.t1]: { default_sla_policy_id: UUID.slaTeam } },
    });
    const svc = new DispatchService(
      supabase as never,
      ticketService as never,
      routingService as never,
      slaService as never,
      visibilityService as never,
      { resolve: jest.fn().mockResolvedValue(null), resolveForLocation: jest.fn().mockResolvedValue(null), deriveEffectiveLocation: jest.fn().mockResolvedValue(null) } as never,
    );
    await svc.dispatch(parent.id, { title: 'x', assigned_team_id: UUID.t1, assigned_vendor_id: UUID.v1 }, '__system__');
    expect(inserted[0].sla_id).toBe(UUID.slaVendor);
  });

  it('falls back through user → user.team → team default', async () => {
    const parent = makeParent();
    const { ticketService, supabase, routingService, slaService, visibilityService, inserted } = makeDeps(parent, {
      users: { [UUID.u1]: { team_id: UUID.tA } },
      teams: { [UUID.tA]: { default_sla_policy_id: UUID.slaUserteam } },
    });
    const svc = new DispatchService(
      supabase as never,
      ticketService as never,
      routingService as never,
      slaService as never,
      visibilityService as never,
      { resolve: jest.fn().mockResolvedValue(null), resolveForLocation: jest.fn().mockResolvedValue(null), deriveEffectiveLocation: jest.fn().mockResolvedValue(null) } as never,
    );
    await svc.dispatch(parent.id, { title: 'x', assigned_user_id: UUID.u1 }, '__system__');
    expect(inserted[0].sla_id).toBe(UUID.slaUserteam);
  });

  it('resolves to null sla_id when no defaults available', async () => {
    const parent = makeParent();
    const { ticketService, supabase, routingService, slaService, visibilityService, inserted } = makeDeps(parent);
    const svc = new DispatchService(
      supabase as never,
      ticketService as never,
      routingService as never,
      slaService as never,
      visibilityService as never,
      { resolve: jest.fn().mockResolvedValue(null), resolveForLocation: jest.fn().mockResolvedValue(null), deriveEffectiveLocation: jest.fn().mockResolvedValue(null) } as never,
    );
    routingService.evaluate.mockResolvedValueOnce({
      target: { kind: 'team', team_id: UUID.t1 },
      chosen_by: 'request_type_default', rule_id: null, rule_name: null, strategy: 'fixed', trace: [],
    });
    await svc.dispatch(parent.id, { title: 'x' }, '__system__');
    expect(inserted[0].sla_id).toBeNull();
    expect(slaService.startTimers).not.toHaveBeenCalled();
  });
});

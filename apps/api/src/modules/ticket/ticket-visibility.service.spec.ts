import { AppError } from '../../common/errors';
import { TicketVisibilityService, VisibilityContext } from './ticket-visibility.service';

function ctx(over: Partial<VisibilityContext> = {}): VisibilityContext {
  return {
    user_id: 'u1',
    person_id: 'p1',
    tenant_id: 't1',
    team_ids: [],
    role_assignments: [],
    vendor_id: null,
    has_read_all: false,
    has_write_all: false,
    ...over,
  };
}

describe('TicketVisibilityService.assertVisible', () => {
  // Shape of the ticket rows the helper reads for local path evaluation.
  type TicketRow = {
    id: string;
    tenant_id: string;
    requester_person_id: string | null;
    assigned_user_id: string | null;
    assigned_team_id: string | null;
    assigned_vendor_id: string | null;
    watchers: string[];
    location_id: string | null;
    domain: string | null;
  };

  function svc(row: TicketRow) {
    const supabase = {
      admin: {
        from: jest.fn(() => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: row, error: null }),
              }),
            }),
          }),
        })),
        rpc: jest.fn(async () => ({ data: [], error: null })),
      },
    };
    return new TicketVisibilityService(supabase as never);
  }

  const baseRow = {
    id: 'tk1', tenant_id: 't1',
    requester_person_id: null, assigned_user_id: null, assigned_team_id: null,
    assigned_vendor_id: null, watchers: [], location_id: null, domain: 'fm',
  };

  it('allows read when user is requester', async () => {
    const s = svc({ ...baseRow, requester_person_id: 'p1' });
    await expect(s.assertVisible('tk1', ctx(), 'read')).resolves.toBeUndefined();
  });

  it('allows read when user is personal assignee', async () => {
    const s = svc({ ...baseRow, assigned_user_id: 'u1' });
    await expect(s.assertVisible('tk1', ctx(), 'read')).resolves.toBeUndefined();
  });

  it('allows read when user person is a watcher', async () => {
    const s = svc({ ...baseRow, watchers: ['p9', 'p1'] });
    await expect(s.assertVisible('tk1', ctx(), 'read')).resolves.toBeUndefined();
  });

  it('allows read when user team matches the assigned team', async () => {
    const s = svc({ ...baseRow, assigned_team_id: 'team1' });
    await expect(s.assertVisible('tk1', ctx({ team_ids: ['team1'] }), 'read')).resolves.toBeUndefined();
  });

  it('allows read via a role with matching domain and empty location scope', async () => {
    const s = svc({ ...baseRow, domain: 'fm', location_id: 'spaceX' });
    const c = ctx({
      role_assignments: [
        { domain_scope: ['fm'], location_scope_closure: [], read_only_cross_domain: false },
      ],
    });
    await expect(s.assertVisible('tk1', c, 'read')).resolves.toBeUndefined();
  });

  it('allows read via a role whose location closure contains the ticket location', async () => {
    const s = svc({ ...baseRow, domain: 'fm', location_id: 'floor3' });
    const c = ctx({
      role_assignments: [
        { domain_scope: [], location_scope_closure: ['bldgA', 'floor3'], read_only_cross_domain: false },
      ],
    });
    await expect(s.assertVisible('tk1', c, 'read')).resolves.toBeUndefined();
  });

  it('denies read when no path matches', async () => {
    const s = svc(baseRow);
    await expect(s.assertVisible('tk1', ctx(), 'read')).rejects.toThrow(AppError);
    await expect(s.assertVisible('tk1', ctx(), 'read')).rejects.toMatchObject({
      code: 'ticket.read_forbidden',
      status: 403,
    });
  });

  it('allows read when has_read_all is true regardless of paths', async () => {
    const s = svc(baseRow);
    await expect(s.assertVisible('tk1', ctx({ has_read_all: true }), 'read')).resolves.toBeUndefined();
  });

  it('denies write when only path is a read_only_cross_domain role', async () => {
    const s = svc({ ...baseRow, domain: 'fm' });
    const c = ctx({
      role_assignments: [
        { domain_scope: ['fm'], location_scope_closure: [], read_only_cross_domain: true },
      ],
    });
    await expect(s.assertVisible('tk1', c, 'read')).resolves.toBeUndefined();
    await expect(s.assertVisible('tk1', c, 'write')).rejects.toThrow(AppError);
    await expect(s.assertVisible('tk1', c, 'write')).rejects.toMatchObject({
      code: 'ticket.write_forbidden',
      status: 403,
    });
  });

  it('allows write when a non-readonly role matches', async () => {
    const s = svc({ ...baseRow, domain: 'fm' });
    const c = ctx({
      role_assignments: [
        { domain_scope: ['fm'], location_scope_closure: [], read_only_cross_domain: true },
        { domain_scope: ['fm'], location_scope_closure: [], read_only_cross_domain: false },
      ],
    });
    await expect(s.assertVisible('tk1', c, 'write')).resolves.toBeUndefined();
  });

  it('allows write for participants even with no operator role', async () => {
    const s = svc({ ...baseRow, requester_person_id: 'p1' });
    await expect(s.assertVisible('tk1', ctx(), 'write')).resolves.toBeUndefined();
  });

  it('allows write when has_write_all is true', async () => {
    const s = svc(baseRow);
    await expect(s.assertVisible('tk1', ctx({ has_write_all: true }), 'write')).resolves.toBeUndefined();
  });

  it('throws AppError (ticket.read_forbidden) when ticket does not exist', async () => {
    const supabase = {
      admin: {
        from: jest.fn(() => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
          }),
        })),
      },
    };
    const s = new TicketVisibilityService(supabase as never);
    await expect(s.assertVisible('tk-missing', ctx(), 'read')).rejects.toThrow(AppError);
    await expect(s.assertVisible('tk-missing', ctx(), 'read')).rejects.toMatchObject({
      code: 'ticket.read_forbidden',
      status: 403,
    });
  });
});

describe('TicketVisibilityService.loadContext', () => {
  it('returns has_read_all=false and empty arrays for a user with no roles or teams', async () => {
    const supabase = {
      admin: {
        from: jest.fn((table: string) => {
          if (table === 'users') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: async () => ({ data: { id: 'u1', person_id: 'p1' }, error: null }),
                  }),
                }),
              }),
            };
          }
          if (table === 'team_members') {
            return {
              select: () => ({
                eq: () => ({ eq: () => ({ then: (fn: Function) => fn({ data: [], error: null }) }) }),
              }),
            };
          }
          if (table === 'user_role_assignments') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    eq: () => ({ then: (fn: Function) => fn({ data: [], error: null }) }),
                  }),
                }),
              }),
            };
          }
          if (table === 'persons') {
            return {
              select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
            };
          }
          return {};
        }),
        rpc: jest.fn(async () => ({ data: false, error: null })),
      },
    };
    const s = new TicketVisibilityService(supabase as never);
    const result = await s.loadContext('auth-123', 't1');
    expect(result.user_id).toBe('u1');
    expect(result.person_id).toBe('p1');
    expect(result.team_ids).toEqual([]);
    expect(result.role_assignments).toEqual([]);
    expect(result.has_read_all).toBe(false);
    expect(result.has_write_all).toBe(false);
  });
});

describe('TicketVisibilityService.getVisibleWorkOrderIds', () => {
  function mkRpcSvc(rpcReturn: unknown) {
    const supabase = {
      admin: {
        rpc: jest.fn(async () => rpcReturn),
      },
    };
    return { svc: new TicketVisibilityService(supabase as never), rpc: supabase.admin.rpc };
  }

  it('returns null when ctx.has_read_all is true (no filter — see all)', async () => {
    const { svc, rpc } = mkRpcSvc({ data: ['wo1'], error: null });
    const result = await svc.getVisibleWorkOrderIds(ctx({ has_read_all: true }));
    expect(result).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('returns [] when ctx.user_id is falsy', async () => {
    const { svc, rpc } = mkRpcSvc({ data: ['wo1'], error: null });
    const result = await svc.getVisibleWorkOrderIds(ctx({ user_id: '' }));
    expect(result).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('calls work_order_visibility_ids rpc with correct args and maps rows (string array)', async () => {
    const { svc, rpc } = mkRpcSvc({ data: ['wo1', 'wo2'], error: null });
    const result = await svc.getVisibleWorkOrderIds(ctx({ user_id: 'u1', tenant_id: 't1' }));
    expect(rpc).toHaveBeenCalledWith('work_order_visibility_ids', {
      p_user_id: 'u1',
      p_tenant_id: 't1',
    });
    expect(result).toEqual(['wo1', 'wo2']);
  });

  it('maps object-shaped rows ({ id: string }) correctly', async () => {
    const { svc } = mkRpcSvc({ data: [{ id: 'wo1' }, { id: 'wo2' }], error: null });
    const result = await svc.getVisibleWorkOrderIds(ctx({ user_id: 'u1', tenant_id: 't1' }));
    expect(result).toEqual(['wo1', 'wo2']);
  });

  it('returns [] when rpc returns null data', async () => {
    const { svc } = mkRpcSvc({ data: null, error: null });
    const result = await svc.getVisibleWorkOrderIds(ctx({ user_id: 'u1', tenant_id: 't1' }));
    expect(result).toEqual([]);
  });

  it('throws when rpc returns an error', async () => {
    const { svc } = mkRpcSvc({ data: null, error: new Error('rpc fail') });
    await expect(svc.getVisibleWorkOrderIds(ctx({ user_id: 'u1', tenant_id: 't1' }))).rejects.toThrow('rpc fail');
  });
});

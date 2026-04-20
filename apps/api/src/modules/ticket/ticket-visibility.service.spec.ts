import { ForbiddenException } from '@nestjs/common';
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
    await expect(s.assertVisible('tk1', ctx(), 'read')).rejects.toThrow(ForbiddenException);
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
    await expect(s.assertVisible('tk1', c, 'write')).rejects.toThrow(ForbiddenException);
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

  it('throws ForbiddenException when ticket does not exist', async () => {
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
    await expect(s.assertVisible('tk-missing', ctx(), 'read')).rejects.toThrow(ForbiddenException);
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

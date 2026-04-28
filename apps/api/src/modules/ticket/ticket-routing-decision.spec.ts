import { TicketService, SYSTEM_ACTOR } from './ticket.service';
import { TenantContext } from '../../common/tenant-context';

/**
 * Covers `TicketService.getLatestRoutingDecision` — the read endpoint behind
 * the "Routed by …" pill on ticket detail. The pill is operator-visible (no
 * `routing.read` admin permission) so the projection must stay minimal and
 * tenant-scoped.
 */

interface DecisionRow {
  id: string;
  decided_at: string;
  strategy: string;
  chosen_by: string;
  rule_id: string | null;
  chosen_team_id: string | null;
  chosen_user_id: string | null;
  chosen_vendor_id: string | null;
  rules: { name: string } | null;
}

const TENANT_ID = '00000000-0000-0000-0000-00000000000a';
const TICKET_ID = 'tk-1';

function makeService(decisionRow: DecisionRow | null) {
  // Capture the args so we can assert tenant scoping + ordering.
  let lastEqs: Array<[string, unknown]> = [];
  let lastOrder: { col: string; asc: boolean } | null = null;
  let lastLimit: number | null = null;

  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        if (table !== 'routing_decisions') {
          throw new Error(`unexpected table: ${table}`);
        }
        const builder: Record<string, unknown> = {
          select: () => builder,
          eq: (col: string, val: unknown) => {
            lastEqs.push([col, val]);
            return builder;
          },
          order: (col: string, opts: { ascending: boolean }) => {
            lastOrder = { col, asc: opts.ascending };
            return builder;
          },
          limit: (n: number) => {
            lastLimit = n;
            return builder;
          },
          maybeSingle: async () => ({ data: decisionRow, error: null }),
        };
        return builder;
      }),
    },
  };

  const visibility = {
    loadContext: jest.fn().mockResolvedValue({}),
    assertVisible: jest.fn().mockResolvedValue(undefined),
  };

  const svc = new TicketService(
    supabase as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    visibility as never,
    {} as never,
  );

  return {
    svc,
    visibility,
    inspect: () => ({ eqs: lastEqs, order: lastOrder, limit: lastLimit }),
  };
}

describe('TicketService.getLatestRoutingDecision', () => {
  beforeEach(() => {
    jest
      .spyOn(TenantContext, 'current')
      .mockReturnValue({ id: TENANT_ID, slug: 'a', tier: 'standard' } as never);
  });

  it('returns null when the ticket has no recorded decision', async () => {
    const { svc } = makeService(null);
    const result = await svc.getLatestRoutingDecision(TICKET_ID, SYSTEM_ACTOR);
    expect(result).toBeNull();
  });

  it('projects a team decision with rule_name resolved from the joined rules row', async () => {
    const { svc } = makeService({
      id: 'd1',
      decided_at: '2026-04-28T10:00:00Z',
      strategy: 'rule',
      chosen_by: 'rule',
      rule_id: 'rule-1',
      chosen_team_id: 'team-1',
      chosen_user_id: null,
      chosen_vendor_id: null,
      rules: { name: 'HQ-AV-Vendor' },
    });

    const result = await svc.getLatestRoutingDecision(TICKET_ID, SYSTEM_ACTOR);

    expect(result).toEqual({
      id: 'd1',
      decided_at: '2026-04-28T10:00:00Z',
      strategy: 'rule',
      chosen_by: 'rule',
      rule_id: 'rule-1',
      rule_name: 'HQ-AV-Vendor',
      target_kind: 'team',
      target_id: 'team-1',
    });
  });

  it('prefers vendor over user when both are set (matches resolver precedence)', async () => {
    // pickTarget(team, vendor): team wins; if no team, vendor; else user.
    // Here: no team, vendor + user both set — vendor wins.
    const { svc } = makeService({
      id: 'd2',
      decided_at: '2026-04-28T10:00:00Z',
      strategy: 'rule',
      chosen_by: 'rule',
      rule_id: 'rule-2',
      chosen_team_id: null,
      chosen_user_id: 'user-1',
      chosen_vendor_id: 'vendor-1',
      rules: { name: 'Catering-fallback' },
    });

    const result = await svc.getLatestRoutingDecision(TICKET_ID, SYSTEM_ACTOR);

    expect(result?.target_kind).toBe('vendor');
    expect(result?.target_id).toBe('vendor-1');
  });

  it('returns target_kind=null for unassigned decisions', async () => {
    const { svc } = makeService({
      id: 'd3',
      decided_at: '2026-04-28T10:00:00Z',
      strategy: 'auto',
      chosen_by: 'unassigned',
      rule_id: null,
      chosen_team_id: null,
      chosen_user_id: null,
      chosen_vendor_id: null,
      rules: null,
    });

    const result = await svc.getLatestRoutingDecision(TICKET_ID, SYSTEM_ACTOR);

    expect(result).toMatchObject({
      chosen_by: 'unassigned',
      rule_id: null,
      rule_name: null,
      target_kind: null,
      target_id: null,
    });
  });

  it('returns the latest decision only — orders by decided_at desc and limits to 1', async () => {
    const { svc, inspect } = makeService({
      id: 'd-latest',
      decided_at: '2026-04-28T10:00:00Z',
      strategy: 'rule',
      chosen_by: 'rule',
      rule_id: 'rule-x',
      chosen_team_id: 'team-x',
      chosen_user_id: null,
      chosen_vendor_id: null,
      rules: { name: 'rx' },
    });

    await svc.getLatestRoutingDecision(TICKET_ID, SYSTEM_ACTOR);

    const { order, limit } = inspect();
    expect(order).toEqual({ col: 'decided_at', asc: false });
    expect(limit).toBe(1);
  });

  it('scopes the query to the current tenant and ticket id', async () => {
    const { svc, inspect } = makeService(null);

    await svc.getLatestRoutingDecision(TICKET_ID, SYSTEM_ACTOR);

    const { eqs } = inspect();
    expect(eqs).toContainEqual(['tenant_id', TENANT_ID]);
    expect(eqs).toContainEqual(['ticket_id', TICKET_ID]);
  });

  it('skips the visibility gate for system actor', async () => {
    const { svc, visibility } = makeService(null);

    await svc.getLatestRoutingDecision(TICKET_ID, SYSTEM_ACTOR);

    expect(visibility.loadContext).not.toHaveBeenCalled();
    expect(visibility.assertVisible).not.toHaveBeenCalled();
  });

  it('runs assertVisible(read) when called by a real user', async () => {
    const { svc, visibility } = makeService(null);

    await svc.getLatestRoutingDecision(TICKET_ID, 'auth-uid-1');

    expect(visibility.loadContext).toHaveBeenCalledWith('auth-uid-1', TENANT_ID);
    expect(visibility.assertVisible).toHaveBeenCalledWith(TICKET_ID, expect.anything(), 'read');
  });

  it('handles a rules join that arrives as an array (PostgREST sometimes returns this shape)', async () => {
    const { svc } = makeService({
      id: 'd4',
      decided_at: '2026-04-28T10:00:00Z',
      strategy: 'rule',
      chosen_by: 'rule',
      rule_id: 'rule-3',
      chosen_team_id: 'team-3',
      chosen_user_id: null,
      chosen_vendor_id: null,
      // PostgREST embed normally returns a single object for to-one joins
      // when the FK is unique, but historically has emitted arrays in some
      // schema/version combinations. The service handles both shapes.
      rules: [{ name: 'array-shaped' }] as unknown as { name: string },
    });

    const result = await svc.getLatestRoutingDecision(TICKET_ID, SYSTEM_ACTOR);

    expect(result?.rule_name).toBe('array-shaped');
  });
});

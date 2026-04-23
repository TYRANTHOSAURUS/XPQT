import { ResolverService } from './resolver.service';
import { ResolverContext } from './resolver.types';

function stubRepo(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    loadRequestType: jest.fn().mockResolvedValue(null),
    loadAsset: jest.fn().mockResolvedValue(null),
    locationChain: jest.fn().mockResolvedValue([]),
    locationTeam: jest.fn().mockResolvedValue(null),
    spaceGroupTeam: jest.fn().mockResolvedValue(null),
    domainChain: jest.fn(async (_tenantId: string, domain: string) => (domain ? [domain] : [])),
    loadRoutingRules: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function ctx(over: Partial<ResolverContext> = {}): ResolverContext {
  return {
    tenant_id: 't1',
    ticket_id: 'tk1',
    request_type_id: null,
    domain: null,
    priority: 'medium',
    asset_id: null,
    location_id: null,
    ...over,
  };
}

describe('ResolverService', () => {
  it('returns unassigned when no context and no fallbacks', async () => {
    const svc = new ResolverService(stubRepo() as never, { resolve: jest.fn().mockResolvedValue(null) } as never);
    const decision = await svc.resolve(ctx());
    expect(decision.target).toBeNull();
    expect(decision.chosen_by).toBe('unassigned');
    expect(decision.trace.length).toBeGreaterThan(0);
  });

  describe('asset strategy', () => {
    const baseRT = {
      id: 'rt1',
      domain: 'fm',
      fulfillment_strategy: 'asset' as const,
      default_team_id: 'default-team',
      default_vendor_id: null,
      asset_type_filter: [],
    };

    it('prefers asset override team over everything else', async () => {
      const repo = stubRepo({
        loadRequestType: jest.fn().mockResolvedValue(baseRT),
        loadAsset: jest.fn().mockResolvedValue({
          id: 'a1', asset_type_id: 'at1', assigned_space_id: 's1',
          override_team_id: 'override-team', override_vendor_id: null,
          type: { id: 'at1', default_team_id: 'at-team', default_vendor_id: null },
        }),
      });
      const svc = new ResolverService(repo as never, { resolve: jest.fn().mockResolvedValue(null) } as never);
      const d = await svc.resolve(ctx({ request_type_id: 'rt1', asset_id: 'a1' }));
      expect(d.target).toEqual({ kind: 'team', team_id: 'override-team' });
      expect(d.chosen_by).toBe('asset_override');
    });

    it('falls through to asset type default when no override', async () => {
      const repo = stubRepo({
        loadRequestType: jest.fn().mockResolvedValue(baseRT),
        loadAsset: jest.fn().mockResolvedValue({
          id: 'a1', asset_type_id: 'at1', assigned_space_id: 's1',
          override_team_id: null, override_vendor_id: null,
          type: { id: 'at1', default_team_id: 'at-team', default_vendor_id: null },
        }),
      });
      const svc = new ResolverService(repo as never, { resolve: jest.fn().mockResolvedValue(null) } as never);
      const d = await svc.resolve(ctx({ request_type_id: 'rt1', asset_id: 'a1' }));
      expect(d.target).toEqual({ kind: 'team', team_id: 'at-team' });
      expect(d.chosen_by).toBe('asset_type_default');
    });

    it('uses asset type default VENDOR when team is absent', async () => {
      const repo = stubRepo({
        loadRequestType: jest.fn().mockResolvedValue(baseRT),
        loadAsset: jest.fn().mockResolvedValue({
          id: 'a1', asset_type_id: 'at1', assigned_space_id: 's1',
          override_team_id: null, override_vendor_id: null,
          type: { id: 'at1', default_team_id: null, default_vendor_id: 'acme' },
        }),
      });
      const svc = new ResolverService(repo as never, { resolve: jest.fn().mockResolvedValue(null) } as never);
      const d = await svc.resolve(ctx({ request_type_id: 'rt1', asset_id: 'a1' }));
      expect(d.target).toEqual({ kind: 'vendor', vendor_id: 'acme' });
      expect(d.chosen_by).toBe('asset_type_default');
    });

    it('falls through to request_type default when asset has nothing', async () => {
      const repo = stubRepo({
        loadRequestType: jest.fn().mockResolvedValue(baseRT),
        loadAsset: jest.fn().mockResolvedValue({
          id: 'a1', asset_type_id: 'at1', assigned_space_id: null,
          override_team_id: null, override_vendor_id: null,
          type: { id: 'at1', default_team_id: null, default_vendor_id: null },
        }),
      });
      const svc = new ResolverService(repo as never, { resolve: jest.fn().mockResolvedValue(null) } as never);
      const d = await svc.resolve(ctx({ request_type_id: 'rt1', asset_id: 'a1' }));
      expect(d.target).toEqual({ kind: 'team', team_id: 'default-team' });
      expect(d.chosen_by).toBe('request_type_default');
    });
  });

  describe('location strategy', () => {
    const baseRT = {
      id: 'rt2',
      domain: 'fm',
      fulfillment_strategy: 'location' as const,
      default_team_id: 'fallback-team',
      default_vendor_id: null,
      asset_type_filter: [],
    };

    it('picks location_teams for exact space + domain match', async () => {
      const repo = stubRepo({
        loadRequestType: jest.fn().mockResolvedValue(baseRT),
        locationChain: jest.fn().mockResolvedValue(['s1', 'b1']),
        locationTeam: jest.fn(async (sid: string, dom: string) => {
          if (sid === 's1' && dom === 'fm') return { team_id: 'floor-team', vendor_id: null };
          return null;
        }),
      });
      const svc = new ResolverService(repo as never, { resolve: jest.fn().mockResolvedValue(null) } as never);
      const d = await svc.resolve(ctx({ request_type_id: 'rt2', location_id: 's1', domain: 'fm' }));
      expect(d.target).toEqual({ kind: 'team', team_id: 'floor-team' });
      expect(d.chosen_by).toBe('location_team');
    });

    it('walks up to parent location when floor has no team', async () => {
      const repo = stubRepo({
        loadRequestType: jest.fn().mockResolvedValue(baseRT),
        locationChain: jest.fn().mockResolvedValue(['s1', 'b1', 'site1']),
        locationTeam: jest.fn(async (sid: string, dom: string) => {
          if (sid === 'b1' && dom === 'fm') return { team_id: 'building-team', vendor_id: null };
          return null;
        }),
      });
      const svc = new ResolverService(repo as never, { resolve: jest.fn().mockResolvedValue(null) } as never);
      const d = await svc.resolve(ctx({ request_type_id: 'rt2', location_id: 's1', domain: 'fm' }));
      expect(d.target).toEqual({ kind: 'team', team_id: 'building-team' });
      expect(d.chosen_by).toBe('parent_location_team');
    });

    it('falls back to request-type default when no location team found', async () => {
      const repo = stubRepo({
        loadRequestType: jest.fn().mockResolvedValue(baseRT),
        locationChain: jest.fn().mockResolvedValue(['s1']),
        locationTeam: jest.fn().mockResolvedValue(null),
      });
      const svc = new ResolverService(repo as never, { resolve: jest.fn().mockResolvedValue(null) } as never);
      const d = await svc.resolve(ctx({ request_type_id: 'rt2', location_id: 's1', domain: 'fm' }));
      expect(d.target).toEqual({ kind: 'team', team_id: 'fallback-team' });
      expect(d.chosen_by).toBe('request_type_default');
    });
  });

  describe('auto strategy', () => {
    it('tries asset first, falls back to location', async () => {
      const repo = stubRepo({
        loadRequestType: jest.fn().mockResolvedValue({
          id: 'rt3', domain: 'fm', fulfillment_strategy: 'auto' as const,
          default_team_id: null, default_vendor_id: null, asset_type_filter: [],
        }),
        loadAsset: jest.fn().mockResolvedValue({
          id: 'a1', asset_type_id: 'at1', assigned_space_id: 's1',
          override_team_id: null, override_vendor_id: null,
          type: { id: 'at1', default_team_id: null, default_vendor_id: null },
        }),
        locationChain: jest.fn().mockResolvedValue(['s1']),
        locationTeam: jest.fn().mockResolvedValue({ team_id: 'loc-team', vendor_id: null }),
      });
      const svc = new ResolverService(repo as never, { resolve: jest.fn().mockResolvedValue(null) } as never);
      const d = await svc.resolve(ctx({ request_type_id: 'rt3', asset_id: 'a1', domain: 'fm' }));
      expect(d.target).toEqual({ kind: 'team', team_id: 'loc-team' });
      expect(d.chosen_by).toBe('location_team');
    });
  });

  describe('fixed strategy', () => {
    it('uses request-type default team', async () => {
      const repo = stubRepo({
        loadRequestType: jest.fn().mockResolvedValue({
          id: 'rt4', domain: 'it', fulfillment_strategy: 'fixed' as const,
          default_team_id: 'it-team', default_vendor_id: null, asset_type_filter: [],
        }),
      });
      const svc = new ResolverService(repo as never, { resolve: jest.fn().mockResolvedValue(null) } as never);
      const d = await svc.resolve(ctx({ request_type_id: 'rt4', domain: 'it' }));
      expect(d.target).toEqual({ kind: 'team', team_id: 'it-team' });
      expect(d.chosen_by).toBe('request_type_default');
    });
  });

  describe('routing_rules pre-step', () => {
    it('first matching active rule wins before any other logic', async () => {
      const repo = stubRepo({
        loadRoutingRules: jest.fn().mockResolvedValue([
          {
            id: 'r1', name: 'VIP', priority: 100,
            conditions: [{ field: 'priority', operator: 'equals', value: 'urgent' }],
            action_assign_team_id: 'vip-team', action_assign_user_id: null,
          },
        ]),
        loadRequestType: jest.fn().mockResolvedValue({
          id: 'rt', domain: 'fm', fulfillment_strategy: 'fixed',
          default_team_id: 'normal-team', default_vendor_id: null, asset_type_filter: [],
        }),
      });
      const svc = new ResolverService(repo as never, { resolve: jest.fn().mockResolvedValue(null) } as never);
      const d = await svc.resolve(ctx({ request_type_id: 'rt', priority: 'urgent' }));
      expect(d.chosen_by).toBe('rule');
      expect(d.rule_id).toBe('r1');
      expect(d.target).toEqual({ kind: 'team', team_id: 'vip-team' });
    });

    it('excluded_rule_ids skips those rules so next step can win (simulator "disable rule")', async () => {
      const repo = stubRepo({
        loadRoutingRules: jest.fn().mockResolvedValue([
          {
            id: 'r1', name: 'VIP', priority: 100,
            conditions: [{ field: 'priority', operator: 'equals', value: 'urgent' }],
            action_assign_team_id: 'vip-team', action_assign_user_id: null,
          },
        ]),
        loadRequestType: jest.fn().mockResolvedValue({
          id: 'rt', domain: 'fm', fulfillment_strategy: 'fixed',
          default_team_id: 'normal-team', default_vendor_id: null, asset_type_filter: [],
        }),
      });
      const svc = new ResolverService(repo as never, { resolve: jest.fn().mockResolvedValue(null) } as never);
      const d = await svc.resolve(
        ctx({ request_type_id: 'rt', priority: 'urgent', excluded_rule_ids: ['r1'] }),
      );
      expect(d.chosen_by).toBe('request_type_default');
      expect(d.target).toEqual({ kind: 'team', team_id: 'normal-team' });
    });

    it('rules with no match fall through to the resolver chain', async () => {
      const repo = stubRepo({
        loadRoutingRules: jest.fn().mockResolvedValue([
          {
            id: 'r1', name: 'VIP', priority: 100,
            conditions: [{ field: 'priority', operator: 'equals', value: 'urgent' }],
            action_assign_team_id: 'vip-team', action_assign_user_id: null,
          },
        ]),
        loadRequestType: jest.fn().mockResolvedValue({
          id: 'rt', domain: 'fm', fulfillment_strategy: 'fixed',
          default_team_id: 'normal-team', default_vendor_id: null, asset_type_filter: [],
        }),
      });
      const svc = new ResolverService(repo as never, { resolve: jest.fn().mockResolvedValue(null) } as never);
      const d = await svc.resolve(ctx({ request_type_id: 'rt', priority: 'medium' }));
      expect(d.chosen_by).toBe('request_type_default');
      expect(d.target).toEqual({ kind: 'team', team_id: 'normal-team' });
    });
  });

  describe('space group expansion', () => {
    it('matches space_group_team when no per-space row exists', async () => {
      const repo = stubRepo({
        loadRequestType: jest.fn().mockResolvedValue({
          id: 'rt', domain: 'fm', fulfillment_strategy: 'location',
          default_team_id: null, default_vendor_id: null, asset_type_filter: [],
        }),
        locationChain: jest.fn().mockResolvedValue(['locB']),
        locationTeam: jest.fn().mockResolvedValue(null),
        spaceGroupTeam: jest.fn(async (sid: string, dom: string) =>
          sid === 'locB' && dom === 'fm' ? { team_id: 'fm-shared', vendor_id: null } : null),
      });
      const svc = new ResolverService(repo as never, { resolve: jest.fn().mockResolvedValue(null) } as never);
      const d = await svc.resolve(ctx({ request_type_id: 'rt', location_id: 'locB', domain: 'fm' }));
      expect(d.chosen_by).toBe('space_group_team');
      expect(d.target).toEqual({ kind: 'team', team_id: 'fm-shared' });
    });
  });

  describe('domain fallback', () => {
    it('falls back to parent domain when exact domain has no team at any scope', async () => {
      const repo = stubRepo({
        loadRequestType: jest.fn().mockResolvedValue({
          id: 'rt', domain: 'doors', fulfillment_strategy: 'location',
          default_team_id: null, default_vendor_id: null, asset_type_filter: [],
        }),
        locationChain: jest.fn().mockResolvedValue(['locC', 'region-west']),
        domainChain: jest.fn().mockResolvedValue(['doors', 'fm']),
        locationTeam: jest.fn(async (sid: string, dom: string) =>
          sid === 'region-west' && dom === 'fm' ? { team_id: 'region-west-fm', vendor_id: null } : null),
      });
      const svc = new ResolverService(repo as never, { resolve: jest.fn().mockResolvedValue(null) } as never);
      const d = await svc.resolve(ctx({ request_type_id: 'rt', location_id: 'locC', domain: 'doors' }));
      expect(d.chosen_by).toBe('domain_fallback');
      expect(d.target).toEqual({ kind: 'team', team_id: 'region-west-fm' });
    });
  });
});

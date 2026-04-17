import { ResolverService } from './resolver.service';
import { ResolverContext } from './resolver.types';

function stubRepo(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    loadRequestType: jest.fn().mockResolvedValue(null),
    loadAsset: jest.fn().mockResolvedValue(null),
    locationChain: jest.fn().mockResolvedValue([]),
    locationTeam: jest.fn().mockResolvedValue(null),
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
    const svc = new ResolverService(stubRepo() as never);
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
      const svc = new ResolverService(repo as never);
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
      const svc = new ResolverService(repo as never);
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
      const svc = new ResolverService(repo as never);
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
      const svc = new ResolverService(repo as never);
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
      const svc = new ResolverService(repo as never);
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
      const svc = new ResolverService(repo as never);
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
      const svc = new ResolverService(repo as never);
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
      const svc = new ResolverService(repo as never);
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
      const svc = new ResolverService(repo as never);
      const d = await svc.resolve(ctx({ request_type_id: 'rt4', domain: 'it' }));
      expect(d.target).toEqual({ kind: 'team', team_id: 'it-team' });
      expect(d.chosen_by).toBe('request_type_default');
    });
  });
});

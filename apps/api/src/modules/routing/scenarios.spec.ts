/**
 * Scenario tests for the canonical enterprise routing patterns.
 * Updated after the resolver rewrite:
 *   - 2b now resolves via space groups.
 *   - 5b now resolves via domain fallback.
 *   - 4 (owner + vendor split) moved to dispatch.service.spec.ts.
 *   - 7 (visibility) is a list-endpoint concern; owned by its own plan.
 */
import { ResolverService } from './resolver.service';
import { ResolverContext } from './resolver.types';

function repo(over: Partial<Record<string, jest.Mock>> = {}) {
  return {
    loadRequestType: jest.fn().mockResolvedValue(null),
    loadAsset: jest.fn().mockResolvedValue(null),
    locationChain: jest.fn().mockResolvedValue([]),
    locationTeam: jest.fn().mockResolvedValue(null),
    spaceGroupTeam: jest.fn().mockResolvedValue(null),
    domainChain: jest.fn(async (_t: string, d: string) => (d ? [d] : [])),
    loadRoutingRules: jest.fn().mockResolvedValue([]),
    ...over,
  };
}

// Scope-override resolver stub: no override configured in any scenario below.
// Tests that exercise the override pre-step live in a dedicated scope-override
// spec file so the scenarios here stay focused on the rules/asset/location
// chain.
const noScopeOverride = { resolve: jest.fn().mockResolvedValue(null), resolveForLocation: jest.fn().mockResolvedValue(null), deriveEffectiveLocation: jest.fn().mockResolvedValue(null) };

function ctx(over: Partial<ResolverContext> = {}): ResolverContext {
  return {
    tenant_id: 't1',
    ticket_id: 'tk1',
    request_type_id: 'rt',
    domain: null,
    priority: 'medium',
    asset_id: null,
    location_id: null,
    ...over,
  };
}

describe('canonical enterprise routing scenarios', () => {
  it('Scenario 1: local team per location', async () => {
    const svc = new ResolverService(repo({
      loadRequestType: jest.fn().mockResolvedValue({
        id: 'rt', domain: 'it', fulfillment_strategy: 'location',
        default_team_id: null, default_vendor_id: null, asset_type_filter: [],
      }),
      locationChain: jest.fn().mockResolvedValue(['locA']),
      locationTeam: jest.fn(async (sid, dom) =>
        sid === 'locA' && dom === 'it' ? { team_id: 'service-desk-A', vendor_id: null } : null),
    }) as never, noScopeOverride as never);
    const d = await svc.resolve(ctx({ location_id: 'locA', domain: 'it' }));
    expect(d.target).toEqual({ kind: 'team', team_id: 'service-desk-A' });
    expect(d.chosen_by).toBe('location_team');
  });

  it('Scenario 2a: shared team via parent-space walk', async () => {
    const svc = new ResolverService(repo({
      loadRequestType: jest.fn().mockResolvedValue({
        id: 'rt', domain: 'fm', fulfillment_strategy: 'location',
        default_team_id: null, default_vendor_id: null, asset_type_filter: [],
      }),
      locationChain: jest.fn().mockResolvedValue(['locB', 'region-east']),
      locationTeam: jest.fn(async (sid, dom) =>
        sid === 'region-east' && dom === 'fm' ? { team_id: 'fm-shared', vendor_id: null } : null),
    }) as never, noScopeOverride as never);
    const d = await svc.resolve(ctx({ location_id: 'locB', domain: 'fm' }));
    expect(d.target).toEqual({ kind: 'team', team_id: 'fm-shared' });
    expect(d.chosen_by).toBe('parent_location_team');
  });

  it('Scenario 2b: shared team across unrelated locations via space group', async () => {
    const svc = new ResolverService(repo({
      loadRequestType: jest.fn().mockResolvedValue({
        id: 'rt', domain: 'fm', fulfillment_strategy: 'location',
        default_team_id: null, default_vendor_id: null, asset_type_filter: [],
      }),
      locationChain: jest.fn().mockResolvedValue(['locC']),
      spaceGroupTeam: jest.fn(async (sid, dom) =>
        sid === 'locC' && dom === 'fm' ? { team_id: 'fm-shared', vendor_id: null } : null),
    }) as never, noScopeOverride as never);
    const d = await svc.resolve(ctx({ location_id: 'locC', domain: 'fm' }));
    expect(d.target).toEqual({ kind: 'team', team_id: 'fm-shared' });
    expect(d.chosen_by).toBe('space_group_team');
  });

  it('Scenario 3: fixed owner by request type', async () => {
    const svc = new ResolverService(repo({
      loadRequestType: jest.fn().mockResolvedValue({
        id: 'rt', domain: 'catering', fulfillment_strategy: 'fixed',
        default_team_id: 'catering-desk', default_vendor_id: null, asset_type_filter: [],
      }),
    }) as never, noScopeOverride as never);
    const d = await svc.resolve(ctx({ domain: 'catering' }));
    expect(d.target).toEqual({ kind: 'team', team_id: 'catering-desk' });
    expect(d.chosen_by).toBe('request_type_default');
  });

  it('Scenario 5a: fallback via parent-space walk', async () => {
    const svc = new ResolverService(repo({
      loadRequestType: jest.fn().mockResolvedValue({
        id: 'rt', domain: 'doors', fulfillment_strategy: 'location',
        default_team_id: null, default_vendor_id: null, asset_type_filter: [],
      }),
      locationChain: jest.fn().mockResolvedValue(['locC', 'region-west']),
      locationTeam: jest.fn(async (sid, dom) =>
        sid === 'region-west' && dom === 'doors' ? { team_id: 'region-west-doors', vendor_id: null } : null),
    }) as never, noScopeOverride as never);
    const d = await svc.resolve(ctx({ location_id: 'locC', domain: 'doors' }));
    expect(d.target).toEqual({ kind: 'team', team_id: 'region-west-doors' });
    expect(d.chosen_by).toBe('parent_location_team');
  });

  it('Scenario 5b: cross-domain fallback via domain hierarchy', async () => {
    const svc = new ResolverService(repo({
      loadRequestType: jest.fn().mockResolvedValue({
        id: 'rt', domain: 'doors', fulfillment_strategy: 'location',
        default_team_id: null, default_vendor_id: null, asset_type_filter: [],
      }),
      locationChain: jest.fn().mockResolvedValue(['locC', 'region-west']),
      domainChain: jest.fn().mockResolvedValue(['doors', 'fm']),
      locationTeam: jest.fn(async (sid, dom) =>
        sid === 'region-west' && dom === 'fm' ? { team_id: 'region-west-fm', vendor_id: null } : null),
    }) as never, noScopeOverride as never);
    const d = await svc.resolve(ctx({ location_id: 'locC', domain: 'doors' }));
    expect(d.target).toEqual({ kind: 'team', team_id: 'region-west-fm' });
    expect(d.chosen_by).toBe('domain_fallback');
  });

  it('Scenario 6: building-specific vendor override wins over default', async () => {
    const svc = new ResolverService(repo({
      loadRequestType: jest.fn().mockResolvedValue({
        id: 'rt', domain: 'fm', fulfillment_strategy: 'location',
        default_team_id: 'fm-shared', default_vendor_id: null, asset_type_filter: [],
      }),
      locationChain: jest.fn().mockResolvedValue(['A1', 'campus']),
      locationTeam: jest.fn(async (sid, dom) =>
        sid === 'A1' && dom === 'fm' ? { team_id: null, vendor_id: 'vendor-Z' } : null),
    }) as never, noScopeOverride as never);
    const d = await svc.resolve(ctx({ location_id: 'A1', domain: 'fm' }));
    expect(d.target).toEqual({ kind: 'vendor', vendor_id: 'vendor-Z' });
    expect(d.chosen_by).toBe('location_team');
  });

  it.skip('Scenario 7: visibility — deferred to a separate plan (list-endpoint scoping)', () => {});
});

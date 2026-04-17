/**
 * Scenario tests for the 7 canonical enterprise routing patterns.
 * Each `it` block documents the scenario and what's expected.
 * Pass = the current system handles it.
 * Fail/skip = documented gap.
 */
import { ResolverService } from './resolver.service';
import { ResolverContext } from './resolver.types';

function repo(over: Partial<Record<string, jest.Mock>> = {}) {
  return {
    loadRequestType: jest.fn().mockResolvedValue(null),
    loadAsset: jest.fn().mockResolvedValue(null),
    locationChain: jest.fn().mockResolvedValue([]),
    locationTeam: jest.fn().mockResolvedValue(null),
    ...over,
  };
}

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

describe('7 canonical enterprise routing scenarios', () => {
  // ─────────────────────────────────────────────────────────────
  // 1. Local team per location
  //    Location A → Service Desk A
  // ─────────────────────────────────────────────────────────────
  it('Scenario 1: local team per location', async () => {
    const svc = new ResolverService(repo({
      loadRequestType: jest.fn().mockResolvedValue({
        id: 'rt', domain: 'it', fulfillment_strategy: 'location',
        default_team_id: null, default_vendor_id: null, asset_type_filter: [],
      }),
      locationChain: jest.fn().mockResolvedValue(['locA']),
      locationTeam: jest.fn(async (sid, dom) =>
        sid === 'locA' && dom === 'it' ? { team_id: 'service-desk-A', vendor_id: null } : null),
    }) as never);

    const d = await svc.resolve(ctx({ location_id: 'locA', domain: 'it' }));
    expect(d.target).toEqual({ kind: 'team', team_id: 'service-desk-A' });
    expect(d.chosen_by).toBe('location_team');
  });

  // ─────────────────────────────────────────────────────────────
  // 2. Shared team across multiple locations
  //    Locations B, C, D → FM Shared
  //    Handled via parent-space walk OR by seeding per-location rows.
  // ─────────────────────────────────────────────────────────────
  it('Scenario 2a: shared team via parent-space walk (ergonomic)', async () => {
    // B is under "Region East", which has FM Shared
    const svc = new ResolverService(repo({
      loadRequestType: jest.fn().mockResolvedValue({
        id: 'rt', domain: 'fm', fulfillment_strategy: 'location',
        default_team_id: null, default_vendor_id: null, asset_type_filter: [],
      }),
      locationChain: jest.fn().mockResolvedValue(['locB', 'region-east']),
      locationTeam: jest.fn(async (sid, dom) =>
        sid === 'region-east' && dom === 'fm' ? { team_id: 'fm-shared', vendor_id: null } : null),
    }) as never);

    const d = await svc.resolve(ctx({ location_id: 'locB', domain: 'fm' }));
    expect(d.target).toEqual({ kind: 'team', team_id: 'fm-shared' });
    expect(d.chosen_by).toBe('parent_location_team');
  });

  it('Scenario 2b: shared team when locations have NO common ancestor (not ergonomic)', async () => {
    // B and C are under separate campuses — no common parent.
    // Admin has to seed an explicit location_teams row for each.
    const svc = new ResolverService(repo({
      loadRequestType: jest.fn().mockResolvedValue({
        id: 'rt', domain: 'fm', fulfillment_strategy: 'location',
        default_team_id: null, default_vendor_id: null, asset_type_filter: [],
      }),
      locationChain: jest.fn().mockResolvedValue(['locC']), // no parent
      locationTeam: jest.fn(async (sid, dom) =>
        sid === 'locC' && dom === 'fm' ? { team_id: 'fm-shared', vendor_id: null } : null),
    }) as never);

    const d = await svc.resolve(ctx({ location_id: 'locC', domain: 'fm' }));
    expect(d.target).toEqual({ kind: 'team', team_id: 'fm-shared' });
    // Works — but admin had to write per-location rows. No "space group" abstraction.
  });

  // ─────────────────────────────────────────────────────────────
  // 3. Request-type-specific owner
  //    Catering always → Catering Desk
  // ─────────────────────────────────────────────────────────────
  it('Scenario 3: fixed owner by request type', async () => {
    const svc = new ResolverService(repo({
      loadRequestType: jest.fn().mockResolvedValue({
        id: 'rt', domain: 'catering', fulfillment_strategy: 'fixed',
        default_team_id: 'catering-desk', default_vendor_id: null, asset_type_filter: [],
      }),
    }) as never);

    const d = await svc.resolve(ctx({ domain: 'catering' }));
    expect(d.target).toEqual({ kind: 'team', team_id: 'catering-desk' });
    expect(d.chosen_by).toBe('request_type_default');
  });

  // ─────────────────────────────────────────────────────────────
  // 4. Owner + Vendor split
  //    FM A owns (accountability), Vendor X executes (does the work)
  //    GAP: current model returns ONE assignee, not two.
  // ─────────────────────────────────────────────────────────────
  it('Scenario 4: FAILS — resolver returns ONE target; no owner/executor split', async () => {
    // Admin wants: owner = fm-team-A, executor = vendor-X.
    // With current schema, you can only express one of these.
    // Say the request type picks the vendor (via asset type default vendor):
    const svc = new ResolverService(repo({
      loadRequestType: jest.fn().mockResolvedValue({
        id: 'rt', domain: 'fm', fulfillment_strategy: 'asset',
        default_team_id: 'fm-team-A', // intended OWNER
        default_vendor_id: null, asset_type_filter: [],
      }),
      loadAsset: jest.fn().mockResolvedValue({
        id: 'a1', asset_type_id: 'elevator-type', assigned_space_id: 'building-A',
        override_team_id: null, override_vendor_id: null,
        type: { id: 'elevator-type', default_team_id: null, default_vendor_id: 'vendor-X' }, // intended EXECUTOR
      }),
    }) as never);

    const d = await svc.resolve(ctx({ asset_id: 'a1', domain: 'fm' }));

    // Current behavior: the resolver picks ONE — the asset-type default (vendor).
    expect(d.target).toEqual({ kind: 'vendor', vendor_id: 'vendor-X' });
    expect(d.chosen_by).toBe('asset_type_default');

    // What's MISSING: there's no `owner` field in the decision.
    // Real enterprise flow: owner=fm-team-A oversees, vendor-X executes, both show on the ticket.
    // This cannot be expressed without schema changes (ticket_assignments table with roles).
    expect((d as unknown as { owner?: unknown }).owner).toBeUndefined();
  });

  // ─────────────────────────────────────────────────────────────
  // 5. Fallback when no exact match exists
  //    Location C + Doors → Region West FM
  // ─────────────────────────────────────────────────────────────
  it('Scenario 5a: fallback via parent-space walk (works)', async () => {
    // C has no specific "doors" team; walks up to Region West which has one.
    const svc = new ResolverService(repo({
      loadRequestType: jest.fn().mockResolvedValue({
        id: 'rt', domain: 'doors', fulfillment_strategy: 'location',
        default_team_id: null, default_vendor_id: null, asset_type_filter: [],
      }),
      locationChain: jest.fn().mockResolvedValue(['locC', 'region-west']),
      locationTeam: jest.fn(async (sid, dom) =>
        sid === 'region-west' && dom === 'doors' ? { team_id: 'region-west-fm', vendor_id: null } : null),
    }) as never);

    const d = await svc.resolve(ctx({ location_id: 'locC', domain: 'doors' }));
    expect(d.target).toEqual({ kind: 'team', team_id: 'region-west-fm' });
    expect(d.chosen_by).toBe('parent_location_team');
  });

  it('Scenario 5b: PARTIAL — no fallback from sub-domain to parent domain', async () => {
    // If Region West only has an "fm" team (not a "doors" team),
    // a ticket with domain="doors" should conceptually fall back to "fm".
    // Current behavior: domain match is exact string. No hierarchy.
    const svc = new ResolverService(repo({
      loadRequestType: jest.fn().mockResolvedValue({
        id: 'rt', domain: 'doors', fulfillment_strategy: 'location',
        default_team_id: null, default_vendor_id: null, asset_type_filter: [],
      }),
      locationChain: jest.fn().mockResolvedValue(['locC', 'region-west']),
      locationTeam: jest.fn(async (sid, dom) =>
        // ONLY has an fm entry, not a doors entry
        sid === 'region-west' && dom === 'fm' ? { team_id: 'region-west-fm', vendor_id: null } : null),
    }) as never);

    const d = await svc.resolve(ctx({ location_id: 'locC', domain: 'doors' }));

    // Current resolver can't match → unassigned.
    // Would need either: seed (region-west, doors, region-west-fm) explicitly,
    // OR introduce domain hierarchy ("doors" → parent "fm").
    expect(d.target).toBeNull();
    expect(d.chosen_by).toBe('unassigned');
  });

  // ─────────────────────────────────────────────────────────────
  // 6. Exception override
  //    Building A1 uses Vendor Z instead of default
  // ─────────────────────────────────────────────────────────────
  it('Scenario 6: building-specific vendor override wins over default', async () => {
    // Default for fm is fm-shared. But A1 explicitly uses Vendor Z.
    const svc = new ResolverService(repo({
      loadRequestType: jest.fn().mockResolvedValue({
        id: 'rt', domain: 'fm', fulfillment_strategy: 'location',
        default_team_id: 'fm-shared', default_vendor_id: null, asset_type_filter: [],
      }),
      locationChain: jest.fn().mockResolvedValue(['A1', 'campus']),
      locationTeam: jest.fn(async (sid, dom) =>
        sid === 'A1' && dom === 'fm' ? { team_id: null, vendor_id: 'vendor-Z' } : null),
    }) as never);

    const d = await svc.resolve(ctx({ location_id: 'A1', domain: 'fm' }));
    // Most-specific match wins over RT default.
    expect(d.target).toEqual({ kind: 'vendor', vendor_id: 'vendor-Z' });
    expect(d.chosen_by).toBe('location_team');
  });

  // ─────────────────────────────────────────────────────────────
  // 7. Visibility rules independent of assignment
  //    Central desk sees A+B, local team sees only own location
  //    GAP: this is a query-layer concern; resolver has nothing to say.
  //    See separate integration note below.
  // ─────────────────────────────────────────────────────────────
  it.skip('Scenario 7: visibility rules — NOT IN RESOLVER (see ticket list endpoint)', () => {
    // Visibility is not routing. The /tickets list endpoint currently returns
    // everything in the tenant — no per-user, per-team, or per-location scoping.
    // See verification in scenarios.spec.ts analysis: no .or(`assigned_team_id.in(...)`)
    // style filter exists on TicketService.list.
  });
});

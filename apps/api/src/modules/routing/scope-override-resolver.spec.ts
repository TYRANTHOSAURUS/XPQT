/**
 * Scope-override integration in ResolverService. The SQL-side precedence
 * resolution is tested against the live DB in migration smoke checks; these
 * tests pin the ResolverService behavior when the effective-override service
 * returns a specific row.
 */
import { ResolverService } from './resolver.service';
import { ResolverContext } from './resolver.types';

function repo() {
  return {
    loadRequestType: jest.fn().mockResolvedValue({
      id: 'rt1', domain: 'it', fulfillment_strategy: 'location',
      default_team_id: 'fallback-team', default_vendor_id: null, asset_type_filter: [],
    }),
    loadAsset: jest.fn().mockResolvedValue(null),
    locationChain: jest.fn().mockResolvedValue(['loc1']),
    locationTeam: jest.fn().mockResolvedValue({ team_id: 'loc-team', vendor_id: null }),
    spaceGroupTeam: jest.fn().mockResolvedValue(null),
    domainChain: jest.fn(async (_t: string, d: string) => (d ? [d] : [])),
    loadRoutingRules: jest.fn().mockResolvedValue([]),
  };
}

function ctx(over: Partial<ResolverContext> = {}): ResolverContext {
  return {
    tenant_id: 't1', ticket_id: 'tk1', request_type_id: 'rt1',
    domain: 'it', priority: 'medium', asset_id: null, location_id: 'loc1', ...over,
  };
}

describe('ResolverService scope-override pre-step', () => {
  it('passes through to the normal chain when no override matches', async () => {
    const svc = new ResolverService(
      repo() as never,
      { resolve: jest.fn().mockResolvedValue(null) } as never,
    );
    const d = await svc.resolve(ctx());
    expect(d.chosen_by).toBe('location_team');
    expect(d.target).toEqual({ kind: 'team', team_id: 'loc-team' });
  });

  it('returns scope_override with team target when handler_kind=team', async () => {
    const svc = new ResolverService(
      repo() as never,
      {
        resolve: jest.fn().mockResolvedValue({
          id: 'ov1', scope_kind: 'space', space_id: 'loc1', space_group_id: null,
          inherit_to_descendants: true, starts_at: null, ends_at: null,
          handler_kind: 'team', handler_team_id: 'override-team',
          handler_vendor_id: null, workflow_definition_id: null,
          case_sla_policy_id: null, case_owner_policy_entity_id: null,
          child_dispatch_policy_entity_id: null, executor_sla_policy_id: null,
          precedence: 'exact_space',
        }),
      } as never,
    );
    const d = await svc.resolve(ctx());
    expect(d.chosen_by).toBe('scope_override');
    expect(d.target).toEqual({ kind: 'team', team_id: 'override-team' });
    expect(d.trace[0].step).toBe('scope_override');
    expect(d.trace[0].reason).toContain('exact_space');
  });

  it('returns scope_override with vendor target when handler_kind=vendor', async () => {
    const svc = new ResolverService(
      repo() as never,
      {
        resolve: jest.fn().mockResolvedValue({
          id: 'ov1', scope_kind: 'tenant', space_id: null, space_group_id: null,
          inherit_to_descendants: true, starts_at: null, ends_at: null,
          handler_kind: 'vendor', handler_team_id: null,
          handler_vendor_id: 'override-vendor', workflow_definition_id: null,
          case_sla_policy_id: null, case_owner_policy_entity_id: null,
          child_dispatch_policy_entity_id: null, executor_sla_policy_id: null,
          precedence: 'tenant',
        }),
      } as never,
    );
    const d = await svc.resolve(ctx());
    expect(d.chosen_by).toBe('scope_override');
    expect(d.target).toEqual({ kind: 'vendor', vendor_id: 'override-vendor' });
  });

  it('returns scope_override_unassigned with null target when handler_kind=none', async () => {
    const svc = new ResolverService(
      repo() as never,
      {
        resolve: jest.fn().mockResolvedValue({
          id: 'ov1', scope_kind: 'space', space_id: 'loc1', space_group_id: null,
          inherit_to_descendants: true, starts_at: null, ends_at: null,
          handler_kind: 'none', handler_team_id: null, handler_vendor_id: null,
          workflow_definition_id: null, case_sla_policy_id: null,
          case_owner_policy_entity_id: null, child_dispatch_policy_entity_id: null,
          executor_sla_policy_id: null, precedence: 'exact_space',
        }),
      } as never,
    );
    const d = await svc.resolve(ctx());
    expect(d.chosen_by).toBe('scope_override_unassigned');
    expect(d.target).toBeNull();
    expect(d.trace[0].step).toBe('scope_override_unassigned');
  });

  it('falls through to the normal chain when handler_kind is null (workflow/SLA only override)', async () => {
    const svc = new ResolverService(
      repo() as never,
      {
        resolve: jest.fn().mockResolvedValue({
          id: 'ov1', scope_kind: 'tenant', space_id: null, space_group_id: null,
          inherit_to_descendants: true, starts_at: null, ends_at: null,
          handler_kind: null, handler_team_id: null, handler_vendor_id: null,
          workflow_definition_id: 'wf-override',  // non-handler override
          case_sla_policy_id: null, case_owner_policy_entity_id: null,
          child_dispatch_policy_entity_id: null, executor_sla_policy_id: null,
          precedence: 'tenant',
        }),
      } as never,
    );
    const d = await svc.resolve(ctx());
    expect(d.chosen_by).toBe('location_team');
    expect(d.target).toEqual({ kind: 'team', team_id: 'loc-team' });
    // Trace still records the override was considered but didn't match on handler
    expect(d.trace.some((t) => t.step === 'scope_override' && !t.matched)).toBe(true);
  });
});

import { Injectable } from '@nestjs/common';
import type {
  IntakeContext,
  NormalizedRoutingContext,
  ScopeSource,
} from '@prequest/shared';
import { ResolverRepository } from './resolver-repository';
import { DomainRegistryService } from './domain-registry.service';

/**
 * Workstream B / task WB-1: normalize intake into the shape every downstream
 * engine expects (Contract 1 in the improvement plan).
 *
 * Scope source selection during dual-run is deliberately minimal: if a request
 * came in with an explicit location, we trust it (`selected`); otherwise we
 * default to `requester_home` and leave `location_id` null. Once the studio UI
 * is live admins configure this per request type; until then the heuristic
 * matches what legacy tickets actually carry.
 *
 * Domain bridging: request_types.domain is still free text today. We look the
 * text up in `public.domains` via the registry and fall back to `null` if the
 * tenant hasn't backfilled yet (Artifact D step 5). A null `domain_id` is a
 * legitimate state during dual-run — the downstream engines can still match on
 * operational_scope alone.
 */

const MAX_SPACE_WALK = 12;

@Injectable()
export class IntakeScopingService {
  constructor(
    private readonly resolverRepo: ResolverRepository,
    private readonly domainRegistry: DomainRegistryService,
  ) {}

  async normalize(intake: IntakeContext): Promise<NormalizedRoutingContext> {
    const scope_source = pickScopeSource(intake);
    const location_id =
      scope_source === 'selected' || scope_source === 'manual'
        ? intake.selected_location_id
        : null;

    const operational_scope_chain = location_id
      ? await this.resolverRepo.locationChain(location_id)
      : [];
    const operational_scope_id = operational_scope_chain[0] ?? null;

    const domain_id = await this.resolveDomainId(intake);

    return {
      tenant_id: intake.tenant_id,
      request_type_id: intake.request_type_id,
      domain_id,
      priority: intake.priority,
      location_id,
      asset_id: intake.asset_id,
      scope_source,
      operational_scope_id,
      operational_scope_chain: operational_scope_chain.slice(0, MAX_SPACE_WALK),
      evaluated_at: intake.evaluated_at,
      active_support_window_id: null, // Workstream D adds time-window support
    };
  }

  private async resolveDomainId(intake: IntakeContext): Promise<string | null> {
    const rt = await this.resolverRepo.loadRequestType(intake.request_type_id);
    if (!rt?.domain) return null;
    const row = await this.domainRegistry.findByKey(intake.tenant_id, rt.domain);
    return row?.id ?? null;
  }
}

function pickScopeSource(intake: IntakeContext): ScopeSource {
  if (intake.selected_location_id) return 'selected';
  if (intake.asset_id) return 'asset_location';
  return 'requester_home';
}

import { Injectable } from '@nestjs/common';
import { ResolverRepository } from './resolver-repository';
import {
  AssignmentTarget,
  ChosenBy,
  FulfillmentShape,
  ResolverContext,
  ResolverDecision,
  TraceEntry,
} from './resolver.types';

@Injectable()
export class ResolverService {
  constructor(private readonly repo: ResolverRepository) {}

  async resolve(context: ResolverContext): Promise<ResolverDecision> {
    const trace: TraceEntry[] = [];
    const loaded = await this.hydrate(context);
    const shape: FulfillmentShape = loaded.request_type?.fulfillment_strategy ?? 'fixed';

    const record = (step: ChosenBy, target: AssignmentTarget | null, reason: string): AssignmentTarget | null => {
      trace.push({ step, matched: !!target, reason, target });
      return target;
    };

    if (shape === 'asset' || shape === 'auto') {
      const asset = loaded.asset;
      if (asset) {
        const override = this.pickTarget(asset.override_team_id, asset.override_vendor_id);
        if (record('asset_override', override, 'asset override')) {
          return this.done(trace, 'asset_override', shape, override as AssignmentTarget);
        }
        const typeDefault = this.pickTarget(asset.type.default_team_id, asset.type.default_vendor_id);
        if (record('asset_type_default', typeDefault, `asset type ${asset.asset_type_id}`)) {
          return this.done(trace, 'asset_type_default', shape, typeDefault as AssignmentTarget);
        }
      } else {
        trace.push({ step: 'asset_override', matched: false, reason: 'no asset in context', target: null });
      }
    }

    if ((shape === 'location' || shape === 'auto') && loaded.location_chain && context.domain) {
      const chain = loaded.location_chain;
      for (let i = 0; i < chain.length; i++) {
        const spaceId = chain[i];
        const hit = await this.repo.locationTeam(spaceId, context.domain);
        const target = hit ? this.pickTarget(hit.team_id, hit.vendor_id) : null;
        const step: ChosenBy = i === 0 ? 'location_team' : 'parent_location_team';
        if (record(step, target, `space ${spaceId} domain ${context.domain}`)) {
          return this.done(trace, step, shape, target as AssignmentTarget);
        }
      }
    }

    const rt = loaded.request_type;
    if (rt) {
      const rtDefault = this.pickTarget(rt.default_team_id, rt.default_vendor_id);
      if (record('request_type_default', rtDefault, `request type ${rt.id}`)) {
        return this.done(trace, 'request_type_default', shape, rtDefault as AssignmentTarget);
      }
    }

    trace.push({ step: 'unassigned', matched: true, reason: 'no candidates matched', target: null });
    return { target: null, chosen_by: 'unassigned', strategy: shape, trace };
  }

  private async hydrate(context: ResolverContext) {
    const request_type = context.request_type_id
      ? await this.repo.loadRequestType(context.request_type_id)
      : null;
    const asset = context.asset_id ? await this.repo.loadAsset(context.asset_id) : null;
    const primaryLocation = context.location_id ?? asset?.assigned_space_id ?? null;
    const location_chain = primaryLocation ? await this.repo.locationChain(primaryLocation) : [];
    context.loaded = { request_type, asset, location_chain };
    return context.loaded;
  }

  private pickTarget(team_id: string | null | undefined, vendor_id: string | null | undefined): AssignmentTarget | null {
    if (team_id) return { kind: 'team', team_id };
    if (vendor_id) return { kind: 'vendor', vendor_id };
    return null;
  }

  private done(trace: TraceEntry[], chosen_by: ChosenBy, strategy: FulfillmentShape, target: AssignmentTarget): ResolverDecision {
    return { target, chosen_by, strategy, trace };
  }
}

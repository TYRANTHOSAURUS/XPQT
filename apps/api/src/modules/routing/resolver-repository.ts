import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { LoadedAsset, LoadedRequestType } from './resolver.types';

@Injectable()
export class ResolverRepository {
  constructor(private readonly supabase: SupabaseService) {}

  async loadRequestType(id: string): Promise<LoadedRequestType | null> {
    const { data } = await this.supabase.admin
      .from('request_types')
      .select('id, domain, fulfillment_strategy, default_team_id, default_vendor_id, asset_type_filter')
      .eq('id', id)
      .maybeSingle();
    return (data as LoadedRequestType | null) ?? null;
  }

  async loadAsset(id: string): Promise<LoadedAsset | null> {
    const { data } = await this.supabase.admin
      .from('assets')
      .select(`
        id, asset_type_id, assigned_space_id, override_team_id, override_vendor_id,
        type:asset_types!assets_asset_type_id_fkey(id, default_team_id, default_vendor_id)
      `)
      .eq('id', id)
      .maybeSingle();
    if (!data) return null;
    const raw = data as Record<string, unknown>;
    const type = Array.isArray(raw.type) ? (raw.type as unknown[])[0] : raw.type;
    return { ...(raw as object), type } as LoadedAsset;
  }

  async locationChain(spaceId: string): Promise<string[]> {
    const chain: string[] = [];
    let current: string | null = spaceId;
    for (let i = 0; current && i < 10; i++) {
      chain.push(current);
      const result: { data: { parent_id: string | null } | null } = await this.supabase.admin
        .from('spaces')
        .select('parent_id')
        .eq('id', current)
        .maybeSingle();
      current = result.data?.parent_id ?? null;
    }
    return chain;
  }

  async locationTeam(
    spaceId: string,
    domain: string,
  ): Promise<{ team_id: string | null; vendor_id: string | null } | null> {
    const { data } = await this.supabase.admin
      .from('location_teams')
      .select('team_id, vendor_id')
      .eq('space_id', spaceId)
      .eq('domain', domain)
      .maybeSingle();
    return data as { team_id: string | null; vendor_id: string | null } | null;
  }
}

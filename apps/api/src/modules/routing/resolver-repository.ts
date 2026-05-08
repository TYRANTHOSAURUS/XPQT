import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import {
  LoadedAsset,
  LoadedRequestType,
  LocationTeamHit,
  RoutingRuleRecord,
} from './resolver.types';

@Injectable()
export class ResolverRepository {
  constructor(private readonly supabase: SupabaseService) {}

  async loadRequestType(id: string, tenantId: string): Promise<LoadedRequestType | null> {
    // Tenant filter is mandatory: supabase.admin bypasses RLS, so a foreign id
    // (smuggled FK or shared uuid across tenants) would otherwise leak through.
    // See commit 75ad3b0 for the analogous ticket-module fix.
    const { data } = await this.supabase.admin
      .from('request_types')
      .select('id, domain, domain_id, fulfillment_strategy, default_team_id, default_vendor_id, asset_type_filter')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    return (data as LoadedRequestType | null) ?? null;
  }

  async loadAsset(id: string, tenantId: string): Promise<LoadedAsset | null> {
    const { data } = await this.supabase.admin
      .from('assets')
      .select(`
        id, asset_type_id, assigned_space_id, override_team_id, override_vendor_id,
        type:asset_types!assets_asset_type_id_fkey(id, default_team_id, default_vendor_id)
      `)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (!data) return null;
    const raw = data as Record<string, unknown>;
    const type = Array.isArray(raw.type) ? (raw.type as unknown[])[0] : raw.type;
    return { ...(raw as object), type } as LoadedAsset;
  }

  async locationChain(spaceId: string, tenantId: string): Promise<string[]> {
    // Cross-tenant FK-smuggle path: a tenant whose space had its parent_id set
    // to a foreign tenant's space could otherwise walk into that tenant's
    // hierarchy. Each step in the chain re-asserts tenant_id.
    const chain: string[] = [];
    let current: string | null = spaceId;
    for (let i = 0; current && i < 10; i++) {
      chain.push(current);
      const result: { data: { parent_id: string | null } | null } = await this.supabase.admin
        .from('spaces')
        .select('parent_id')
        .eq('id', current)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      current = result.data?.parent_id ?? null;
    }
    return chain;
  }

  async locationTeam(spaceId: string, domain: string, tenantId: string): Promise<LocationTeamHit | null> {
    const { data } = await this.supabase.admin
      .from('location_teams')
      .select('team_id, vendor_id')
      .eq('space_id', spaceId)
      .eq('domain', domain)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    return (data as LocationTeamHit | null) ?? null;
  }

  async spaceGroupTeam(spaceId: string, domain: string, tenantId: string): Promise<LocationTeamHit | null> {
    const { data: memberships } = await this.supabase.admin
      .from('space_group_members')
      .select('space_group_id')
      .eq('space_id', spaceId)
      .eq('tenant_id', tenantId);
    const groupIds = (memberships ?? []).map((m) => (m as { space_group_id: string }).space_group_id);
    if (groupIds.length === 0) return null;

    const { data } = await this.supabase.admin
      .from('location_teams')
      .select('team_id, vendor_id')
      .in('space_group_id', groupIds)
      .eq('domain', domain)
      .eq('tenant_id', tenantId)
      .limit(1)
      .maybeSingle();
    return (data as LocationTeamHit | null) ?? null;
  }

  async domainChain(tenantId: string, domain: string): Promise<string[]> {
    const chain: string[] = [domain];
    let current = domain;
    for (let i = 0; i < 10; i++) {
      const { data } = await this.supabase.admin
        .from('domain_parents')
        .select('parent_domain')
        .eq('tenant_id', tenantId)
        .eq('domain', current)
        .maybeSingle();
      const parent = (data as { parent_domain: string } | null)?.parent_domain;
      if (!parent || chain.includes(parent)) break;
      chain.push(parent);
      current = parent;
    }
    return chain;
  }

  async loadRoutingRules(tenantId: string): Promise<RoutingRuleRecord[]> {
    const { data } = await this.supabase.admin
      .from('routing_rules')
      .select('id, name, priority, conditions, action_assign_team_id, action_assign_user_id')
      .eq('tenant_id', tenantId)
      .eq('active', true)
      .order('priority', { ascending: false });
    return (data as RoutingRuleRecord[] | null) ?? [];
  }
}

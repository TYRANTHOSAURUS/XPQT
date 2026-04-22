import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

export interface CreateServiceItemDto {
  key: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  search_terms?: string[];
  kb_link?: string | null;
  disruption_banner?: string | null;
  on_behalf_policy?: 'self_only' | 'any_person' | 'direct_reports' | 'configured_list';
  fulfillment_type_id: string;
  display_order?: number;
  active?: boolean;
}

export interface UpdateServiceItemDto extends Partial<CreateServiceItemDto> {}

export interface OfferingDto {
  scope_kind: 'tenant' | 'space' | 'space_group';
  space_id?: string | null;
  space_group_id?: string | null;
  inherit_to_descendants?: boolean;
  starts_at?: string | null;
  ends_at?: string | null;
  active?: boolean;
}

/**
 * Phase-3 admin CRUD for service_items + their offerings, criteria bindings,
 * form variants, and on-behalf rules. RLS is tenant-scoped; permission gates
 * live in the controller via PermissionGuard('service_catalog:manage').
 * See docs/service-catalog-redesign.md §5.3.
 */
@Injectable()
export class ServiceItemService {
  constructor(private readonly supabase: SupabaseService) {}

  async list() {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('service_items')
      .select(`
        *,
        categories:service_item_categories(category_id),
        offerings:service_item_offerings(id, scope_kind, space_id, space_group_id, inherit_to_descendants, active)
      `)
      .eq('tenant_id', tenant.id)
      .order('display_order')
      .order('name');
    if (error) throw error;
    return data;
  }

  async getByRequestTypeId(requestTypeId: string) {
    const tenant = TenantContext.current();
    const { data } = await this.supabase.admin
      .from('request_type_service_item_bridge')
      .select('service_item_id')
      .eq('request_type_id', requestTypeId)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    const sid = (data as { service_item_id: string } | null)?.service_item_id;
    if (!sid) throw new NotFoundException('No paired service item for this request type');
    return this.getById(sid);
  }

  async getById(id: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('service_items')
      .select(`
        *,
        categories:service_item_categories(id, category_id, display_order),
        offerings:service_item_offerings(*),
        criteria:service_item_criteria(*),
        form_variants:service_item_form_variants(*),
        on_behalf_rules:service_item_on_behalf_rules(*)
      `)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new NotFoundException('Service item not found');
    return data;
  }

  async create(dto: CreateServiceItemDto) {
    const tenant = TenantContext.current();
    if (!dto.key || !dto.name || !dto.fulfillment_type_id) {
      throw new BadRequestException('key, name, and fulfillment_type_id are required');
    }
    const { data, error } = await this.supabase.admin
      .from('service_items')
      .insert({
        tenant_id: tenant.id,
        key: dto.key,
        name: dto.name,
        description: dto.description ?? null,
        icon: dto.icon ?? null,
        search_terms: dto.search_terms ?? [],
        kb_link: dto.kb_link ?? null,
        disruption_banner: dto.disruption_banner ?? null,
        on_behalf_policy: dto.on_behalf_policy ?? 'self_only',
        fulfillment_type_id: dto.fulfillment_type_id,
        display_order: dto.display_order ?? 0,
        active: dto.active ?? true,
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async update(id: string, dto: UpdateServiceItemDto) {
    const tenant = TenantContext.current();
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(dto)) {
      if (v !== undefined) patch[k] = v;
    }
    if (Object.keys(patch).length === 0) return this.getById(id);
    const { data, error } = await this.supabase.admin
      .from('service_items')
      .update(patch)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async remove(id: string) {
    const tenant = TenantContext.current();
    // Soft-delete per design §11. Flip active=false rather than DELETE —
    // preserves ticket references + audit trail.
    const { error } = await this.supabase.admin
      .from('service_items')
      .update({ active: false })
      .eq('id', id)
      .eq('tenant_id', tenant.id);
    if (error) throw error;
    return { ok: true };
  }

  // ── Offerings (replace-set) ──────────────────────────────────────────

  async putOfferings(serviceItemId: string, offerings: OfferingDto[]) {
    const tenant = TenantContext.current();
    // Replace-set pattern: DELETE existing + INSERT new within a single RPC
    // is atomic-enough for admin authoring. Future work can move this into
    // a PL/pgSQL function for stronger transactional guarantees.
    for (const o of offerings) {
      this.validateOfferingShape(o);
    }
    const del = await this.supabase.admin
      .from('service_item_offerings')
      .delete()
      .eq('service_item_id', serviceItemId)
      .eq('tenant_id', tenant.id);
    if (del.error) throw del.error;
    if (offerings.length === 0) return { ok: true, inserted: 0 };

    const rows = offerings.map((o) => ({
      tenant_id: tenant.id,
      service_item_id: serviceItemId,
      scope_kind: o.scope_kind,
      space_id: o.space_id ?? null,
      space_group_id: o.space_group_id ?? null,
      inherit_to_descendants: o.inherit_to_descendants ?? true,
      starts_at: o.starts_at ?? null,
      ends_at: o.ends_at ?? null,
      active: o.active ?? true,
    }));
    const { error, count } = await this.supabase.admin
      .from('service_item_offerings')
      .insert(rows, { count: 'exact' });
    if (error) throw error;
    return { ok: true, inserted: count ?? rows.length };
  }

  private validateOfferingShape(o: OfferingDto) {
    if (o.scope_kind === 'tenant' && (o.space_id || o.space_group_id)) {
      throw new BadRequestException('tenant scope must have no space_id or space_group_id');
    }
    if (o.scope_kind === 'space' && !o.space_id) {
      throw new BadRequestException('space scope requires space_id');
    }
    if (o.scope_kind === 'space_group' && !o.space_group_id) {
      throw new BadRequestException('space_group scope requires space_group_id');
    }
  }

  // ── Categories (replace-set) ─────────────────────────────────────────

  /**
   * Coverage matrix data for the catalog Sheet. Returns every active
   * site/building in the tenant paired with:
   *  - the matching offering (if any) for this service_item
   *  - reachability of a team/vendor for the fulfillment's domain, walking
   *    location_teams + space parents + domain_parents + RT defaults
   *
   * One round trip for the admin UI. See docs/service-catalog-redesign.md §5.6.
   */
  async getCoverageMatrix(serviceItemId: string) {
    const tenant = TenantContext.current();

    const { data: siRow } = await this.supabase.admin
      .from('service_items')
      .select('id, fulfillment_type_id')
      .eq('id', serviceItemId)
      .eq('tenant_id', tenant.id)
      .single();
    if (!siRow) throw new NotFoundException('Service item not found');
    const fulfillmentTypeId = (siRow as { fulfillment_type_id: string }).fulfillment_type_id;

    const { data: ftRow } = await this.supabase.admin
      .from('request_types')
      .select('id, domain, default_team_id, default_vendor_id')
      .eq('id', fulfillmentTypeId)
      .eq('tenant_id', tenant.id)
      .single();
    const ft = ftRow as { id: string; domain: string | null; default_team_id: string | null; default_vendor_id: string | null };

    // Load active sites/buildings in the tenant.
    const { data: sitesRows } = await this.supabase.admin
      .from('spaces')
      .select('id, name, type, parent_id')
      .eq('tenant_id', tenant.id)
      .eq('active', true)
      .in('type', ['site', 'building'])
      .order('name');
    const sites = (sitesRows ?? []) as Array<{ id: string; name: string; type: string; parent_id: string | null }>;

    // Load active offerings for this service item.
    const { data: offeringRows } = await this.supabase.admin
      .from('service_item_offerings')
      .select('*')
      .eq('service_item_id', serviceItemId)
      .eq('tenant_id', tenant.id)
      .eq('active', true);
    const offerings = (offeringRows ?? []) as Array<{
      id: string; scope_kind: 'tenant' | 'space' | 'space_group';
      space_id: string | null; space_group_id: string | null;
      inherit_to_descendants: boolean; starts_at: string | null; ends_at: string | null;
    }>;

    // Domain chain for reachability checks.
    const domainChain: string[] = [];
    if (ft.domain) {
      domainChain.push(ft.domain);
      let current = ft.domain;
      for (let i = 0; i < 10; i += 1) {
        const { data } = await this.supabase.admin
          .from('domain_parents')
          .select('parent_domain')
          .eq('tenant_id', tenant.id)
          .eq('domain', current)
          .maybeSingle();
        const parent = (data as { parent_domain: string } | null)?.parent_domain;
        if (!parent || domainChain.includes(parent)) break;
        domainChain.push(parent);
        current = parent;
      }
    }

    // Location_teams for (any site or its ancestors) × domain_chain. Preload once.
    const { data: ltRows } = await this.supabase.admin
      .from('location_teams')
      .select('id, space_id, space_group_id, domain, team_id, vendor_id, team:teams(id, name), vendor:vendors(id, name)')
      .eq('tenant_id', tenant.id)
      .in('domain', domainChain.length > 0 ? domainChain : ['__none__']);
    const locationTeams = (ltRows ?? []) as Array<{
      id: string; space_id: string | null; space_group_id: string | null; domain: string;
      team_id: string | null; vendor_id: string | null;
      team: { id: string; name: string } | { id: string; name: string }[] | null;
      vendor: { id: string; name: string } | { id: string; name: string }[] | null;
    }>;

    // Space group memberships for sites (lazy if needed).
    const { data: groupRows } = await this.supabase.admin
      .from('space_group_members')
      .select('space_group_id, space_id')
      .eq('tenant_id', tenant.id);
    const groupMembersBySite = new Map<string, string[]>();
    for (const m of ((groupRows ?? []) as Array<{ space_group_id: string; space_id: string }>)) {
      if (!groupMembersBySite.has(m.space_id)) groupMembersBySite.set(m.space_id, []);
      groupMembersBySite.get(m.space_id)!.push(m.space_group_id);
    }

    // Parent chains. For each site, walk up via parent_id.
    const parentBySite = new Map<string, string | null>();
    for (const s of sites) parentBySite.set(s.id, s.parent_id);
    const spaceChain = (spaceId: string): string[] => {
      const chain: string[] = [];
      let cur: string | null | undefined = spaceId;
      for (let i = 0; i < 12 && cur; i += 1) {
        chain.push(cur);
        cur = parentBySite.get(cur);
      }
      return chain;
    };

    // For each site, compute: matching offering + reachability.
    const tenantOffering = offerings.find((o) => o.scope_kind === 'tenant') ?? null;

    const rows = sites.map((site) => {
      // Matching offering: explicit space match (with inheritance) → space-group match → tenant.
      let matched: typeof offerings[number] | null = null;
      for (const o of offerings) {
        if (o.scope_kind !== 'space') continue;
        if (o.space_id === site.id) { matched = o; break; }
        if (o.inherit_to_descendants && o.space_id && spaceChain(site.id).includes(o.space_id)) { matched = o; break; }
      }
      if (!matched) {
        const groups = groupMembersBySite.get(site.id) ?? [];
        matched = offerings.find((o) => o.scope_kind === 'space_group' && o.space_group_id && groups.includes(o.space_group_id)) ?? null;
      }
      if (!matched) matched = tenantOffering;

      // Reachability: walk space chain × domain chain; fall back to RT defaults.
      let reachable = false;
      let reachable_via: 'location_team' | 'space_group' | 'rt_default' | null = null;
      let handler_kind: 'team' | 'vendor' | null = null;
      let handler_id: string | null = null;
      let handler_name: string | null = null;

      if (domainChain.length > 0 && locationTeams.length > 0) {
        const chain = spaceChain(site.id);
        const groups = groupMembersBySite.get(site.id) ?? [];
        outer: for (const dom of domainChain) {
          for (const sp of chain) {
            const hit = locationTeams.find((lt) => lt.domain === dom && lt.space_id === sp);
            if (hit) {
              reachable = true;
              reachable_via = 'location_team';
              if (hit.team_id) {
                handler_kind = 'team';
                handler_id = hit.team_id;
                const teamObj = Array.isArray(hit.team) ? hit.team[0] : hit.team;
                handler_name = teamObj?.name ?? null;
              } else if (hit.vendor_id) {
                handler_kind = 'vendor';
                handler_id = hit.vendor_id;
                const vendorObj = Array.isArray(hit.vendor) ? hit.vendor[0] : hit.vendor;
                handler_name = vendorObj?.name ?? null;
              }
              break outer;
            }
          }
          for (const gid of groups) {
            const hit = locationTeams.find((lt) => lt.domain === dom && lt.space_group_id === gid);
            if (hit) {
              reachable = true;
              reachable_via = 'space_group';
              if (hit.team_id) {
                handler_kind = 'team';
                handler_id = hit.team_id;
                const teamObj = Array.isArray(hit.team) ? hit.team[0] : hit.team;
                handler_name = teamObj?.name ?? null;
              } else if (hit.vendor_id) {
                handler_kind = 'vendor';
                handler_id = hit.vendor_id;
                const vendorObj = Array.isArray(hit.vendor) ? hit.vendor[0] : hit.vendor;
                handler_name = vendorObj?.name ?? null;
              }
              break outer;
            }
          }
        }
      }
      if (!reachable) {
        if (ft.default_team_id) {
          reachable = true; reachable_via = 'rt_default'; handler_kind = 'team'; handler_id = ft.default_team_id;
        } else if (ft.default_vendor_id) {
          reachable = true; reachable_via = 'rt_default'; handler_kind = 'vendor'; handler_id = ft.default_vendor_id;
        }
      }

      return {
        site_id: site.id,
        site_name: site.name,
        site_type: site.type,
        offering: matched
          ? {
              id: matched.id,
              scope_kind: matched.scope_kind,
              inherit_to_descendants: matched.inherit_to_descendants,
              starts_at: matched.starts_at,
              ends_at: matched.ends_at,
            }
          : null,
        reachable,
        reachable_via,
        handler_kind,
        handler_id,
        handler_name,
      };
    });

    return {
      service_item_id: serviceItemId,
      fulfillment_type_id: fulfillmentTypeId,
      domain: ft.domain,
      domain_chain: domainChain,
      has_tenant_offering: !!tenantOffering,
      sites: rows,
    };
  }

  async putCategories(serviceItemId: string, categoryIds: string[]) {
    const tenant = TenantContext.current();
    const del = await this.supabase.admin
      .from('service_item_categories')
      .delete()
      .eq('service_item_id', serviceItemId)
      .eq('tenant_id', tenant.id);
    if (del.error) throw del.error;
    if (categoryIds.length === 0) return { ok: true, inserted: 0 };

    const rows = categoryIds.map((cid, i) => ({
      tenant_id: tenant.id,
      service_item_id: serviceItemId,
      category_id: cid,
      display_order: i,
    }));
    const { error, count } = await this.supabase.admin
      .from('service_item_categories')
      .insert(rows, { count: 'exact' });
    if (error) throw error;
    return { ok: true, inserted: count ?? rows.length };
  }
}

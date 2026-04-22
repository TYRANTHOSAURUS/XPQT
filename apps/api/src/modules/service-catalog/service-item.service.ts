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

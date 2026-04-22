import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

export interface CreateMenuDto {
  vendor_id: string;
  space_id?: string | null;
  service_type: string;
  name: string;
  description?: string | null;
  effective_from: string;
  effective_until?: string | null;
  status?: 'draft' | 'published' | 'archived';
}

export interface CreateMenuItemDto {
  catalog_item_id: string;
  price: number;
  unit?: string;
  minimum_quantity?: number | null;
  maximum_quantity?: number | null;
  lead_time_hours?: number | null;
  available_days_of_week?: number[] | null;
  available_from_time?: string | null;
  available_until_time?: string | null;
}

export interface ResolveOfferDto {
  catalog_item_id: string;
  delivery_space_id: string;
  on_date?: string;
}

export interface DuplicateMenuDto {
  name?: string;
  effective_from: string;
  effective_until?: string | null;
  price_adjustment_percent?: number | null;
  price_adjustment_flat?: number | null;
  status?: 'draft' | 'published';
}

@Injectable()
export class CatalogMenuService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(filter: { vendor_id?: string; service_type?: string; status?: string } = {}) {
    const tenant = TenantContext.current();
    let q = this.supabase.admin
      .from('catalog_menus')
      .select('*, vendor:vendors(id, name), space:spaces(id, name, type)')
      .eq('tenant_id', tenant.id);
    if (filter.vendor_id) q = q.eq('vendor_id', filter.vendor_id);
    if (filter.service_type) q = q.eq('service_type', filter.service_type);
    if (filter.status) q = q.eq('status', filter.status);
    const { data, error } = await q.order('effective_from', { ascending: false });
    if (error) throw error;
    return data;
  }

  async get(id: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('catalog_menus')
      .select('*, vendor:vendors(id, name), space:spaces(id, name, type)')
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .single();
    if (error) throw error;
    return data;
  }

  async create(dto: CreateMenuDto) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('catalog_menus')
      .insert({
        ...dto,
        status: dto.status ?? 'draft',
        tenant_id: tenant.id,
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async update(id: string, dto: Partial<CreateMenuDto>) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('catalog_menus')
      .update(dto)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async listItems(menuId: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('menu_items')
      .select('*, catalog_item:catalog_items(id, name, category, subcategory, image_url)')
      .eq('menu_id', menuId)
      .eq('tenant_id', tenant.id)
      .order('created_at');
    if (error) throw error;
    return data;
  }

  async addItem(menuId: string, dto: CreateMenuItemDto) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('menu_items')
      .insert({ ...dto, menu_id: menuId, tenant_id: tenant.id })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async updateItem(menuId: string, itemId: string, dto: Partial<CreateMenuItemDto> & { active?: boolean }) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('menu_items')
      .update(dto)
      .eq('id', itemId)
      .eq('menu_id', menuId)
      .eq('tenant_id', tenant.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async removeItem(menuId: string, itemId: string) {
    const tenant = TenantContext.current();
    const { error } = await this.supabase.admin
      .from('menu_items')
      .delete()
      .eq('id', itemId)
      .eq('menu_id', menuId)
      .eq('tenant_id', tenant.id);
    if (error) throw error;
    return { removed: true };
  }

  async duplicate(id: string, dto: DuplicateMenuDto) {
    const tenant = TenantContext.current();
    const source = await this.get(id);

    const { data: newMenu, error: menuErr } = await this.supabase.admin
      .from('catalog_menus')
      .insert({
        tenant_id: tenant.id,
        vendor_id: source.vendor_id,
        space_id: source.space_id,
        service_type: source.service_type,
        name: dto.name ?? `${source.name} (copy)`,
        description: source.description,
        effective_from: dto.effective_from,
        effective_until: dto.effective_until ?? null,
        status: dto.status ?? 'draft',
      })
      .select()
      .single();
    if (menuErr) throw menuErr;

    const sourceItems = await this.listItems(id);
    if (sourceItems.length === 0) return newMenu;

    const pct = dto.price_adjustment_percent ?? 0;
    const flat = dto.price_adjustment_flat ?? 0;

    const newItems = sourceItems.map((it: Record<string, unknown>) => {
      const basePrice = Number(it.price);
      const adjusted = basePrice * (1 + pct / 100) + flat;
      return {
        tenant_id: tenant.id,
        menu_id: newMenu.id,
        catalog_item_id: it.catalog_item_id,
        price: Math.round(adjusted * 100) / 100,
        unit: it.unit,
        minimum_quantity: it.minimum_quantity,
        maximum_quantity: it.maximum_quantity,
        lead_time_hours: it.lead_time_hours,
        available_days_of_week: it.available_days_of_week,
        available_from_time: it.available_from_time,
        available_until_time: it.available_until_time,
        active: it.active,
      };
    });

    const { error: itemsErr } = await this.supabase.admin
      .from('menu_items')
      .insert(newItems);
    if (itemsErr) throw itemsErr;

    return newMenu;
  }

  async bulkUpdateItems(
    menuId: string,
    itemIds: string[],
    patch: {
      price_adjustment_percent?: number | null;
      price_adjustment_flat?: number | null;
      lead_time_hours?: number | null;
      unit?: string;
      active?: boolean;
    },
  ) {
    const tenant = TenantContext.current();
    const { data: existing, error: fetchErr } = await this.supabase.admin
      .from('menu_items')
      .select('id, price')
      .eq('menu_id', menuId)
      .eq('tenant_id', tenant.id)
      .in('id', itemIds);
    if (fetchErr) throw fetchErr;

    const pct = patch.price_adjustment_percent ?? 0;
    const flat = patch.price_adjustment_flat ?? 0;
    const hasPriceChange = pct !== 0 || flat !== 0;

    const updates = (existing ?? []).map((row) => {
      const update: Record<string, unknown> = { id: row.id };
      if (hasPriceChange) {
        const base = Number(row.price);
        update.price = Math.round((base * (1 + pct / 100) + flat) * 100) / 100;
      }
      if (patch.lead_time_hours !== undefined) update.lead_time_hours = patch.lead_time_hours;
      if (patch.unit !== undefined) update.unit = patch.unit;
      if (patch.active !== undefined) update.active = patch.active;
      return update;
    });

    for (const u of updates) {
      const { id, ...fields } = u;
      if (Object.keys(fields).length === 0) continue;
      const { error } = await this.supabase.admin
        .from('menu_items')
        .update(fields)
        .eq('id', id)
        .eq('menu_id', menuId)
        .eq('tenant_id', tenant.id);
      if (error) throw error;
    }
    return { updated: updates.length };
  }

  async bulkDeleteItems(menuId: string, itemIds: string[]) {
    const tenant = TenantContext.current();
    const { error } = await this.supabase.admin
      .from('menu_items')
      .delete()
      .eq('menu_id', menuId)
      .eq('tenant_id', tenant.id)
      .in('id', itemIds);
    if (error) throw error;
    return { removed: itemIds.length };
  }

  async listCatalogItems() {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('catalog_items')
      .select('id, name, category, subcategory, unit, image_url, active')
      .eq('tenant_id', tenant.id)
      .eq('active', true)
      .order('name');
    if (error) throw error;
    return data;
  }

  async resolveOffer(dto: ResolveOfferDto) {
    const { data, error } = await this.supabase.admin.rpc('resolve_menu_offer', {
      p_catalog_item_id: dto.catalog_item_id,
      p_delivery_space_id: dto.delivery_space_id,
      p_on_date: dto.on_date ?? new Date().toISOString().slice(0, 10),
    });
    if (error) throw error;
    return data?.[0] ?? null;
  }
}

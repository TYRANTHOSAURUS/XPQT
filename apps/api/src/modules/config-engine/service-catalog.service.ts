import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

@Injectable()
export class ServiceCatalogService {
  constructor(private readonly supabase: SupabaseService) {}

  async listCategories() {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('service_catalog_categories')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('active', true)
      .order('display_order');

    if (error) throw error;
    return data;
  }

  async getCategoryWithRequestTypes(categoryId: string) {
    const tenant = TenantContext.current();

    const { data: links, error } = await this.supabase.admin
      .from('request_type_categories')
      .select('request_type:request_types(*)')
      .eq('category_id', categoryId)
      .eq('tenant_id', tenant.id);

    if (error) throw error;
    return (links ?? []).map((l) => l.request_type);
  }

  async createCategory(dto: { name: string; description?: string; icon?: string; parent_category_id?: string; display_order?: number }) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('service_catalog_categories')
      .insert({ ...dto, tenant_id: tenant.id })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async updateCategory(id: string, dto: Record<string, unknown>) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('service_catalog_categories')
      .update(dto)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async deleteCategory(id: string) {
    const tenant = TenantContext.current();
    const { error } = await this.supabase.admin
      .from('service_catalog_categories')
      .update({ active: false })
      .eq('id', id)
      .eq('tenant_id', tenant.id);

    if (error) throw error;
    return { deleted: true };
  }

  async linkRequestTypeToCategory(requestTypeId: string, categoryId: string) {
    const tenant = TenantContext.current();
    const { error } = await this.supabase.admin
      .from('request_type_categories')
      .insert({ tenant_id: tenant.id, request_type_id: requestTypeId, category_id: categoryId });

    if (error) throw error;
    return { linked: true };
  }
}

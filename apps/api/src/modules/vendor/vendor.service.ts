import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

export interface CreateVendorDto {
  name: string;
  contact_email?: string | null;
  contact_phone?: string | null;
  website?: string | null;
  notes?: string | null;
  owning_team_id?: string | null;
}

export interface ServiceAreaDto {
  space_id: string;
  service_type: string;
  default_priority?: number;
  active?: boolean;
}

@Injectable()
export class VendorService {
  constructor(private readonly supabase: SupabaseService) {}

  async list() {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('vendors')
      .select('*, owning_team:teams(id, name)')
      .eq('tenant_id', tenant.id)
      .order('name');
    if (error) throw error;
    return data;
  }

  async get(id: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('vendors')
      .select('*, owning_team:teams(id, name)')
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .single();
    if (error) throw error;
    return data;
  }

  async create(dto: CreateVendorDto) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('vendors')
      .insert({ ...dto, tenant_id: tenant.id })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async update(id: string, dto: Partial<CreateVendorDto> & { active?: boolean }) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('vendors')
      .update(dto)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async listServiceAreas(vendorId: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('vendor_service_areas')
      .select('*, space:spaces(id, name, type)')
      .eq('vendor_id', vendorId)
      .eq('tenant_id', tenant.id)
      .order('service_type');
    if (error) throw error;
    return data;
  }

  async addServiceArea(vendorId: string, dto: ServiceAreaDto) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('vendor_service_areas')
      .insert({
        vendor_id: vendorId,
        space_id: dto.space_id,
        service_type: dto.service_type,
        default_priority: dto.default_priority ?? 100,
        active: dto.active ?? true,
        tenant_id: tenant.id,
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async removeServiceArea(vendorId: string, serviceAreaId: string) {
    const tenant = TenantContext.current();
    const { error } = await this.supabase.admin
      .from('vendor_service_areas')
      .delete()
      .eq('id', serviceAreaId)
      .eq('vendor_id', vendorId)
      .eq('tenant_id', tenant.id);
    if (error) throw error;
    return { removed: true };
  }
}

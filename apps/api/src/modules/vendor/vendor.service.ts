import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { wrapPgError } from '../../common/errors';

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
    if (error) {
      throw wrapPgError(error, 'vendor.list_failed', {
        detail: 'Vendor list query failed',
      });
    }
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
    if (error) {
      throw wrapPgError(error, 'vendor.lookup_failed', {
        detail: `Vendor lookup failed for id ${id}`,
        notFoundCode: 'vendor.not_found',
      });
    }
    return data;
  }

  async create(dto: CreateVendorDto) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('vendors')
      .insert({ ...dto, tenant_id: tenant.id })
      .select()
      .single();
    if (error) {
      // 23505 (unique vendor name within tenant) → 409 db.unique_violation.
      // 23503 (FK violation on owning_team_id) → 409 db.fk_violation.
      throw wrapPgError(error, 'vendor.create_failed', {
        detail: 'Vendor insert failed',
      });
    }
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
    if (error) {
      throw wrapPgError(error, 'vendor.update_failed', {
        detail: `Vendor update failed for id ${id}`,
        notFoundCode: 'vendor.not_found',
      });
    }
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
    if (error) {
      throw wrapPgError(error, 'vendor.service_area_list_failed', {
        detail: `Vendor service area list query failed for vendor ${vendorId}`,
      });
    }
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
    if (error) {
      // 23505 (already an area for this space/service_type) → 409.
      // 23503 (FK violation on vendor_id / space_id) → 409 db.fk_violation.
      throw wrapPgError(error, 'vendor.service_area_add_failed', {
        detail: `Vendor service area insert failed for vendor ${vendorId}`,
      });
    }
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
    if (error) {
      throw wrapPgError(error, 'vendor.service_area_remove_failed', {
        detail: `Vendor service area delete failed for vendor ${vendorId} area ${serviceAreaId}`,
      });
    }
    return { removed: true };
  }
}

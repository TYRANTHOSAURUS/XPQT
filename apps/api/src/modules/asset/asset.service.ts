import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

export interface CreateAssetDto {
  name: string;
  asset_type_id: string;
  asset_role: 'fixed' | 'personal' | 'pooled';
  tag?: string;
  serial_number?: string;
  status?: string;
  assigned_person_id?: string;
  assigned_space_id?: string;
  purchase_date?: string;
  lifecycle_state?: string;
}

export interface UpdateAssetDto extends Partial<CreateAssetDto> {}

export interface CreateAssetTypeDto {
  name: string;
  description?: string;
  default_role?: string;
}

@Injectable()
export class AssetService {
  constructor(private readonly supabase: SupabaseService) {}

  async listTypes() {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('asset_types')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('active', true)
      .order('name');
    if (error) throw error;
    return data;
  }

  async createType(dto: CreateAssetTypeDto) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('asset_types')
      .insert({ ...dto, tenant_id: tenant.id })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async list(filters?: { asset_role?: string; status?: string; search?: string }) {
    const tenant = TenantContext.current();
    let query = this.supabase.admin
      .from('assets')
      .select(`
        *,
        asset_type:asset_types(id, name),
        assigned_person:persons(id, first_name, last_name),
        assigned_space:spaces(id, name)
      `)
      .eq('tenant_id', tenant.id)
      .order('name');

    if (filters?.asset_role) query = query.eq('asset_role', filters.asset_role);
    if (filters?.status) query = query.eq('status', filters.status);
    if (filters?.search) query = query.ilike('name', `%${filters.search}%`);

    const { data, error } = await query;
    if (error) throw error;
    return data;
  }

  async getById(id: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('assets')
      .select(`
        *,
        asset_type:asset_types(id, name),
        assigned_person:persons(id, first_name, last_name),
        assigned_space:spaces(id, name)
      `)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .single();
    if (error) throw error;
    return data;
  }

  async create(dto: CreateAssetDto) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('assets')
      .insert({ ...dto, tenant_id: tenant.id })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async update(id: string, dto: UpdateAssetDto) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('assets')
      .update(dto)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async getHistory(assetId: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('asset_assignment_history')
      .select(`
        *,
        person:persons(id, first_name, last_name),
        space:spaces(id, name)
      `)
      .eq('asset_id', assetId)
      .eq('tenant_id', tenant.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  }
}

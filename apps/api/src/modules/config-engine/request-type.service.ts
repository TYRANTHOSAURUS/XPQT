import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

@Injectable()
export class RequestTypeService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(domain?: string) {
    const tenant = TenantContext.current();
    let query = this.supabase.admin
      .from('request_types')
      .select('*, sla_policy:sla_policies(*)')
      .eq('tenant_id', tenant.id)
      .eq('active', true)
      .order('name');

    if (domain) query = query.eq('domain', domain);

    const { data, error } = await query;
    if (error) throw error;
    return data;
  }

  async getById(id: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('request_types')
      .select('*, sla_policy:sla_policies(*), workflow:workflow_definitions(*)')
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .single();

    if (error) throw error;
    return data;
  }

  async create(dto: {
    name: string;
    domain?: string;
    form_schema_id?: string;
    workflow_definition_id?: string;
    sla_policy_id?: string;
    fulfillment_strategy?: 'asset' | 'location' | 'fixed' | 'auto';
    requires_asset?: boolean;
    asset_required?: boolean;
    asset_type_filter?: string[];
    requires_location?: boolean;
    location_required?: boolean;
    default_team_id?: string | null;
    default_vendor_id?: string | null;
  }) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('request_types')
      .insert({ ...dto, tenant_id: tenant.id })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async update(id: string, dto: Record<string, unknown>) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('request_types')
      .update(dto)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }
}

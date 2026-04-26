import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

@Injectable()
export class TeamService {
  constructor(private readonly supabase: SupabaseService) {}

  async list() {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('teams')
      .select('*, org_node:org_nodes(id, name, code)')
      .eq('tenant_id', tenant.id)
      .order('name');
    if (error) throw error;
    return data;
  }

  async getById(id: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('teams')
      .select('*, org_node:org_nodes(id, name, code)')
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async create(dto: {
    name: string;
    domain_scope?: string;
    location_scope?: string;
    org_node_id?: string | null;
  }) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('teams')
      .insert({ ...dto, tenant_id: tenant.id })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async update(id: string, dto: Record<string, unknown>) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('teams')
      .update(dto)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async listMembers(teamId: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('team_members')
      .select('*, user:users(id, email, person:persons(id, first_name, last_name))')
      .eq('team_id', teamId)
      .eq('tenant_id', tenant.id);
    if (error) throw error;
    return data;
  }

  async addMember(teamId: string, userId: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('team_members')
      .insert({ team_id: teamId, user_id: userId, tenant_id: tenant.id })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async removeMember(teamId: string, userId: string) {
    const tenant = TenantContext.current();
    const { error } = await this.supabase.admin
      .from('team_members')
      .delete()
      .eq('team_id', teamId)
      .eq('user_id', userId)
      .eq('tenant_id', tenant.id);
    if (error) throw error;
    return { removed: true };
  }
}

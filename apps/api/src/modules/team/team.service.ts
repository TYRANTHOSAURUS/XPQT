import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { wrapPgError } from '../../common/errors';

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
    if (error) {
      throw wrapPgError(error, 'team.list_failed', {
        detail: 'Team list query failed',
      });
    }
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
    if (error) {
      // `.maybeSingle()` returns `data: null` (not an error) when no rows
      // match, so PGRST116 won't typically fire here. The notFoundCode is
      // wired up anyway as defense-in-depth in case supabase-js evolves.
      throw wrapPgError(error, 'team.lookup_failed', {
        detail: `Team lookup failed for id ${id}`,
        notFoundCode: 'team.not_found',
      });
    }
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
    if (error) {
      // 23505 (unique team name within tenant) → 409 db.unique_violation
      // via wrapPgError. 23503 (FK violation on org_node_id) → 409
      // db.fk_violation. Anything else → 500 team.create_failed.
      throw wrapPgError(error, 'team.create_failed', {
        detail: 'Team insert failed',
      });
    }
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
    if (error) {
      throw wrapPgError(error, 'team.update_failed', {
        detail: `Team update failed for id ${id}`,
        notFoundCode: 'team.not_found',
      });
    }
    return data;
  }

  async listMembers(teamId: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('team_members')
      .select('*, user:users(id, email, person:persons(id, first_name, last_name))')
      .eq('team_id', teamId)
      .eq('tenant_id', tenant.id);
    if (error) {
      throw wrapPgError(error, 'team.member_list_failed', {
        detail: `Team member list query failed for team ${teamId}`,
      });
    }
    return data;
  }

  async addMember(teamId: string, userId: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('team_members')
      .insert({ team_id: teamId, user_id: userId, tenant_id: tenant.id })
      .select()
      .single();
    if (error) {
      // 23505 (already a member) → 409 db.unique_violation.
      // 23503 (unknown team_id / user_id) → 409 db.fk_violation.
      throw wrapPgError(error, 'team.member_add_failed', {
        detail: `Team member insert failed for team ${teamId} user ${userId}`,
      });
    }
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
    if (error) {
      throw wrapPgError(error, 'team.member_remove_failed', {
        detail: `Team member delete failed for team ${teamId} user ${userId}`,
      });
    }
    return { removed: true };
  }
}

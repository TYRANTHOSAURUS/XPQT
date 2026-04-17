import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

export type RoleType = 'admin' | 'agent' | 'employee';

export interface CreateRoleDto {
  name: string;
  description?: string;
  permissions?: string[];
  type?: RoleType;
}

export interface CreateRoleAssignmentDto {
  user_id: string;
  role_id: string;
  domain_scope?: string[];
  location_scope?: string[];
}

export interface CreateUserDto {
  person_id: string;
  email: string;
  username?: string;
  status?: string;
}

export interface CreatePersonDto {
  first_name: string;
  last_name: string;
  email?: string;
  phone?: string;
  type: string;
  division?: string;
  department?: string;
  cost_center?: string;
  manager_person_id?: string;
}

@Injectable()
export class UserManagementService {
  constructor(private readonly supabase: SupabaseService) {}

  // ─── Users ───────────────────────────────────────────────────────────────

  async createUser(dto: CreateUserDto) {
    const tenant = TenantContext.current();

    // Best-effort: link to Supabase Auth account if one exists for this email
    let auth_uid: string | null = null;
    try {
      const { data: list } = await this.supabase.admin.auth.admin.listUsers();
      const authUser = list?.users?.find(
        (u) => u.email?.toLowerCase() === dto.email.toLowerCase(),
      );
      auth_uid = authUser?.id ?? null;
    } catch {
      // listUsers requires service role; ignore and proceed without linkage
    }

    const { data, error } = await this.supabase.admin
      .from('users')
      .insert({
        tenant_id: tenant.id,
        person_id: dto.person_id,
        email: dto.email,
        username: dto.username ?? null,
        status: dto.status ?? 'active',
        auth_uid,
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async listUsers() {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('users')
      .select(`
        *,
        person:persons(id, first_name, last_name, email, department, type),
        role_assignments:user_role_assignments(
          id, domain_scope, location_scope,
          role:roles(id, name, type)
        )
      `)
      .eq('tenant_id', tenant.id)
      .order('email');
    if (error) throw error;
    return data;
  }

  async getUser(id: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('users')
      .select(`
        *,
        person:persons(id, first_name, last_name, email, department, type),
        role_assignments:user_role_assignments(
          id, domain_scope, location_scope,
          role:roles(id, name, type)
        )
      `)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .single();
    if (error) throw error;
    return data;
  }

  async updateUser(id: string, dto: Record<string, unknown>) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('users')
      .update(dto)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async getUserRoles(userId: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('user_role_assignments')
      .select('*, role:roles(id, name, description, type)')
      .eq('user_id', userId)
      .eq('tenant_id', tenant.id);
    if (error) throw error;
    return data;
  }

  async addUserRole(userId: string, dto: { role_id: string; domain_scope?: string[]; location_scope?: string[] }) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('user_role_assignments')
      .insert({
        user_id: userId,
        role_id: dto.role_id,
        domain_scope: dto.domain_scope ?? [],
        location_scope: dto.location_scope ?? [],
        tenant_id: tenant.id,
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async removeUserRole(userId: string, roleAssignmentId: string) {
    const tenant = TenantContext.current();
    const { error } = await this.supabase.admin
      .from('user_role_assignments')
      .delete()
      .eq('id', roleAssignmentId)
      .eq('user_id', userId)
      .eq('tenant_id', tenant.id);
    if (error) throw error;
    return { removed: true };
  }

  // ─── Roles ───────────────────────────────────────────────────────────────

  async listRoles() {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('roles')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('active', true)
      .order('name');
    if (error) throw error;
    return data;
  }

  async createRole(dto: CreateRoleDto) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('roles')
      .insert({ ...dto, permissions: dto.permissions ?? [], tenant_id: tenant.id })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async updateRole(id: string, dto: Partial<CreateRoleDto>) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('roles')
      .update(dto)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  // ─── Role Assignments ─────────────────────────────────────────────────────

  async assignRole(dto: CreateRoleAssignmentDto) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('user_role_assignments')
      .insert({ ...dto, tenant_id: tenant.id })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async removeRoleAssignment(id: string) {
    const tenant = TenantContext.current();
    const { error } = await this.supabase.admin
      .from('user_role_assignments')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenant.id);
    if (error) throw error;
    return { removed: true };
  }

  // ─── Persons CRUD ─────────────────────────────────────────────────────────

  async listPersons(type?: string) {
    const tenant = TenantContext.current();
    let query = this.supabase.admin
      .from('persons')
      .select('*, manager:persons!persons_manager_person_id_fkey(id, first_name, last_name)')
      .eq('tenant_id', tenant.id)
      .eq('active', true)
      .order('first_name');

    if (type) query = query.eq('type', type);

    const { data, error } = await query;
    if (error) throw error;
    return data;
  }

  async createPerson(dto: CreatePersonDto) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('persons')
      .insert({ ...dto, tenant_id: tenant.id })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async updatePerson(id: string, dto: Partial<CreatePersonDto>) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('persons')
      .update(dto)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }
}

import { BadRequestException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import {
  expandGranted,
  normalisePermission,
  PERMISSION_CATALOG,
  validatePermission,
  type ModuleMeta,
} from '@prequest/shared';
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
  starts_at?: string | null;
  ends_at?: string | null;
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

  /**
   * Resolve the authenticated caller by their Supabase auth_uid. Returns the
   * user row, joined person, and role_assignments in one query. Used by
   * GET /users/me so the frontend doesn't need to search persons by email to
   * find role assignments.
   */
  async getByAuthUid(authUid: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('users')
      .select(`
        *,
        person:persons(id, first_name, last_name, email, type, default_location_id),
        role_assignments:user_role_assignments(
          id, domain_scope, location_scope,
          role:roles(id, name, type)
        )
      `)
      .eq('auth_uid', authUid)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async listUsers() {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('users')
      .select(`
        *,
        person:persons(id, first_name, last_name, email, type),
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
        person:persons(id, first_name, last_name, email, type),
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

  async addUserRole(
    userId: string,
    dto: {
      role_id: string;
      domain_scope?: string[];
      location_scope?: string[];
      starts_at?: string | null;
      ends_at?: string | null;
    },
    actor?: { userId?: string | null },
  ) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('user_role_assignments')
      .insert({
        user_id: userId,
        role_id: dto.role_id,
        domain_scope: dto.domain_scope ?? [],
        location_scope: dto.location_scope ?? [],
        starts_at: dto.starts_at ?? null,
        ends_at: dto.ends_at ?? null,
        tenant_id: tenant.id,
      })
      .select()
      .single();
    if (error) throw error;
    const created = data as { id: string } | null;
    await this.emitAudit({
      actor_user_id: actor?.userId ?? null,
      event_type: 'assignment.created',
      target_role_id: dto.role_id,
      target_user_id: userId,
      target_assignment_id: created?.id ?? null,
      payload: {
        domain_scope: dto.domain_scope ?? [],
        location_scope: dto.location_scope ?? [],
        starts_at: dto.starts_at ?? null,
        ends_at: dto.ends_at ?? null,
      },
    });
    return data;
  }

  async removeUserRole(
    userId: string,
    roleAssignmentId: string,
    actor?: { userId?: string | null },
  ) {
    const tenant = TenantContext.current();
    const { data: prev } = await this.supabase.admin
      .from('user_role_assignments')
      .select('role_id, domain_scope, location_scope, starts_at, ends_at')
      .eq('id', roleAssignmentId)
      .eq('user_id', userId)
      .eq('tenant_id', tenant.id)
      .maybeSingle();

    const { error } = await this.supabase.admin
      .from('user_role_assignments')
      .delete()
      .eq('id', roleAssignmentId)
      .eq('user_id', userId)
      .eq('tenant_id', tenant.id);
    if (error) throw error;

    const snap = prev as { role_id: string } | null;
    await this.emitAudit({
      actor_user_id: actor?.userId ?? null,
      event_type: 'assignment.revoked',
      target_role_id: snap?.role_id ?? null,
      target_user_id: userId,
      target_assignment_id: roleAssignmentId,
      payload: prev as unknown as Record<string, unknown>,
    });
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

  async createRole(dto: CreateRoleDto, actor?: { userId?: string | null }) {
    const tenant = TenantContext.current();
    const permissions = this.normaliseAndValidatePermissions(dto.permissions);
    const { data, error } = await this.supabase.admin
      .from('roles')
      .insert({ ...dto, permissions, tenant_id: tenant.id })
      .select()
      .single();
    if (error) throw error;
    await this.emitAudit({
      actor_user_id: actor?.userId ?? null,
      event_type: 'role.created',
      target_role_id: (data as { id: string }).id,
      payload: { name: dto.name, type: dto.type ?? null, permissions },
    });
    return data;
  }

  async updateRole(
    id: string,
    dto: Partial<CreateRoleDto>,
    actor?: { userId?: string | null },
  ) {
    const tenant = TenantContext.current();
    const patch: Record<string, unknown> = { ...dto };
    let nextPermissions: string[] | undefined;
    if (dto.permissions !== undefined) {
      nextPermissions = this.normaliseAndValidatePermissions(dto.permissions);
      patch.permissions = nextPermissions;
    }

    // Snapshot pre-update permissions so the audit diff is actually useful.
    const { data: prev } = await this.supabase.admin
      .from('roles')
      .select('name, type, permissions')
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .maybeSingle();

    const { data, error } = await this.supabase.admin
      .from('roles')
      .update(patch)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();
    if (error) throw error;

    const prevPerms = ((prev as { permissions?: string[] } | null)?.permissions ?? [])
      .slice()
      .sort();
    const nextPerms = (nextPermissions ?? prevPerms).slice().sort();
    const permsChanged = JSON.stringify(prevPerms) !== JSON.stringify(nextPerms);

    await this.emitAudit({
      actor_user_id: actor?.userId ?? null,
      event_type: permsChanged ? 'role.permissions_changed' : 'role.updated',
      target_role_id: id,
      payload: {
        changed_fields: Object.keys(patch),
        previous_permissions: permsChanged ? prevPerms : undefined,
        next_permissions: permsChanged ? nextPerms : undefined,
      },
    });
    return data;
  }

  /**
   * Canonicalise permission strings on write: lower-case, colon→dot, reject
   * malformed / unknown keys. Dedupes. The UI should already send dot-form,
   * but callers can pass either.
   */
  private normaliseAndValidatePermissions(raw: string[] | undefined): string[] {
    if (!raw) return [];
    const seen = new Set<string>();
    for (const key of raw) {
      if (typeof key !== 'string') {
        throw new BadRequestException(`Permission must be a string, got ${typeof key}`);
      }
      const norm = normalisePermission(key);
      const result = validatePermission(norm);
      if (!result.ok) {
        throw new BadRequestException(result.reason);
      }
      seen.add(norm);
    }
    return [...seen].sort();
  }

  // ─── Role Assignments ─────────────────────────────────────────────────────

  async assignRole(dto: CreateRoleAssignmentDto, actor?: { userId?: string | null }) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('user_role_assignments')
      .insert({
        user_id: dto.user_id,
        role_id: dto.role_id,
        domain_scope: dto.domain_scope ?? [],
        location_scope: dto.location_scope ?? [],
        starts_at: dto.starts_at ?? null,
        ends_at: dto.ends_at ?? null,
        tenant_id: tenant.id,
      })
      .select()
      .single();
    if (error) throw error;
    const created = data as { id: string } | null;
    await this.emitAudit({
      actor_user_id: actor?.userId ?? null,
      event_type: 'assignment.created',
      target_role_id: dto.role_id,
      target_user_id: dto.user_id,
      target_assignment_id: created?.id ?? null,
      payload: {
        domain_scope: dto.domain_scope ?? [],
        location_scope: dto.location_scope ?? [],
        starts_at: dto.starts_at ?? null,
        ends_at: dto.ends_at ?? null,
      },
    });
    return data;
  }

  async updateRoleAssignment(
    id: string,
    dto: Partial<{
      domain_scope: string[];
      location_scope: string[];
      starts_at: string | null;
      ends_at: string | null;
      active: boolean;
    }>,
    actor?: { userId?: string | null },
  ) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('user_role_assignments')
      .update(dto)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();
    if (error) throw error;
    const row = data as { role_id: string; user_id: string } | null;
    await this.emitAudit({
      actor_user_id: actor?.userId ?? null,
      event_type: 'assignment.updated',
      target_role_id: row?.role_id ?? null,
      target_user_id: row?.user_id ?? null,
      target_assignment_id: id,
      payload: { changed_fields: Object.keys(dto), patch: dto },
    });
    return data;
  }

  async removeRoleAssignment(id: string, actor?: { userId?: string | null }) {
    const tenant = TenantContext.current();
    const { data: prev } = await this.supabase.admin
      .from('user_role_assignments')
      .select('role_id, user_id, domain_scope, location_scope, starts_at, ends_at')
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .maybeSingle();

    const { error } = await this.supabase.admin
      .from('user_role_assignments')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenant.id);
    if (error) throw error;

    const snap = prev as {
      role_id: string;
      user_id: string;
      domain_scope: string[] | null;
      location_scope: string[] | null;
      starts_at: string | null;
      ends_at: string | null;
    } | null;
    await this.emitAudit({
      actor_user_id: actor?.userId ?? null,
      event_type: 'assignment.revoked',
      target_role_id: snap?.role_id ?? null,
      target_user_id: snap?.user_id ?? null,
      target_assignment_id: id,
      payload: {
        domain_scope: snap?.domain_scope ?? null,
        location_scope: snap?.location_scope ?? null,
        starts_at: snap?.starts_at ?? null,
        ends_at: snap?.ends_at ?? null,
      },
    });
    return { removed: true };
  }

  // ─── Persons CRUD ─────────────────────────────────────────────────────────

  async listPersons(type?: string) {
    const tenant = TenantContext.current();
    let query = this.supabase.admin
      .from('persons')
      .select('*, manager:persons!manager_person_id(id, first_name, last_name)')
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

  // ─── Audit log ────────────────────────────────────────────────────────────

  private async emitAudit(input: {
    actor_user_id: string | null;
    event_type:
      | 'role.created'
      | 'role.updated'
      | 'role.deleted'
      | 'role.permissions_changed'
      | 'assignment.created'
      | 'assignment.updated'
      | 'assignment.revoked';
    target_role_id?: string | null;
    target_user_id?: string | null;
    target_assignment_id?: string | null;
    payload?: Record<string, unknown>;
  }): Promise<void> {
    // Best-effort: a failing audit insert must never block the primary
    // mutation the caller just performed. Swallow + log.
    try {
      const tenant = TenantContext.current();
      const { error } = await this.supabase.admin.from('role_audit_events').insert({
        tenant_id: tenant.id,
        actor_user_id: input.actor_user_id,
        event_type: input.event_type,
        target_role_id: input.target_role_id ?? null,
        target_user_id: input.target_user_id ?? null,
        target_assignment_id: input.target_assignment_id ?? null,
        payload: input.payload ?? {},
      });
      if (error) {
        // eslint-disable-next-line no-console
        console.warn('[role_audit_events] emit failed', error);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[role_audit_events] emit threw', err);
    }
  }

  async listRoleAuditEvents(
    filter: { role_id?: string; user_id?: string },
    limit = 100,
  ) {
    const tenant = TenantContext.current();
    let q = this.supabase.admin
      .from('role_audit_events')
      .select('*, actor:users!actor_user_id(id, email, person:persons(id, first_name, last_name))')
      .eq('tenant_id', tenant.id)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (filter.role_id) q = q.eq('target_role_id', filter.role_id);
    if (filter.user_id) q = q.eq('target_user_id', filter.user_id);
    const { data, error } = await q;
    if (error) throw error;
    return data;
  }

  async resolveUserIdFromAuthUid(authUid: string): Promise<string | null> {
    const tenant = TenantContext.current();
    const { data } = await this.supabase.admin
      .from('users')
      .select('id')
      .eq('tenant_id', tenant.id)
      .eq('auth_uid', authUid)
      .maybeSingle();
    return (data as { id: string } | null)?.id ?? null;
  }

  async actorFromRequest(request: Request): Promise<{ userId: string | null }> {
    const authUid = (request as { user?: { id: string } }).user?.id;
    if (!authUid) return { userId: null };
    return { userId: await this.resolveUserIdFromAuthUid(authUid) };
  }

  // ─── Effective permissions ────────────────────────────────────────────────

  /**
   * Resolves the union of permissions granted to a user via their active,
   * non-expired role assignments. Returns the raw permission strings per
   * role, the concrete expansion (wildcards resolved into catalog entries),
   * and per-permission attribution so the UI can show "granted by role X".
   */
  async getEffectivePermissions(userId: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('user_role_assignments')
      .select(`
        id, domain_scope, location_scope, starts_at, ends_at, active,
        role:roles(id, name, type, permissions, active)
      `)
      .eq('user_id', userId)
      .eq('tenant_id', tenant.id);
    if (error) throw error;

    const now = Date.now();
    type AssignmentRow = {
      id: string;
      domain_scope: string[] | null;
      location_scope: string[] | null;
      starts_at: string | null;
      ends_at: string | null;
      active: boolean;
      role: {
        id: string;
        name: string;
        type: string | null;
        permissions: string[] | null;
        active: boolean;
      } | null;
    };
    const rows = ((data ?? []) as unknown as AssignmentRow[]).filter((row) => {
      if (!row.active || !row.role || !row.role.active) return false;
      if (row.starts_at && Date.parse(row.starts_at) > now) return false;
      if (row.ends_at && Date.parse(row.ends_at) <= now) return false;
      return true;
    });

    const grantedByKey = new Map<
      string,
      Array<{
        assignment_id: string;
        role_id: string;
        role_name: string;
        domain_scope: string[];
        location_scope: string[];
        source: 'exact' | 'module_wildcard' | 'action_wildcard' | 'full_wildcard';
        raw_token: string;
      }>
    >();

    const addGrant = (
      key: string,
      row: AssignmentRow,
      source: 'exact' | 'module_wildcard' | 'action_wildcard' | 'full_wildcard',
      rawToken: string,
    ) => {
      const arr = grantedByKey.get(key) ?? [];
      if (!row.role) return;
      arr.push({
        assignment_id: row.id,
        role_id: row.role.id,
        role_name: row.role.name,
        domain_scope: row.domain_scope ?? [],
        location_scope: row.location_scope ?? [],
        source,
        raw_token: rawToken,
      });
      grantedByKey.set(key, arr);
    };

    for (const row of rows) {
      const rawPerms = (row.role?.permissions ?? []).map(normalisePermission);
      const concrete = expandGranted(rawPerms);
      for (const key of concrete) {
        const [resource, action] = key.split('.');
        if (rawPerms.includes(key)) {
          addGrant(key, row, 'exact', key);
        } else if (rawPerms.includes(`${resource}.*`)) {
          addGrant(key, row, 'module_wildcard', `${resource}.*`);
        } else if (rawPerms.includes(`*.${action}`)) {
          addGrant(key, row, 'action_wildcard', `*.${action}`);
        } else if (rawPerms.includes('*.*')) {
          addGrant(key, row, 'full_wildcard', '*.*');
        }
      }
    }

    const byModule: Record<
      string,
      {
        module: string;
        label: string;
        permissions: Array<{
          key: string;
          action: string;
          label: string;
          is_override: boolean;
          grants: ReturnType<typeof Array.prototype.slice> extends infer _ ? ReturnType<typeof grantedByKey.get> : never;
        }>;
      }
    > = {};

    for (const [key, grants] of grantedByKey.entries()) {
      const [resource, action] = key.split('.');
      const mod = (PERMISSION_CATALOG as Record<string, ModuleMeta>)[resource];
      if (!mod) continue;
      const isOverride = mod.overrides ? action in mod.overrides : false;
      const actionMeta = mod.actions[action] ?? (mod.overrides?.[action] ?? null);
      if (!byModule[resource]) {
        byModule[resource] = { module: resource, label: mod.label, permissions: [] };
      }
      byModule[resource].permissions.push({
        key,
        action,
        label: actionMeta?.label ?? action,
        is_override: isOverride,
        grants,
      });
    }

    for (const entry of Object.values(byModule)) {
      entry.permissions.sort((a, b) => a.action.localeCompare(b.action));
    }

    return {
      user_id: userId,
      assignments: rows.map((row) => ({
        id: row.id,
        role_id: row.role?.id,
        role_name: row.role?.name,
        role_type: row.role?.type,
        domain_scope: row.domain_scope ?? [],
        location_scope: row.location_scope ?? [],
        starts_at: row.starts_at,
        ends_at: row.ends_at,
        raw_permissions: (row.role?.permissions ?? []).map(normalisePermission),
      })),
      modules: Object.values(byModule).sort((a, b) => a.label.localeCompare(b.label)),
    };
  }
}

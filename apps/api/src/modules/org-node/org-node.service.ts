import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

const PG_UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === PG_UNIQUE_VIOLATION;
}

interface OrgNodeRow {
  id: string;
  tenant_id: string;
  parent_id: string | null;
  name: string;
  code: string | null;
  description: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface OrgNodeListItem extends OrgNodeRow {
  member_count: number;
  location_grant_count: number;
  team_count: number;
}

export interface CreateOrgNodeDto {
  name: string;
  parent_id?: string | null;
  code?: string | null;
  description?: string | null;
}

export interface UpdateOrgNodeDto {
  name?: string;
  parent_id?: string | null;
  code?: string | null;
  description?: string | null;
  active?: boolean;
}

@Injectable()
export class OrgNodeService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(): Promise<OrgNodeListItem[]> {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('org_nodes')
      .select('*')
      .eq('tenant_id', tenant.id)
      .order('name');
    if (error) throw error;

    const ids = (data ?? []).map((r) => r.id);
    if (ids.length === 0) return [];

    const [members, grants, teams] = await Promise.all([
      this.supabase.admin
        .from('person_org_memberships')
        .select('org_node_id')
        .in('org_node_id', ids),
      this.supabase.admin
        .from('org_node_location_grants')
        .select('org_node_id')
        .in('org_node_id', ids),
      this.supabase.admin
        .from('teams')
        .select('org_node_id')
        .in('org_node_id', ids),
    ]);
    if (members.error) throw members.error;
    if (grants.error) throw grants.error;
    if (teams.error) throw teams.error;

    const tally = (rows: { org_node_id: string }[] | null) => {
      const m = new Map<string, number>();
      for (const r of rows ?? []) m.set(r.org_node_id, (m.get(r.org_node_id) ?? 0) + 1);
      return m;
    };
    const memberMap = tally(members.data as { org_node_id: string }[] | null);
    const grantMap = tally(grants.data as { org_node_id: string }[] | null);
    const teamMap = tally(teams.data as { org_node_id: string }[] | null);

    return (data as OrgNodeRow[]).map((r) => ({
      ...r,
      member_count: memberMap.get(r.id) ?? 0,
      location_grant_count: grantMap.get(r.id) ?? 0,
      team_count: teamMap.get(r.id) ?? 0,
    }));
  }

  async getById(id: string): Promise<OrgNodeRow> {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('org_nodes')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new NotFoundException(`org_node ${id} not found`);
    return data as OrgNodeRow;
  }

  async create(dto: CreateOrgNodeDto): Promise<OrgNodeRow> {
    if (!dto.name?.trim()) throw new BadRequestException('name is required');
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('org_nodes')
      .insert({
        tenant_id: tenant.id,
        name: dto.name.trim(),
        parent_id: dto.parent_id ?? null,
        code: dto.code ?? null,
        description: dto.description ?? null,
      })
      .select('*')
      .single();
    if (error) throw new BadRequestException(error.message);
    return data as OrgNodeRow;
  }

  async update(id: string, dto: UpdateOrgNodeDto): Promise<OrgNodeRow> {
    const tenant = TenantContext.current();
    const patch: Record<string, unknown> = {};
    if (dto.name !== undefined) patch.name = dto.name.trim();
    if (dto.parent_id !== undefined) patch.parent_id = dto.parent_id;
    if (dto.code !== undefined) patch.code = dto.code;
    if (dto.description !== undefined) patch.description = dto.description;
    if (dto.active !== undefined) patch.active = dto.active;
    if (Object.keys(patch).length === 0) {
      return this.getById(id);
    }
    const { data, error } = await this.supabase.admin
      .from('org_nodes')
      .update(patch)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select('*')
      .single();
    if (error) throw new BadRequestException(error.message);
    return data as OrgNodeRow;
  }

  async remove(id: string): Promise<{ ok: true }> {
    const tenant = TenantContext.current();
    const { error } = await this.supabase.admin
      .from('org_nodes')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenant.id);
    if (error) throw new BadRequestException(error.message);
    return { ok: true };
  }

  // ── Memberships ────────────────────────────────────────────────────────
  // v1 single-select UI: only primary memberships are surfaced. Non-primary
  // rows in the join table (reserved for future multi-membership support)
  // stay invisible so "person's org is X" matches what the admin sees.
  async listMembers(nodeId: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('person_org_memberships')
      .select('id, person_id, is_primary, created_at, person:persons(id, first_name, last_name, email)')
      .eq('org_node_id', nodeId)
      .eq('tenant_id', tenant.id)
      .eq('is_primary', true)
      .order('created_at');
    if (error) throw error;
    return data;
  }

  async addMember(nodeId: string, personId: string, isPrimary = true) {
    const tenant = TenantContext.current();

    if (isPrimary) {
      const { error: demoteErr } = await this.supabase.admin
        .from('person_org_memberships')
        .update({ is_primary: false })
        .eq('person_id', personId)
        .eq('tenant_id', tenant.id)
        .eq('is_primary', true);
      if (demoteErr) throw demoteErr;
    }

    const { data, error } = await this.supabase.admin
      .from('person_org_memberships')
      .upsert(
        {
          tenant_id: tenant.id,
          person_id: personId,
          org_node_id: nodeId,
          is_primary: isPrimary,
        },
        { onConflict: 'person_id,org_node_id' },
      )
      .select('*')
      .single();
    if (error) {
      // Raced with another "set primary" call — the partial unique index on
      // is_primary per person is our safety net. Surface a readable 409.
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'Another organisation change for this person is in progress. Reload and try again.',
        );
      }
      throw new BadRequestException(error.message);
    }
    return data;
  }

  async removeMember(nodeId: string, personId: string) {
    const tenant = TenantContext.current();
    const { error } = await this.supabase.admin
      .from('person_org_memberships')
      .delete()
      .eq('org_node_id', nodeId)
      .eq('person_id', personId)
      .eq('tenant_id', tenant.id);
    if (error) throw error;
    return { ok: true };
  }

  // ── Location grants ────────────────────────────────────────────────────
  async listGrants(nodeId: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('org_node_location_grants')
      .select('id, space_id, granted_by_user_id, granted_at, note, space:spaces(id, name, type)')
      .eq('org_node_id', nodeId)
      .eq('tenant_id', tenant.id)
      .order('granted_at');
    if (error) throw error;
    return data;
  }

  async addGrant(
    nodeId: string,
    spaceId: string,
    note: string | undefined,
    grantedByUserId?: string,
  ) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('org_node_location_grants')
      .insert({
        tenant_id: tenant.id,
        org_node_id: nodeId,
        space_id: spaceId,
        note: note ?? null,
        granted_by_user_id: grantedByUserId ?? null,
      })
      .select('id, space_id, granted_by_user_id, granted_at, note')
      .single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  async removeGrant(nodeId: string, grantId: string) {
    const tenant = TenantContext.current();
    const { error } = await this.supabase.admin
      .from('org_node_location_grants')
      .delete()
      .eq('id', grantId)
      .eq('org_node_id', nodeId)
      .eq('tenant_id', tenant.id);
    if (error) throw error;
    return { ok: true };
  }

  // ── Teams attached ─────────────────────────────────────────────────────
  async listAttachedTeams(nodeId: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('teams')
      .select('id, name, description')
      .eq('org_node_id', nodeId)
      .eq('tenant_id', tenant.id)
      .order('name');
    if (error) throw error;
    return data;
  }
}

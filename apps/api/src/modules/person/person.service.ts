import { ConflictException, Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

const PG_UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === PG_UNIQUE_VIOLATION;
}

@Injectable()
export class PersonService {
  constructor(private readonly supabase: SupabaseService) {}

  async search(query: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('persons')
      .select(
        `id, first_name, last_name, email, type,
         primary_membership:person_org_memberships(org_node_id, is_primary, org_node:org_nodes(id, name, code))`,
      )
      .eq('tenant_id', tenant.id)
      .eq('active', true)
      .or(`first_name.ilike.%${query}%,last_name.ilike.%${query}%,email.ilike.%${query}%`)
      .order('first_name')
      .limit(20);

    if (error) throw error;
    return data;
  }

  async list() {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('persons')
      .select(
        `*, manager:persons!manager_person_id(id, first_name, last_name),
         primary_membership:person_org_memberships(org_node_id, is_primary, org_node:org_nodes(id, name, code))`,
      )
      .eq('tenant_id', tenant.id)
      .eq('active', true)
      .order('first_name')
      .limit(100);

    if (error) throw error;
    return data;
  }

  async getById(id: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('persons')
      .select(
        `*, primary_membership:person_org_memberships(org_node_id, is_primary, org_node:org_nodes(id, name, code))`,
      )
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .single();

    if (error) throw error;
    return data;
  }

  async create(dto: {
    first_name: string;
    last_name: string;
    email?: string;
    phone?: string;
    type: string;
    cost_center?: string;
    manager_person_id?: string;
    primary_org_node_id?: string | null;
  }) {
    const tenant = TenantContext.current();
    const { primary_org_node_id, ...personFields } = dto;

    const { data, error } = await this.supabase.admin
      .from('persons')
      .insert({ ...personFields, tenant_id: tenant.id })
      .select()
      .single();
    if (error) throw error;

    if (primary_org_node_id) {
      await this.upsertPrimaryMembership(data.id, primary_org_node_id);
    }
    return data;
  }

  async update(id: string, dto: Record<string, unknown>) {
    const tenant = TenantContext.current();
    const { primary_org_node_id, ...rest } = dto as Record<string, unknown> & {
      primary_org_node_id?: string | null;
    };

    const { data, error } = await this.supabase.admin
      .from('persons')
      .update(rest)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();
    if (error) throw error;

    if (primary_org_node_id !== undefined) {
      if (primary_org_node_id === null) {
        await this.clearPrimaryMembership(id);
      } else {
        await this.upsertPrimaryMembership(id, primary_org_node_id);
      }
    }
    return data;
  }

  async listByType(type?: string) {
    const tenant = TenantContext.current();
    let query = this.supabase.admin
      .from('persons')
      .select(
        `*, manager:persons!manager_person_id(id, first_name, last_name),
         primary_membership:person_org_memberships(org_node_id, is_primary, org_node:org_nodes(id, name, code))`,
      )
      .eq('tenant_id', tenant.id)
      .eq('active', true)
      .order('first_name');

    if (type) query = query.eq('type', type);

    const { data, error } = await query;
    if (error) throw error;
    return data;
  }

  private async upsertPrimaryMembership(personId: string, orgNodeId: string) {
    const tenant = TenantContext.current();
    // Demote any existing primary for this person.
    const { error: demoteErr } = await this.supabase.admin
      .from('person_org_memberships')
      .update({ is_primary: false })
      .eq('person_id', personId)
      .eq('tenant_id', tenant.id)
      .eq('is_primary', true);
    if (demoteErr) throw demoteErr;

    const { error } = await this.supabase.admin
      .from('person_org_memberships')
      .upsert(
        {
          tenant_id: tenant.id,
          person_id: personId,
          org_node_id: orgNodeId,
          is_primary: true,
        },
        { onConflict: 'person_id,org_node_id' },
      );
    if (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'Another organisation change for this person is in progress. Reload and try again.',
        );
      }
      throw error;
    }
  }

  private async clearPrimaryMembership(personId: string) {
    const tenant = TenantContext.current();
    const { error } = await this.supabase.admin
      .from('person_org_memberships')
      .delete()
      .eq('person_id', personId)
      .eq('tenant_id', tenant.id)
      .eq('is_primary', true);
    if (error) throw error;
  }

  // ── Portal-scope slice: location grants ──────────────────────────────────

  async listLocationGrants(personId: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('person_location_grants')
      .select('id, space_id, granted_by_user_id, granted_at, note, space:spaces(id, name, type)')
      .eq('person_id', personId)
      .eq('tenant_id', tenant.id)
      .order('granted_at');
    if (error) throw error;
    return data;
  }

  async addLocationGrant(
    personId: string,
    dto: { space_id: string; note?: string },
    grantedByUserId?: string,
  ) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('person_location_grants')
      .insert({
        tenant_id: tenant.id,
        person_id: personId,
        space_id: dto.space_id,
        note: dto.note ?? null,
        granted_by_user_id: grantedByUserId ?? null,
      })
      .select('id, space_id, granted_by_user_id, granted_at, note')
      .single();
    if (error) throw error;
    return data;
  }

  async removeLocationGrant(personId: string, grantId: string) {
    const tenant = TenantContext.current();
    const { error } = await this.supabase.admin
      .from('person_location_grants')
      .delete()
      .eq('id', grantId)
      .eq('person_id', personId)
      .eq('tenant_id', tenant.id);
    if (error) throw error;
    return { ok: true };
  }

  /**
   * Effective portal authorization for this person — the union of:
   *  - persons.default_location_id (source: 'default')
   *  - person_location_grants rows (source: 'grant')
   *  - org_node_location_grants walked through person_org_memberships (source: 'org_grant')
   *
   * Mirrors public.portal_authorized_root_matches (migration 00080). Returned
   * rows are enriched with space + grant + org-node names so the admin UI can
   * show why each location is authorized.
   */
  async listEffectiveAuthorization(personId: string) {
    const tenant = TenantContext.current();

    const { data: rows, error: rpcErr } = await this.supabase.admin.rpc(
      'portal_authorized_root_matches',
      { p_person_id: personId, p_tenant_id: tenant.id },
    );
    if (rpcErr) throw rpcErr;

    const matches = ((rows ?? []) as Array<{ root_id: string; source: string; grant_id: string | null }>);
    if (matches.length === 0) return [];

    const spaceIds = Array.from(new Set(matches.map((m) => m.root_id)));
    const grantIds = matches.filter((m) => m.source === 'grant' && m.grant_id).map((m) => m.grant_id!);
    const orgGrantIds = matches.filter((m) => m.source === 'org_grant' && m.grant_id).map((m) => m.grant_id!);

    const [spacesRes, grantsRes, orgGrantsRes] = await Promise.all([
      this.supabase.admin
        .from('spaces')
        .select('id, name, type')
        .in('id', spaceIds)
        .eq('tenant_id', tenant.id),
      grantIds.length > 0
        ? this.supabase.admin
            .from('person_location_grants')
            .select('id, granted_at, note')
            .in('id', grantIds)
            .eq('tenant_id', tenant.id)
        : Promise.resolve({ data: [], error: null }),
      orgGrantIds.length > 0
        ? this.supabase.admin
            .from('org_node_location_grants')
            .select('id, org_node_id, org_node:org_nodes(id, name)')
            .in('id', orgGrantIds)
            .eq('tenant_id', tenant.id)
        : Promise.resolve({ data: [], error: null }),
    ]);

    const spacesById = new Map(
      ((spacesRes.data ?? []) as Array<{ id: string; name: string; type: string }>).map((s) => [s.id, s]),
    );
    const grantsById = new Map(
      ((grantsRes.data ?? []) as Array<{ id: string; granted_at: string; note: string | null }>).map(
        (g) => [g.id, g],
      ),
    );
    const orgGrantsById = new Map(
      ((orgGrantsRes.data ?? []) as Array<{ id: string; org_node_id: string; org_node: { id: string; name: string } | { id: string; name: string }[] | null }>).map((o) => {
        const node = Array.isArray(o.org_node) ? o.org_node[0] : o.org_node;
        return [o.id, { org_node_id: o.org_node_id, org_node_name: node?.name ?? null }];
      }),
    );

    return matches
      .map((m) => {
        const space = spacesById.get(m.root_id);
        if (!space) return null;
        if (m.source === 'default') {
          return {
            source: 'default' as const,
            space,
            grant_id: null as string | null,
            granted_at: null as string | null,
            note: null as string | null,
            org_node: null as { id: string; name: string } | null,
          };
        }
        if (m.source === 'grant') {
          const g = m.grant_id ? grantsById.get(m.grant_id) : null;
          return {
            source: 'grant' as const,
            space,
            grant_id: m.grant_id,
            granted_at: g?.granted_at ?? null,
            note: g?.note ?? null,
            org_node: null,
          };
        }
        const o = m.grant_id ? orgGrantsById.get(m.grant_id) : null;
        return {
          source: 'org_grant' as const,
          space,
          grant_id: m.grant_id,
          granted_at: null,
          note: null,
          org_node: o?.org_node_name
            ? { id: o.org_node_id, name: o.org_node_name }
            : null,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }
}

import { ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

interface SpaceSummary {
  id: string;
  name: string;
  type: string;
}

interface AuthorizedLocation extends SpaceSummary {
  source: 'default' | 'grant';
  grant_id: string | null;
  granted_at: string | null;
  note: string | null;
}

interface RoleScope {
  role_name: string;
  domain_scope: string[] | null;
  location_scope: string[] | null;
}

export interface PortalMeResponse {
  person: {
    id: string;
    first_name: string;
    last_name: string;
    email: string | null;
  };
  user: { id: string; email: string | null };
  default_location: SpaceSummary | null;
  authorized_locations: AuthorizedLocation[];
  current_location: SpaceSummary | null;
  role_scopes: RoleScope[];
  can_submit: boolean;
}

interface CatalogRequestType {
  id: string;
  name: string;
  description: string | null;
  domain: string | null;
  form_schema_id: string | null;
  requires_location: boolean;
  location_required: boolean;
  location_granularity: string | null;
  requires_asset: boolean;
  asset_required: boolean;
  asset_type_filter: string[];
}

interface CatalogCategory {
  id: string;
  name: string;
  icon: string | null;
  request_types: CatalogRequestType[];
}

export interface PortalCatalogResponse {
  selected_location: SpaceSummary;
  categories: CatalogCategory[];
}

export interface PortalSpacesResponse {
  parent: SpaceSummary;
  children: Array<{
    id: string;
    name: string;
    type: string;
    has_children: boolean;
    active: boolean;
  }>;
}

/**
 * Portal-facing endpoints: /portal/me, PATCH /portal/me, /portal/catalog, /portal/spaces.
 * See docs/portal-scope-slice.md §5.1–§5.4.
 */
@Injectable()
export class PortalService {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Resolves authUid → { user, person } in the current tenant, or throws 401.
   */
  private async resolveActor(authUid: string): Promise<{
    userId: string;
    personId: string | null;
    userEmail: string | null;
  }> {
    const tenant = TenantContext.current();
    const lookup = await this.supabase.admin
      .from('users')
      .select('id, person_id, email')
      .eq('tenant_id', tenant.id)
      .eq('auth_uid', authUid)
      .maybeSingle();
    const row = lookup.data as { id: string; person_id: string | null; email: string | null } | null;
    if (!row) throw new UnauthorizedException('No user in this tenant');
    return { userId: row.id, personId: row.person_id, userEmail: row.email };
  }

  async getMe(authUid: string): Promise<PortalMeResponse> {
    const tenant = TenantContext.current();
    const { userId, personId, userEmail } = await this.resolveActor(authUid);
    if (!personId) throw new UnauthorizedException('No linked person');

    const [personRes, userFull, authorizedLocationsRes, userRolesRes] = await Promise.all([
      this.supabase.admin
        .from('persons')
        .select('id, first_name, last_name, email, default_location_id')
        .eq('id', personId)
        .eq('tenant_id', tenant.id)
        .single(),
      this.supabase.admin
        .from('users')
        .select('id, email, portal_current_location_id')
        .eq('id', userId)
        .single(),
      this.loadAuthorizedLocations(personId),
      this.loadRoleScopes(userId),
    ]);

    const person = personRes.data as
      | { id: string; first_name: string; last_name: string; email: string | null; default_location_id: string | null }
      | null;
    if (!person) throw new NotFoundException('Person not found');

    const userRow = userFull.data as { id: string; email: string | null; portal_current_location_id: string | null };

    const defaultLocation = person.default_location_id
      ? await this.loadSpaceSummary(person.default_location_id)
      : null;

    const authorized = authorizedLocationsRes;
    const can_submit = authorized.length > 0;

    // Self-heal stale current_location.
    let currentLocationId = userRow.portal_current_location_id;
    const currentIsAuthorized = currentLocationId
      ? authorized.some((loc) => loc.id === currentLocationId)
      : false;

    if (currentLocationId && !currentIsAuthorized) {
      // Fall back to default if active, else oldest grant.
      const defaultIsActive = defaultLocation !== null;
      let fallback: string | null = null;
      if (defaultIsActive) {
        fallback = defaultLocation!.id;
      } else {
        const oldestGrant = authorized
          .filter((l) => l.source === 'grant' && l.granted_at)
          .sort((a, b) => (a.granted_at! < b.granted_at! ? -1 : 1))[0];
        fallback = oldestGrant?.id ?? null;
      }
      currentLocationId = fallback;
      await this.supabase.admin
        .from('users')
        .update({ portal_current_location_id: fallback })
        .eq('id', userId);
    } else if (!currentLocationId && can_submit) {
      // First visit: default current to default_location, else oldest grant.
      const initial =
        defaultLocation?.id ??
        authorized
          .filter((l) => l.source === 'grant' && l.granted_at)
          .sort((a, b) => (a.granted_at! < b.granted_at! ? -1 : 1))[0]?.id ??
        null;
      if (initial) {
        currentLocationId = initial;
        await this.supabase.admin
          .from('users')
          .update({ portal_current_location_id: initial })
          .eq('id', userId);
      }
    }

    const currentLocation = currentLocationId
      ? authorized.find((l) => l.id === currentLocationId) ?? (await this.loadSpaceSummary(currentLocationId))
      : null;

    return {
      person: {
        id: person.id,
        first_name: person.first_name,
        last_name: person.last_name,
        email: person.email,
      },
      user: { id: userRow.id, email: userRow.email ?? userEmail },
      default_location: defaultLocation,
      authorized_locations: authorized,
      current_location: currentLocation
        ? { id: currentLocation.id, name: currentLocation.name, type: currentLocation.type }
        : null,
      role_scopes: userRolesRes,
      can_submit,
    };
  }

  async setCurrentLocation(authUid: string, locationId: string): Promise<PortalMeResponse> {
    const tenant = TenantContext.current();
    const { userId, personId } = await this.resolveActor(authUid);
    if (!personId) throw new UnauthorizedException('No linked person');

    const authorizedIds = await this.loadAuthorizedSpaceIds(personId);
    if (!authorizedIds.includes(locationId)) {
      throw new ForbiddenException({
        code: 'location_not_authorized',
        message: 'Selected location is not in your authorized scope',
      });
    }

    await this.supabase.admin
      .from('users')
      .update({ portal_current_location_id: locationId })
      .eq('id', userId)
      .eq('tenant_id', tenant.id);

    return this.getMe(authUid);
  }

  async getCatalog(authUid: string, locationId: string): Promise<PortalCatalogResponse> {
    const tenant = TenantContext.current();
    const { personId } = await this.resolveActor(authUid);
    if (!personId) throw new UnauthorizedException('No linked person');

    const authorizedIds = await this.loadAuthorizedSpaceIds(personId);
    if (!authorizedIds.includes(locationId)) {
      throw new ForbiddenException({
        code: 'location_not_authorized',
        message: 'Selected location is not in your authorized scope',
      });
    }

    // Get visible request type ids via the single-source-of-truth RPC.
    const { data: visibleRtIdsData, error: visibleErr } = await this.supabase.admin.rpc(
      'portal_visible_request_type_ids',
      {
        p_person_id: personId,
        p_effective_space_id: locationId,
        p_tenant_id: tenant.id,
      },
    );
    if (visibleErr) throw visibleErr;

    // The rpc returns a set of rows: [{ portal_visible_request_type_ids: '<uuid>' }, ...].
    // Supabase js flattens to an array of objects; normalize.
    const visibleIds = (visibleRtIdsData as unknown as Array<Record<string, string> | string> | null) ?? [];
    const normalizedIds: string[] = visibleIds.map((row) =>
      typeof row === 'string' ? row : (Object.values(row)[0] as string),
    );

    if (normalizedIds.length === 0) {
      const selected = await this.loadSpaceSummary(locationId);
      return { selected_location: selected!, categories: [] };
    }

    const [rtRes, rtCatRes, categoriesRes, selectedSpace] = await Promise.all([
      this.supabase.admin
        .from('request_types')
        .select(
          'id, name, description, domain, form_schema_id, requires_location, location_required, location_granularity, requires_asset, asset_required, asset_type_filter',
        )
        .eq('tenant_id', tenant.id)
        .in('id', normalizedIds),
      this.supabase.admin
        .from('request_type_categories')
        .select('request_type_id, category_id')
        .eq('tenant_id', tenant.id)
        .in('request_type_id', normalizedIds),
      this.supabase.admin
        .from('service_catalog_categories')
        .select('id, name, icon, display_order')
        .eq('tenant_id', tenant.id)
        .eq('active', true)
        .order('display_order'),
      this.loadSpaceSummary(locationId),
    ]);

    const rtRows = (rtRes.data ?? []) as Array<Record<string, unknown>>;
    const rtCats = (rtCatRes.data ?? []) as Array<{ request_type_id: string; category_id: string }>;
    const categories = (categoriesRes.data ?? []) as Array<{ id: string; name: string; icon: string | null }>;

    const byCategory = new Map<string, CatalogRequestType[]>();
    for (const row of rtRows) {
      const rt: CatalogRequestType = {
        id: row.id as string,
        name: row.name as string,
        description: (row.description as string | null) ?? null,
        domain: (row.domain as string | null) ?? null,
        form_schema_id: (row.form_schema_id as string | null) ?? null,
        requires_location: Boolean(row.requires_location),
        location_required: Boolean(row.location_required),
        location_granularity: (row.location_granularity as string | null) ?? null,
        requires_asset: Boolean(row.requires_asset),
        asset_required: Boolean(row.asset_required),
        asset_type_filter: (row.asset_type_filter as string[] | null) ?? [],
      };
      const cats = rtCats.filter((c) => c.request_type_id === rt.id);
      if (cats.length === 0) {
        // Uncategorized bucket — fold under a synthetic "__uncategorized" key.
        const key = '__uncategorized';
        if (!byCategory.has(key)) byCategory.set(key, []);
        byCategory.get(key)!.push(rt);
      } else {
        for (const c of cats) {
          if (!byCategory.has(c.category_id)) byCategory.set(c.category_id, []);
          byCategory.get(c.category_id)!.push(rt);
        }
      }
    }

    const resultCategories: CatalogCategory[] = [];
    for (const cat of categories) {
      const rts = byCategory.get(cat.id);
      if (rts && rts.length > 0) {
        resultCategories.push({
          id: cat.id,
          name: cat.name,
          icon: cat.icon,
          request_types: rts,
        });
      }
    }
    const uncategorized = byCategory.get('__uncategorized');
    if (uncategorized && uncategorized.length > 0) {
      resultCategories.push({
        id: '__uncategorized',
        name: 'Other',
        icon: null,
        request_types: uncategorized,
      });
    }

    return {
      selected_location: selectedSpace!,
      categories: resultCategories,
    };
  }

  async getSpaces(authUid: string, under: string): Promise<PortalSpacesResponse> {
    const tenant = TenantContext.current();
    const { personId } = await this.resolveActor(authUid);
    if (!personId) throw new UnauthorizedException('No linked person');

    const authorizedIds = await this.loadAuthorizedSpaceIds(personId);
    if (!authorizedIds.includes(under)) {
      throw new ForbiddenException({
        code: 'location_not_authorized',
        message: 'Parent location is not in your authorized scope',
      });
    }

    const [parentRes, childrenRes] = await Promise.all([
      this.loadSpaceSummary(under),
      this.supabase.admin
        .from('spaces')
        .select('id, name, type, active, parent_id')
        .eq('tenant_id', tenant.id)
        .eq('parent_id', under)
        .eq('active', true)
        .order('name'),
    ]);

    if (!parentRes) throw new NotFoundException('Parent space not found');

    const childRows = (childrenRes.data ?? []) as Array<{
      id: string;
      name: string;
      type: string;
      active: boolean;
      parent_id: string | null;
    }>;

    // For has_children, one query across all children.
    let grandchildrenIds: Set<string> = new Set();
    if (childRows.length > 0) {
      const gc = await this.supabase.admin
        .from('spaces')
        .select('parent_id')
        .eq('tenant_id', tenant.id)
        .eq('active', true)
        .in(
          'parent_id',
          childRows.map((c) => c.id),
        );
      grandchildrenIds = new Set(
        ((gc.data ?? []) as Array<{ parent_id: string }>).map((r) => r.parent_id),
      );
    }

    return {
      parent: parentRes,
      children: childRows.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        has_children: grandchildrenIds.has(c.id),
        active: c.active,
      })),
    };
  }

  // ── Internal helpers ────────────────────────────────────────────────────

  private async loadSpaceSummary(spaceId: string): Promise<SpaceSummary | null> {
    const tenant = TenantContext.current();
    const { data } = await this.supabase.admin
      .from('spaces')
      .select('id, name, type')
      .eq('id', spaceId)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    return (data as SpaceSummary | null) ?? null;
  }

  private async loadAuthorizedLocations(personId: string): Promise<AuthorizedLocation[]> {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin.rpc('portal_authorized_root_matches', {
      p_person_id: personId,
      p_tenant_id: tenant.id,
    });
    if (error) throw error;

    const rows = ((data ?? []) as unknown as Array<{
      root_id: string;
      source: 'default' | 'grant';
      grant_id: string | null;
    }>);

    if (rows.length === 0) return [];

    // Fetch space details in one query.
    const ids = rows.map((r) => r.root_id);
    const { data: spaceRows } = await this.supabase.admin
      .from('spaces')
      .select('id, name, type')
      .in('id', ids)
      .eq('tenant_id', tenant.id);

    // Fetch grant metadata for grant rows.
    const grantIds = rows.filter((r) => r.grant_id).map((r) => r.grant_id!);
    let grantMetadata: Map<string, { granted_at: string; note: string | null }> = new Map();
    if (grantIds.length > 0) {
      const { data: gd } = await this.supabase.admin
        .from('person_location_grants')
        .select('id, granted_at, note')
        .in('id', grantIds)
        .eq('tenant_id', tenant.id);
      grantMetadata = new Map(
        ((gd ?? []) as Array<{ id: string; granted_at: string; note: string | null }>).map((g) => [
          g.id,
          { granted_at: g.granted_at, note: g.note },
        ]),
      );
    }

    const spaceMap = new Map(
      ((spaceRows ?? []) as Array<{ id: string; name: string; type: string }>).map((s) => [s.id, s]),
    );

    return rows
      .map<AuthorizedLocation | null>((r) => {
        const s = spaceMap.get(r.root_id);
        if (!s) return null;
        const meta = r.grant_id ? grantMetadata.get(r.grant_id) ?? null : null;
        return {
          id: s.id,
          name: s.name,
          type: s.type,
          source: r.source,
          grant_id: r.grant_id,
          granted_at: meta?.granted_at ?? null,
          note: meta?.note ?? null,
        };
      })
      .filter((x): x is AuthorizedLocation => x !== null);
  }

  private async loadAuthorizedSpaceIds(personId: string): Promise<string[]> {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin.rpc('portal_authorized_space_ids', {
      p_person_id: personId,
      p_tenant_id: tenant.id,
    });
    if (error) throw error;
    const rows = (data as unknown as Array<Record<string, string> | string>) ?? [];
    return rows.map((r) => (typeof r === 'string' ? r : (Object.values(r)[0] as string)));
  }

  private async loadRoleScopes(userId: string): Promise<RoleScope[]> {
    const tenant = TenantContext.current();
    const { data } = await this.supabase.admin
      .from('user_role_assignments')
      .select('domain_scope, location_scope, roles:role_id(name)')
      .eq('user_id', userId)
      .eq('tenant_id', tenant.id)
      .eq('active', true);

    const rows = (data ?? []) as Array<{
      domain_scope: string[] | null;
      location_scope: string[] | null;
      roles: { name: string } | { name: string }[] | null;
    }>;

    return rows.map((r) => {
      const role = Array.isArray(r.roles) ? r.roles[0] : r.roles;
      return {
        role_name: role?.name ?? 'unknown',
        domain_scope: r.domain_scope,
        location_scope: r.location_scope,
      };
    });
  }
}

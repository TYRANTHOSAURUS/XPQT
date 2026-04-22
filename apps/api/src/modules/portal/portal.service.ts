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
    type: string;
  };
  user: { id: string; email: string | null };
  default_location: SpaceSummary | null;
  authorized_locations: AuthorizedLocation[];
  current_location: SpaceSummary | null;
  role_scopes: RoleScope[];
  can_submit: boolean;
  /**
   * True iff the server would accept POST /portal/me/claim-default-location
   * for this caller right now. All of: tenant has portal_self_onboard flag
   * enabled, person has type='employee', person has no default and no grants.
   */
  can_self_onboard: boolean;
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

// ── v2 (service-catalog-redesign) response shape ─────────────────────
// Shipped alongside v1 during phase 2. Frontend cuts over in phase 4 when
// tenants.feature_flags.service_catalog_read flips to dualrun/v2_only.
// See docs/service-catalog-redesign.md §5.1

interface CatalogServiceItem {
  id: string;
  key: string;
  name: string;
  description: string | null;
  icon: string | null;
  kb_link: string | null;
  disruption_banner: string | null;
  search_terms: string[];
  on_behalf_policy: 'self_only' | 'any_person' | 'direct_reports' | 'configured_list';
  form_schema_id: string | null;       // from matched form variant (null → no form)
  fulfillment: {
    id: string;                          // fulfillment_type_id
    requires_location: boolean;
    location_required: boolean;
    location_granularity: string | null;
    requires_asset: boolean;
    asset_required: boolean;
    asset_type_filter: string[];
  };
}

interface CatalogCategoryV2 {
  id: string;
  name: string;
  icon: string | null;
  service_items: CatalogServiceItem[];
}

export interface PortalCatalogResponseV2 {
  selected_location: SpaceSummary;
  categories: CatalogCategoryV2[];
}

export type ServiceCatalogReadMode = 'off' | 'dualrun' | 'v2_only';

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

    const [personRes, userFull, authorizedLocationsRes, userRolesRes, tenantFlagsRes] = await Promise.all([
      this.supabase.admin
        .from('persons')
        .select('id, first_name, last_name, email, type, default_location_id')
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
      this.supabase.admin
        .from('tenants')
        .select('feature_flags')
        .eq('id', tenant.id)
        .single(),
    ]);

    const person = personRes.data as
      | { id: string; first_name: string; last_name: string; email: string | null; type: string; default_location_id: string | null }
      | null;
    if (!person) throw new NotFoundException('Person not found');

    const userRow = userFull.data as { id: string; email: string | null; portal_current_location_id: string | null };

    const authorized = authorizedLocationsRes;
    const can_submit = authorized.length > 0;

    // default_location projected ONLY when it's active (i.e. present in the
    // authorized-roots list with source='default'). An inactive default is
    // hidden from the display and from self-heal fallback — otherwise the
    // trigger on users.portal_current_location_id would throw 500 on read.
    const activeDefaultFromAuth = authorized.find((loc) => loc.source === 'default') ?? null;
    const defaultLocation = activeDefaultFromAuth
      ? { id: activeDefaultFromAuth.id, name: activeDefaultFromAuth.name, type: activeDefaultFromAuth.type }
      : null;

    // Self-heal stale current_location.
    let currentLocationId = userRow.portal_current_location_id;
    const currentIsAuthorized = currentLocationId
      ? authorized.some((loc) => loc.id === currentLocationId)
      : false;

    if (currentLocationId && !currentIsAuthorized) {
      // Deterministic fallback: active default → oldest active grant → null.
      let fallback: string | null = null;
      if (defaultLocation) {
        fallback = defaultLocation.id;
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

    // Self-onboard gate — exposed on the response so the UI can show the
    // picker in the NoScopeBlocker only when the server would actually
    // accept a POST /portal/me/claim-default-location. Matches the same
    // conditions checked server-side in claimDefaultLocation() below.
    const tenantFlags =
      ((tenantFlagsRes.data as { feature_flags?: Record<string, unknown> } | null)
        ?.feature_flags ?? {}) as Record<string, unknown>;
    const self_onboard_flag_on = tenantFlags.portal_self_onboard === true;
    const zero_scope = !person.default_location_id && authorized.length === 0;
    const can_self_onboard =
      self_onboard_flag_on && zero_scope && person.type === 'employee';

    return {
      person: {
        id: person.id,
        first_name: person.first_name,
        last_name: person.last_name,
        email: person.email,
        type: person.type,
      },
      user: { id: userRow.id, email: userRow.email ?? userEmail },
      default_location: defaultLocation,
      authorized_locations: authorized,
      current_location: currentLocation
        ? { id: currentLocation.id, name: currentLocation.name, type: currentLocation.type }
        : null,
      role_scopes: userRolesRes,
      can_submit,
      can_self_onboard,
    };
  }

  /**
   * Pre-onboard list: sites/buildings in this tenant that actually have
   * at least one active request type with an eligible-descendant match for
   * the user's eventual catalog. Filters out "dead" sites so the onboarding
   * picker doesn't lead the user into an empty catalog.
   *
   * Only callable when the caller's self-onboard gate is open. v1 doesn't
   * filter by role/department — all employees see the same tenant-wide
   * onboardable set. See docs/portal-scope-slice.md §11.
   */
  async getOnboardableLocations(authUid: string): Promise<SpaceSummary[]> {
    const tenant = TenantContext.current();
    const me = await this.getMe(authUid);
    if (!me.can_self_onboard) {
      throw new ForbiddenException({
        code: 'self_onboard_disabled',
        message: 'Self-onboarding is not available for this account',
      });
    }

    // Service-catalog redesign phase 2: per-person onboardable set via v2 RPC.
    // Legacy portal_onboardable_locations(tenant) kept deprecated in SQL for
    // other callers; this controller route switches to the v2 signature so
    // criteria + effective-dating are honored identically to the catalog
    // render. See docs/service-catalog-redesign.md Phase 2 §Migration.
    const { personId: actorPersonId } = await this.resolveActor(authUid);
    if (!actorPersonId) throw new UnauthorizedException('No linked person');
    const { data: rows, error } = await this.supabase.admin.rpc(
      'portal_onboardable_space_ids_v2',
      { p_tenant_id: tenant.id, p_actor_person_id: actorPersonId },
    );
    if (error) throw error;

    const ids =
      ((rows ?? []) as Array<Record<string, string> | string>).map((r) =>
        typeof r === 'string' ? r : (Object.values(r)[0] as string),
      );
    if (ids.length === 0) return [];

    const { data: spaces } = await this.supabase.admin
      .from('spaces')
      .select('id, name, type')
      .in('id', ids)
      .eq('tenant_id', tenant.id)
      .order('name');

    return (spaces ?? []) as SpaceSummary[];
  }

  /**
   * Zero-scope bootstrap: an employee claims their initial default work location
   * on first login. Subject to THREE independent gates:
   *   1. Tenant flag `portal_self_onboard` = true.
   *   2. persons.type = 'employee' (contractors/vendors/temps/visitors can't).
   *   3. Person currently has NO default and NO grants (one-shot, not re-homing).
   * All three re-checked server-side. DB triggers from 00047/00055 enforce
   * site/building + active + tenant on the space reference.
   */
  async claimDefaultLocation(authUid: string, spaceId: string): Promise<PortalMeResponse> {
    const tenant = TenantContext.current();
    const { personId } = await this.resolveActor(authUid);
    if (!personId) throw new UnauthorizedException('No linked person');

    // Gate 1 — tenant feature flag.
    const { data: tenantRow } = await this.supabase.admin
      .from('tenants')
      .select('feature_flags')
      .eq('id', tenant.id)
      .single();
    const flags =
      ((tenantRow as { feature_flags?: Record<string, unknown> } | null)?.feature_flags ?? {}) as Record<string, unknown>;
    if (flags.portal_self_onboard !== true) {
      throw new ForbiddenException({
        code: 'self_onboard_disabled',
        message: 'Portal self-onboarding is not enabled for this tenant',
      });
    }

    // Gates 2 + 3 — person state.
    const { data: personRow } = await this.supabase.admin
      .from('persons')
      .select('id, type, default_location_id')
      .eq('id', personId)
      .eq('tenant_id', tenant.id)
      .single();
    const person = personRow as
      | { id: string; type: string; default_location_id: string | null }
      | null;
    if (!person) throw new NotFoundException('Person not found');
    if (person.type !== 'employee') {
      throw new ForbiddenException({
        code: 'self_onboard_forbidden_person_type',
        message: `Only employees can self-assign a work location (your record type is '${person.type}')`,
      });
    }
    if (person.default_location_id) {
      throw new ForbiddenException({
        code: 'default_already_set',
        message: 'Your work location is already set; contact an admin to change it',
      });
    }
    const { count: grantCount } = await this.supabase.admin
      .from('person_location_grants')
      .select('id', { count: 'exact', head: true })
      .eq('person_id', personId)
      .eq('tenant_id', tenant.id);
    if ((grantCount ?? 0) > 0) {
      throw new ForbiddenException({
        code: 'grants_exist',
        message: 'You already have location access; contact an admin for changes',
      });
    }

    // Validated — write. Trigger 00047/00055 enforces site|building + active + tenant.
    const { error } = await this.supabase.admin
      .from('persons')
      .update({ default_location_id: spaceId })
      .eq('id', personId)
      .eq('tenant_id', tenant.id);
    if (error) throw error;

    return this.getMe(authUid);
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

  /**
   * Service-catalog v2 read path. Returns service_items shaped by the
   * locked redesign (docs/service-catalog-redesign.md §5.1). Gated by
   * tenants.feature_flags.service_catalog_read; callers hit getCatalog()
   * which delegates here when the flag is dualrun or v2_only.
   */
  async getCatalogV2(authUid: string, locationId: string): Promise<PortalCatalogResponseV2> {
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

    const { data: visibleRows, error: visibleErr } = await this.supabase.admin.rpc(
      'portal_visible_service_item_ids',
      {
        p_actor_person_id: personId,
        p_selected_space_id: locationId,
        p_tenant_id: tenant.id,
      },
    );
    if (visibleErr) throw visibleErr;

    const visibleIds = ((visibleRows ?? []) as Array<Record<string, string> | string>).map((r) =>
      typeof r === 'string' ? r : (Object.values(r)[0] as string),
    );

    if (visibleIds.length === 0) {
      const selected = await this.loadSpaceSummary(locationId);
      return { selected_location: selected!, categories: [] };
    }

    // Load items + their categories + fulfillment intake fields in parallel.
    const [itemsRes, catsRes, categoriesRes, selectedSpace] = await Promise.all([
      this.supabase.admin
        .from('service_items')
        .select('id, key, name, description, icon, search_terms, kb_link, disruption_banner, on_behalf_policy, fulfillment_type_id, display_order')
        .eq('tenant_id', tenant.id)
        .in('id', visibleIds),
      this.supabase.admin
        .from('service_item_categories')
        .select('service_item_id, category_id, display_order')
        .eq('tenant_id', tenant.id)
        .in('service_item_id', visibleIds),
      this.supabase.admin
        .from('service_catalog_categories')
        .select('id, name, icon, display_order')
        .eq('tenant_id', tenant.id)
        .eq('active', true)
        .order('display_order'),
      this.loadSpaceSummary(locationId),
    ]);

    const items = (itemsRes.data ?? []) as Array<{
      id: string; key: string; name: string; description: string | null;
      icon: string | null; search_terms: string[] | null;
      kb_link: string | null; disruption_banner: string | null;
      on_behalf_policy: string;
      fulfillment_type_id: string;
      display_order: number;
    }>;

    const fulfillmentIds = Array.from(new Set(items.map((i) => i.fulfillment_type_id)));
    const { data: ftRows } = await this.supabase.admin
      .from('fulfillment_types')
      .select('id, requires_location, location_required, location_granularity, requires_asset, asset_required, asset_type_filter')
      .eq('tenant_id', tenant.id)
      .in('id', fulfillmentIds);
    const ftMap = new Map(
      ((ftRows ?? []) as Array<Record<string, unknown>>).map((r) => [r.id as string, r]),
    );

    // Matched form variant per item. One query over all visibleIds; resolve winner in JS.
    const { data: variantRows } = await this.supabase.admin
      .from('service_item_form_variants')
      .select('id, service_item_id, criteria_set_id, form_schema_id, priority, starts_at, ends_at, active, created_at')
      .eq('tenant_id', tenant.id)
      .in('service_item_id', visibleIds);
    const now = Date.now();
    type Variant = {
      id: string; service_item_id: string; criteria_set_id: string | null;
      form_schema_id: string; priority: number; starts_at: string | null;
      ends_at: string | null; active: boolean; created_at: string;
    };
    const activeVariantsByItem = new Map<string, Variant[]>();
    for (const v of ((variantRows ?? []) as Variant[])) {
      if (!v.active) continue;
      if (v.starts_at && new Date(v.starts_at).getTime() > now) continue;
      if (v.ends_at && new Date(v.ends_at).getTime() <= now) continue;
      const arr = activeVariantsByItem.get(v.service_item_id) ?? [];
      arr.push(v);
      activeVariantsByItem.set(v.service_item_id, arr);
    }

    // Criteria matches for non-default variants: evaluate all in parallel.
    // Design §3.4 "criteria caching" called for explicit per-invocation batch;
    // Promise.all pushes the ≤N RPCs concurrently and the PL/pgSQL evaluator
    // preloads the person row in each call (no extra round trips).
    const nonDefaultCriteriaIds = new Set<string>();
    for (const list of activeVariantsByItem.values()) {
      for (const v of list) if (v.criteria_set_id) nonDefaultCriteriaIds.add(v.criteria_set_id);
    }
    const criteriaEntries = await Promise.all(
      Array.from(nonDefaultCriteriaIds).map((csId) =>
        this.supabase.admin
          .rpc('criteria_matches', {
            p_set_id: csId,
            p_person_id: personId,
            p_tenant_id: tenant.id,
          })
          .then(({ data, error }) => {
            if (error) throw error;
            return [csId, Boolean(data)] as const;
          }),
      ),
    );
    const criteriaHits = new Map<string, boolean>(criteriaEntries);
    const pickVariant = (itemId: string): string | null => {
      const list = activeVariantsByItem.get(itemId) ?? [];
      // priority desc, created_at asc
      list.sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at));
      for (const v of list) {
        if (v.criteria_set_id === null) return v.form_schema_id;
        if (criteriaHits.get(v.criteria_set_id)) return v.form_schema_id;
      }
      // Fall back to default if not already hit
      const def = list.find((v) => v.criteria_set_id === null);
      return def?.form_schema_id ?? null;
    };

    // Group into categories
    const catBindings = ((catsRes.data ?? []) as Array<{ service_item_id: string; category_id: string }>);
    const categories = ((categoriesRes.data ?? []) as Array<{ id: string; name: string; icon: string | null }>);
    const byCategory = new Map<string, CatalogServiceItem[]>();

    for (const item of items) {
      const ft = ftMap.get(item.fulfillment_type_id) ?? {};
      const serviceItem: CatalogServiceItem = {
        id: item.id,
        key: item.key,
        name: item.name,
        description: item.description,
        icon: item.icon,
        kb_link: item.kb_link,
        disruption_banner: item.disruption_banner,
        search_terms: item.search_terms ?? [],
        on_behalf_policy: (item.on_behalf_policy as CatalogServiceItem['on_behalf_policy']) ?? 'self_only',
        form_schema_id: pickVariant(item.id),
        fulfillment: {
          id: item.fulfillment_type_id,
          requires_location: Boolean(ft.requires_location),
          location_required: Boolean(ft.location_required),
          location_granularity: (ft.location_granularity as string | null) ?? null,
          requires_asset: Boolean(ft.requires_asset),
          asset_required: Boolean(ft.asset_required),
          asset_type_filter: (ft.asset_type_filter as string[] | null) ?? [],
        },
      };
      const bindings = catBindings.filter((b) => b.service_item_id === item.id);
      if (bindings.length === 0) {
        const key = '__uncategorized';
        if (!byCategory.has(key)) byCategory.set(key, []);
        byCategory.get(key)!.push(serviceItem);
      } else {
        for (const b of bindings) {
          if (!byCategory.has(b.category_id)) byCategory.set(b.category_id, []);
          byCategory.get(b.category_id)!.push(serviceItem);
        }
      }
    }

    const resultCategories: CatalogCategoryV2[] = [];
    for (const cat of categories) {
      const list = byCategory.get(cat.id);
      if (list && list.length > 0) {
        resultCategories.push({ id: cat.id, name: cat.name, icon: cat.icon, service_items: list });
      }
    }
    const uncategorized = byCategory.get('__uncategorized');
    if (uncategorized && uncategorized.length > 0) {
      resultCategories.push({ id: '__uncategorized', name: 'Other', icon: null, service_items: uncategorized });
    }

    return { selected_location: selectedSpace!, categories: resultCategories };
  }

  /**
   * Reads tenants.feature_flags.service_catalog_read with a 30s cache.
   * Matches the pattern in RoutingEvaluatorService.getMode.
   */
  private readonly catalogModeCache = new Map<string, { mode: ServiceCatalogReadMode; expires_at: number }>();
  private readonly CATALOG_MODE_TTL_MS = 30_000;

  async getServiceCatalogReadMode(tenantId: string): Promise<ServiceCatalogReadMode> {
    const cached = this.catalogModeCache.get(tenantId);
    const now = Date.now();
    if (cached && cached.expires_at > now) return cached.mode;

    const { data, error } = await this.supabase.admin
      .from('tenants')
      .select('feature_flags')
      .eq('id', tenantId)
      .maybeSingle();
    if (error || !data) {
      this.catalogModeCache.set(tenantId, { mode: 'off', expires_at: now + this.CATALOG_MODE_TTL_MS });
      return 'off';
    }
    const raw = ((data.feature_flags as Record<string, unknown> | null) ?? {}).service_catalog_read;
    const mode: ServiceCatalogReadMode =
      raw === 'dualrun' || raw === 'v2_only' ? raw : 'off';
    this.catalogModeCache.set(tenantId, { mode, expires_at: now + this.CATALOG_MODE_TTL_MS });
    return mode;
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
      .eq('active', true)
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

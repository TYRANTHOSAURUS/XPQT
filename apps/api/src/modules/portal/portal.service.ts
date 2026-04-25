import { ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { PortalAppearanceService } from '../portal-appearance/portal-appearance.service';
import { PortalAnnouncementsService } from '../portal-announcements/portal-announcements.service';

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
    phone: string | null;
    type: string;
    avatar_url: string | null;
    primary_org_node: { id: string; name: string; code: string | null } | null;
  };
  user: { id: string; email: string | null };
  tenant: { id: string; name: string };
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
  appearance: {
    hero_image_url: string | null;
    welcome_headline: string | null;
    supporting_line: string | null;
    greeting_enabled: boolean;
  } | null;
  announcement: {
    id: string;
    title: string;
    body: string;
    published_at: string;
    expires_at: string | null;
  } | null;
}

/**
 * Catalog response shape. Categories list request types directly — there is
 * no service_item intermediate (see docs/service-catalog-live.md). Portal-
 * facing fields (kb_link, disruption_banner, keywords, on_behalf_policy) live
 * on request_types after 00085. Intake gating fields stay on request_types
 * and are projected onto `intake`.
 */
interface CatalogRequestType {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  keywords: string[];
  kb_link: string | null;
  disruption_banner: string | null;
  on_behalf_policy: 'self_only' | 'any_person' | 'direct_reports' | 'configured_list';
  domain: string | null;
  form_schema_id: string | null;       // from matched form variant, else null
  display_order: number;
  intake: {
    requires_location: boolean;
    location_required: boolean;
    location_granularity: string | null;
    requires_asset: boolean;
    asset_required: boolean;
    asset_type_filter: string[];
  };
}

interface CatalogCategory {
  id: string;
  name: string;
  icon: string | null;
  parent_category_id: string | null;
  description: string | null;
  cover_image_url: string | null;
  cover_source: 'image' | 'icon' | null;
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
 * See docs/portal-scope-slice.md §5.1–§5.4 and docs/service-catalog-live.md §6.
 */
@Injectable()
export class PortalService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly appearance: PortalAppearanceService,
    private readonly announcements: PortalAnnouncementsService,
  ) {}

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
        .select(
          `id, first_name, last_name, email, phone, type, default_location_id, avatar_url,
           primary_membership:person_org_memberships(is_primary, org_node:org_nodes(id, name, code))`,
        )
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
        .select('name, feature_flags')
        .eq('id', tenant.id)
        .single(),
    ]);

    const person = personRes.data as
      | {
          id: string;
          first_name: string;
          last_name: string;
          email: string | null;
          phone: string | null;
          type: string;
          default_location_id: string | null;
          avatar_url: string | null;
          primary_membership:
            | Array<{
                is_primary: boolean;
                org_node: { id: string; name: string; code: string | null } | { id: string; name: string; code: string | null }[] | null;
              }>
            | null;
        }
      | null;
    if (!person) throw new NotFoundException('Person not found');

    const primaryRow = (person.primary_membership ?? []).find((m) => m.is_primary) ?? null;
    const primaryOrgRaw = primaryRow?.org_node ?? null;
    const primaryOrg = Array.isArray(primaryOrgRaw) ? primaryOrgRaw[0] ?? null : primaryOrgRaw;

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

    let appearance: PortalMeResponse['appearance'] = null;
    let announcement: PortalMeResponse['announcement'] = null;
    if (currentLocation) {
      const [app, ann] = await Promise.all([
        this.appearance.get(currentLocation.id),
        this.announcements.getActiveForLocation(currentLocation.id),
      ]);
      appearance = app
        ? {
            hero_image_url: app.hero_image_url,
            welcome_headline: app.welcome_headline,
            supporting_line: app.supporting_line,
            greeting_enabled: app.greeting_enabled,
          }
        : null;
      announcement = ann
        ? {
            id: ann.id,
            title: ann.title,
            body: ann.body,
            published_at: ann.published_at,
            expires_at: ann.expires_at,
          }
        : null;
    }

    return {
      person: {
        id: person.id,
        first_name: person.first_name,
        last_name: person.last_name,
        email: person.email,
        phone: person.phone,
        type: person.type,
        avatar_url: person.avatar_url,
        primary_org_node: primaryOrg
          ? { id: primaryOrg.id, name: primaryOrg.name, code: primaryOrg.code ?? null }
          : null,
      },
      user: { id: userRow.id, email: userRow.email ?? userEmail },
      tenant: {
        id: tenant.id,
        name: ((tenantFlagsRes.data as { name?: string } | null)?.name) ?? '',
      },
      default_location: defaultLocation,
      authorized_locations: authorized,
      current_location: currentLocation
        ? { id: currentLocation.id, name: currentLocation.name, type: currentLocation.type }
        : null,
      role_scopes: userRolesRes,
      can_submit,
      can_self_onboard,
      appearance,
      announcement,
    };
  }

  /**
   * Pre-onboard list: sites/buildings in this tenant that have at least one
   * active + visible request type (per-actor criteria + coverage). Reads the
   * request-type-native onboardable function directly; no bridge.
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

    const { personId: actorPersonId } = await this.resolveActor(authUid);
    if (!actorPersonId) throw new UnauthorizedException('No linked person');
    const { data: rows, error } = await this.supabase.admin.rpc(
      'request_type_onboardable_space_ids',
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

  /**
   * Profile self-edit: phone and default_location_id.
   * - phone is free text (no format gate; tenants vary).
   * - default_location_id, when provided, must be in the caller's authorized
   *   set. The DB trigger from 00047 additionally enforces site|building +
   *   tenant + active.
   */
  async updateProfile(
    authUid: string,
    body: { phone?: string | null; default_location_id?: string | null },
  ): Promise<PortalMeResponse> {
    const tenant = TenantContext.current();
    const { personId } = await this.resolveActor(authUid);
    if (!personId) throw new UnauthorizedException('No linked person');

    const update: Record<string, unknown> = {};
    if (body.phone !== undefined) {
      const trimmed = typeof body.phone === 'string' ? body.phone.trim() : null;
      update.phone = trimmed && trimmed.length > 0 ? trimmed : null;
    }
    if (body.default_location_id !== undefined) {
      if (body.default_location_id) {
        const authorizedIds = await this.loadAuthorizedSpaceIds(personId);
        if (!authorizedIds.includes(body.default_location_id)) {
          throw new ForbiddenException({
            code: 'location_not_authorized',
            message: 'Selected location is not in your authorized scope',
          });
        }
      }
      update.default_location_id = body.default_location_id ?? null;
    }

    if (Object.keys(update).length > 0) {
      const { error } = await this.supabase.admin
        .from('persons')
        .update(update)
        .eq('id', personId)
        .eq('tenant_id', tenant.id);
      if (error) throw error;
    }

    return this.getMe(authUid);
  }

  async uploadAvatar(
    authUid: string,
    file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
  ): Promise<PortalMeResponse> {
    const tenant = TenantContext.current();
    const { personId } = await this.resolveActor(authUid);
    if (!personId) throw new UnauthorizedException('No linked person');

    const ALLOWED = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const;
    const MAX_BYTES = 2 * 1024 * 1024;
    const ext = ALLOWED[file.mimetype as keyof typeof ALLOWED];
    if (!ext) {
      throw new ForbiddenException({
        code: 'unsupported_media_type',
        message: 'Avatar must be JPG, PNG, or WebP',
      });
    }
    if (file.buffer.byteLength > MAX_BYTES) {
      throw new ForbiddenException({
        code: 'avatar_too_large',
        message: 'Avatar image must be 2MB or smaller',
      });
    }

    // Remove any prior extensions so the bucket never accumulates stale variants.
    const variants = (['jpg', 'png', 'webp'] as const).map(
      (e) => `${tenant.id}/avatar/${personId}.${e}`,
    );
    await this.supabase.admin.storage.from('portal-assets').remove(variants);

    const path = `${tenant.id}/avatar/${personId}.${ext}`;
    const { error: uploadErr } = await this.supabase.admin.storage
      .from('portal-assets')
      .upload(path, file.buffer, { contentType: file.mimetype, upsert: true, cacheControl: '3600' });
    if (uploadErr) throw uploadErr;

    const { data: pub } = this.supabase.admin.storage.from('portal-assets').getPublicUrl(path);
    const url = `${pub.publicUrl}?v=${Date.now()}`;

    const { error: updErr } = await this.supabase.admin
      .from('persons')
      .update({ avatar_url: url })
      .eq('id', personId)
      .eq('tenant_id', tenant.id);
    if (updErr) throw updErr;

    return this.getMe(authUid);
  }

  async removeAvatar(authUid: string): Promise<PortalMeResponse> {
    const tenant = TenantContext.current();
    const { personId } = await this.resolveActor(authUid);
    if (!personId) throw new UnauthorizedException('No linked person');

    const variants = (['jpg', 'png', 'webp'] as const).map(
      (e) => `${tenant.id}/avatar/${personId}.${e}`,
    );
    await this.supabase.admin.storage.from('portal-assets').remove(variants);

    const { error } = await this.supabase.admin
      .from('persons')
      .update({ avatar_url: null })
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

  /**
   * Single source of truth for portal catalog reads. Returns categories →
   * request_types with portal-facing fields projected from request_types and
   * the matched form variant. Reads request_type_visible_ids; no bridge.
   */
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

    const { data: visibleRows, error: visibleErr } = await this.supabase.admin.rpc(
      'request_type_visible_ids',
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

    const [rtRes, rtCatRes, categoriesRes, variantRes, selectedSpace] = await Promise.all([
      this.supabase.admin
        .from('request_types')
        .select(
          'id, name, description, icon, keywords, kb_link, disruption_banner, on_behalf_policy, domain, display_order, requires_location, location_required, location_granularity, requires_asset, asset_required, asset_type_filter',
        )
        .eq('tenant_id', tenant.id)
        .in('id', visibleIds),
      this.supabase.admin
        .from('request_type_categories')
        .select('request_type_id, category_id')
        .eq('tenant_id', tenant.id)
        .in('request_type_id', visibleIds),
      this.supabase.admin
        .from('service_catalog_categories')
        .select('id, name, icon, parent_category_id, description, cover_image_url, cover_source, display_order')
        .eq('tenant_id', tenant.id)
        .eq('active', true)
        .order('display_order'),
      this.supabase.admin
        .from('request_type_form_variants')
        .select('id, request_type_id, criteria_set_id, form_schema_id, priority, starts_at, ends_at, active, created_at')
        .eq('tenant_id', tenant.id)
        .in('request_type_id', visibleIds),
      this.loadSpaceSummary(locationId),
    ]);

    const rtRows = (rtRes.data ?? []) as Array<Record<string, unknown>>;
    const rtCats = ((rtCatRes.data ?? []) as Array<{ request_type_id: string; category_id: string }>);
    const categories = ((categoriesRes.data ?? []) as Array<{
      id: string; name: string; icon: string | null; parent_category_id: string | null;
      description: string | null; cover_image_url: string | null; cover_source: 'image' | 'icon' | null;
    }>);

    // Form variant resolution — conditional beats default (matches
    // request_type_requestable_trace ordering and uniq_request_type_default_variant).
    type Variant = {
      id: string; request_type_id: string; criteria_set_id: string | null;
      form_schema_id: string; priority: number; starts_at: string | null;
      ends_at: string | null; active: boolean; created_at: string;
    };
    const now = Date.now();
    const activeVariantsByRt = new Map<string, Variant[]>();
    for (const v of ((variantRes.data ?? []) as Variant[])) {
      if (!v.active) continue;
      if (v.starts_at && new Date(v.starts_at).getTime() > now) continue;
      if (v.ends_at && new Date(v.ends_at).getTime() <= now) continue;
      const arr = activeVariantsByRt.get(v.request_type_id) ?? [];
      arr.push(v);
      activeVariantsByRt.set(v.request_type_id, arr);
    }
    const nonDefaultCriteriaIds = new Set<string>();
    for (const list of activeVariantsByRt.values()) {
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
    const pickVariant = (rtId: string): string | null => {
      const list = activeVariantsByRt.get(rtId) ?? [];
      const conditional = list
        .filter((v) => v.criteria_set_id !== null && criteriaHits.get(v.criteria_set_id))
        .sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at));
      if (conditional.length > 0) return conditional[0].form_schema_id;
      const def = list.find((v) => v.criteria_set_id === null);
      return def?.form_schema_id ?? null;
    };

    const byCategory = new Map<string, CatalogRequestType[]>();
    for (const row of rtRows) {
      const rt: CatalogRequestType = {
        id: row.id as string,
        name: row.name as string,
        description: (row.description as string | null) ?? null,
        icon: (row.icon as string | null) ?? null,
        keywords: (row.keywords as string[] | null) ?? [],
        kb_link: (row.kb_link as string | null) ?? null,
        disruption_banner: (row.disruption_banner as string | null) ?? null,
        on_behalf_policy: (row.on_behalf_policy as CatalogRequestType['on_behalf_policy']) ?? 'self_only',
        domain: (row.domain as string | null) ?? null,
        form_schema_id: pickVariant(row.id as string),
        display_order: (row.display_order as number | null) ?? 0,
        intake: {
          requires_location: Boolean(row.requires_location),
          location_required: Boolean(row.location_required),
          location_granularity: (row.location_granularity as string | null) ?? null,
          requires_asset: Boolean(row.requires_asset),
          asset_required: Boolean(row.asset_required),
          asset_type_filter: (row.asset_type_filter as string[] | null) ?? [],
        },
      };
      const bindings = rtCats.filter((c) => c.request_type_id === rt.id);
      if (bindings.length === 0) {
        const key = '__uncategorized';
        if (!byCategory.has(key)) byCategory.set(key, []);
        byCategory.get(key)!.push(rt);
      } else {
        for (const b of bindings) {
          if (!byCategory.has(b.category_id)) byCategory.set(b.category_id, []);
          byCategory.get(b.category_id)!.push(rt);
        }
      }
    }

    // Surface categories whose subtree has items, so clients can render the
    // full tree and drill in. Client filters to top-level on first render.
    const childrenByParent = new Map<string | null, string[]>();
    for (const cat of categories) {
      const key = cat.parent_category_id ?? null;
      if (!childrenByParent.has(key)) childrenByParent.set(key, []);
      childrenByParent.get(key)!.push(cat.id);
    }
    const hasItemsDeep = new Map<string, boolean>();
    const compute = (id: string): boolean => {
      if (hasItemsDeep.has(id)) return hasItemsDeep.get(id)!;
      const direct = (byCategory.get(id)?.length ?? 0) > 0;
      const kids = childrenByParent.get(id) ?? [];
      const deep = direct || kids.some(compute);
      hasItemsDeep.set(id, deep);
      return deep;
    };
    for (const cat of categories) compute(cat.id);

    const resultCategories: CatalogCategory[] = [];
    for (const cat of categories) {
      if (!hasItemsDeep.get(cat.id)) continue;
      const rts = (byCategory.get(cat.id) ?? []).sort((a, b) => a.display_order - b.display_order);
      resultCategories.push({
        id: cat.id,
        name: cat.name,
        icon: cat.icon,
        parent_category_id: cat.parent_category_id,
        description: cat.description,
        cover_image_url: cat.cover_image_url,
        cover_source: cat.cover_source,
        request_types: rts,
      });
    }
    const uncategorized = byCategory.get('__uncategorized');
    if (uncategorized && uncategorized.length > 0) {
      resultCategories.push({
        id: '__uncategorized',
        name: 'Other',
        icon: null,
        parent_category_id: null,
        description: null,
        cover_image_url: null,
        cover_source: null,
        request_types: uncategorized.sort((a, b) => a.display_order - b.display_order),
      });
    }

    return { selected_location: selectedSpace!, categories: resultCategories };
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

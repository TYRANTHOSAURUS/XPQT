import { BadRequestException, Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

type ScopeKind = 'tenant' | 'space' | 'space_group';

export interface CoverageRuleInput {
  scope_kind: ScopeKind;
  space_id?: string | null;
  space_group_id?: string | null;
  inherit_to_descendants?: boolean;
  starts_at?: string | null;
  ends_at?: string | null;
  active?: boolean;
}

export interface AudienceRuleInput {
  criteria_set_id: string;
  mode: 'visible_allow' | 'visible_deny' | 'request_allow' | 'request_deny';
  starts_at?: string | null;
  ends_at?: string | null;
  active?: boolean;
}

export interface FormVariantInput {
  criteria_set_id: string | null;  // NULL = default variant
  form_schema_id: string;
  priority?: number;
  starts_at?: string | null;
  ends_at?: string | null;
  active?: boolean;
}

export interface OnBehalfRuleInput {
  role: 'actor' | 'target';
  criteria_set_id: string;
}

export interface ScopeOverrideInput {
  scope_kind: ScopeKind;
  space_id?: string | null;
  space_group_id?: string | null;
  inherit_to_descendants?: boolean;
  starts_at?: string | null;
  ends_at?: string | null;
  active?: boolean;
  handler_kind?: 'team' | 'vendor' | 'none' | null;
  handler_team_id?: string | null;
  handler_vendor_id?: string | null;
  workflow_definition_id?: string | null;
  case_sla_policy_id?: string | null;
  case_owner_policy_entity_id?: string | null;
  child_dispatch_policy_entity_id?: string | null;
  executor_sla_policy_id?: string | null;
}

@Injectable()
export class RequestTypeService {
  constructor(private readonly supabase: SupabaseService) {}

  // ── Core CRUD ──────────────────────────────────────────────────────────

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
    description?: string;
    icon?: string;
    keywords?: string[];
    kb_link?: string;
    disruption_banner?: string;
    on_behalf_policy?: 'self_only' | 'any_person' | 'direct_reports' | 'configured_list';
    display_order?: number;
    domain?: string;
    // form_schema_id removed: default form lives exclusively on
    // request_type_form_variants (criteria_set_id IS NULL). Admin writes via
    // PUT /request-types/:id/form-variants. See migration 00098.
    workflow_definition_id?: string;
    sla_policy_id?: string;
    fulfillment_strategy?: 'asset' | 'location' | 'fixed' | 'auto';
    requires_asset?: boolean;
    asset_required?: boolean;
    asset_type_filter?: string[];
    requires_location?: boolean;
    location_required?: boolean;
    location_granularity?: string | null;
    default_team_id?: string | null;
    default_vendor_id?: string | null;
    requires_approval?: boolean;
    approval_approver_team_id?: string | null;
    approval_approver_person_id?: string | null;
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

  // ── Categories (M2M) ───────────────────────────────────────────────────

  async putCategories(requestTypeId: string, categoryIds: string[]) {
    const tenant = TenantContext.current();
    await this.assertRequestTypeExists(requestTypeId);
    await this.assertIdsInTenant('service_catalog_categories', categoryIds, 'category_id');
    const { error } = await this.supabase.admin.rpc('request_type_replace_categories', {
      p_request_type_id: requestTypeId,
      p_tenant_id: tenant.id,
      p_category_ids: categoryIds ?? [],
    });
    if (error) throw error;
    return this.listCategories(requestTypeId);
  }

  async listCategories(requestTypeId: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('request_type_categories')
      .select('category_id')
      .eq('tenant_id', tenant.id)
      .eq('request_type_id', requestTypeId);
    if (error) throw error;
    return ((data ?? []) as Array<{ category_id: string }>).map((r) => r.category_id);
  }

  // ── Coverage rules ─────────────────────────────────────────────────────

  async putCoverage(requestTypeId: string, rules: CoverageRuleInput[]) {
    const tenant = TenantContext.current();
    await this.assertRequestTypeExists(requestTypeId);

    for (const r of rules) this.validateScope(r.scope_kind, r.space_id ?? null, r.space_group_id ?? null);
    await this.assertIdsInTenant('spaces', rules.map((r) => r.space_id ?? null), 'space_id');
    await this.assertIdsInTenant('space_groups', rules.map((r) => r.space_group_id ?? null), 'space_group_id');

    const { error } = await this.supabase.admin.rpc('request_type_replace_coverage', {
      p_request_type_id: requestTypeId,
      p_tenant_id: tenant.id,
      p_rules: rules,
    });
    if (error) throw error;
    return this.listCoverage(requestTypeId);
  }

  async listCoverage(requestTypeId: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('request_type_coverage_rules')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('request_type_id', requestTypeId)
      .order('created_at');
    if (error) throw error;
    return data;
  }

  // ── Audience rules ─────────────────────────────────────────────────────

  async putAudience(requestTypeId: string, rules: AudienceRuleInput[]) {
    const tenant = TenantContext.current();
    await this.assertRequestTypeExists(requestTypeId);
    await this.assertIdsInTenant('criteria_sets', rules.map((r) => r.criteria_set_id), 'criteria_set_id');

    const { error } = await this.supabase.admin.rpc('request_type_replace_audience', {
      p_request_type_id: requestTypeId,
      p_tenant_id: tenant.id,
      p_rules: rules,
    });
    if (error) throw error;
    return this.listAudience(requestTypeId);
  }

  async listAudience(requestTypeId: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('request_type_audience_rules')
      .select('*, criteria_set:criteria_sets(id, name, description)')
      .eq('tenant_id', tenant.id)
      .eq('request_type_id', requestTypeId)
      .order('created_at');
    if (error) throw error;
    return data;
  }

  // ── Form variants ──────────────────────────────────────────────────────

  async putFormVariants(requestTypeId: string, variants: FormVariantInput[]) {
    const tenant = TenantContext.current();
    await this.assertRequestTypeExists(requestTypeId);

    const defaults = variants.filter((v) => v.criteria_set_id === null);
    if (defaults.length > 1) {
      throw new BadRequestException({
        code: 'form_variants_multiple_defaults',
        message: 'At most one default form variant (criteria_set_id = null) is allowed per request type',
      });
    }
    await this.assertIdsInTenant(
      'criteria_sets',
      variants.map((v) => v.criteria_set_id),
      'criteria_set_id',
    );
    await this.assertIdsInTenant(
      'config_entities',
      variants.map((v) => v.form_schema_id),
      'form_schema_id',
    );

    const { error } = await this.supabase.admin.rpc('request_type_replace_form_variants', {
      p_request_type_id: requestTypeId,
      p_tenant_id: tenant.id,
      p_variants: variants,
    });
    if (error) throw error;
    return this.listFormVariants(requestTypeId);
  }

  async listFormVariants(requestTypeId: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('request_type_form_variants')
      .select('*, criteria_set:criteria_sets(id, name)')
      .eq('tenant_id', tenant.id)
      .eq('request_type_id', requestTypeId)
      .order('priority', { ascending: false })
      .order('created_at');
    if (error) throw error;
    return data;
  }

  // ── On-behalf rules ────────────────────────────────────────────────────

  async putOnBehalfRules(requestTypeId: string, rules: OnBehalfRuleInput[]) {
    const tenant = TenantContext.current();
    await this.assertRequestTypeExists(requestTypeId);
    await this.assertIdsInTenant('criteria_sets', rules.map((r) => r.criteria_set_id), 'criteria_set_id');

    const { error } = await this.supabase.admin.rpc('request_type_replace_on_behalf_rules', {
      p_request_type_id: requestTypeId,
      p_tenant_id: tenant.id,
      p_rules: rules,
    });
    if (error) throw error;
    return this.listOnBehalfRules(requestTypeId);
  }

  async listOnBehalfRules(requestTypeId: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('request_type_on_behalf_rules')
      .select('*, criteria_set:criteria_sets(id, name)')
      .eq('tenant_id', tenant.id)
      .eq('request_type_id', requestTypeId);
    if (error) throw error;
    return data;
  }

  // ── Scope overrides ────────────────────────────────────────────────────

  async putScopeOverrides(requestTypeId: string, overrides: ScopeOverrideInput[]) {
    const tenant = TenantContext.current();
    await this.assertRequestTypeExists(requestTypeId);

    for (const o of overrides) {
      this.validateScope(o.scope_kind, o.space_id ?? null, o.space_group_id ?? null);
      this.validateHandlerShape(o);
      this.validateOverrideNonEmpty(o);
    }
    // Migration 00101 dropped the 00091 partial-unique indexes so scheduled
    // handoffs are expressible (admin prepares next month's override with
    // active=true + future starts_at while the current one is still active).
    // This service-layer check is now the sole arbiter: it permits multiple
    // active rows on the same (request_type, scope, scope-target) AS LONG AS
    // their [starts_at, ends_at) windows don't intersect. The resolver
    // precedence function filters by `active AND starts_at <= now() AND
    // ends_at > now()` so at most one row is ever in-effect at runtime; the
    // ORDER BY id ASC breaks residual ties.
    this.validateNoTemporalOverlap(overrides);
    await this.assertIdsInTenant('spaces', overrides.map((o) => o.space_id ?? null), 'space_id');
    await this.assertIdsInTenant('space_groups', overrides.map((o) => o.space_group_id ?? null), 'space_group_id');
    await this.assertIdsInTenant('teams', overrides.map((o) => o.handler_team_id ?? null), 'handler_team_id');
    await this.assertIdsInTenant('vendors', overrides.map((o) => o.handler_vendor_id ?? null), 'handler_vendor_id');
    await this.assertIdsInTenant(
      'workflow_definitions',
      overrides.map((o) => o.workflow_definition_id ?? null),
      'workflow_definition_id',
    );
    await this.assertIdsInTenant(
      'sla_policies',
      overrides.flatMap((o) => [o.case_sla_policy_id ?? null, o.executor_sla_policy_id ?? null]),
      'case_sla_policy_id / executor_sla_policy_id',
    );
    await this.assertIdsInTenant(
      'config_entities',
      overrides.flatMap((o) => [
        o.case_owner_policy_entity_id ?? null,
        o.child_dispatch_policy_entity_id ?? null,
      ]),
      'case_owner_policy_entity_id / child_dispatch_policy_entity_id',
    );

    const { error } = await this.supabase.admin.rpc('request_type_replace_scope_overrides', {
      p_request_type_id: requestTypeId,
      p_tenant_id: tenant.id,
      p_overrides: overrides,
    });
    if (error) throw error;
    return this.listScopeOverrides(requestTypeId);
  }

  async listScopeOverrides(requestTypeId: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('request_type_scope_overrides')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('request_type_id', requestTypeId)
      .order('created_at');
    if (error) throw error;
    return data;
  }

  // ── Coverage matrix (read-only aggregate for admin UI) ─────────────────
  // Returns one row per site/building in the tenant with the composed
  // effective state: which coverage rule offers it (if any), which scope
  // override wins (if any), and the request_types defaults that fall through.
  // Source labels are computed server-side so the UI renders badges without
  // re-implementing precedence. See live-doc §8.
  async getCoverageMatrix(requestTypeId: string) {
    const tenant = TenantContext.current();
    await this.assertRequestTypeExists(requestTypeId);

    const { data: rows, error } = await this.supabase.admin.rpc('request_type_coverage_matrix', {
      p_tenant_id: tenant.id,
      p_request_type_id: requestTypeId,
    });
    if (error) throw error;

    type MatrixRow = {
      site_id: string;
      site_name: string;
      site_type: 'site' | 'building';
      parent_id: string | null;
      offering: Record<string, unknown> | null;
      override: Record<string, unknown> | null;
      rt_defaults: {
        default_team_id: string | null;
        default_vendor_id: string | null;
        workflow_definition_id: string | null;
        sla_policy_id: string | null;
      };
    };
    const raw = (rows ?? []) as MatrixRow[];

    // Gather every id we need to hydrate into a display name in one batch per
    // table. Skipping nulls + de-duping keeps the per-request work bounded at
    // O(distinct-ids) regardless of tenant size.
    const teamIds = new Set<string>();
    const vendorIds = new Set<string>();
    const workflowIds = new Set<string>();
    const slaIds = new Set<string>();
    const configEntityIds = new Set<string>();

    for (const r of raw) {
      const o = (r.override ?? {}) as Record<string, string | null | undefined>;
      if (o.handler_team_id) teamIds.add(o.handler_team_id);
      if (o.handler_vendor_id) vendorIds.add(o.handler_vendor_id);
      if (o.workflow_definition_id) workflowIds.add(o.workflow_definition_id);
      if (o.case_sla_policy_id) slaIds.add(o.case_sla_policy_id);
      if (o.executor_sla_policy_id) slaIds.add(o.executor_sla_policy_id);
      if (o.case_owner_policy_entity_id) configEntityIds.add(o.case_owner_policy_entity_id);
      if (o.child_dispatch_policy_entity_id) configEntityIds.add(o.child_dispatch_policy_entity_id);
    }
    const d = raw[0]?.rt_defaults;
    if (d?.default_team_id) teamIds.add(d.default_team_id);
    if (d?.default_vendor_id) vendorIds.add(d.default_vendor_id);
    if (d?.workflow_definition_id) workflowIds.add(d.workflow_definition_id);
    if (d?.sla_policy_id) slaIds.add(d.sla_policy_id);

    const [teams, vendors, workflows, slas, configEntities] = await Promise.all([
      this.fetchNames('teams', tenant.id, Array.from(teamIds), 'name'),
      this.fetchNames('vendors', tenant.id, Array.from(vendorIds), 'name'),
      this.fetchNames('workflow_definitions', tenant.id, Array.from(workflowIds), 'name'),
      this.fetchNames('sla_policies', tenant.id, Array.from(slaIds), 'name'),
      this.fetchNames('config_entities', tenant.id, Array.from(configEntityIds), 'display_name'),
    ]);

    type Source = 'override' | 'default' | 'override_unassigned' | 'none' | 'routing';
    const rtDefaults = raw[0]?.rt_defaults ?? {
      default_team_id: null, default_vendor_id: null,
      workflow_definition_id: null, sla_policy_id: null,
    };

    return {
      request_type_id: requestTypeId,
      defaults: {
        default_team_id: rtDefaults.default_team_id,
        default_team_name: rtDefaults.default_team_id
          ? teams.get(rtDefaults.default_team_id) ?? null : null,
        default_vendor_id: rtDefaults.default_vendor_id,
        default_vendor_name: rtDefaults.default_vendor_id
          ? vendors.get(rtDefaults.default_vendor_id) ?? null : null,
        workflow_definition_id: rtDefaults.workflow_definition_id,
        workflow_definition_name: rtDefaults.workflow_definition_id
          ? workflows.get(rtDefaults.workflow_definition_id) ?? null : null,
        sla_policy_id: rtDefaults.sla_policy_id,
        sla_policy_name: rtDefaults.sla_policy_id
          ? slas.get(rtDefaults.sla_policy_id) ?? null : null,
      },
      rows: raw.map((r) => {
        const override = (r.override ?? null) as null | {
          id: string;
          scope_kind: string;
          space_id: string | null;
          space_group_id: string | null;
          handler_kind: 'team' | 'vendor' | 'none' | null;
          handler_team_id: string | null;
          handler_vendor_id: string | null;
          workflow_definition_id: string | null;
          case_sla_policy_id: string | null;
          case_owner_policy_entity_id: string | null;
          child_dispatch_policy_entity_id: string | null;
          executor_sla_policy_id: string | null;
          precedence: string;
        };
        const offering = (r.offering ?? null) as null | {
          id: string;
          scope_kind: 'tenant' | 'space' | 'space_group';
          space_id: string | null;
          space_group_id: string | null;
        };

        // Handler composition -------------------------------------------------
        let handler: {
          kind: 'team' | 'vendor' | 'none' | null;
          id: string | null;
          name: string | null;
          source: Source;
        };
        if (override?.handler_kind) {
          const kind = override.handler_kind;
          if (kind === 'team') {
            handler = {
              kind: 'team', id: override.handler_team_id,
              name: override.handler_team_id ? teams.get(override.handler_team_id) ?? null : null,
              source: 'override',
            };
          } else if (kind === 'vendor') {
            handler = {
              kind: 'vendor', id: override.handler_vendor_id,
              name: override.handler_vendor_id ? vendors.get(override.handler_vendor_id) ?? null : null,
              source: 'override',
            };
          } else {
            handler = { kind: 'none', id: null, name: null, source: 'override_unassigned' };
          }
        } else if (rtDefaults.default_team_id) {
          handler = {
            kind: 'team', id: rtDefaults.default_team_id,
            name: teams.get(rtDefaults.default_team_id) ?? null,
            source: 'default',
          };
        } else if (rtDefaults.default_vendor_id) {
          handler = {
            kind: 'vendor', id: rtDefaults.default_vendor_id,
            name: vendors.get(rtDefaults.default_vendor_id) ?? null,
            source: 'default',
          };
        } else {
          handler = { kind: null, id: null, name: null, source: 'routing' };
        }

        const composeId = (
          overrideId: string | null | undefined,
          defaultId: string | null | undefined,
          names: Map<string, string>,
        ): { id: string | null; name: string | null; source: Source } => {
          if (overrideId) return { id: overrideId, name: names.get(overrideId) ?? null, source: 'override' };
          if (defaultId) return { id: defaultId, name: names.get(defaultId) ?? null, source: 'default' };
          return { id: null, name: null, source: 'none' };
        };

        return {
          site: { id: r.site_id, name: r.site_name, type: r.site_type, parent_id: r.parent_id },
          offering: offering ? { scope_kind: offering.scope_kind, rule_id: offering.id } : null,
          offered: !!offering,
          override_id: override?.id ?? null,
          override_scope_kind: override?.scope_kind ?? null,
          override_precedence: override?.precedence ?? null,
          handler,
          workflow: composeId(
            override?.workflow_definition_id,
            rtDefaults.workflow_definition_id,
            workflows,
          ),
          case_sla: composeId(
            override?.case_sla_policy_id,
            rtDefaults.sla_policy_id,
            slas,
          ),
          // child_dispatch / executor_sla have no request-type default — they
          // fall through to team/vendor defaults at dispatch time. Show
          // override-or-none here; the UI labels 'none' as "team/vendor default".
          child_dispatch: composeId(override?.child_dispatch_policy_entity_id, null, configEntities),
          executor_sla: composeId(override?.executor_sla_policy_id, null, slas),
        };
      }),
    };
  }

  private async fetchNames(
    table: string,
    tenantId: string,
    ids: string[],
    nameColumn: string,
  ): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const { data, error } = await this.supabase.admin
      .from(table)
      .select('*')
      .eq('tenant_id', tenantId)
      .in('id', ids);
    if (error) throw error;
    const map = new Map<string, string>();
    for (const row of (data ?? []) as unknown as Array<Record<string, unknown>>) {
      const name = row[nameColumn];
      const id = row.id;
      if (typeof id === 'string' && typeof name === 'string') map.set(id, name);
    }
    return map;
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async assertRequestTypeExists(requestTypeId: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('request_types')
      .select('id')
      .eq('id', requestTypeId)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new BadRequestException('Request type not found in this tenant');
  }

  /**
   * Reject references to rows in other tenants before running the replace-set.
   * The service uses the RLS-bypassing admin client, so plain FKs can't catch
   * cross-tenant leakage. Each relevant tenant-scoped table gets a batched
   * existence check; missing rows throw BadRequest.
   *
   * `nullable=true` drops null entries from the ID set before the query; it's
   * used for optional references (e.g. form variant criteria_set_id can be
   * null for the default variant).
   */
  private async assertIdsInTenant(
    table: string,
    ids: Array<string | null | undefined>,
    label = table,
  ): Promise<void> {
    const nonEmpty = Array.from(new Set(ids.filter((x): x is string => !!x)));
    if (nonEmpty.length === 0) return;
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from(table)
      .select('id')
      .eq('tenant_id', tenant.id)
      .in('id', nonEmpty);
    if (error) throw error;
    const found = new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id));
    const missing = nonEmpty.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new BadRequestException(
        `${label}: ${missing.length} referenced id(s) not found in this tenant — ${missing.join(', ')}`,
      );
    }
  }

  private validateScope(scope_kind: ScopeKind, space_id: string | null, space_group_id: string | null) {
    const has_space = !!space_id;
    const has_group = !!space_group_id;
    if (scope_kind === 'tenant' && (has_space || has_group)) {
      throw new BadRequestException('tenant scope cannot carry space_id or space_group_id');
    }
    if (scope_kind === 'space' && (!has_space || has_group)) {
      throw new BadRequestException('space scope requires space_id and must not set space_group_id');
    }
    if (scope_kind === 'space_group' && (has_space || !has_group)) {
      throw new BadRequestException('space_group scope requires space_group_id and must not set space_id');
    }
  }

  private validateHandlerShape(o: ScopeOverrideInput) {
    const k = o.handler_kind ?? null;
    const hasTeam = !!o.handler_team_id;
    const hasVendor = !!o.handler_vendor_id;
    if (k === null && (hasTeam || hasVendor)) {
      throw new BadRequestException('handler_kind is required when handler_team_id or handler_vendor_id is set');
    }
    if (k === 'team' && (!hasTeam || hasVendor)) {
      throw new BadRequestException('handler_kind=team requires handler_team_id and forbids handler_vendor_id');
    }
    if (k === 'vendor' && (hasTeam || !hasVendor)) {
      throw new BadRequestException('handler_kind=vendor requires handler_vendor_id and forbids handler_team_id');
    }
    if (k === 'none' && (hasTeam || hasVendor)) {
      throw new BadRequestException('handler_kind=none forbids both handler_team_id and handler_vendor_id');
    }
  }

  /**
   * Reject two active overrides on the same (scope_kind, scope-target) tuple
   * whose effective windows overlap. The DB's partial-unique indexes catch
   * two rows that are both active=true AND both unbounded (null start + null
   * end), but scheduled-date pairs slip through. "Overlap" here means
   * [startA, endA) ∩ [startB, endB) is non-empty, with null=open-ended.
   */
  private validateNoTemporalOverlap(overrides: ScopeOverrideInput[]) {
    const active = overrides.filter((o) => o.active !== false);
    // Bucket by (scope_kind, scope-target).
    const bucket = new Map<string, ScopeOverrideInput[]>();
    for (const o of active) {
      const target = o.scope_kind === 'tenant'
        ? '__tenant__'
        : o.scope_kind === 'space'
          ? `space:${o.space_id ?? ''}`
          : `group:${o.space_group_id ?? ''}`;
      const key = `${o.scope_kind}|${target}`;
      const list = bucket.get(key) ?? [];
      list.push(o);
      bucket.set(key, list);
    }
    const toMs = (s: string | null | undefined, fallback: number) =>
      s ? new Date(s).getTime() : fallback;
    for (const [key, list] of bucket.entries()) {
      if (list.length < 2) continue;
      // Compare each pair once.
      for (let i = 0; i < list.length; i += 1) {
        const a = list[i];
        const aStart = toMs(a.starts_at, -Infinity);
        const aEnd = toMs(a.ends_at, Infinity);
        for (let j = i + 1; j < list.length; j += 1) {
          const b = list[j];
          const bStart = toMs(b.starts_at, -Infinity);
          const bEnd = toMs(b.ends_at, Infinity);
          // Overlap iff aStart < bEnd && bStart < aEnd.
          if (aStart < bEnd && bStart < aEnd) {
            throw new BadRequestException({
              code: 'scope_override_temporal_overlap',
              message:
                `Two active overrides on ${key} have overlapping windows. ` +
                `Adjust starts_at/ends_at so they don't intersect, or mark one active=false.`,
            });
          }
        }
      }
    }
  }

  private validateOverrideNonEmpty(o: ScopeOverrideInput) {
    const hasAny =
      !!o.handler_kind ||
      !!o.workflow_definition_id ||
      !!o.case_sla_policy_id ||
      !!o.case_owner_policy_entity_id ||
      !!o.child_dispatch_policy_entity_id ||
      !!o.executor_sla_policy_id;
    if (!hasAny) {
      throw new BadRequestException('Scope override must set at least one of: handler_kind, workflow_definition_id, case_sla_policy_id, case_owner_policy_entity_id, child_dispatch_policy_entity_id, executor_sla_policy_id');
    }
  }
}

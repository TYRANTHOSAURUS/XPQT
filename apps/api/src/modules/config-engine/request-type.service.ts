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
    form_schema_id?: string;
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
    // Partial-unique indexes in 00091 reject two concurrently-active rows
    // for the same (request_type, scope, scope-target). Scheduled windows
    // (starts_at/ends_at) are service-layer's job — two active rows with
    // non-overlapping windows on the same scope-target would both pass the
    // DB unique check but are semantically ambiguous once the calendar
    // advances. Reject overlap here so the admin has to resolve it.
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

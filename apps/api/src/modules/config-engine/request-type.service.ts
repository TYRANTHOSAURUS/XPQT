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

    const { error: delErr } = await this.supabase.admin
      .from('request_type_categories')
      .delete()
      .eq('tenant_id', tenant.id)
      .eq('request_type_id', requestTypeId);
    if (delErr) throw delErr;

    if (categoryIds.length > 0) {
      const rows = categoryIds.map((category_id) => ({
        tenant_id: tenant.id,
        request_type_id: requestTypeId,
        category_id,
      }));
      const { error } = await this.supabase.admin.from('request_type_categories').insert(rows);
      if (error) throw error;
    }
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

    const { error: delErr } = await this.supabase.admin
      .from('request_type_coverage_rules')
      .delete()
      .eq('tenant_id', tenant.id)
      .eq('request_type_id', requestTypeId);
    if (delErr) throw delErr;

    if (rules.length > 0) {
      const rows = rules.map((r) => ({
        tenant_id: tenant.id,
        request_type_id: requestTypeId,
        scope_kind: r.scope_kind,
        space_id: r.space_id ?? null,
        space_group_id: r.space_group_id ?? null,
        inherit_to_descendants: r.inherit_to_descendants ?? true,
        starts_at: r.starts_at ?? null,
        ends_at: r.ends_at ?? null,
        active: r.active ?? true,
      }));
      const { error } = await this.supabase.admin.from('request_type_coverage_rules').insert(rows);
      if (error) throw error;
    }
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

    const { error: delErr } = await this.supabase.admin
      .from('request_type_audience_rules')
      .delete()
      .eq('tenant_id', tenant.id)
      .eq('request_type_id', requestTypeId);
    if (delErr) throw delErr;

    if (rules.length > 0) {
      const rows = rules.map((r) => ({
        tenant_id: tenant.id,
        request_type_id: requestTypeId,
        criteria_set_id: r.criteria_set_id,
        mode: r.mode,
        starts_at: r.starts_at ?? null,
        ends_at: r.ends_at ?? null,
        active: r.active ?? true,
      }));
      const { error } = await this.supabase.admin.from('request_type_audience_rules').insert(rows);
      if (error) throw error;
    }
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

    const { error: delErr } = await this.supabase.admin
      .from('request_type_form_variants')
      .delete()
      .eq('tenant_id', tenant.id)
      .eq('request_type_id', requestTypeId);
    if (delErr) throw delErr;

    if (variants.length > 0) {
      const rows = variants.map((v) => ({
        tenant_id: tenant.id,
        request_type_id: requestTypeId,
        criteria_set_id: v.criteria_set_id,
        form_schema_id: v.form_schema_id,
        priority: v.priority ?? 0,
        starts_at: v.starts_at ?? null,
        ends_at: v.ends_at ?? null,
        active: v.active ?? true,
      }));
      const { error } = await this.supabase.admin.from('request_type_form_variants').insert(rows);
      if (error) throw error;
    }
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

    const { error: delErr } = await this.supabase.admin
      .from('request_type_on_behalf_rules')
      .delete()
      .eq('tenant_id', tenant.id)
      .eq('request_type_id', requestTypeId);
    if (delErr) throw delErr;

    if (rules.length > 0) {
      const rows = rules.map((r) => ({
        tenant_id: tenant.id,
        request_type_id: requestTypeId,
        role: r.role,
        criteria_set_id: r.criteria_set_id,
      }));
      const { error } = await this.supabase.admin.from('request_type_on_behalf_rules').insert(rows);
      if (error) throw error;
    }
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

    const { error: delErr } = await this.supabase.admin
      .from('request_type_scope_overrides')
      .delete()
      .eq('tenant_id', tenant.id)
      .eq('request_type_id', requestTypeId);
    if (delErr) throw delErr;

    if (overrides.length > 0) {
      const rows = overrides.map((o) => ({
        tenant_id: tenant.id,
        request_type_id: requestTypeId,
        scope_kind: o.scope_kind,
        space_id: o.space_id ?? null,
        space_group_id: o.space_group_id ?? null,
        inherit_to_descendants: o.inherit_to_descendants ?? true,
        starts_at: o.starts_at ?? null,
        ends_at: o.ends_at ?? null,
        active: o.active ?? true,
        handler_kind: o.handler_kind ?? null,
        handler_team_id: o.handler_team_id ?? null,
        handler_vendor_id: o.handler_vendor_id ?? null,
        workflow_definition_id: o.workflow_definition_id ?? null,
        case_sla_policy_id: o.case_sla_policy_id ?? null,
        case_owner_policy_entity_id: o.case_owner_policy_entity_id ?? null,
        child_dispatch_policy_entity_id: o.child_dispatch_policy_entity_id ?? null,
        executor_sla_policy_id: o.executor_sla_policy_id ?? null,
      }));
      const { error } = await this.supabase.admin.from('request_type_scope_overrides').insert(rows);
      if (error) throw error;
    }
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

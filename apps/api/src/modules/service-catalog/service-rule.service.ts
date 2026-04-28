import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { PredicateEngineService } from '../room-booking-rules/predicate-engine.service';
import type {
  ApprovalConfig,
  ServiceRuleEffect,
  ServiceRuleRow,
  ServiceRuleTargetKind,
} from './dto/types';

export interface CreateFromTemplateArgs {
  templateKey: string;
  params: Record<string, unknown>;
  targetKind: ServiceRuleTargetKind;
  targetId?: string | null;
  /** Override the template's default name. */
  name?: string;
  description?: string | null;
  priority?: number;
  active?: boolean;
}

/**
 * Walk a template predicate (or approval-config) JSON tree, replacing
 * any string literal of the form "$.paramKey" with the value at
 * params[paramKey]. Templates use this lightweight const-substitution
 * model; visual AST is Sprint 2.
 *
 * Examples:
 *   compile({ const: '$.threshold' }, { threshold: 500 })
 *     → { const: 500 }
 *   compile({ op: '>', left: {...}, right: { const: '$.threshold' } }, ...)
 *     → { op: '>', left: {...}, right: { const: 500 } }
 *
 * Arrays + nested objects are walked recursively. Non-template strings
 * pass through unchanged so non-placeholder predicate values still work.
 */
export function compileTemplatePredicate(
  template: unknown,
  params: Record<string, unknown>,
): Record<string, unknown> | unknown {
  if (template == null) return template;
  if (typeof template === 'string') {
    if (template.startsWith('$.')) {
      const key = template.slice(2);
      if (key in params) return params[key];
    }
    return template;
  }
  if (Array.isArray(template)) {
    return template.map((entry) => compileTemplatePredicate(entry, params));
  }
  if (typeof template === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(template as Record<string, unknown>)) {
      out[k] = compileTemplatePredicate(v, params);
    }
    return out;
  }
  return template;
}

export interface ServiceRuleUpsertDto {
  name: string;
  description?: string | null;
  target_kind: ServiceRuleTargetKind;
  target_id?: string | null;
  applies_when?: Record<string, unknown>;
  effect: ServiceRuleEffect;
  approval_config?: ApprovalConfig | null;
  denial_message?: string | null;
  priority?: number;
  active?: boolean;
  template_id?: string | null;
}

export interface ServiceRuleTemplate {
  id: string;
  template_key: string;
  name: string;
  description: string;
  category: 'approval' | 'availability' | 'capacity';
  effect_default: ServiceRuleEffect;
  applies_when_template: Record<string, unknown>;
  param_specs: Array<{
    key: string;
    label: string;
    type: 'number' | 'string' | 'boolean' | 'days_of_week' | 'catalog_item' | 'role';
    default?: unknown;
  }>;
  approval_config_template: Record<string, unknown> | null;
  active: boolean;
}

/**
 * Admin CRUD over `service_rules`. Mirrors the room-booking-rules service
 * but trimmed for v1 — no template-driven editor yet; admins compose
 * predicate JSON manually or start from `applies_when: {}` (always fires).
 *
 * Validation:
 *   - target_id is required for non-tenant target_kinds (DB constraint
 *     too, but surface as a 400 with a nice message).
 *   - applies_when goes through PredicateEngineService.validate so admins
 *     get a clear error instead of a runtime engine throw.
 */
@Injectable()
export class ServiceRuleService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly engine: PredicateEngineService,
  ) {}

  async list(filters?: { active?: boolean }): Promise<ServiceRuleRow[]> {
    const tenant = TenantContext.current();
    let query = this.supabase.admin
      .from('service_rules')
      .select('*')
      .eq('tenant_id', tenant.id)
      .order('priority', { ascending: false })
      .order('created_at', { ascending: false });
    if (filters?.active != null) query = query.eq('active', filters.active);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as ServiceRuleRow[];
  }

  async findOne(id: string): Promise<ServiceRuleRow> {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('service_rules')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      throw new NotFoundException({
        code: 'service_rule_not_found',
        message: `Service rule ${id} not found.`,
      });
    }
    return data as ServiceRuleRow;
  }

  async create(dto: ServiceRuleUpsertDto): Promise<ServiceRuleRow> {
    this.assertValid(dto);
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('service_rules')
      .insert({
        tenant_id: tenant.id,
        name: dto.name.trim(),
        description: dto.description ?? null,
        target_kind: dto.target_kind,
        target_id: dto.target_kind === 'tenant' ? null : dto.target_id,
        applies_when: dto.applies_when ?? {},
        effect: dto.effect,
        approval_config: dto.approval_config ?? null,
        denial_message: dto.denial_message ?? null,
        priority: dto.priority ?? 100,
        active: dto.active ?? true,
        template_id: dto.template_id ?? null,
      })
      .select('*')
      .single();
    if (error) throw error;
    return data as ServiceRuleRow;
  }

  async update(id: string, dto: Partial<ServiceRuleUpsertDto>): Promise<ServiceRuleRow> {
    if (dto.name != null && !dto.name.trim()) {
      throw new BadRequestException({ code: 'name_required', message: 'name cannot be empty' });
    }
    if (dto.applies_when != null) {
      try {
        this.engine.validate(dto.applies_when);
      } catch (err) {
        throw new BadRequestException({
          code: 'invalid_predicate',
          message: (err as Error).message,
        });
      }
    }
    if (dto.target_kind != null && dto.target_kind !== 'tenant' && dto.target_id == null) {
      const existing = await this.findOne(id);
      if (!existing.target_id) {
        throw new BadRequestException({
          code: 'target_id_required',
          message: 'target_id is required when target_kind is not tenant',
        });
      }
    }

    const tenant = TenantContext.current();
    const patch: Record<string, unknown> = {};
    if (dto.name != null) patch.name = dto.name.trim();
    if ('description' in dto) patch.description = dto.description ?? null;
    if (dto.target_kind != null) patch.target_kind = dto.target_kind;
    if ('target_id' in dto) {
      patch.target_id = dto.target_kind === 'tenant' ? null : (dto.target_id ?? null);
    }
    if (dto.applies_when != null) patch.applies_when = dto.applies_when;
    if (dto.effect != null) patch.effect = dto.effect;
    if ('approval_config' in dto) patch.approval_config = dto.approval_config ?? null;
    if ('denial_message' in dto) patch.denial_message = dto.denial_message ?? null;
    if (dto.priority != null) patch.priority = dto.priority;
    if (dto.active != null) patch.active = dto.active;
    if ('template_id' in dto) patch.template_id = dto.template_id ?? null;

    const { data, error } = await this.supabase.admin
      .from('service_rules')
      .update(patch)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select('*')
      .single();
    if (error) throw error;
    if (!data) {
      throw new NotFoundException({
        code: 'service_rule_not_found',
        message: `Service rule ${id} not found.`,
      });
    }
    return data as ServiceRuleRow;
  }

  async remove(id: string): Promise<{ id: string }> {
    const tenant = TenantContext.current();
    const { error } = await this.supabase.admin
      .from('service_rules')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenant.id);
    if (error) throw error;
    return { id };
  }

  /**
   * Lists the seven v1 templates from migration 00149. Tenant-agnostic, so
   * the read permission policy from migration 00150 lets any authenticated
   * user query — admins just see them as starting points.
   */
  async listTemplates(): Promise<ServiceRuleTemplate[]> {
    const { data, error } = await this.supabase.admin
      .from('service_rule_templates')
      .select('*')
      .eq('active', true)
      .order('category', { ascending: true })
      .order('name', { ascending: true });
    if (error) throw error;
    return (data ?? []) as ServiceRuleTemplate[];
  }

  /**
   * Sprint 1B — template-driven create. Substitutes admin-provided
   * params into the template's `applies_when_template` placeholders,
   * carries the template's `effect_default` + `approval_config_template`
   * unless the caller overrides, and inserts a fresh service_rules row.
   *
   * Templates store predicate JSON with `"$.<paramKey>"` shaped const
   * references that we resolve by walking the JSON tree. This is
   * deliberately a small, predictable substitution — the rule builder
   * spec §6 calls it out as the v1 simple shape; visual AST + computed
   * vocabulary are Sprint 2 territory.
   */
  async createFromTemplate(args: CreateFromTemplateArgs): Promise<ServiceRuleRow> {
    const { templateKey, params, targetKind, targetId, name, description, priority, active } = args;
    if (!templateKey) {
      throw new BadRequestException({ code: 'template_required', message: 'templateKey required' });
    }

    const tenant = TenantContext.current();
    const tplLookup = await this.supabase.admin
      .from('service_rule_templates')
      .select('*')
      .eq('template_key', templateKey)
      .eq('active', true)
      .maybeSingle();
    if (tplLookup.error) throw tplLookup.error;
    const tpl = tplLookup.data as ServiceRuleTemplate | null;
    if (!tpl) {
      throw new NotFoundException({
        code: 'template_not_found',
        message: `Template ${templateKey} not found.`,
      });
    }

    // Validate every required param is present.
    const supplied = params ?? {};
    for (const spec of tpl.param_specs ?? []) {
      if ((spec as { required?: boolean }).required === false) continue;
      if (supplied[spec.key] === undefined || supplied[spec.key] === null) {
        if (spec.default !== undefined) {
          supplied[spec.key] = spec.default;
        } else {
          throw new BadRequestException({
            code: 'param_required',
            message: `Template ${templateKey} requires param '${spec.key}' (${spec.label}).`,
          });
        }
      }
    }

    // Compile the predicate by substituting "$.<paramKey>" const refs.
    const compiled = compileTemplatePredicate(
      tpl.applies_when_template ?? {},
      supplied,
    );

    // Validate the compiled predicate runs through the engine.
    try {
      this.engine.validate(compiled);
    } catch (err) {
      throw new BadRequestException({
        code: 'invalid_compiled_predicate',
        message: `Template compiled to an invalid predicate: ${(err as Error).message}`,
      });
    }

    const compiledApprovalConfig = tpl.approval_config_template
      ? compileTemplatePredicate(tpl.approval_config_template, supplied) as ApprovalConfig
      : null;

    const { data, error } = await this.supabase.admin
      .from('service_rules')
      .insert({
        tenant_id: tenant.id,
        name: (name ?? tpl.name).trim(),
        description: description ?? tpl.description ?? null,
        target_kind: targetKind,
        target_id: targetKind === 'tenant' ? null : targetId ?? null,
        applies_when: compiled,
        effect: tpl.effect_default,
        approval_config: tpl.effect_default === 'require_approval' ? compiledApprovalConfig : null,
        denial_message: null,
        priority: priority ?? 100,
        active: active ?? true,
        template_id: tpl.id,
      })
      .select('*')
      .single();
    if (error) throw error;
    return data as ServiceRuleRow;
  }

  // ── Validation ─────────────────────────────────────────────────────────

  private assertValid(dto: ServiceRuleUpsertDto): void {
    if (!dto.name?.trim()) {
      throw new BadRequestException({ code: 'name_required', message: 'name is required' });
    }
    if (!dto.target_kind) {
      throw new BadRequestException({
        code: 'target_kind_required',
        message: 'target_kind is required',
      });
    }
    if (!dto.effect) {
      throw new BadRequestException({ code: 'effect_required', message: 'effect is required' });
    }
    if (dto.target_kind !== 'tenant' && !dto.target_id) {
      throw new BadRequestException({
        code: 'target_id_required',
        message: 'target_id is required when target_kind is not tenant',
      });
    }
    if (dto.applies_when != null) {
      try {
        this.engine.validate(dto.applies_when);
      } catch (err) {
        throw new BadRequestException({
          code: 'invalid_predicate',
          message: (err as Error).message,
        });
      }
    }
  }
}

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
 * Compile a service-rule template predicate (or approval-config) into
 * the AST shape `PredicateEngineService` actually evaluates.
 *
 * Templates are seeded in a HUMAN-READABLE shape (migration 00149):
 *   - ASCII operators: `>`, `<`, `=`, `!=`, `>=`, `<=`, `in`, `contains`.
 *   - Wrappers: `{ path: '$.foo.bar' }` for context refs, `{ const: <v> }`
 *     for literal values (often `'$.<param_key>'` placeholders).
 *   - Composition: `and`/`or`/`not` with `args: [...]`.
 *   - Synthetic op `is_not_null` (no engine fn equivalent today).
 *
 * The engine accepts:
 *   - Symbolic ops: `eq, ne, gt, gte, lt, lte, in, contains` on
 *     `{ op, left, right }` shape.
 *   - Bare `$.<path>` strings as refs (no `{path}` wrapper).
 *   - Literals as plain JS values (no `{const}` wrapper).
 *   - `and/or/not` with `args: [...]`.
 *
 * Compile in two passes:
 *   1. Substitute params: walk the tree, replace any literal string
 *      `'$.<paramKey>'` with `params[paramKey]`.
 *   2. Normalise: walk again, translate ASCII ops to symbolic, unwrap
 *      `{path}` / `{const}`, translate `is_not_null(x)` to
 *      `{op:'ne', left:x, right:null}`.
 *
 * Codex Sprint 1B round-1 fix: round-0 only did pass 1, so the
 * compiled output still had `{op:'>', left:{path:'…'}, right:{const:N}}`
 * which fails `engine.validate()` ("unknown op: >"). REJECT.
 */
export function compileTemplatePredicate(
  template: unknown,
  params: Record<string, unknown>,
): unknown {
  return normalizeForEngine(substituteParams(template, params));
}

/**
 * Pass 1 — purely a value substitution. Replaces string literals of the
 * form `"$.paramKey"` with `params[paramKey]`. Walks objects + arrays.
 * Substituted values are NOT recursively scanned (so a param value that
 * happens to start with "$." is treated as a literal string, never a
 * second-level placeholder).
 */
function substituteParams(template: unknown, params: Record<string, unknown>): unknown {
  if (template == null) return template;
  if (typeof template === 'string') {
    if (template.startsWith('$.')) {
      const key = template.slice(2);
      if (key in params) return params[key];
    }
    return template;
  }
  if (Array.isArray(template)) {
    return template.map((entry) => substituteParams(entry, params));
  }
  if (typeof template === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(template as Record<string, unknown>)) {
      out[k] = substituteParams(v, params);
    }
    return out;
  }
  return template;
}

/**
 * Map ASCII op symbols to the engine's symbolic op names. `is_not_null`
 * is rewritten to a `ne` against `null` since the engine has no
 * is_not_null fn. ASCII ops not in this map fall through unchanged
 * (and would later be caught by `engine.validate()`).
 */
const ASCII_OP_TO_ENGINE: Record<string, string> = {
  '>':  'gt',
  '<':  'lt',
  '>=': 'gte',
  '<=': 'lte',
  '=':  'eq',
  '==': 'eq',
  '!=': 'ne',
  /* Symbolic ops (engine-native) pass through. */
  in:        'in',
  contains:  'contains',
  eq:        'eq',
  ne:        'ne',
  gt:        'gt',
  gte:       'gte',
  lt:        'lt',
  lte:       'lte',
};

/**
 * Pass 2 — walk the tree and translate every node into the engine's
 * accepted shape:
 *   - {path: 'X'}  → 'X'                           (bare ref)
 *   - {const: V}   → V                             (literal)
 *   - {op: '>',  left, right}    → {op: 'gt',  left, right}
 *   - {op: 'is_not_null', args}  → {op: 'ne', left, right: null}
 *   - {op: 'and'|'or'|'not', args} stays composition.
 */
function normalizeForEngine(node: unknown): unknown {
  if (node == null) return node;
  if (typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(normalizeForEngine);

  const obj = node as Record<string, unknown>;

  /* Wrapper unwrap. */
  if ('path' in obj && typeof obj.path === 'string') {
    return obj.path;             // 'path' wrapper → bare $.foo string
  }
  if ('const' in obj && Object.keys(obj).length === 1) {
    return normalizeForEngine(obj.const);
  }

  /* is_not_null synthetic. */
  if (obj.op === 'is_not_null') {
    const args = (obj.args as unknown[]) ?? [];
    const left = normalizeForEngine(args[0]);
    return { op: 'ne', left, right: null };
  }

  /* Composition (and/or/not) — keep shape, recurse args. */
  if (obj.op === 'and' || obj.op === 'or' || obj.op === 'not') {
    return { op: obj.op, args: ((obj.args as unknown[]) ?? []).map(normalizeForEngine) };
  }

  /* Comparison op — translate ASCII → symbolic, recurse left/right. */
  if (typeof obj.op === 'string') {
    const mapped = ASCII_OP_TO_ENGINE[obj.op] ?? obj.op;
    const out: Record<string, unknown> = { op: mapped };
    if ('left' in obj)  out.left  = normalizeForEngine(obj.left);
    if ('right' in obj) out.right = normalizeForEngine(obj.right);
    if ('args' in obj)  out.args  = ((obj.args as unknown[]) ?? []).map(normalizeForEngine);
    return out;
  }

  /* fn nodes pass through with args recursed. */
  if (typeof obj.fn === 'string') {
    return {
      ...obj,
      args: ((obj.args as unknown[]) ?? []).map(normalizeForEngine),
    };
  }

  /* Plain object literal (e.g. inside approval_config_template). Walk
     children so nested wrapped values still get unwrapped. */
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = normalizeForEngine(v);
  }
  return out;
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
  /**
   * When true, an order line that matches this rule auto-creates an
   * internal setup work order. Routing (team, lead time, SLA) is
   * resolved via location_service_routing (00194). Independent of
   * `effect`: a line can be (allow AND requires_internal_setup).
   */
  requires_internal_setup?: boolean;
  /**
   * Optional override for the matrix's default lead time. Null = use
   * matrix default. Useful for high-touch rules ("VIP catering = 90min
   * before service window").
   */
  internal_setup_lead_time_minutes?: number | null;
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
        requires_internal_setup: dto.requires_internal_setup ?? false,
        internal_setup_lead_time_minutes: dto.internal_setup_lead_time_minutes ?? null,
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
    if (dto.requires_internal_setup != null) {
      patch.requires_internal_setup = dto.requires_internal_setup;
    }
    if ('internal_setup_lead_time_minutes' in dto) {
      const v = dto.internal_setup_lead_time_minutes;
      if (v != null && (!Number.isInteger(v) || v < 0 || v > 1440)) {
        throw new BadRequestException({
          code: 'invalid_lead_time',
          message: 'internal_setup_lead_time_minutes must be a non-negative integer up to 1440.',
        });
      }
      patch.internal_setup_lead_time_minutes = v ?? null;
    }

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

    /* Codex Sprint 1B round-1 fix: enforce the same surface contract as
       create() so the /from-template endpoint can't bypass validation
       (empty name, missing target_id when not tenant, etc). */
    if (!targetKind) {
      throw new BadRequestException({
        code: 'target_kind_required',
        message: 'target_kind is required',
      });
    }
    if (targetKind !== 'tenant' && (!targetId || !targetId.trim())) {
      throw new BadRequestException({
        code: 'target_id_required',
        message: 'target_id is required when target_kind is not tenant',
      });
    }
    if (name !== undefined && !name.trim()) {
      throw new BadRequestException({
        code: 'name_required',
        message: 'name cannot be empty',
      });
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

    /* Required-param check. The default fallback covers templates that
       ship a sensible default (e.g. cost_threshold_approval default
       500) so admins can mint a rule with one click. Whitespace-only
       strings + empty arrays are treated as missing — same gate the
       dialog applies on the frontend. */
    const supplied = params ?? {};
    for (const spec of tpl.param_specs ?? []) {
      if ((spec as { required?: boolean }).required === false) continue;
      const v = supplied[spec.key];
      const isEmpty =
        v === undefined
        || v === null
        || (typeof v === 'string' && v.trim() === '')
        || (Array.isArray(v) && v.length === 0);
      if (isEmpty) {
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

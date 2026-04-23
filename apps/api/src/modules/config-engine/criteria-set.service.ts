import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

/**
 * criteria_sets authoring. The expression grammar + evaluation live in
 * `public.criteria_matches(p_set_id, p_person_id, p_tenant_id)` and
 * `_criteria_eval_node` (migration 00060). Supported shape (live-doc §3.4a,
 * bounded depth = 3):
 *
 *   composites: { all_of: [...] } | { any_of: [...] } | { not: <node> }
 *   leaves:     { attr: string, op: 'eq'|'neq'|'in'|'not_in', value: any }
 *
 * Supported `attr` values: type, department, division, cost_center,
 * manager_person_id. The service rejects malformed expressions up front so
 * admins don't have to wait for the first evaluation to discover a typo.
 */

type Leaf = {
  attr: string;
  op: 'eq' | 'neq' | 'in' | 'not_in';
  value: unknown;
};
type Node = Leaf | { all_of: Node[] } | { any_of: Node[] } | { not: Node };

const ALLOWED_ATTRS = new Set([
  'type', 'department', 'division', 'cost_center', 'manager_person_id',
]);
const ALLOWED_OPS = new Set(['eq', 'neq', 'in', 'not_in']);
const MAX_DEPTH = 3;

function validateExpression(expr: unknown, depth = 0): asserts expr is Node {
  if (depth > MAX_DEPTH) {
    throw new BadRequestException(`expression nesting exceeds max depth ${MAX_DEPTH}`);
  }
  if (expr === null || typeof expr !== 'object') {
    throw new BadRequestException('expression must be an object');
  }
  const keys = Object.keys(expr as Record<string, unknown>);
  if (keys.length !== 1) {
    throw new BadRequestException(`expression node must have exactly one key, got ${keys.length}`);
  }
  const key = keys[0];
  const val = (expr as Record<string, unknown>)[key];

  if (key === 'all_of' || key === 'any_of') {
    if (!Array.isArray(val) || val.length === 0) {
      throw new BadRequestException(`${key} must be a non-empty array`);
    }
    for (const child of val) validateExpression(child, depth + 1);
    return;
  }
  if (key === 'not') {
    validateExpression(val, depth + 1);
    return;
  }
  // Leaf: treat `expr` itself as { attr, op, value }. Guard via shape check.
  const leaf = expr as Record<string, unknown>;
  if (!('attr' in leaf) || !('op' in leaf) || !('value' in leaf)) {
    throw new BadRequestException(
      'leaf node must have `attr`, `op`, `value` (or use all_of / any_of / not)',
    );
  }
  if (typeof leaf.attr !== 'string' || !ALLOWED_ATTRS.has(leaf.attr)) {
    throw new BadRequestException(
      `attr '${String(leaf.attr)}' not supported. Allowed: ${[...ALLOWED_ATTRS].join(', ')}`,
    );
  }
  if (typeof leaf.op !== 'string' || !ALLOWED_OPS.has(leaf.op)) {
    throw new BadRequestException(
      `op '${String(leaf.op)}' not supported. Allowed: ${[...ALLOWED_OPS].join(', ')}`,
    );
  }
  if ((leaf.op === 'in' || leaf.op === 'not_in') && !Array.isArray(leaf.value)) {
    throw new BadRequestException(`op '${leaf.op}' requires value to be an array`);
  }
}

export interface CriteriaSetInput {
  name: string;
  description?: string | null;
  expression: unknown;
  active?: boolean;
}

@Injectable()
export class CriteriaSetService {
  constructor(private readonly supabase: SupabaseService) {}

  async list() {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('criteria_sets')
      .select('*')
      .eq('tenant_id', tenant.id)
      .order('name');
    if (error) throw error;
    return data;
  }

  async getById(id: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('criteria_sets')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new NotFoundException('Criteria set not found');
    return data;
  }

  async create(input: CriteriaSetInput) {
    const tenant = TenantContext.current();
    if (!input.name?.trim()) {
      throw new BadRequestException('name is required');
    }
    validateExpression(input.expression);
    const { data, error } = await this.supabase.admin
      .from('criteria_sets')
      .insert({
        tenant_id: tenant.id,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        expression: input.expression,
        active: input.active ?? true,
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async update(id: string, patch: Partial<CriteriaSetInput>) {
    const tenant = TenantContext.current();
    const body: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.name !== undefined) {
      if (!patch.name.trim()) throw new BadRequestException('name cannot be empty');
      body.name = patch.name.trim();
    }
    if (patch.description !== undefined) body.description = patch.description?.trim() || null;
    if (patch.expression !== undefined) {
      validateExpression(patch.expression);
      body.expression = patch.expression;
    }
    if (patch.active !== undefined) body.active = patch.active;
    const { data, error } = await this.supabase.admin
      .from('criteria_sets')
      .update(body)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();
    if (error) throw error;
    if (!data) throw new NotFoundException('Criteria set not found');
    return data;
  }

  async remove(id: string) {
    // Soft-delete: flip active=false. Hard-delete would break FKs on
    // request_type_audience_rules / form_variants / on_behalf_rules that
    // still reference this set. Admin can use update({active:false}) too;
    // expose this as the destructive shorthand.
    return this.update(id, { active: false });
  }

  /**
   * Preview how many persons in the tenant match this expression right now.
   * Useful when authoring audience/on-behalf rules so admins can sanity-check
   * their criteria without saving it first. Returns count + up to 5 sample
   * persons (id + first/last name) for display.
   */
  async preview(expression: unknown): Promise<{ count: number; sample: Array<{ id: string; first_name: string; last_name: string }> }> {
    const tenant = TenantContext.current();
    validateExpression(expression);

    // We can't pass the expression to criteria_matches without first inserting
    // a row (the function takes p_set_id). For MVP, insert a throwaway row
    // in a transaction and rollback — but Supabase JS doesn't expose txns.
    // Instead, evaluate the expression in TS against person attributes.
    // `criteria_matches` does the same logic in plpgsql; we duplicate the
    // evaluator here to stay consistent.
    const { data: persons, error } = await this.supabase.admin
      .from('persons')
      .select('id, first_name, last_name, type, department, division, cost_center, manager_person_id, active')
      .eq('tenant_id', tenant.id)
      .eq('active', true);
    if (error) throw error;
    const rows = (persons ?? []) as Array<Record<string, unknown>>;

    const matches = rows.filter((p) => evalNode(expression as Node, p));
    return {
      count: matches.length,
      sample: matches.slice(0, 5).map((m) => ({
        id: m.id as string,
        first_name: (m.first_name as string) ?? '',
        last_name: (m.last_name as string) ?? '',
      })),
    };
  }
}

/**
 * Mirrors public._criteria_eval_node (migration 00060) for TS-side preview.
 * Absent-attribute semantics (live-doc §3.4a):
 *   eq/in → false when attr is null on the actor
 *   neq/not_in → true when attr is null
 */
function evalNode(node: Node, person: Record<string, unknown>): boolean {
  if ('all_of' in node) return node.all_of.every((c) => evalNode(c, person));
  if ('any_of' in node) return node.any_of.some((c) => evalNode(c, person));
  if ('not' in node) return !evalNode(node.not, person);
  const actual = person[node.attr];
  const missing = actual === null || actual === undefined;
  switch (node.op) {
    case 'eq': return missing ? false : actual === node.value;
    case 'neq': return missing ? true : actual !== node.value;
    case 'in':
      return missing ? false : Array.isArray(node.value) && (node.value as unknown[]).includes(actual);
    case 'not_in':
      return missing ? true : Array.isArray(node.value) && !(node.value as unknown[]).includes(actual);
  }
}

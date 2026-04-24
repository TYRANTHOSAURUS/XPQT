import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

/**
 * criteria_sets authoring. The canonical evaluator is plpgsql —
 * `public.criteria_matches(p_set_id, p_person_id, p_tenant_id)` +
 * `public._criteria_eval_node` (migration 00099, superseding 00060 once the
 * persons.department / persons.division columns were dropped in 00079).
 *
 * Supported grammar (bounded depth = 3):
 *
 *   composites: { all_of: [...] } | { any_of: [...] } | { not: <node> }
 *   scalar leaf: { attr, op: 'eq'|'neq', value }
 *   list leaf:   { attr, op: 'in'|'not_in', values: [...] }
 *
 * Supported `attr` values: type, cost_center, manager_person_id,
 * org_node_id, org_node_code, org_node_name. The TS preview evaluator
 * below mirrors the plpgsql, so the admin UI can sanity-check an
 * unsaved expression against the live tenant without inserting a row.
 */

type ScalarLeaf = { attr: string; op: 'eq' | 'neq'; value: unknown };
type ListLeaf = { attr: string; op: 'in' | 'not_in'; values: unknown[] };
type Leaf = ScalarLeaf | ListLeaf;
type Node = Leaf | { all_of: Node[] } | { any_of: Node[] } | { not: Node };

const ALLOWED_ATTRS = new Set([
  'type',
  'cost_center',
  'manager_person_id',
  'org_node_id',
  'org_node_code',
  'org_node_name',
]);
const SCALAR_OPS = new Set(['eq', 'neq']);
const LIST_OPS = new Set(['in', 'not_in']);
const MAX_DEPTH = 3;

function validateExpression(expr: unknown, depth = 0): asserts expr is Node {
  if (depth > MAX_DEPTH) {
    throw new BadRequestException(`expression nesting exceeds max depth ${MAX_DEPTH}`);
  }
  if (expr === null || typeof expr !== 'object' || Array.isArray(expr)) {
    throw new BadRequestException('expression must be an object');
  }
  const obj = expr as Record<string, unknown>;

  if ('all_of' in obj) {
    const val = obj.all_of;
    if (!Array.isArray(val) || val.length === 0) {
      throw new BadRequestException('all_of must be a non-empty array');
    }
    for (const child of val) validateExpression(child, depth + 1);
    return;
  }
  if ('any_of' in obj) {
    const val = obj.any_of;
    if (!Array.isArray(val) || val.length === 0) {
      throw new BadRequestException('any_of must be a non-empty array');
    }
    for (const child of val) validateExpression(child, depth + 1);
    return;
  }
  if ('not' in obj) {
    validateExpression(obj.not, depth + 1);
    return;
  }

  // Leaf node.
  if (!('attr' in obj) || !('op' in obj)) {
    throw new BadRequestException(
      'leaf node must have `attr` and `op` (or use all_of / any_of / not)',
    );
  }
  if (typeof obj.attr !== 'string' || !ALLOWED_ATTRS.has(obj.attr)) {
    throw new BadRequestException(
      `attr '${String(obj.attr)}' not supported. Allowed: ${[...ALLOWED_ATTRS].join(', ')}`,
    );
  }
  const op = obj.op;
  if (typeof op !== 'string' || (!SCALAR_OPS.has(op) && !LIST_OPS.has(op))) {
    throw new BadRequestException(
      `op '${String(op)}' not supported. Allowed: eq, neq, in, not_in`,
    );
  }
  if (SCALAR_OPS.has(op)) {
    if (!('value' in obj)) {
      throw new BadRequestException(`op '${op}' requires a \`value\` field`);
    }
  } else {
    if (!('values' in obj) || !Array.isArray(obj.values) || obj.values.length === 0) {
      throw new BadRequestException(
        `op '${op}' requires a non-empty \`values\` array`,
      );
    }
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
    // still reference this set.
    return this.update(id, { active: false });
  }

  /**
   * Preview how many persons in the tenant match this expression right now.
   * Mirrors public._criteria_eval_node (migration 00099). Returns count + up
   * to `limit` sample persons (default 10, max 500) so admins can
   * sanity-check criteria without saving.
   */
  async preview(
    expression: unknown,
    limit = 10,
  ): Promise<{
    count: number;
    sample: MatchRow[];
  }> {
    validateExpression(expression);
    const matches = await this.evaluateTenantMatches(expression as Node);
    const capped = Math.max(1, Math.min(limit, 500));
    return {
      count: matches.length,
      sample: matches.slice(0, capped),
    };
  }

  /**
   * Full match list for a saved criteria set — used by the detail page's
   * "show all matches" drill-down. Returns up to `limit` rows (default 500)
   * so we don't ship tens of thousands of persons over the wire. Count is
   * the true total, not capped.
   */
  async getMatches(
    id: string,
    limit = 500,
  ): Promise<{
    criteriaSet: { id: string; name: string; description: string | null };
    count: number;
    matches: MatchRow[];
  }> {
    const set = await this.getById(id);
    validateExpression(set.expression);
    const matches = await this.evaluateTenantMatches(set.expression);
    const capped = Math.max(1, Math.min(limit, 2000));
    return {
      criteriaSet: { id: set.id, name: set.name, description: set.description },
      count: matches.length,
      matches: matches.slice(0, capped),
    };
  }

  /**
   * Shared matcher used by `preview` (unsaved expression) and `getMatches`
   * (saved set). Loads every active person in the tenant with their primary
   * org membership, then filters in TS using the mirror of
   * `public._criteria_eval_node`.
   */
  private async evaluateTenantMatches(expression: Node): Promise<MatchRow[]> {
    const tenant = TenantContext.current();

    const [{ data: persons, error: pErr }, { data: memberships, error: mErr }] = await Promise.all([
      this.supabase.admin
        .from('persons')
        .select('id, first_name, last_name, email, type, cost_center, manager_person_id')
        .eq('tenant_id', tenant.id)
        .eq('active', true)
        .order('first_name'),
      this.supabase.admin
        .from('person_org_memberships')
        .select('person_id, org_nodes(id, code, name)')
        .eq('tenant_id', tenant.id)
        .eq('is_primary', true),
    ]);
    if (pErr) throw pErr;
    if (mErr) throw mErr;

    // Supabase types `org_nodes` as an array when joined, even though the FK
    // is single-valued — unwrap it manually.
    type OrgNode = { id: string; code: string | null; name: string | null };
    const orgByPersonId = new Map<string, OrgNode>();
    for (const row of (memberships ?? []) as Array<{
      person_id: string;
      org_nodes: OrgNode | OrgNode[] | null;
    }>) {
      const org = Array.isArray(row.org_nodes) ? row.org_nodes[0] : row.org_nodes;
      if (org) orgByPersonId.set(row.person_id, org);
    }

    type Person = {
      id: string;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
      type: string | null;
      cost_center: string | null;
      manager_person_id: string | null;
    };

    return ((persons ?? []) as Person[])
      .map((p) => {
        const org = orgByPersonId.get(p.id) ?? null;
        const evalPerson = {
          ...p,
          org_node_id: org?.id ?? null,
          org_node_code: org?.code ?? null,
          org_node_name: org?.name ?? null,
        };
        return { person: p, org, evalPerson };
      })
      .filter(({ evalPerson }) => evalNode(expression, evalPerson as unknown as Record<string, unknown>))
      .map(({ person, org }) => ({
        id: person.id,
        first_name: person.first_name ?? '',
        last_name: person.last_name ?? '',
        email: person.email ?? null,
        type: person.type ?? null,
        primary_org: org
          ? { id: org.id, code: org.code ?? null, name: org.name ?? null }
          : null,
      }));
  }
}

export interface MatchRow {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  type: string | null;
  primary_org: { id: string; code: string | null; name: string | null } | null;
}

/**
 * Mirrors public._criteria_eval_node (migration 00099). Absent-attribute
 * semantics: eq/in → false when attr is null on the actor; neq/not_in → true
 * when attr is null. All comparisons are done as strings, matching the
 * plpgsql `::text` casts.
 */
function evalNode(node: Node, person: Record<string, unknown>): boolean {
  if ('all_of' in node) return node.all_of.every((c) => evalNode(c, person));
  if ('any_of' in node) return node.any_of.some((c) => evalNode(c, person));
  if ('not' in node) return !evalNode(node.not, person);

  const raw = person[node.attr];
  if (raw === null || raw === undefined) {
    return node.op === 'neq' || node.op === 'not_in';
  }
  const actual = String(raw);
  switch (node.op) {
    case 'eq':
      return actual === String((node as ScalarLeaf).value ?? '');
    case 'neq':
      return actual !== String((node as ScalarLeaf).value ?? '');
    case 'in':
      return (node as ListLeaf).values.map((v) => String(v ?? '')).includes(actual);
    case 'not_in':
      return !(node as ListLeaf).values.map((v) => String(v ?? '')).includes(actual);
  }
}

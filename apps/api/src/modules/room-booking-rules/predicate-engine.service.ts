import { BadRequestException, Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import type { Predicate } from './dto';

/**
 * Minimal predicate engine for room-booking rules' `applies_when` JSONB.
 *
 * Why not reuse `criteria_sets`? The criteria-set evaluator is bound to a
 * Person actor (see criteria-set.service.ts) — its leaves only address person
 * attributes. Room-booking rules need to reason over a richer context: the
 * requester (with role + org_node), the space (with parents + type), and the
 * booking (start_at / end_at / attendee_count). Rather than retro-fit the
 * person-only engine, we ship a small dedicated engine here. It still calls
 * the SQL helpers from migration 00119 (`in_business_hours`,
 * `org_node_descendants`, `space_descendants`) for the parts that need DB
 * data we already have.
 *
 * Grammar:
 *   { and: [Predicate, …] }
 *   { or: [Predicate, …] }
 *   { not: Predicate }
 *   { op: 'eq'|'ne'|'in'|'gt'|'gte'|'lt'|'lte'|'contains', left: <ref|literal>, right: <ref|literal> }
 *   { fn: '<helper>', args: [<ref|literal>, …] }
 *
 * References (`<ref>`) are JSONPath-ish strings starting with `$.`. The
 * resolver writes them against the EvaluationContext below.
 *
 * Examples:
 *   { op: 'in', left: '$.requester.role_id', right: ['<uuid>'] }
 *   { fn: 'in_business_hours', args: ['$.start_at', '$.calendar_id'] }
 *   { fn: 'duration_minutes_lt', args: ['$.start_at', '$.end_at', 60] }
 */

/**
 * Minimum context shape the predicate engine itself needs. Any module-specific
 * context (room rules, service rules, …) must satisfy this base — the engine
 * only reads `permissions` + `resolved` directly; everything else is reached
 * via the `$.path` resolver. The `[key: string]: unknown` index lets callers
 * attach arbitrary nested data (e.g. `$.line.menu.fulfillment_vendor_id`) and
 * still type-check.
 */
export interface BaseEvaluationContext {
  permissions: Record<string, boolean>;
  resolved: {
    org_descendants: Record<string, Set<string>>;
    in_business_hours: Record<string, boolean>; // key = `${at}|${calendar_id}`
  };
  [key: string]: unknown;
}

export interface EvaluationContext extends BaseEvaluationContext {
  requester: {
    id: string; // person id
    role_ids: string[];
    org_node_id: string | null;
    type: string | null;
    cost_center: string | null;
    user_id: string | null; // matched user id, if any
  };
  space: {
    id: string;
    type: string | null;
    parent_id: string | null;
    capacity: number | null;
    min_attendees: number | null;
    default_calendar_id: string | null;
    ancestor_ids: string[]; // including self
  };
  booking: {
    start_at: string;
    end_at: string;
    duration_minutes: number;
    lead_time_minutes: number; // start_at - now()
    attendee_count: number | null;
  };
}

@Injectable()
export class PredicateEngineService {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Top-level evaluator. Throws BadRequest on a structural error in the
   * predicate (so admins get a real error in the editor); returns false for
   * runtime mismatches.
   */
  evaluate(predicate: Predicate, ctx: BaseEvaluationContext, depth = 0): boolean {
    if (depth > 10) throw new BadRequestException('predicate nesting too deep');

    if (!predicate || typeof predicate !== 'object') {
      throw new BadRequestException('predicate must be an object');
    }

    if ('and' in predicate) {
      if (!Array.isArray(predicate.and)) throw new BadRequestException('and must be an array');
      return predicate.and.every((p) => this.evaluate(p, ctx, depth + 1));
    }
    if ('or' in predicate) {
      if (!Array.isArray(predicate.or)) throw new BadRequestException('or must be an array');
      // Empty or = false; matches typical predicate-engine semantics.
      return predicate.or.some((p) => this.evaluate(p, ctx, depth + 1));
    }
    if ('not' in predicate) {
      return !this.evaluate(predicate.not, ctx, depth + 1);
    }
    if ('fn' in predicate) {
      return this.evalFn(predicate.fn, predicate.args ?? [], ctx);
    }
    if ('op' in predicate) {
      return this.evalOp(predicate as { op: string; left: unknown; right?: unknown }, ctx);
    }
    throw new BadRequestException(
      `predicate must be one of and|or|not|fn|op (got keys: ${Object.keys(predicate).join(',')})`,
    );
  }

  /**
   * Static validator. Walks the predicate tree without a context; catches
   * malformed nodes / unknown ops before persisting. Used by the rule
   * service on create/update.
   */
  validate(predicate: unknown, depth = 0): void {
    if (depth > 10) throw new BadRequestException('predicate nesting too deep');
    if (!predicate || typeof predicate !== 'object' || Array.isArray(predicate)) {
      throw new BadRequestException('predicate must be a non-array object');
    }
    const node = predicate as Record<string, unknown>;
    if ('and' in node) {
      if (!Array.isArray(node.and) || node.and.length === 0) {
        throw new BadRequestException('and must be a non-empty array');
      }
      for (const c of node.and) this.validate(c, depth + 1);
      return;
    }
    if ('or' in node) {
      if (!Array.isArray(node.or) || node.or.length === 0) {
        throw new BadRequestException('or must be a non-empty array');
      }
      for (const c of node.or) this.validate(c, depth + 1);
      return;
    }
    if ('not' in node) {
      this.validate(node.not, depth + 1);
      return;
    }
    if ('fn' in node) {
      if (typeof node.fn !== 'string' || !KNOWN_FNS.has(node.fn)) {
        throw new BadRequestException(`unknown predicate fn: ${String(node.fn)}`);
      }
      if (!Array.isArray(node.args)) {
        throw new BadRequestException(`fn ${String(node.fn)} requires args[]`);
      }
      return;
    }
    if ('op' in node) {
      if (typeof node.op !== 'string' || !KNOWN_OPS.has(node.op)) {
        throw new BadRequestException(`unknown op: ${String(node.op)}`);
      }
      if (!('left' in node)) throw new BadRequestException(`op ${node.op} requires left`);
      if (node.op !== 'in' && !('right' in node)) {
        throw new BadRequestException(`op ${node.op} requires right`);
      }
      return;
    }
    throw new BadRequestException('predicate node must have one of and|or|not|fn|op');
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private evalOp(
    node: { op: string; left: unknown; right?: unknown },
    ctx: BaseEvaluationContext,
  ): boolean {
    const left = this.resolveRef(node.left, ctx);
    const right = this.resolveRef(node.right, ctx);
    switch (node.op) {
      case 'eq':
        return looseEq(left, right);
      case 'ne':
        return !looseEq(left, right);
      case 'in': {
        if (!Array.isArray(right)) return false;
        return right.some((v) => looseEq(v, left));
      }
      case 'gt':
        return cmp(left, right) > 0;
      case 'gte':
        return cmp(left, right) >= 0;
      case 'lt':
        return cmp(left, right) < 0;
      case 'lte':
        return cmp(left, right) <= 0;
      case 'contains': {
        if (Array.isArray(left)) return left.some((v) => looseEq(v, right));
        if (typeof left === 'string' && typeof right === 'string') return left.includes(right);
        return false;
      }
      default:
        throw new BadRequestException(`unknown op: ${node.op}`);
    }
  }

  private evalFn(fn: string, rawArgs: unknown[], ctx: BaseEvaluationContext): boolean {
    const args = rawArgs.map((a) => this.resolveRef(a, ctx));
    switch (fn) {
      case 'in_business_hours': {
        const [at, calId] = args as [string, string | null];
        if (!at || !calId) return false;
        const key = `${at}|${calId}`;
        return Boolean(ctx.resolved.in_business_hours[key]);
      }
      case 'in_org_descendants': {
        const [nodeId, rootId] = args as [string | null, string | null];
        if (!nodeId || !rootId) return false;
        const set = ctx.resolved.org_descendants[rootId];
        if (!set) return false;
        return set.has(nodeId);
      }
      case 'duration_minutes_lt': {
        const [start, end, mins] = args as [string, string, number];
        const d = (Date.parse(end) - Date.parse(start)) / 60_000;
        return Number.isFinite(d) && d < Number(mins);
      }
      case 'duration_minutes_gt': {
        const [start, end, mins] = args as [string, string, number];
        const d = (Date.parse(end) - Date.parse(start)) / 60_000;
        return Number.isFinite(d) && d > Number(mins);
      }
      case 'lead_minutes_lt': {
        const [start, mins] = args as [string, number];
        const d = (Date.parse(start) - Date.now()) / 60_000;
        return Number.isFinite(d) && d < Number(mins);
      }
      case 'lead_minutes_gt': {
        const [start, mins] = args as [string, number];
        const d = (Date.parse(start) - Date.now()) / 60_000;
        return Number.isFinite(d) && d > Number(mins);
      }
      case 'has_permission': {
        const [perm] = args as [string];
        return Boolean(ctx.permissions[perm]);
      }
      case 'array_intersects': {
        // True when the two arrays share at least one element. Used by the
        // restrict_to_roles template to test "any of requester.role_ids is in
        // the allowed list".
        const [a, b] = args as [unknown, unknown];
        if (!Array.isArray(a) || !Array.isArray(b)) return false;
        const right = new Set(b.map((v) => String(v)));
        return a.some((v) => right.has(String(v)));
      }
      case 'attendees_over_capacity_factor': {
        // attendee_count > capacity * factor. Returns false when either is
        // missing — the rule can't fire on incomplete data.
        const [att, cap, factor] = args as [number | null, number | null, number];
        if (att == null || cap == null) return false;
        return Number(att) > Number(cap) * Number(factor);
      }
      case 'attendees_below_min': {
        // attendee_count < min_attendees. Skips when min_attendees is null
        // (the spec says capacity_floor only fires when min_attendees is set).
        const [att, min] = args as [number | null, number | null];
        if (att == null || min == null) return false;
        return Number(att) < Number(min);
      }
      default:
        throw new BadRequestException(`unknown fn: ${fn}`);
    }
  }

  /**
   * Resolves a JSONPath-ish reference (`$.requester.role_ids`) against the
   * evaluation context. Non-string or non-`$.` values are returned as
   * literals — so predicate authors can mix references and literals freely.
   */
  private resolveRef(value: unknown, ctx: BaseEvaluationContext): unknown {
    if (typeof value !== 'string' || !value.startsWith('$.')) return value;
    const parts = value.slice(2).split('.');
    let cursor: unknown = ctx as unknown as Record<string, unknown>;
    for (const part of parts) {
      if (cursor === null || cursor === undefined) return undefined;
      if (typeof cursor !== 'object') return undefined;
      cursor = (cursor as Record<string, unknown>)[part];
    }
    return cursor;
  }

  /**
   * Pre-resolves DB-backed helper data the engine needs at evaluation time.
   * Called by the rule resolver in one batch per booking attempt — keeps the
   * predicate evaluation pure (no async, no DB) once the context is built.
   */
  async hydrateContextHelpers(
    predicates: Predicate[],
    ctx: BaseEvaluationContext,
  ): Promise<void> {
    // Walk every predicate to collect helper invocations.
    const orgRoots = new Set<string>();
    const businessHourKeys = new Set<string>(); // "<at>|<cal_id>"

    const visit = (p: unknown) => {
      if (!p || typeof p !== 'object') return;
      const obj = p as Record<string, unknown>;
      if (Array.isArray(obj.and)) obj.and.forEach(visit);
      if (Array.isArray(obj.or)) obj.or.forEach(visit);
      if (obj.not) visit(obj.not);
      if (typeof obj.fn === 'string' && Array.isArray(obj.args)) {
        const args = obj.args.map((a) => this.resolveRef(a, ctx));
        if (obj.fn === 'in_org_descendants') {
          const root = args[1];
          if (typeof root === 'string') orgRoots.add(root);
        } else if (obj.fn === 'in_business_hours') {
          const at = args[0];
          const cal = args[1];
          if (typeof at === 'string' && typeof cal === 'string') {
            businessHourKeys.add(`${at}|${cal}`);
          }
        }
      }
    };
    predicates.forEach(visit);

    // Batch: org descendants
    for (const root of orgRoots) {
      if (ctx.resolved.org_descendants[root]) continue;
      const { data, error } = await this.supabase.admin.rpc('org_node_descendants', {
        root_id: root,
      });
      if (error) throw error;
      const ids = ((data ?? []) as Array<string | { id?: string }>).map((row) =>
        typeof row === 'string' ? row : row?.id ?? '',
      );
      ctx.resolved.org_descendants[root] = new Set(ids.filter(Boolean));
    }

    // Batch: in_business_hours per (at, calendar_id) call. Postgres has no
    // batched form of this fn so we issue them concurrently. The Supabase JS
    // builder is a thenable, not a real Promise, so wrap in Promise.resolve
    // to satisfy Promise.all's overload.
    const pending: Array<Promise<void>> = [];
    for (const key of businessHourKeys) {
      if (ctx.resolved.in_business_hours[key] !== undefined) continue;
      const [at, cal] = key.split('|');
      pending.push(
        Promise.resolve(
          this.supabase.admin.rpc('in_business_hours', { at, calendar_id: cal }),
        ).then(({ data, error }) => {
          if (error) throw error;
          ctx.resolved.in_business_hours[key] = Boolean(data);
        }),
      );
    }
    await Promise.all(pending);
  }
}

const KNOWN_OPS = new Set(['eq', 'ne', 'in', 'gt', 'gte', 'lt', 'lte', 'contains']);
const KNOWN_FNS = new Set([
  'in_business_hours',
  'in_org_descendants',
  'duration_minutes_lt',
  'duration_minutes_gt',
  'lead_minutes_lt',
  'lead_minutes_gt',
  'has_permission',
  'array_intersects',
  'attendees_over_capacity_factor',
  'attendees_below_min',
]);

function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

function cmp(a: unknown, b: unknown): number {
  // Numbers compare numerically; strings compare lexically; ISO timestamps
  // compare via Date.parse so '2026-01-01T10:00Z' > '2026-01-01T09:00Z'.
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'number' || typeof b === 'number') {
    return Number(a) - Number(b);
  }
  const aDate = typeof a === 'string' ? Date.parse(a) : NaN;
  const bDate = typeof b === 'string' ? Date.parse(b) : NaN;
  if (Number.isFinite(aDate) && Number.isFinite(bDate)) return aDate - bDate;
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

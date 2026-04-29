import { z } from 'zod';

// Matches PostgreSQL's uuid type (any 8-4-4-4-12 hex). See policy-validators.ts
// for why we avoid zod's strict RFC 4122 `z.uuid()`.
const uuidString = () =>
  z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'invalid uuid');

/**
 * Workstream D: stricter routing_rules validation at the HTTP boundary.
 *
 * The legacy controller took `conditions: unknown` and `action_assign_*: any`,
 * so an admin could save a malformed rule that resolves to nothing at ticket
 * time. The resolver then silently skips the rule. These schemas make that a
 * 400 at write time instead.
 *
 * Enforced invariants:
 *   - conditions is a non-empty array of { field, operator, value } records
 *   - exactly one of action_assign_team_id / action_assign_user_id is set
 *     (the legacy type also had a vendor branch, but the runtime resolver
 *     only reads team or user — see ResolverService.tryRules)
 *   - priority is an integer (null allowed; defaults apply)
 */

const RuleCondition = z
  .object({
    field: z.string().min(1),
    operator: z.enum([
      'equals', 'not_equals', 'in', 'not_in',
      'gt', 'lt', 'gte', 'lte',
      'contains', 'exists',
    ]),
    // `exists` is a value-less check; every other operator requires a value
    // or the resolver silently matches `undefined` against the saved value
    // and we recreate the original drift. `superRefine` enforces that
    // per-operator at write time.
    value: z
      .union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()])), z.null()])
      .optional(),
  })
  .superRefine((cond, ctx) => {
    if (cond.operator === 'exists') return;
    if (cond.value === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: `operator "${cond.operator}" requires a value`,
      });
    }
    if (cond.operator === 'in' || cond.operator === 'not_in') {
      if (!Array.isArray(cond.value)) {
        ctx.addIssue({
          code: 'custom',
          path: ['value'],
          message: `operator "${cond.operator}" requires an array value`,
        });
      }
    }
  });

export const RoutingRuleCreateSchema = z
  .object({
    name: z.string().min(1).max(200),
    priority: z.number().int().optional().nullable(),
    active: z.boolean().optional(),
    conditions: z.array(RuleCondition).min(1, 'at least one condition required — empty rules match every ticket'),
    action_assign_team_id: uuidString().optional().nullable(),
    action_assign_user_id: uuidString().optional().nullable(),
  })
  .superRefine((val, ctx) => {
    const hasTeam = Boolean(val.action_assign_team_id);
    const hasUser = Boolean(val.action_assign_user_id);
    if (!hasTeam && !hasUser) {
      ctx.addIssue({
        code: 'custom',
        path: ['action_assign_team_id'],
        message: 'rule must assign a team or a user',
      });
    }
    if (hasTeam && hasUser) {
      ctx.addIssue({
        code: 'custom',
        path: ['action_assign_team_id'],
        message: 'rule cannot assign both a team and a user — pick one',
      });
    }
  });

// PATCH allows partial updates, but if conditions or either assignee are
// touched, the same shape rules apply. Downstream service merges with the
// existing row; we can't know the final shape here without re-reading, so
// only constrain the fields actually present in the payload.
export const RoutingRuleUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  priority: z.number().int().optional().nullable(),
  active: z.boolean().optional(),
  conditions: z.array(RuleCondition).min(1).optional(),
  action_assign_team_id: uuidString().optional().nullable(),
  action_assign_user_id: uuidString().optional().nullable(),
});

export type RoutingRuleCreateInput = z.infer<typeof RoutingRuleCreateSchema>;
export type RoutingRuleUpdateInput = z.infer<typeof RoutingRuleUpdateSchema>;

import { RoutingRuleCreateSchema, RoutingRuleUpdateSchema } from './routing-rule-validators';

const TEAM = 'c0000000-0000-0000-0000-000000000001';
const USER = 'c0000000-0000-0000-0000-000000000002';

const baseCreate = {
  name: 'IT incidents go to IT Service Desk',
  priority: 100,
  conditions: [{ field: 'domain', operator: 'equals' as const, value: 'it' }],
  action_assign_team_id: TEAM,
};

describe('RoutingRuleCreateSchema', () => {
  it('accepts a minimal valid rule', () => {
    const result = RoutingRuleCreateSchema.safeParse(baseCreate);
    expect(result.success).toBe(true);
  });

  it('rejects a rule with no conditions — empty rules match every ticket', () => {
    const result = RoutingRuleCreateSchema.safeParse({ ...baseCreate, conditions: [] });
    expect(result.success).toBe(false);
  });

  it('rejects a rule with neither team nor user assignee', () => {
    const result = RoutingRuleCreateSchema.safeParse({
      name: 'x',
      conditions: baseCreate.conditions,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a rule with BOTH team and user assignee', () => {
    const result = RoutingRuleCreateSchema.safeParse({
      ...baseCreate,
      action_assign_user_id: USER,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown operator', () => {
    const result = RoutingRuleCreateSchema.safeParse({
      ...baseCreate,
      conditions: [{ field: 'domain', operator: 'fuzzy_match', value: 'it' }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts array values for "in" operator', () => {
    const result = RoutingRuleCreateSchema.safeParse({
      ...baseCreate,
      conditions: [{ field: 'priority', operator: 'in' as const, value: ['high', 'urgent'] }],
    });
    expect(result.success).toBe(true);
  });
});

describe('RoutingRuleUpdateSchema', () => {
  it('accepts a partial patch', () => {
    const result = RoutingRuleUpdateSchema.safeParse({ priority: 50 });
    expect(result.success).toBe(true);
  });

  it('accepts patch that only toggles active', () => {
    const result = RoutingRuleUpdateSchema.safeParse({ active: false });
    expect(result.success).toBe(true);
  });

  it('rejects patch that replaces conditions with empty array', () => {
    const result = RoutingRuleUpdateSchema.safeParse({ conditions: [] });
    expect(result.success).toBe(false);
  });
});

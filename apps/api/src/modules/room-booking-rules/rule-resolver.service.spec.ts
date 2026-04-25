import {
  aggregateOutcome,
  bucketRulesBySpecificity,
  filterRulesForSpace,
  MatchedRule,
  RuleRow,
} from './rule-resolver.service';

const baseRule: Omit<RuleRow, 'id' | 'target_scope' | 'target_id' | 'effect'> = {
  tenant_id: 't1',
  name: 'r',
  applies_when: { op: 'eq', left: '$.requester.id', right: 'p1' },
  approval_config: null,
  denial_message: null,
  priority: 100,
  active: true,
  template_id: null,
};

function rule(overrides: Partial<RuleRow>): RuleRow {
  return {
    id: overrides.id ?? `rule-${Math.random().toString(36).slice(2, 8)}`,
    target_scope: overrides.target_scope ?? 'tenant',
    target_id: overrides.target_id ?? null,
    effect: overrides.effect ?? 'deny',
    ...baseRule,
    ...overrides,
  } as RuleRow;
}

describe('bucketRulesBySpecificity', () => {
  const space = {
    id: 'room-1',
    type: 'meeting_room',
    ancestor_ids: ['room-1', 'floor-2', 'building-3', 'site-4'],
  };

  it('orders specificity room < subtree < type < tenant', () => {
    const rules = [
      rule({ target_scope: 'tenant', target_id: null }),
      rule({ target_scope: 'room_type', target_id: null }),
      rule({ target_scope: 'space_subtree', target_id: 'building-3' }),
      rule({ target_scope: 'room', target_id: 'room-1' }),
    ];
    const buckets = bucketRulesBySpecificity(rules, space);
    expect([...buckets.keys()]).toEqual([1, 2, 3, 4]);
  });

  it('drops rules whose target is unrelated to the space', () => {
    const rules = [
      rule({ target_scope: 'room', target_id: 'other-room' }),
      rule({ target_scope: 'space_subtree', target_id: 'unrelated' }),
    ];
    const buckets = bucketRulesBySpecificity(rules, space);
    expect(buckets.size).toBe(0);
  });

  it('room_type rules with null target_id match every room (type-agnostic)', () => {
    const rules = [rule({ target_scope: 'room_type', target_id: null })];
    const buckets = bucketRulesBySpecificity(rules, space);
    expect(buckets.get(3)).toHaveLength(1);
  });

  it('skips inactive rules', () => {
    const rules = [
      rule({ target_scope: 'tenant', target_id: null, active: false }),
    ];
    expect(filterRulesForSpace(rules, space)).toHaveLength(0);
  });
});

describe('aggregateOutcome', () => {
  function matched(overrides: Partial<MatchedRule> = {}): MatchedRule {
    return {
      ...rule({}),
      specificity: 4,
      ...overrides,
    } as MatchedRule;
  }

  it('empty matched → allow', () => {
    const out = aggregateOutcome([], 's1');
    expect(out.final).toBe('allow');
    expect(out.denialMessages).toEqual([]);
    expect(out.warnings).toEqual([]);
  });

  it('any deny wins over approval', () => {
    const out = aggregateOutcome(
      [
        matched({ effect: 'require_approval' }),
        matched({ effect: 'deny', denial_message: 'Restricted to VPs' }),
      ],
      's1',
    );
    expect(out.final).toBe('deny');
    expect(out.denialMessages).toEqual(['Restricted to VPs']);
  });

  it('require_approval picked when no deny', () => {
    const out = aggregateOutcome(
      [matched({ effect: 'require_approval', approval_config: { threshold: 'any' } })],
      's1',
    );
    expect(out.final).toBe('require_approval');
    expect(out.approvalConfig).toEqual({ threshold: 'any' });
  });

  it('warn rules collected without changing final outcome', () => {
    const out = aggregateOutcome([matched({ effect: 'warn', denial_message: 'tight fit' })], 's1');
    expect(out.final).toBe('allow');
    expect(out.warnings).toEqual(['tight fit']);
  });

  it('allow_override sets the overridable flag', () => {
    const out = aggregateOutcome(
      [
        matched({ effect: 'deny', denial_message: 'restricted' }),
        matched({ effect: 'allow_override' }),
      ],
      's1',
    );
    expect(out.final).toBe('deny');
    expect(out.overridable).toBe(true);
  });

  it('approval config picked from the most specific, highest-priority approval rule', () => {
    const out = aggregateOutcome(
      [
        matched({ effect: 'require_approval', specificity: 4, priority: 100, approval_config: { threshold: 'all' } }),
        matched({ effect: 'require_approval', specificity: 1, priority: 50, approval_config: { threshold: 'any' } }),
      ],
      's1',
    );
    expect(out.approvalConfig).toEqual({ threshold: 'any' });
  });

  it('all denial messages collected', () => {
    const out = aggregateOutcome(
      [
        matched({ effect: 'deny', denial_message: 'msg-A' }),
        matched({ effect: 'deny', denial_message: 'msg-B' }),
      ],
      's1',
    );
    expect(out.denialMessages).toEqual(['msg-A', 'msg-B']);
  });
});

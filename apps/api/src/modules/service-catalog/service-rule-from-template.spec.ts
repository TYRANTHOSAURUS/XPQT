import { compileTemplatePredicate } from './service-rule.service';

/**
 * Codex Sprint 1B round-1 fix: round-0 tests only covered the
 * substitution pass and let the engine-incompatible AST shape
 * through. These tests cover the FULL compile (substitute →
 * normalise) and the realistic template shapes from migration 00149.
 */

describe('compileTemplatePredicate — substitution pass', () => {
  it('substitutes a top-level $.param const reference + unwraps the const wrapper', () => {
    expect(
      compileTemplatePredicate({ const: '$.threshold' }, { threshold: 500 }),
    ).toBe(500);
  });

  it('walks nested objects and arrays', () => {
    const tpl = {
      op: 'and',
      args: [
        { tag: '$.tag' },
        { other: 'literal' },
      ],
    };
    expect(
      compileTemplatePredicate(tpl, { tag: 'high-cost' }),
    ).toEqual({
      op: 'and',
      args: [{ tag: 'high-cost' }, { other: 'literal' }],
    });
  });

  it('preserves $. strings that have no matching param (JSONPath refs)', () => {
    /* `$.order.total` is a JSONPath ref in the template; not a placeholder.
       After substitution + normalization the {path} wrapper is removed
       and the bare ref string is preserved. */
    const tpl = {
      op: '>',
      left: { path: '$.order.total_per_occurrence' },
      right: { const: '$.threshold' },
    };
    expect(
      compileTemplatePredicate(tpl, { threshold: 100 }),
    ).toEqual({
      op: 'gt',
      left: '$.order.total_per_occurrence',
      right: 100,
    });
  });

  it('does not recurse into substituted $. strings (param values are literal)', () => {
    /* If a param value happens to start with '$.', it must NOT be
       interpreted as a second-level placeholder. */
    expect(
      compileTemplatePredicate({ value: '$.tricky' }, { tricky: '$.fake_param' }),
    ).toEqual({ value: '$.fake_param' });
  });

  it('passes through non-template primitives unchanged', () => {
    expect(compileTemplatePredicate(42, {})).toBe(42);
    expect(compileTemplatePredicate('hello', {})).toBe('hello');
    expect(compileTemplatePredicate(null, {})).toBe(null);
    expect(compileTemplatePredicate(true, {})).toBe(true);
  });
});

describe('compileTemplatePredicate — engine-AST normalisation', () => {
  it('translates ASCII operators to engine symbolic ops', () => {
    expect(
      compileTemplatePredicate({ op: '>',  left: '$.x', right: 5 }, {}),
    ).toEqual({ op: 'gt', left: '$.x', right: 5 });
    expect(
      compileTemplatePredicate({ op: '<',  left: '$.x', right: 5 }, {}),
    ).toEqual({ op: 'lt', left: '$.x', right: 5 });
    expect(
      compileTemplatePredicate({ op: '=',  left: '$.x', right: 5 }, {}),
    ).toEqual({ op: 'eq', left: '$.x', right: 5 });
    expect(
      compileTemplatePredicate({ op: '!=', left: '$.x', right: 5 }, {}),
    ).toEqual({ op: 'ne', left: '$.x', right: 5 });
    expect(
      compileTemplatePredicate({ op: '>=', left: '$.x', right: 5 }, {}),
    ).toEqual({ op: 'gte', left: '$.x', right: 5 });
    expect(
      compileTemplatePredicate({ op: '<=', left: '$.x', right: 5 }, {}),
    ).toEqual({ op: 'lte', left: '$.x', right: 5 });
  });

  it('unwraps {path: ...} into a bare $. ref string', () => {
    expect(
      compileTemplatePredicate({ path: '$.order.total' }, {}),
    ).toBe('$.order.total');
  });

  it('unwraps {const: ...} into the literal value', () => {
    expect(compileTemplatePredicate({ const: 5 }, {})).toBe(5);
    expect(compileTemplatePredicate({ const: 'literal' }, {})).toBe('literal');
    expect(compileTemplatePredicate({ const: [1, 2, 3] }, {})).toEqual([1, 2, 3]);
  });

  it('translates is_not_null(x) into ne(x, null)', () => {
    expect(
      compileTemplatePredicate(
        { op: 'is_not_null', args: [{ path: '$.line.menu.fulfillment_vendor_id' }] },
        {},
      ),
    ).toEqual({
      op: 'ne',
      left: '$.line.menu.fulfillment_vendor_id',
      right: null,
    });
  });

  it('keeps and/or/not composition shape, recurses args', () => {
    const tpl = {
      op: 'and',
      args: [
        { op: '>', left: { path: '$.x' }, right: { const: 1 } },
        { op: 'not', args: [{ op: '=', left: { path: '$.y' }, right: { const: 2 } }] },
      ],
    };
    expect(compileTemplatePredicate(tpl, {})).toEqual({
      op: 'and',
      args: [
        { op: 'gt', left: '$.x', right: 1 },
        { op: 'not', args: [{ op: 'eq', left: '$.y', right: 2 }] },
      ],
    });
  });
});

describe('compileTemplatePredicate — seeded template fixtures (migration 00149)', () => {
  it('cost_threshold_approval compiles to engine-valid gt', () => {
    const tpl = {
      op: '>',
      left: { path: '$.order.total_per_occurrence' },
      right: { const: '$.threshold' },
    };
    expect(compileTemplatePredicate(tpl, { threshold: 500 })).toEqual({
      op: 'gt',
      left: '$.order.total_per_occurrence',
      right: 500,
    });
  });

  it('per_item_lead_time compiles to engine-valid lt', () => {
    const tpl = {
      op: '<',
      left: { path: '$.order.line.lead_time_remaining_hours' },
      right: { const: '$.threshold' },
    };
    expect(compileTemplatePredicate(tpl, { threshold: 24 })).toEqual({
      op: 'lt',
      left: '$.order.line.lead_time_remaining_hours',
      right: 24,
    });
  });

  it('external_vendor_approval compiles is_not_null + and to engine shape', () => {
    const tpl = {
      op: 'and',
      args: [
        { op: 'is_not_null', args: [{ path: '$.line.menu.fulfillment_vendor_id' }] },
        { op: '>', left: { path: '$.order.total' }, right: { const: '$.threshold' } },
      ],
    };
    expect(compileTemplatePredicate(tpl, { threshold: 200 })).toEqual({
      op: 'and',
      args: [
        { op: 'ne', left: '$.line.menu.fulfillment_vendor_id', right: null },
        { op: 'gt', left: '$.order.total', right: 200 },
      ],
    });
  });

  it('role_restricted_item compiles with single role id (not array)', () => {
    const tpl = {
      op: 'and',
      args: [
        { op: '=', left: { path: '$.line.catalog_item_id' }, right: { const: '$.target_item_id' } },
        { op: 'not', args: [{ op: 'contains', left: { path: '$.requester.role_ids' }, right: { const: '$.target_role_id' } }] },
      ],
    };
    expect(
      compileTemplatePredicate(tpl, {
        target_item_id: 'item-uuid',
        target_role_id: 'role-uuid',
      }),
    ).toEqual({
      op: 'and',
      args: [
        { op: 'eq', left: '$.line.catalog_item_id', right: 'item-uuid' },
        {
          op: 'not',
          args: [{ op: 'contains', left: '$.requester.role_ids', right: 'role-uuid' }],
        },
      ],
    });
  });

  it('item_blackout compiles in-list', () => {
    const tpl = {
      op: 'in',
      left: { path: '$.booking.start_at_day_of_week' },
      right: { const: '$.blackout_days' },
    };
    expect(compileTemplatePredicate(tpl, { blackout_days: [1, 6] })).toEqual({
      op: 'in',
      left: '$.booking.start_at_day_of_week',
      right: [1, 6],
    });
  });

  it('approval_config_template references compile to flat strings', () => {
    /* external_vendor_approval's approval_config — `role_id` references
       the new `$.finance_role_id` param (added by migration 00182). */
    const tpl = {
      approver_target: 'role',
      role_id: '$.finance_role_id',
    };
    expect(
      compileTemplatePredicate(tpl, { finance_role_id: 'finance-role-uuid' }),
    ).toEqual({
      approver_target: 'role',
      role_id: 'finance-role-uuid',
    });
  });
});

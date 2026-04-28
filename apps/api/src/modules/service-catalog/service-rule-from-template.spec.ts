import { compileTemplatePredicate } from './service-rule.service';

describe('compileTemplatePredicate', () => {
  it('substitutes a top-level $.param const reference', () => {
    expect(
      compileTemplatePredicate({ const: '$.threshold' }, { threshold: 500 }),
    ).toEqual({ const: 500 });
  });

  it('walks nested objects and arrays', () => {
    const tpl = {
      op: '>',
      left:  { path: '$.order.total_per_occurrence' },           // not a placeholder
      right: { const: '$.threshold' },
      tags:  ['$.tag', 'literal-tag'],
    };
    expect(
      compileTemplatePredicate(tpl, { threshold: 500, tag: 'high-cost' }),
    ).toEqual({
      op: '>',
      left:  { path: '$.order.total_per_occurrence' },           // path strings preserved (no key match)
      right: { const: 500 },
      tags:  ['high-cost', 'literal-tag'],
    });
  });

  it('preserves $. strings that have no matching param', () => {
    /* The `$.order.total_per_occurrence` JSONPath is NOT a placeholder
       — there's no params['order.total_per_occurrence'] supplied. The
       compiler must leave it intact so the predicate engine can resolve
       it at evaluation time. */
    const tpl = {
      op: '>',
      left: { path: '$.order.total_per_occurrence' },
      right: { const: '$.threshold' },
    };
    expect(
      compileTemplatePredicate(tpl, { threshold: 100 }),
    ).toEqual({
      op: '>',
      left: { path: '$.order.total_per_occurrence' },
      right: { const: 100 },
    });
  });

  it('handles boolean / number / null param values', () => {
    expect(
      compileTemplatePredicate(
        { effect: '$.flag', limit: '$.cap', missing: '$.gone' },
        { flag: true, cap: 0, gone: null },
      ),
    ).toEqual({ effect: true, limit: 0, missing: null });
  });

  it('resolves multi-level shapes like the cost_threshold_approval template', () => {
    const tpl = {
      op: '>',
      left: { path: '$.order.total_per_occurrence' },
      right: { const: '$.threshold' },
    };
    expect(
      compileTemplatePredicate(tpl, { threshold: 250 }),
    ).toEqual({
      op: '>',
      left: { path: '$.order.total_per_occurrence' },
      right: { const: 250 },
    });
  });

  it('passes through non-template primitives unchanged', () => {
    expect(compileTemplatePredicate(42, {})).toBe(42);
    expect(compileTemplatePredicate('hello', {})).toBe('hello');
    expect(compileTemplatePredicate(null, {})).toBe(null);
    expect(compileTemplatePredicate(true, {})).toBe(true);
  });

  it('handles arrays of placeholders for multi-value params', () => {
    expect(
      compileTemplatePredicate(
        { roles: ['$.role_ids', 'literal-role'] },
        { role_ids: ['exec', 'manager'] },
      ),
    ).toEqual({ roles: [['exec', 'manager'], 'literal-role'] });
  });
});

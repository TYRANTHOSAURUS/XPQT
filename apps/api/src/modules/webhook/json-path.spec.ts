import { evalJsonPath } from './json-path';

describe('evalJsonPath', () => {
  const obj = {
    issue: {
      key: 'PROJ-42',
      fields: {
        priority: { name: 'High' },
        labels: ['urgent', 'bug'],
      },
    },
    items: [{ id: 'a', n: 1 }, { id: 'b', n: 2 }],
  };

  it('returns undefined for empty path', () => {
    expect(evalJsonPath(obj, '')).toBeUndefined();
  });

  it('resolves dotted paths with leading $', () => {
    expect(evalJsonPath(obj, '$.issue.key')).toBe('PROJ-42');
  });

  it('resolves dotted paths without leading $', () => {
    expect(evalJsonPath(obj, 'issue.fields.priority.name')).toBe('High');
  });

  it('resolves array index access', () => {
    expect(evalJsonPath(obj, '$.items[1].id')).toBe('b');
    expect(evalJsonPath(obj, '$.issue.fields.labels[0]')).toBe('urgent');
  });

  it('returns undefined for missing keys', () => {
    expect(evalJsonPath(obj, '$.issue.missing.nested')).toBeUndefined();
  });

  it('returns undefined when indexing a non-array', () => {
    expect(evalJsonPath(obj, '$.issue[0]')).toBeUndefined();
  });

  it('returns undefined when descending into null', () => {
    expect(evalJsonPath({ a: null }, '$.a.b')).toBeUndefined();
  });
});

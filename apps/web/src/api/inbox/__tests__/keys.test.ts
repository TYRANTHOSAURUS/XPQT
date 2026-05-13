/**
 * Stability tests for the inbox query-key factory.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step F. The Realtime subscription
 * (`apps/web/src/lib/realtime/inbox-subscription.ts`) invalidates by
 * `inboxKeys.all` and `inboxKeys.count()`; an accidental rename here
 * would silently break the wire-up. Pin the wire-shape via these tests.
 */

import { describe, expect, it } from 'vitest';
import { inboxKeys } from '../keys';

describe('inboxKeys factory', () => {
  it('roots every key under ["inbox"]', () => {
    expect(inboxKeys.all).toEqual(['inbox']);
  });

  it('lists() nests under all', () => {
    expect(inboxKeys.lists()).toEqual(['inbox', 'list']);
  });

  it('list() includes the args object verbatim — no defaults injected', () => {
    expect(inboxKeys.list()).toEqual(['inbox', 'list', {}]);
    expect(inboxKeys.list({ limit: 5 })).toEqual(['inbox', 'list', { limit: 5 }]);
    expect(inboxKeys.list({ limit: 20 })).toEqual(['inbox', 'list', { limit: 20 }]);
  });

  it('different list args produce structurally distinct keys', () => {
    expect(inboxKeys.list({ limit: 5 })).not.toEqual(inboxKeys.list({ limit: 20 }));
  });

  it('count() and details() are siblings of lists()', () => {
    expect(inboxKeys.count()).toEqual(['inbox', 'count']);
    expect(inboxKeys.details()).toEqual(['inbox', 'detail']);
  });

  it('detail(id) appends the id to details()', () => {
    expect(inboxKeys.detail('abc')).toEqual(['inbox', 'detail', 'abc']);
  });

  // Hierarchical-prefix invariant: invalidating a parent must bust every
  // child. React Query matches by prefix, so this is a literal structural
  // check on the array shape.
  it('count, lists, and details share the same ["inbox"] prefix', () => {
    for (const k of [inboxKeys.count(), inboxKeys.lists(), inboxKeys.details()]) {
      expect(k[0]).toBe('inbox');
    }
  });
});

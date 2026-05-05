import {
  NS_PLAN_BOOKING_WITH_ATTACH,
  planUuid,
  type PlanRowKind,
} from './plan-uuid';

describe('planUuid', () => {
  it('returns the same UUID for the same (idempotencyKey, rowKind, stableIndex)', () => {
    const a = planUuid('idem-key-1', 'oli', 'order-1:line-a');
    const b = planUuid('idem-key-1', 'oli', 'order-1:line-a');
    expect(a).toBe(b);
  });

  it('returns a different UUID when stableIndex differs', () => {
    const a = planUuid('idem-key-1', 'oli', 'order-1:line-a');
    const b = planUuid('idem-key-1', 'oli', 'order-1:line-b');
    expect(a).not.toBe(b);
  });

  it('returns a different UUID when rowKind differs', () => {
    const a = planUuid('idem-key-1', 'order', 'catering');
    const b = planUuid('idem-key-1', 'oli', 'catering');
    expect(a).not.toBe(b);
  });

  it('returns a different UUID when idempotencyKey differs', () => {
    const a = planUuid('idem-key-1', 'oli', 'x');
    const b = planUuid('idem-key-2', 'oli', 'x');
    expect(a).not.toBe(b);
  });

  it('produces a v5 UUID (RFC 4122 — 5xxx variant byte)', () => {
    // v5 UUIDs have '5' as the leading char of the third group AND a variant
    // byte in '8'/'9'/'a'/'b' as the leading char of the fourth group.
    const id = planUuid('idem-key-1', 'booking', '0');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('exposes the namespace UUID (sanity — never rotate)', () => {
    expect(NS_PLAN_BOOKING_WITH_ATTACH).toBe('8e7c1a32-4b6f-4a10-9d2e-6b9a2c4f7d10');
  });

  it('rejects empty idempotencyKey', () => {
    expect(() => planUuid('', 'booking', '0')).toThrow(/idempotencyKey required/);
  });

  it('rejects empty stableIndex', () => {
    expect(() => planUuid('idem-key-1', 'oli', '')).toThrow(/stableIndex required/);
  });

  it('handles every documented row kind', () => {
    const kinds: PlanRowKind[] = ['booking', 'slot', 'order', 'oli', 'asset_reservation', 'approval'];
    const seen = new Set<string>();
    for (const kind of kinds) {
      const id = planUuid('idem-key-1', kind, 'x');
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
    expect(seen.size).toBe(kinds.length);
  });

  it('is stable across deploy boundaries (deterministic output for fixed inputs)', () => {
    // Snapshot a known triple — if anyone rotates the namespace this test
    // catches it.
    const id = planUuid('fixed-idem', 'booking', '0');
    expect(id).toBe('d20bf3a4-3929-5cc6-b690-9eea3f7c124c');
  });
});

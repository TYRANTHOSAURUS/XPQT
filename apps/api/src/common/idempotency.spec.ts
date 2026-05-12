/**
 * Unit tests for the @prequest/shared idempotency-key helpers.
 *
 * Scope (B.4.A.2): the new `buildEditBookingIdempotencyKey` helper plus a
 * smoke that the sibling builders remain deterministic + namespace-
 * separated. The existing builders had no dedicated spec — every prior
 * regression was caught indirectly by RPC-level concurrency tests. The
 * B.2.A retro called out that "indirectly tested" is exactly how key-
 * shape drift hides: when a sibling builder grows a typo'd prefix, the
 * RPC test still passes because `command_operations` is empty for the
 * stale key and the no-row path is the silent-failure path. Locking the
 * shape down here prevents that class.
 *
 * The test file lives under apps/api/src/common/ because that's the only
 * package that ships a jest runner (`apps/api/jest.config.cjs` →
 * `rootDir: 'src'`, `testRegex: '.*\\.spec\\.ts$'`). The `@prequest/shared`
 * package itself currently runs `"test": "echo \\"No tests yet\\""` —
 * placing the spec there would never execute.
 */

import {
  buildApprovalGrantIdempotencyKey,
  buildDispatchBatchIdempotencyKey,
  buildDispatchIdempotencyKey,
  buildEditBookingIdempotencyKey,
  buildReclassifyIdempotencyKey,
  EDIT_BOOKING_IDEMPOTENCY_KEY_PREFIX,
} from '@prequest/shared';

describe('buildEditBookingIdempotencyKey', () => {
  const bookingId = '11111111-1111-1111-1111-111111111111';
  const bookingIdAlt = '22222222-2222-2222-2222-222222222222';
  const crid = 'crid-abc';
  const cridAlt = 'crid-xyz';

  it('is deterministic given the same (bookingId, clientRequestId)', () => {
    const a = buildEditBookingIdempotencyKey(bookingId, crid);
    const b = buildEditBookingIdempotencyKey(bookingId, crid);
    expect(a).toBe(b);
  });

  it('uses the booking:edit prefix exactly (grep-safe)', () => {
    const key = buildEditBookingIdempotencyKey(bookingId, crid);
    expect(key.startsWith(`${EDIT_BOOKING_IDEMPOTENCY_KEY_PREFIX}:`)).toBe(true);
    expect(EDIT_BOOKING_IDEMPOTENCY_KEY_PREFIX).toBe('booking:edit');
    // Full shape per the helper contract: `booking:edit:<id>:<crid>`.
    expect(key).toBe(`booking:edit:${bookingId}:${crid}`);
  });

  it('mints distinct keys for different bookings (same crid)', () => {
    const a = buildEditBookingIdempotencyKey(bookingId, crid);
    const b = buildEditBookingIdempotencyKey(bookingIdAlt, crid);
    expect(a).not.toBe(b);
  });

  it('mints distinct keys for different crids (same booking)', () => {
    const a = buildEditBookingIdempotencyKey(bookingId, crid);
    const b = buildEditBookingIdempotencyKey(bookingId, cridAlt);
    expect(a).not.toBe(b);
  });

  it('drops actor from the key shape (B.2.A Step 8 lesson — F-CRIT-2 / plan-C1)', () => {
    // The helper signature deliberately takes (bookingId, crid) — NO
    // actor segment. Same booking + same crid across two actors (e.g.
    // delegation switch mid-retry) must collapse to the cached result,
    // not double-write. The shape test alone is the structural defense:
    // if a future refactor adds an actor parameter, this spec fails to
    // compile.
    const sameActorAttempt = buildEditBookingIdempotencyKey(bookingId, crid);
    const sameActorRetry = buildEditBookingIdempotencyKey(bookingId, crid);
    expect(sameActorAttempt).toBe(sameActorRetry);
    // Defense-in-depth: the rendered shape has exactly 4 colon-segments.
    expect(sameActorAttempt.split(':').length).toBe(4);
  });

  // B.4 Step 2F.3 — operation discriminator. Closes the cross-op-
  // collision followup at docs/follow-ups/b4-followups.md by namespacing
  // the key per editOne / editSlot / editScope. The discriminator is
  // the THIRD argument and is optional only for backward-compat with
  // pre-Step-2F.3 callers; every booking-edit producer route now passes
  // it.
  describe('op discriminator (Step 2F.3)', () => {
    it('omits the op segment when op is undefined (backward-compat)', () => {
      const key = buildEditBookingIdempotencyKey(bookingId, crid);
      expect(key).toBe(`booking:edit:${bookingId}:${crid}`);
      // Shape: 4 segments → no op.
      expect(key.split(':').length).toBe(4);
    });

    it('inserts the op segment when op is provided', () => {
      expect(buildEditBookingIdempotencyKey(bookingId, crid, 'one')).toBe(
        `booking:edit:one:${bookingId}:${crid}`,
      );
      expect(buildEditBookingIdempotencyKey(bookingId, crid, 'slot')).toBe(
        `booking:edit:slot:${bookingId}:${crid}`,
      );
      expect(buildEditBookingIdempotencyKey(bookingId, crid, 'scope')).toBe(
        `booking:edit:scope:${bookingId}:${crid}`,
      );
    });

    it('mints distinct keys for different ops with same (booking, crid)', () => {
      // The exact collision class the followup documents: a frontend
      // reusing the same crid across an editOne + editSlot must NOT
      // collapse to a single command_operations row.
      const oneKey = buildEditBookingIdempotencyKey(bookingId, crid, 'one');
      const slotKey = buildEditBookingIdempotencyKey(bookingId, crid, 'slot');
      const scopeKey = buildEditBookingIdempotencyKey(bookingId, crid, 'scope');
      const keys = [oneKey, slotKey, scopeKey];
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('legacy (no op) and op-discriminated keys do not collide', () => {
      // Migration safety: a deploy that goes from "every caller is op-less"
      // to "every caller passes op" must not have a window where a
      // pre-deploy `legacy` key collides with a post-deploy `op` key on
      // the same (booking, crid). The op segment lives BEFORE the bookingId,
      // not after, so the rendered strings can never alias.
      const legacy = buildEditBookingIdempotencyKey(bookingId, crid);
      const opOne = buildEditBookingIdempotencyKey(bookingId, crid, 'one');
      const opSlot = buildEditBookingIdempotencyKey(bookingId, crid, 'slot');
      const opScope = buildEditBookingIdempotencyKey(bookingId, crid, 'scope');
      expect(legacy).not.toBe(opOne);
      expect(legacy).not.toBe(opSlot);
      expect(legacy).not.toBe(opScope);
    });
  });
});

describe('idempotency key prefixes are namespace-separated', () => {
  // Cross-helper smoke — every prefix must be distinct so a retry of
  // one RPC family can never collide on (tenant_id, idempotency_key)
  // with a retry of another. Same shape concern as F-CRIT-2 but across
  // helpers instead of across actors.
  const bookingId = '11111111-1111-1111-1111-111111111111';
  const parentId = '33333333-3333-3333-3333-333333333333';
  const ticketId = '44444444-4444-4444-4444-444444444444';
  const approvalId = '55555555-5555-5555-5555-555555555555';
  const crid = 'crid-shared';

  it('booking:edit does not collide with dispatch / dispatch_batch / reclassify / approval:grant', () => {
    const editKey = buildEditBookingIdempotencyKey(bookingId, crid);
    const dispatchKey = buildDispatchIdempotencyKey(parentId, crid);
    const dispatchBatchKey = buildDispatchBatchIdempotencyKey(parentId, crid);
    const reclassifyKey = buildReclassifyIdempotencyKey(ticketId, crid);
    const approvalKey = buildApprovalGrantIdempotencyKey(approvalId, crid);

    const keys = [editKey, dispatchKey, dispatchBatchKey, reclassifyKey, approvalKey];
    const uniq = new Set(keys);
    expect(uniq.size).toBe(keys.length);
  });
});

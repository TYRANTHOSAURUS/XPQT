import { createMagicCheckInToken, verifyMagicCheckInToken } from './magic-check-in.token';

describe('magic-check-in token', () => {
  const RID = '11111111-1111-1111-1111-111111111111';
  const PID = '22222222-2222-2222-2222-222222222222';

  beforeAll(() => {
    process.env.CHECK_IN_MAGIC_SECRET = 'test-secret';
  });

  it('round-trips a valid token', () => {
    const tok = createMagicCheckInToken({
      reservationId: RID, requesterPersonId: PID, ttlMinutes: 30,
    });
    const result = verifyMagicCheckInToken(tok);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.reservationId).toBe(RID);
      expect(result.payload.requesterPersonId).toBe(PID);
    }
  });

  it('rejects malformed tokens', () => {
    const result = verifyMagicCheckInToken('garbage');
    expect(result.ok).toBe(false);
  });

  it('rejects tampered signature', () => {
    const tok = createMagicCheckInToken({
      reservationId: RID, requesterPersonId: PID,
    });
    // Tamper: change one base64-url character mid-token.
    const tampered = tok.slice(0, -2) + 'AA';
    const result = verifyMagicCheckInToken(tampered);
    expect(result.ok).toBe(false);
  });

  it('rejects expired tokens', () => {
    const past = Date.now() - 60 * 60 * 1000;
    // Construct a token whose expiry is in the past by overriding nowMs
    // when signing, then verify with the real now.
    const tok = createMagicCheckInToken({
      reservationId: RID, requesterPersonId: PID, ttlMinutes: 1, nowMs: past,
    });
    const result = verifyMagicCheckInToken(tok);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('rejects token signed with a different secret', () => {
    const tok = createMagicCheckInToken({
      reservationId: RID, requesterPersonId: PID,
    });
    const previous = process.env.CHECK_IN_MAGIC_SECRET;
    process.env.CHECK_IN_MAGIC_SECRET = 'a-different-secret';
    try {
      const result = verifyMagicCheckInToken(tok);
      expect(result.ok).toBe(false);
    } finally {
      process.env.CHECK_IN_MAGIC_SECRET = previous;
    }
  });
});

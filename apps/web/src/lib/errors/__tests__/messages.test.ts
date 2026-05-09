import { describe, expect, it } from 'vitest';
import { ERROR_MESSAGES_EN, resolveMessage } from '../messages.en';

describe('resolveMessage', () => {
  it('returns title + detail for a registered code', () => {
    const m = resolveMessage('auth.unauthorized');
    expect(m.title).toBe('Sign in to continue');
    expect(m.detail).toMatch(/sign-in/i);
  });

  it('falls back to unknown.server_error for unregistered codes', () => {
    const fallback = resolveMessage('unknown.server_error');
    const m = resolveMessage('totally-fake-code-xyz');
    expect(m).toEqual(fallback);
  });

  it('every registered entry has a non-empty title', () => {
    for (const [code, entry] of Object.entries(ERROR_MESSAGES_EN)) {
      expect(entry.title.length, `code ${code}`).toBeGreaterThan(0);
    }
  });

  it('voice rule: error titles use "Couldn\'t" or are present-state (sign-in / can\'t / etc.)', () => {
    // Spot-check a couple — codes mapped to actions should follow voice.
    expect(resolveMessage('booking.slot_conflict').title).toMatch(/Couldn't/i);
    expect(resolveMessage('cost_center_code_taken').title).toMatch(/Couldn't/i);
  });

  it('always registers the four bedrock codes', () => {
    for (const code of [
      'unknown.server_error',
      'auth.unauthorized',
      'permission.denied',
      'validation.failed',
    ]) {
      expect(ERROR_MESSAGES_EN[code]).toBeDefined();
    }
  });
});

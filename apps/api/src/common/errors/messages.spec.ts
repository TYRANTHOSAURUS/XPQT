import { ERROR_MESSAGES_EN, resolveMessageEn } from './messages.en';
import { ERROR_MESSAGES_NL, resolveMessageNl } from './messages.nl';

describe('resolveMessageEn', () => {
  it('returns title + detail for a registered code', () => {
    const m = resolveMessageEn('auth.unauthorized');
    expect(m.title).toBe('Sign in to continue');
    expect(m.detail).toMatch(/sign-in/i);
  });

  it('falls back to unknown.server_error for unregistered codes', () => {
    const fallback = resolveMessageEn('unknown.server_error');
    const m = resolveMessageEn('totally-fake-code-xyz');
    expect(m).toEqual(fallback);
  });

  it('every registered entry has a non-empty title', () => {
    for (const [code, entry] of Object.entries(ERROR_MESSAGES_EN)) {
      expect(entry.title.length).toBeGreaterThan(0);
      if (!entry.title.length) {
        throw new Error(`empty title for ${code}`);
      }
    }
  });
});

describe('resolveMessageNl', () => {
  it('returns title + detail for a registered code', () => {
    const m = resolveMessageNl('auth.unauthorized');
    expect(m.title).toBe('Meld je opnieuw aan');
    expect(m.detail).toMatch(/sessie/i);
  });

  it('falls back to unknown.server_error for unregistered codes', () => {
    const fallback = resolveMessageNl('unknown.server_error');
    const m = resolveMessageNl('totally-fake-code-xyz');
    expect(m).toEqual(fallback);
  });

  it('every registered NL entry has a non-empty title', () => {
    for (const [code, entry] of Object.entries(ERROR_MESSAGES_NL)) {
      expect(entry.title.length).toBeGreaterThan(0);
      if (!entry.title.length) {
        throw new Error(`empty NL title for ${code}`);
      }
    }
  });
});

describe('coverage drift — EN vs NL (server)', () => {
  it('every EN code has a NL translation', () => {
    const missing: string[] = [];
    for (const code of Object.keys(ERROR_MESSAGES_EN)) {
      if (!ERROR_MESSAGES_NL[code as keyof typeof ERROR_MESSAGES_NL]) {
        missing.push(code);
      }
    }
    expect(missing).toEqual([]);
  });

  it('NL has no extra codes beyond EN', () => {
    const extra: string[] = [];
    for (const code of Object.keys(ERROR_MESSAGES_NL)) {
      if (!ERROR_MESSAGES_EN[code as keyof typeof ERROR_MESSAGES_EN]) {
        extra.push(code);
      }
    }
    expect(extra).toEqual([]);
  });

  it('NL message count matches EN', () => {
    expect(Object.keys(ERROR_MESSAGES_NL).length).toBe(
      Object.keys(ERROR_MESSAGES_EN).length,
    );
  });

  it('voice rule: NL error titles use "Kon" or "Je" / neutral fragments', () => {
    // Spot check: a couple of error codes should follow the Dutch voice.
    expect(resolveMessageNl('booking.slot_conflict').title).toMatch(/^Kon/);
    expect(resolveMessageNl('cost_center_code_taken').title).toMatch(/^Kon/);
    expect(resolveMessageNl('permission.denied').title).toMatch(/^Je/);
  });
});

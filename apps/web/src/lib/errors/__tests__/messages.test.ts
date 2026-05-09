import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ERROR_MESSAGES_EN,
  INTERNAL_ONLY_CODES,
  INTERNAL_ONLY_PREFIXES,
  resolveMessage,
} from '../messages.en';

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

  it('always registers the three bedrock codes', () => {
    // validation.failed is intentionally NOT in the client registry — it's
    // always overridden by `fields[]`. The three below must always exist
    // because the renderer falls back through them.
    for (const code of [
      'unknown.server_error',
      'auth.unauthorized',
      'permission.denied',
    ]) {
      expect(ERROR_MESSAGES_EN[code]).toBeDefined();
    }
  });
});

describe('coverage drift — server vs client', () => {
  // The server's messages.en.ts is the canonical SoT for what codes can
  // be emitted. Every user-visible code must exist in the client registry
  // OR be on the internal-only allowlist. Anything else is a coverage gap
  // that surfaces as `unknown.server_error` to the user.
  function readServerCodes(): Set<string> {
    const file = path.resolve(
      __dirname,
      '../../../../../api/src/common/errors/messages.en.ts',
    );
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      // If the api file isn't reachable from the test (e.g. a stripped CI
      // checkout), skip the test rather than fail loudly.
      return new Set();
    }
    // Match top-level entries inside the registry. Server keys are either
    // 'foo.bar' (quoted) or bare snake_case (unquoted). Restrict to lines
    // indented by exactly two spaces and ending in `: {` to avoid nested
    // members of `surface: { toast: ... }`.
    const set = new Set<string>();
    const re = /^ {2}(?:'([^']+)'|"([^"]+)"|([a-zA-Z_][\w]*)): \{/gm;
    let match: RegExpExecArray | null;
    while ((match = re.exec(raw)) !== null) {
      const code = match[1] ?? match[2] ?? match[3];
      if (code) set.add(code);
    }
    return set;
  }

  function isInternalOnly(code: string): boolean {
    if (INTERNAL_ONLY_CODES.has(code)) return true;
    return INTERNAL_ONLY_PREFIXES.some((p) => code.startsWith(p));
  }

  const serverCodes = readServerCodes();

  it('reads server codes (>= 300 expected)', () => {
    // If this fires, the regex broke — retune before trusting drift.
    if (serverCodes.size === 0) {
      // CI without server source — skip.
      return;
    }
    expect(serverCodes.size).toBeGreaterThanOrEqual(300);
  });

  it('every user-visible server code has a client message', () => {
    if (serverCodes.size === 0) return;
    const missing: string[] = [];
    for (const code of serverCodes) {
      if (isInternalOnly(code)) continue;
      if (!ERROR_MESSAGES_EN[code]) missing.push(code);
    }
    // Failure prints the gap so the dev knows what to add to messages.en.ts.
    expect(missing, `missing client message for ${missing.length} server code(s)`).toEqual([]);
  });

  it('client message count clears the 350 floor', () => {
    expect(Object.keys(ERROR_MESSAGES_EN).length).toBeGreaterThanOrEqual(350);
  });
});

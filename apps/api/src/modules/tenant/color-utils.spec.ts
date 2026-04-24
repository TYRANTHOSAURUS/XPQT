import {
  isValidHex,
  contrastAgainstWhite,
  assertUsablePrimary,
  assertValidHexOrNull,
} from './color-utils';

describe('isValidHex', () => {
  it('accepts lowercase 6-digit hex', () => expect(isValidHex('#2563eb')).toBe(true));
  it('accepts uppercase 6-digit hex', () => expect(isValidHex('#AABBCC')).toBe(true));
  it('rejects 3-digit hex', () => expect(isValidHex('#abc')).toBe(false));
  it('rejects missing hash', () => expect(isValidHex('2563eb')).toBe(false));
  it('rejects non-hex characters', () => expect(isValidHex('#zzzzzz')).toBe(false));
});

describe('contrastAgainstWhite', () => {
  it('returns 21 for black', () => {
    expect(contrastAgainstWhite('#000000')).toBeCloseTo(21, 1);
  });
  it('returns 1 for white', () => {
    expect(contrastAgainstWhite('#ffffff')).toBeCloseTo(1, 2);
  });
  it('returns > 3 for a typical blue', () => {
    expect(contrastAgainstWhite('#2563eb')).toBeGreaterThan(3);
  });
  it('returns < 3 for a very light yellow', () => {
    expect(contrastAgainstWhite('#ffff99')).toBeLessThan(3);
  });
});

describe('assertUsablePrimary', () => {
  it('passes for dark blue', () => {
    expect(() => assertUsablePrimary('#2563eb')).not.toThrow();
  });
  it('throws for very light colors', () => {
    expect(() => assertUsablePrimary('#ffff99')).toThrow(/contrast/i);
  });
});

describe('assertValidHexOrNull', () => {
  it('accepts null', () => {
    expect(() => assertValidHexOrNull(null, 'background_light')).not.toThrow();
  });
  it('accepts a valid hex', () => {
    expect(() => assertValidHexOrNull('#1a1a1f', 'background_dark')).not.toThrow();
  });
  it('throws for an invalid hex', () => {
    expect(() => assertValidHexOrNull('not-a-color', 'sidebar_light')).toThrow(/hex color/i);
  });
  it('throws for undefined (not the same as null)', () => {
    // Treat undefined as a missing field — the DTO must explicitly send null to clear.
    expect(() => assertValidHexOrNull(undefined as unknown as null, 'sidebar_dark')).toThrow();
  });
});

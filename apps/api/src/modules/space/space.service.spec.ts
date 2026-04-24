import { isValidSpaceParent } from '@prequest/shared';

describe('isValidSpaceParent (shared taxonomy)', () => {
  it('allows site at the root', () => {
    expect(isValidSpaceParent(null, 'site')).toBe(true);
  });

  it('rejects site under any parent', () => {
    expect(isValidSpaceParent('building', 'site')).toBe(false);
  });

  it('allows wing under building', () => {
    expect(isValidSpaceParent('building', 'wing')).toBe(true);
  });

  it('rejects wing under site (wings live inside buildings)', () => {
    expect(isValidSpaceParent('site', 'wing')).toBe(false);
  });

  it('allows desk under room only', () => {
    expect(isValidSpaceParent('room', 'desk')).toBe(true);
    expect(isValidSpaceParent('floor', 'desk')).toBe(false);
  });
});

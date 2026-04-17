import { sanitizeSvg } from './svg-sanitizer';

describe('sanitizeSvg', () => {
  it('strips <script> tags', () => {
    const dirty = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle r="5"/></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toMatch(/<script/i);
    expect(clean).toMatch(/<circle/);
  });

  it('strips any on* event handler (allowlist approach)', () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg">
      <rect onclick="a()" onmouseout="b()" onkeydown="c()" ontouchstart="d()" width="10" height="10"/>
    </svg>`;
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toMatch(/on\w+\s*=/i);
    expect(clean).toMatch(/<rect/);
  });

  it('strips external hrefs but keeps fragment refs', () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg"><image href="http://evil.example/x.png"/><use href="#icon"/></svg>`;
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toMatch(/evil\.example/);
    expect(clean).toMatch(/href="#icon"/);
  });

  it('strips foreignObject', () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>bad</div></foreignObject></svg>`;
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toMatch(/<foreignObject/i);
    expect(clean).not.toMatch(/<div/i);
  });

  it('keeps basic shapes and styling', () => {
    const dirty = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#2563eb"/></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).toMatch(/<circle/);
    expect(clean).toMatch(/fill="#2563eb"/);
  });

  it('preserves filter primitives', () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg">
      <defs><filter id="blur"><feGaussianBlur stdDeviation="2"/></filter></defs>
      <rect filter="url(#blur)" width="10" height="10"/>
    </svg>`;
    const clean = sanitizeSvg(dirty);
    expect(clean).toMatch(/<feGaussianBlur/);
    expect(clean).toMatch(/filter="url\(#blur\)"/);
  });

  it('throws when the input is not valid SVG', () => {
    expect(() => sanitizeSvg('not svg at all')).toThrow(/svg/i);
  });
});

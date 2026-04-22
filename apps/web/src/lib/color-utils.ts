// Hex → oklch() conversion + WCAG-based foreground picker.
// Tiny and dependency-free. See https://bottosson.github.io/posts/oklab/ for the math.

function srgbToLinear(c: number): number {
  const n = c / 255;
  return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
}

function linearSrgbToOklab(r: number, g: number, b: number): [number, number, number] {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ];
}

export function hexToOklch(hex: string): string {
  const r = srgbToLinear(parseInt(hex.slice(1, 3), 16));
  const g = srgbToLinear(parseInt(hex.slice(3, 5), 16));
  const b = srgbToLinear(parseInt(hex.slice(5, 7), 16));
  const [L, a, bb] = linearSrgbToOklab(r, g, b);
  const C = Math.sqrt(a * a + bb * bb);
  let h = (Math.atan2(bb, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return `oklch(${L.toFixed(4)} ${C.toFixed(4)} ${h.toFixed(2)})`;
}

export function relativeLuminance(hex: string): number {
  const to = (c: number) => {
    const n = c / 255;
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  };
  return (
    0.2126 * to(parseInt(hex.slice(1, 3), 16)) +
    0.7152 * to(parseInt(hex.slice(3, 5), 16)) +
    0.0722 * to(parseInt(hex.slice(5, 7), 16))
  );
}

export function pickForeground(bgHex: string): string {
  return relativeLuminance(bgHex) > 0.5 ? 'oklch(0.145 0 0)' : 'oklch(0.985 0 0)';
}

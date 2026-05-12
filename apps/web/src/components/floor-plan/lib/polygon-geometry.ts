import type { Point } from '../../../api/floor-plans/types';

/** Returns true when every point is a finite {x,y}. Degenerate inputs return false. */
export function isValidPolygon(points: unknown): points is Point[] {
  if (!Array.isArray(points)) return false;
  for (const p of points) {
    if (
      !p || typeof p !== 'object' ||
      typeof (p as Point).x !== 'number' || !Number.isFinite((p as Point).x) ||
      typeof (p as Point).y !== 'number' || !Number.isFinite((p as Point).y)
    ) return false;
  }
  return true;
}

export function polygonArea(points: Point[]): number {
  if (!points || points.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area / 2);
}

export function polygonCentroid(points: Point[]): Point {
  // Degenerate inputs (empty, < 3 points, collinear, duplicates → zero signed
  // area) would produce NaN through the standard formula. Fall back safely.
  if (!points || points.length === 0) return { x: 0, y: 0 };
  if (points.length < 3) return { x: points[0].x, y: points[0].y };

  let x = 0, y = 0, twiceArea = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const cross = a.x * b.y - b.x * a.y;
    twiceArea += cross;
    x += (a.x + b.x) * cross;
    y += (a.y + b.y) * cross;
  }
  if (twiceArea === 0) {
    // Collinear or duplicate vertices — average the points instead of dividing by zero.
    const sx = points.reduce((s, p) => s + p.x, 0);
    const sy = points.reduce((s, p) => s + p.y, 0);
    return { x: sx / points.length, y: sy / points.length };
  }
  const factor = 1 / (3 * twiceArea);
  return { x: x * factor, y: y * factor };
}

export function polygonToSvgPath(points: Point[]): string {
  if (!points || !points.length) return '';
  return `M ${points[0].x} ${points[0].y} ` +
    points.slice(1).map((p) => `L ${p.x} ${p.y}`).join(' ') + ' Z';
}

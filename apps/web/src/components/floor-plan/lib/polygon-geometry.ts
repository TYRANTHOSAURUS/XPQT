import type { Point } from '../../../api/floor-plans/types';

export function polygonArea(points: Point[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area / 2);
}

export function polygonCentroid(points: Point[]): Point {
  let x = 0, y = 0, twiceArea = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const cross = a.x * b.y - b.x * a.y;
    twiceArea += cross;
    x += (a.x + b.x) * cross;
    y += (a.y + b.y) * cross;
  }
  const factor = 1 / (3 * twiceArea);
  return { x: x * factor, y: y * factor };
}

export function polygonToSvgPath(points: Point[]): string {
  if (!points.length) return '';
  return `M ${points[0].x} ${points[0].y} ` +
    points.slice(1).map((p) => `L ${p.x} ${p.y}`).join(' ') + ' Z';
}

import type { Point, Polygon } from '@/api/floor-plans/types';

const GRID = 10;
const SNAP_GRID = 4;
const SNAP_VERTEX = 8;

export function snap(point: Point, polygons: Polygon[]): Point {
  // 1. Snap to existing vertex within 8px
  for (const poly of polygons) {
    for (const v of poly.points) {
      if (Math.hypot(v.x - point.x, v.y - point.y) <= SNAP_VERTEX) {
        return { x: v.x, y: v.y };
      }
    }
  }
  // 2. Snap to 10px grid if within 4px of a grid point
  const gx = Math.round(point.x / GRID) * GRID;
  const gy = Math.round(point.y / GRID) * GRID;
  if (Math.abs(gx - point.x) <= SNAP_GRID && Math.abs(gy - point.y) <= SNAP_GRID) {
    return { x: gx, y: gy };
  }
  return point;
}

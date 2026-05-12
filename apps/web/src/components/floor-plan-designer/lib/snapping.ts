// Stub for B.11 — real snapping implementation lands in a later task.
import type { Point, Polygon } from '@/api/floor-plans/types';

export function snap(point: Point, _polygons: Polygon[]): Point {
  return point;
}

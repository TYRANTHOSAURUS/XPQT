import { describe, it, expect } from 'vitest';
import { polygonArea, polygonCentroid, polygonToSvgPath } from '../lib/polygon-geometry';

describe('polygon geometry', () => {
  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  it('area of 10x10 square is 100', () => expect(polygonArea(square)).toBe(100));
  it('centroid of square is (5,5)', () => {
    const c = polygonCentroid(square);
    expect(c.x).toBeCloseTo(5); expect(c.y).toBeCloseTo(5);
  });
  it('svg path closes', () => expect(polygonToSvgPath(square)).toBe('M 0 0 L 10 0 L 10 10 L 0 10 Z'));
});

/**
 * F.3 — Perf budget smoke gate.
 *
 * JSDOM render budget is a smoke gate — real perf measurement is manual via Chrome DevTools Profiler.
 * This test catches severe regressions (e.g. O(n²) sort, synchronous layout thrash on mount).
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { FloorPlanCanvas } from '../floor-plan-canvas';
import type { PublishedFloorPlan } from '@/api/floor-plans/types';

describe('FloorPlanCanvas perf', () => {
  it('renders 500 polygons in under 400ms', () => {
    const plan: PublishedFloorPlan = {
      floor: { space_id: 'f', image_url: '', width_px: 2000, height_px: 2000, labels: [] },
      spaces: Array.from({ length: 500 }, (_, i) => ({
        id: `s-${i}`,
        name: `Desk ${i}`,
        type: 'desk',
        capacity: 1,
        amenities: [],
        floor_plan_polygon: {
          points: [
            { x: (i % 25) * 80, y: Math.floor(i / 25) * 80 },
            { x: (i % 25) * 80 + 60, y: Math.floor(i / 25) * 80 },
            { x: (i % 25) * 80 + 60, y: Math.floor(i / 25) * 80 + 40 },
            { x: (i % 25) * 80, y: Math.floor(i / 25) * 80 + 40 },
          ],
        },
        floor_plan_render_hint: 'default',
      })),
    };
    const t0 = performance.now();
    render(<FloorPlanCanvas plan={plan} />);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(400);
  });
});

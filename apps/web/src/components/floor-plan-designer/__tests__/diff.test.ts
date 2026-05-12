import { describe, it, expect } from 'vitest';
import { computePublishDiff } from '../lib/diff';
import type { PublishedFloorPlan } from '../../../api/floor-plans/types';

const pt3 = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }];
const pt3b = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }];

function makePublished(spaces: Array<{ id: string; name: string; points: typeof pt3; render_hint?: 'default' | 'seat' | 'parking' }>): PublishedFloorPlan {
  return {
    floor: { space_id: 'floor-1', image_url: 'https://example.com/img.png', width_px: 1000, height_px: 800, labels: [] },
    spaces: spaces.map((s) => ({
      id: s.id,
      name: s.name,
      type: 'room',
      capacity: null,
      amenities: [],
      floor_plan_polygon: { points: s.points },
      floor_plan_render_hint: s.render_hint ?? 'default',
    })),
  };
}

describe('computePublishDiff', () => {
  it('detects added polygons', () => {
    const d = computePublishDiff(
      [{ space_id: 'a', points: pt3 }],
      null,
      null,
    );
    expect(d.added).toHaveLength(1);
    expect(d.added[0].space_id).toBe('a');
    expect(d.removed).toHaveLength(0);
    expect(d.modified).toHaveLength(0);
  });

  it('ignores polygons without a space_id (unlinked drafts)', () => {
    const d = computePublishDiff(
      [{ space_id: '', points: pt3 }],
      null,
      null,
    );
    expect(d.added).toHaveLength(0);
    expect(d.removed).toHaveLength(0);
  });

  it('detects removed polygons', () => {
    const published = makePublished([{ id: 'b', name: 'Room B', points: pt3 }]);
    const d = computePublishDiff([], null, published);
    expect(d.removed).toHaveLength(1);
    expect(d.removed[0].space_id).toBe('b');
    expect(d.removed[0].name).toBe('Room B');
    expect(d.added).toHaveLength(0);
  });

  it('detects modified polygons (points changed)', () => {
    const published = makePublished([{ id: 'c', name: 'Room C', points: pt3 }]);
    const d = computePublishDiff(
      [{ space_id: 'c', points: pt3b }],
      null,
      published,
    );
    expect(d.modified).toHaveLength(1);
    expect(d.modified[0].space_id).toBe('c');
    expect(d.added).toHaveLength(0);
    expect(d.removed).toHaveLength(0);
  });

  it('detects imageChanged when draft image differs from published', () => {
    const published = makePublished([]);
    const d = computePublishDiff([], 'https://example.com/new.png', published);
    expect(d.imageChanged).toBe(true);
  });

  it('no-op: identical draft and published produces empty diff', () => {
    const published = makePublished([{ id: 'd', name: 'Room D', points: pt3, render_hint: 'default' }]);
    const d = computePublishDiff(
      [{ space_id: 'd', points: pt3, render_hint: 'default' }],
      'https://example.com/img.png',
      published,
    );
    expect(d.added).toHaveLength(0);
    expect(d.removed).toHaveLength(0);
    expect(d.modified).toHaveLength(0);
    expect(d.imageChanged).toBe(false);
  });
});

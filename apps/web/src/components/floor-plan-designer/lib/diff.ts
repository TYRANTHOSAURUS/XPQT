import type { Polygon, PublishedFloorPlan } from '../../../api/floor-plans/types';

export type PublishDiff = {
  added: Polygon[];
  removed: { space_id: string; name: string }[];
  modified: { space_id: string; before: Polygon; after: Polygon }[];
  imageChanged: boolean;
};

export function computePublishDiff(
  draftPolygons: Polygon[],
  draftImageUrl: string | null,
  published: PublishedFloorPlan | null,
): PublishDiff {
  const publishedPolygons: Polygon[] = (published?.spaces ?? []).map((s) => ({
    space_id: s.id,
    points: s.floor_plan_polygon.points,
    render_hint: s.floor_plan_render_hint,
  }));
  // Filter out unlinked draft polygons (empty space_id — publish rejects them)
  const draftMap = new Map(draftPolygons.filter((p) => p.space_id).map((p) => [p.space_id, p]));
  const publishedMap = new Map(publishedPolygons.map((p) => [p.space_id, p]));

  const added: Polygon[] = [];
  const modified: PublishDiff['modified'] = [];
  for (const [id, draft] of draftMap) {
    const before = publishedMap.get(id);
    if (!before) { added.push(draft); continue; }
    if (
      JSON.stringify(before.points) !== JSON.stringify(draft.points) ||
      before.render_hint !== draft.render_hint
    ) {
      modified.push({ space_id: id, before, after: draft });
    }
  }
  const removed: PublishDiff['removed'] = [];
  for (const [id] of publishedMap) {
    if (!draftMap.has(id)) {
      const sp = published?.spaces.find((s) => s.id === id);
      removed.push({ space_id: id, name: sp?.name ?? '(unknown)' });
    }
  }
  return {
    added, removed, modified,
    imageChanged: draftImageUrl !== (published?.floor.image_url ?? null),
  };
}

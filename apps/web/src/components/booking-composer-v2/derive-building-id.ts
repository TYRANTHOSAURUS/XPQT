import type { Space } from '@/api/spaces';

/**
 * Walk a Space up to its enclosing building. Used by the booking
 * composer's visitors flush + visitors-row defaults — visitor
 * invitations need a `building_id` but the composer only knows the
 * room. Reception's today view filters on exact `building_id`
 * equality, so a building wins over a site (the closest building in
 * the chain, not the closest ancestor).
 *
 * Edge case: if no building exists in the chain (rare), fall back to
 * the closest site so the visitor at least has SOME location anchor.
 *
 * Returns "" when nothing resolves so callers can disambiguate
 * "anchor not yet known" from "deliberately empty" with a single
 * truthy check.
 */
export function deriveBuildingId(
  spaces: Space[] | undefined,
  spaceId: string | null,
): string {
  if (!spaceId || !spaces) return '';
  const byId = new Map(spaces.map((s) => [s.id, s]));
  let cursor: Space | undefined = byId.get(spaceId);
  let fallbackSiteId = '';
  let depth = 0;
  while (cursor && depth < 10) {
    if (cursor.type === 'building') return cursor.id;
    if (cursor.type === 'site' && !fallbackSiteId) fallbackSiteId = cursor.id;
    if (!cursor.parent_id) break;
    cursor = byId.get(cursor.parent_id);
    depth += 1;
  }
  return fallbackSiteId;
}

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
/** Max ancestor walk before declaring a cycle / pathological depth. */
const MAX_DEPTH = 10;

export function deriveBuildingId(
  spaces: Space[] | undefined,
  spaceId: string | null,
): string {
  if (!spaceId || !spaces) return '';
  const byId = new Map(spaces.map((s) => [s.id, s]));
  let cursor: Space | undefined = byId.get(spaceId);
  // Missing-from-tree: spaceId was set but the spaces list doesn't
  // contain it. The most common cause is racing between the modal
  // mounting (with a pre-seeded spaceId) and the spaces query
  // resolving. Returning "" without warning lets the caller resolve
  // on the next render once spaces lands. Codex remediation — the
  // prior dev warn fired on every render during the load window,
  // which dominated dev console output for any modal open.
  if (!cursor) return '';
  let fallbackSiteId = '';
  let depth = 0;
  while (cursor && depth < MAX_DEPTH) {
    if (cursor.type === 'building') return cursor.id;
    if (cursor.type === 'site' && !fallbackSiteId) fallbackSiteId = cursor.id;
    if (!cursor.parent_id) break;
    cursor = byId.get(cursor.parent_id);
    depth += 1;
  }
  // /full-review v4 I2 — surface depth-10 truncation in dev.
  // The defensive cap stops infinite loops from corrupted parent_id
  // chains, but silently dropping back to the fallback (or "") hid
  // tree-corruption bugs from view. Logging in dev gives ops a signal
  // when a customer's space tree gets into a bad shape; production
  // stays silent so we don't spam logs over recoverable cases.
  if (depth === MAX_DEPTH && import.meta.env.DEV) {
    console.warn(
      `[deriveBuildingId] hit depth-${MAX_DEPTH} cap walking ancestors of space "${spaceId}" — likely a cycle in spaces.parent_id. Falling back to "${fallbackSiteId || ''}".`,
    );
  }
  return fallbackSiteId;
}

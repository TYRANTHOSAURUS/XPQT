/**
 * Display-time helpers for `Space` records that don't fit on the type itself.
 *
 * Kept separate from `queries.ts` / `mutations.ts` so callers that only need
 * a label string don't pull a React Query hook into their bundle, and so the
 * format rules live one level above any individual surface (the building
 * picker, the location breadcrumb, etc. all reach for the same helpers).
 */
import type { Space } from './types';

/**
 * Resolve a sub-label for a building/site. We don't have a structured
 * `address` field on `spaces`, so we fall back through the most useful
 * context the data model gives us:
 *
 *   1. `attributes.address` (free-form jsonb attribute, if the tenant set it)
 *   2. `attributes.street` (alternate key some tenants use)
 *   3. Parent space name (e.g. "Amsterdam Campus" for a building under it)
 *   4. The building's code (e.g. "AMS-HQ")
 *   5. The space type label ("Building" / "Site")
 *
 * The parent-space lookup needs the full `spaces` list; we accept it as
 * an arg so the caller can pass `null` while the list is still loading.
 * Returning `null` in that window prevents the sub-line from flipping
 * from `code` → parent name once spaces resolve, which would re-shape
 * the trigger height mid-render.
 *
 * Concretely answers "where is this in the world" without requiring a
 * schema change. When backends grow a real address column, swap step 1.
 */
export function resolveSpaceSubline(
  space: Space,
  allSpaces: Space[] | null,
): string | null {
  const attrs = space.attributes as
    | { address?: string; street?: string }
    | null
    | undefined;
  if (attrs?.address) return attrs.address;
  if (attrs?.street) return attrs.street;
  // Lazy parent lookup — only scans `allSpaces` when we actually need
  // the parent. With at most ~N buildings rendered, this is N lookups
  // over a list of size M, vs. building an M-entry Map up-front for
  // every render. M can be 1k–10k tenant-wide; N is typically <10.
  if (space.parent_id) {
    if (!allSpaces) return null;
    const parent = allSpaces.find((s) => s.id === space.parent_id);
    if (parent) return parent.name;
  }
  if (space.code) return space.code;
  return space.type === 'site' ? 'Site' : 'Building';
}

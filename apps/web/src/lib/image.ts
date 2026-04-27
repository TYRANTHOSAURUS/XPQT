/**
 * Helpers for rendering Supabase Storage images at a target size.
 *
 * Supabase exposes two URL shapes for a public file:
 *   /storage/v1/object/public/<bucket>/<path>   — the original bytes.
 *   /storage/v1/render/image/public/<bucket>/<path>?width=…&resize=…
 *      — an on-the-fly resized variant served from the CDN.
 *
 * We only ever ship resized variants to the UI: a small thumbnail for
 * dense lists (rows, pickers) and a larger preview for modals. The CDN
 * caches each (path, width) pair, so repeat hits are free.
 *
 * Non-Supabase URLs (external CDN, S3 direct, data URLs) pass through —
 * the browser still benefits from `loading="lazy"` + explicit width/height
 * on the `<img>` tag, but we don't manufacture transform params they
 * wouldn't understand.
 */

const PUBLIC_OBJECT_PREFIX = '/storage/v1/object/public/';
const RENDER_IMAGE_PREFIX = '/storage/v1/render/image/public/';

function isSupabasePublic(url: string): boolean {
  return url.includes(PUBLIC_OBJECT_PREFIX);
}

function withParams(url: string, params: Record<string, string | number>): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/**
 * Square thumbnail (cover-cropped). Use for row avatars / list cells.
 *
 * `size` is the *displayed* CSS pixel size — this helper requests 2× to
 * stay sharp on retina without doubling 1× users' bandwidth (the CDN
 * caches each requested width independently, so 1× and 2× are separate
 * cache keys, but a 2× image scaled down to 1× looks fine and avoids a
 * second network round-trip when DPR changes).
 */
export function spaceImageThumbnail(url: string | null, size: number): string | null {
  if (!url) return null;
  if (!isSupabasePublic(url)) return url;
  const transformed = url.replace(PUBLIC_OBJECT_PREFIX, RENDER_IMAGE_PREFIX);
  const target = Math.round(size * 2);
  return withParams(transformed, {
    width: target,
    height: target,
    resize: 'cover',
    quality: 75,
  });
}

/**
 * Wide preview (contain-fitted to a max width). Use for the room detail
 * modal's hero. Don't preload — only request when the modal mounts.
 */
export function spaceImagePreview(url: string | null, maxWidth: number): string | null {
  if (!url) return null;
  if (!isSupabasePublic(url)) return url;
  const transformed = url.replace(PUBLIC_OBJECT_PREFIX, RENDER_IMAGE_PREFIX);
  return withParams(transformed, {
    width: maxWidth,
    resize: 'contain',
    quality: 85,
  });
}

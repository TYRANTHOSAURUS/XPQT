/**
 * Rewrite hardcoded `https://<project>.supabase.co/...` URLs to use whichever
 * Supabase host is configured for the current environment via
 * `VITE_SUPABASE_URL`.
 *
 * Why this exists: some DB columns store *absolute* storage URLs verbatim
 * (e.g. `service_catalog_categories.cover_image_url`,
 * `portal_appearance.hero_image_url`, `catalog_items.image_url`,
 * `persons.avatar_url`, branding logo URLs). The browser renders them through
 * `<img src=…>` / `background-image: url(…)`, which bypasses the supabase-js
 * client config and hits the literal hostname.
 *
 * In normal operation (`VITE_SUPABASE_URL` is the project's own Supabase URL)
 * this helper is a no-op. In proxy mode — where `VITE_SUPABASE_URL` points at
 * a Cloudflare Worker reverse-proxy because the Supabase HTTPS gateway is
 * blocked on the current network (commercial-VPN exits, certain ISP paths) —
 * it rewrites stored URLs so they flow through the same proxy as supabase-js.
 *
 * Where to apply this:
 *   1. **Choke points first** — if a piece of data flows through a shared
 *      helper / hook / component, wrap it there ONCE. This module is
 *      already applied automatically inside:
 *         - `lib/image.ts` (space image helpers)
 *         - `hooks/use-branding.tsx` (logo / hero URLs returned by the hook)
 *         - `components/person-avatar.tsx` (avatar surface)
 *   2. **Leaf-wrap** raw URLs that don't pass through any of the above
 *      (e.g. one-off admin previews, SVG `<image href>`).
 *   3. **Never** apply server-side (Node) — emails / notifications go to
 *      arbitrary networks and should keep the canonical Supabase host.
 *
 * Convention: any new code that renders a stored Supabase URL in the browser
 * must use one of the choke-point helpers above, OR wrap with this function
 * directly. Adding raw `<img src={row.image_url}>` for a stored absolute URL
 * is a regression that breaks under proxy mode.
 *
 * See `docs/vpn-supabase-proxy-bypass.md` for the full architecture context.
 */
const TARGET_ORIGIN: string | null = (() => {
  const raw = import.meta.env.VITE_SUPABASE_URL;
  if (!raw) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.warn(
        '[rewriteSupabaseUrl] VITE_SUPABASE_URL is empty; helper is a no-op. ' +
          'Stored absolute Supabase URLs may not load under proxy mode.',
      );
    }
    return null;
  }
  try {
    return new URL(raw).origin;
  } catch {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.warn(
        `[rewriteSupabaseUrl] VITE_SUPABASE_URL is malformed (${raw}); ` +
          'helper is a no-op. Stored absolute Supabase URLs will not be rewritten.',
      );
    }
    return null;
  }
})();

const SUPABASE_ORIGIN_RE = /https?:\/\/[a-z0-9-]+\.supabase\.co/gi;

/**
 * Overload: `string` → `string`, nullish → `undefined`. Lets TypeScript keep
 * call-site types tight (no surprise `string | undefined` widening when the
 * caller knows the input is a real string).
 */
export function rewriteSupabaseUrl(url: string): string;
export function rewriteSupabaseUrl(url: null | undefined): undefined;
export function rewriteSupabaseUrl(url: string | null | undefined): string | undefined;
export function rewriteSupabaseUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  if (!TARGET_ORIGIN) return url;
  return url.replace(SUPABASE_ORIGIN_RE, TARGET_ORIGIN);
}

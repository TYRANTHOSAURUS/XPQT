/**
 * Surface-aware deeplink picker for inbox notification payloads.
 *
 * The same notification row is delivered to both desk operators and
 * portal users, so payloads carry two CTA URLs:
 *
 *   - `approvalCtaUrl` — points into `/desk/…` (legacy; primary email CTA).
 *   - `portalUrl`      — points into `/portal/…` (added 2026-06).
 *
 * The right one to render depends on which shell the recipient is
 * looking at:
 *
 *   - On `/portal/…` pathnames: prefer `portalUrl`. If absent (older
 *     queued/cached payloads), rewrite the leading `/desk/…` prefix to
 *     the portal-equivalent path as a defensive fallback so the link
 *     doesn't 404 a portal-only user into the desk app.
 *   - On `/desk/…` pathnames (or anywhere else): prefer `approvalCtaUrl`
 *     untouched.
 *
 * Always returns a same-origin path (or null). External URLs are rejected
 * to keep the inbox immune to a payload that smuggles an off-origin link.
 */

interface CtaUrlContext {
  /** Current pathname — typically `window.location.pathname`. */
  pathname: string;
}

export function pickInboxCtaUrl(
  payload: Record<string, unknown>,
  ctx: CtaUrlContext,
): string | null {
  const onPortal = ctx.pathname.startsWith('/portal/');

  if (onPortal) {
    const portal = normalizeSameOrigin(payload.portalUrl);
    if (portal) return portal;
    const desk = normalizeSameOrigin(payload.approvalCtaUrl);
    if (desk) return rewriteDeskToPortal(desk);
    return null;
  }

  const desk = normalizeSameOrigin(payload.approvalCtaUrl);
  if (desk) return desk;
  // Desk shell rendering a portal-only payload — fall through to the
  // portal URL rather than showing a dead row.
  return normalizeSameOrigin(payload.portalUrl);
}

function normalizeSameOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.startsWith('/')) return value;
  try {
    const parsed = new URL(value, window.location.origin);
    if (parsed.origin === window.location.origin) {
      return parsed.pathname + parsed.search + parsed.hash;
    }
  } catch {
    /* invalid URL — fall through */
  }
  return null;
}

/**
 * Map a desk path to the portal equivalent for the two entity surfaces
 * the booking-approval handler emits today. Anything unrecognized falls
 * back to a generic `/portal/me/inbox` so the user lands somewhere
 * sensible rather than the desk app they can't access.
 */
function rewriteDeskToPortal(deskPath: string): string {
  // /desk/bookings/<id>?tab=approval → /portal/me/bookings/<id>
  const booking = deskPath.match(/^\/desk\/bookings\/([^/?#]+)/);
  if (booking) return `/portal/me/bookings/${booking[1]}`;
  // /desk/tickets/<id> → /portal/requests/<id>
  const ticket = deskPath.match(/^\/desk\/tickets\/([^/?#]+)/);
  if (ticket) return `/portal/requests/${ticket[1]}`;
  return '/portal/me/inbox';
}

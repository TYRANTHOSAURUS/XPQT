/**
 * Marker function — throws an error in a way React's class-component error
 * boundary catches it. Used by `usePageQuery` to escalate page-class query
 * errors to `RouteErrorBoundary` so the page replaces instead of toasting
 * over stale content (spec §3.4 / §3.5).
 *
 * The actual escalation magic lives in `usePageQuery` — this is the named
 * funnel so call sites are greppable.
 */
export function throwToBoundary(error: unknown): never {
  throw error;
}

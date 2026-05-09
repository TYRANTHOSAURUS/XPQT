/**
 * usePageQuery — like `useQuery`, but throws page-class errors
 * (`not_found` / `permission` / `server` / `unknown`) to `RouteErrorBoundary`
 * so the page replaces instead of toasting over stale content.
 *
 * Transient classes (`transport`, `rate_limit`, `conflict`) flow through
 * the regular query layer — the page can render its own retry surface or
 * a sibling toast.
 *
 * Spec: docs/superpowers/specs/2026-05-02-error-handling-system-design.md §3.5
 *
 * Usage:
 *
 * ```tsx
 * const { data, isLoading } = usePageQuery(costCenterDetailOptions(id));
 * ```
 *
 * Sidebar / autocomplete queries should keep using `useQuery` + a
 * `handleQueryError` call from a `useEffect`.
 *
 * Implementation note: we classify ONCE per error instance and stash the
 * result on a non-enumerable property so React's class-component error
 * boundary (which re-runs `getDerivedStateFromError`) can consume the same
 * object instead of re-classifying on every render / retry / refocus.
 */

import {
  useQuery,
  type DefinedUseQueryResult,
  type UseQueryOptions,
  type UseQueryResult,
} from '@tanstack/react-query';
import { classify, type ClassifiedError } from './classify';
import { throwToBoundary } from './throw-to-boundary';

const PAGE_CLASSES = new Set(['not_found', 'permission', 'server', 'unknown']);

/** Hidden symbol for the cached classification — not exported on purpose. */
export const STASHED_CLASSIFIED = Symbol.for('prequest.classified');

export function usePageQuery<TQueryFnData, TError = unknown, TData = TQueryFnData>(
  options: UseQueryOptions<TQueryFnData, TError, TData>,
): UseQueryResult<TData, TError> | DefinedUseQueryResult<TData, TError> {
  const result = useQuery(options);
  if (result.isError) {
    const err = result.error as object & { [STASHED_CLASSIFIED]?: ClassifiedError };
    let classified = err && typeof err === 'object' ? err[STASHED_CLASSIFIED] : undefined;
    if (!classified) {
      classified = classify(result.error, { callSite: 'route_load' });
      // Stash on the error so the error boundary's getDerivedStateFromError
      // re-uses the same classification rather than running classify() again
      // on every render. Non-enumerable so it doesn't leak into JSON / logs.
      if (err && typeof err === 'object') {
        try {
          Object.defineProperty(err, STASHED_CLASSIFIED, {
            value: classified,
            enumerable: false,
            configurable: true,
            writable: true,
          });
        } catch {
          // Frozen errors (rare) — classification still works, we just pay
          // the cost again on the boundary's first render.
        }
      }
    }
    if (PAGE_CLASSES.has(classified.class)) {
      throwToBoundary(result.error);
    }
  }
  return result;
}

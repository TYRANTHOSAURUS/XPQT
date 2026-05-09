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
 */

import {
  useQuery,
  type DefinedUseQueryResult,
  type UseQueryOptions,
  type UseQueryResult,
} from '@tanstack/react-query';
import { classify } from './classify';
import { throwToBoundary } from './throw-to-boundary';

const PAGE_CLASSES = new Set(['not_found', 'permission', 'server', 'unknown']);

export function usePageQuery<TQueryFnData, TError = unknown, TData = TQueryFnData>(
  options: UseQueryOptions<TQueryFnData, TError, TData>,
): UseQueryResult<TData, TError> | DefinedUseQueryResult<TData, TError> {
  const result = useQuery(options);
  if (result.isError) {
    const classified = classify(result.error, { callSite: 'route_load' });
    if (PAGE_CLASSES.has(classified.class)) {
      throwToBoundary(result.error);
    }
  }
  return result;
}

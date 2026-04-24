import { QueryClient, QueryCache, MutationCache } from '@tanstack/react-query';
import { ApiError } from './api';

/**
 * App-wide query client. One instance, created at module scope, shared by every
 * `QueryClientProvider` consumer. Do not construct new clients inside components.
 *
 * Defaults tuned for the desk: multi-agent, long-lived tabs, background refetch
 * on focus is desirable. Per-query `staleTime` overrides happen in each module's
 * `queryOptions` factory — see `docs/react-query-guidelines.md` §7.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: true,
      retry: (failureCount, error) => {
        if (error instanceof ApiError) {
          if (error.isNetworkError()) return failureCount < 2;
          // Client errors (4xx) are never retried — they won't resolve by retrying.
          if (error.isClientError()) return false;
          // Server errors (5xx) — retry twice.
          return failureCount < 2;
        }
        return failureCount < 2;
      },
    },
    mutations: {
      retry: false,
    },
  },

  queryCache: new QueryCache({
    onError: (error) => {
      if (error instanceof ApiError && error.status === 401) {
        // 401 from any query means the JWT expired. The AuthProvider listens
        // for Supabase session changes and will redirect; no action needed here
        // beyond logging. Avoid forcing a redirect inside a cache callback —
        // it can fire mid-render.
        console.warn('[query] 401 — session likely expired');
      }
    },
  }),

  mutationCache: new MutationCache({
    onError: (error) => {
      if (error instanceof ApiError && error.status === 401) {
        console.warn('[mutation] 401 — session likely expired');
      }
    },
  }),
});

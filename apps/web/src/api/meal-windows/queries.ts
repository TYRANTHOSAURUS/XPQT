import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { mealWindowKeys } from './keys';
import type { MealWindow } from './types';

/**
 * Tenant meal windows. Fetched once per session (long staleTime) — the
 * create-booking modal calls `useMealWindows()` from `getSuggestions` to
 * decide whether to flag the catering add-in card with a "Suggested"
 * chip. Endpoint: GET /tenants/current/meal-windows. Drives nothing
 * user-visible by itself; pure config.
 */
export function mealWindowListOptions() {
  return queryOptions({
    queryKey: mealWindowKeys.list(),
    queryFn: ({ signal }) =>
      apiFetch<MealWindow[]>('/tenants/current/meal-windows', { signal }),
    // 30 minutes — admins editing meal windows is rare; the picker is
    // not real-time. Tab-focus revalidation handles the rest.
    staleTime: 30 * 60_000,
  });
}

export function useMealWindows() {
  return useQuery(mealWindowListOptions());
}

import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query';
import type { WorkOrderPlanningResponse } from '@prequest/shared';
import { apiFetch } from '@/lib/api';
import { workOrderPlanningKeys, type PlanningWindowFilters } from './keys';

/**
 * Planning-board window query. Reads `GET /work-orders/planning` and
 * returns the shared `WorkOrderPlanningResponse` shape (planned[] +
 * unscheduled[]).
 *
 * `staleTime: 15_000` — the desk drags blocks around and other operators
 * may be doing the same, so we refresh on remount/refocus inside 15s.
 * `keepPreviousData` so prev/next date nav doesn't flash to empty while
 * the next window resolves.
 */
export function workOrderPlanningWindowOptions(filters: PlanningWindowFilters) {
  return queryOptions({
    queryKey: workOrderPlanningKeys.window(filters),
    queryFn: ({ signal }) =>
      apiFetch<WorkOrderPlanningResponse>('/work-orders/planning', {
        signal,
        query: {
          from: filters.from,
          to: filters.to,
          // Repeated `status` params — `apiFetch` builds them via
          // `URLSearchParams.append` so the server reads an array.
          status: filters.status && filters.status.length > 0 ? filters.status : undefined,
          team_id: filters.teamId ?? undefined,
        },
      }),
    staleTime: 15_000,
    placeholderData: keepPreviousData,
    enabled: Boolean(filters.from && filters.to),
  });
}

export function useWorkOrderPlanning(filters: PlanningWindowFilters) {
  return useQuery(workOrderPlanningWindowOptions(filters));
}

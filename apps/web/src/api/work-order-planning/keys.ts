/**
 * Query-key factory for the planning-board read path
 * (`GET /work-orders/planning`). Separate from `ticketKeys` because the
 * response is a window of blocks (planned + unscheduled lanes) — a
 * different shape from the `tickets` list/detail responses, so it gets
 * its own cache namespace.
 *
 * See `docs/react-query-guidelines.md` §3. Hierarchy:
 *   all
 *     └─ windows → window(filters)
 */

/** Filter shape the page uses to drive the planning window query. */
export interface PlanningWindowFilters {
  /** ISO instant — inclusive lower bound of the window. */
  from: string;
  /** ISO instant — exclusive upper bound of the window. */
  to: string;
  /** status_category values to include. Empty / undefined = all. */
  status?: string[];
  /** Team UUID. null = no team filter. */
  teamId: string | null;
}

export const workOrderPlanningKeys = {
  all: ['work-order-planning'] as const,
  windows: () => [...workOrderPlanningKeys.all, 'window'] as const,
  window: (filters: PlanningWindowFilters) =>
    [...workOrderPlanningKeys.windows(), filters] as const,
} as const;

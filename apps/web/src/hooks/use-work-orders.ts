import { useMutation, useQuery, useQueryClient, queryOptions } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { ticketKeys } from '@/api/tickets';

export interface WorkOrderRow {
  id: string;
  title: string;
  status: string;
  status_category: string;
  priority: string;
  ticket_kind: 'case' | 'work_order';
  assigned_team_id: string | null;
  assigned_user_id: string | null;
  assigned_vendor_id: string | null;
  interaction_mode: string;
  created_at: string;
  resolved_at: string | null;
  sla_id: string | null;
  sla_resolution_due_at: string | null;
  sla_resolution_breached_at: string | null;
}

export interface DispatchDto {
  title: string;
  description?: string;
  assigned_team_id?: string;
  assigned_user_id?: string;
  assigned_vendor_id?: string;
  priority?: string;
  interaction_mode?: 'internal' | 'external';
  /**
   * Executor SLA. `undefined` falls through to vendor/team defaults server-side.
   * Explicit `null` is "No SLA" — the server skips timer creation.
   */
  sla_id?: string | null;
}

/**
 * Load work-order children of a parent case. Keyed under
 * `ticketKeys.children(parentId)` so it shares an invalidation subtree with
 * the parent ticket's detail — changes roll up cleanly.
 *
 * API surface matches the pre-RQ hook (`data`, `loading`, `error`, `refetch`)
 * so existing callers (`ticket-meta-row`, `sub-issues-section`,
 * `add-sub-issue-dialog`) don't need to change shape.
 */
export function useWorkOrders(parentId: string | null) {
  const qc = useQueryClient();
  const query = useQuery(queryOptions({
    queryKey: parentId ? ticketKeys.children(parentId) : ['tickets', 'children', 'disabled'] as const,
    queryFn: ({ signal }) => apiFetch<WorkOrderRow[]>(`/tickets/${parentId}/children`, { signal }),
    enabled: Boolean(parentId),
    staleTime: 10_000, // T1 — rolled up into parent status.
  }));

  return {
    data: query.data ?? [],
    loading: query.isPending && Boolean(parentId),
    error: query.error,
    refetch: () => {
      if (!parentId) return;
      qc.invalidateQueries({ queryKey: ticketKeys.children(parentId) });
    },
  };
}

/**
 * Dispatch a new work order under a parent case. Settlement invalidates both
 * the children list and the parent's detail — parent `status_category` rolls
 * up when the first child arrives (new → assigned), so the sidebar updates
 * without the caller having to invalidate manually.
 */
export function useDispatchWorkOrder(parentId: string) {
  const qc = useQueryClient();
  const mutation = useMutation<WorkOrderRow, Error, DispatchDto>({
    mutationFn: (dto) =>
      apiFetch<WorkOrderRow>(`/tickets/${parentId}/dispatch`, {
        method: 'POST',
        body: JSON.stringify(dto),
      }),
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ticketKeys.children(parentId) }),
        qc.invalidateQueries({ queryKey: ticketKeys.detail(parentId) }),
        qc.invalidateQueries({ queryKey: ticketKeys.lists() }),
      ]),
  });

  return {
    dispatch: mutation.mutateAsync,
    submitting: mutation.isPending,
    error: mutation.error,
  };
}

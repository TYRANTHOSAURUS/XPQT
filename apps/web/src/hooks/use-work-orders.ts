import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient, queryOptions } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { handleQueryError, withErrorHandling } from '@/lib/errors';
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
      // Audit-02 P1-5 FE-rollup (FOLD item-7): the nonce callers
      // (sub-issues-section refreshNonce ← ticket-detail onReclassified) only
      // refetch the visibility-filtered child LIST through this `refetch`.
      // Reclassify can reshape children → privileged done/total changes — so
      // the rollup feeding the ring/badge must refetch alongside the list,
      // else it stays stale until staleTime. Covers every nonce caller.
      qc.invalidateQueries({ queryKey: ticketKeys.childrenRollup(parentId) });
    },
  };
}

export interface WorkOrderRollup {
  done: number;
  total: number;
}

/**
 * Audit-02 P1-5 FE-rollup fix. The PRIVILEGED `{ done, total }` aggregate
 * over a parent case's child work_orders (`GET /tickets/:id/children/rollup`).
 *
 * This is the single source of truth for the desk progress ring/badge.
 * `useWorkOrders` (the child LIST) is `work_order_visibility_ids`-filtered
 * per P1-5 — computing progress from that array under-reports for a scoped
 * operator. The server-side rollup is parent-`read`-gated but NOT per-child
 * filtered, so the ratio is honest even when the operator can't see every
 * child. It returns ONLY counts — no hidden child identities/metadata.
 *
 * Keyed under `ticketKeys.childrenRollup(parentId)` (sibling of
 * `children(parentId)`) so it shares the parent-detail invalidation subtree.
 * Secondary data — `useQuery` + `handleQueryError`, NOT a page query.
 */
export function useWorkOrdersRollup(parentId: string | null) {
  const query = useQuery(queryOptions({
    queryKey: parentId
      ? ticketKeys.childrenRollup(parentId)
      : (['tickets', 'children-rollup', 'disabled'] as const),
    queryFn: ({ signal }) =>
      apiFetch<WorkOrderRollup>(`/tickets/${parentId}/children/rollup`, { signal }),
    enabled: Boolean(parentId),
    staleTime: 10_000, // T1 — rolled up into parent status, same as the list.
  }));

  useEffect(() => {
    if (query.error) {
      handleQueryError(query.error, {
        callSite: 'query',
        actionTitle: "Couldn't load sub-issue progress",
      });
    }
  }, [query.error]);

  return {
    data: query.data ?? null,
    loading: query.isPending && Boolean(parentId),
    error: query.error,
  };
}

/** Variables for `useDispatchWorkOrder` — the dispatch DTO + the
 *  producer-route requestId that the dispatch endpoint's guard requires. */
export interface DispatchWorkOrderVariables {
  payload: DispatchDto;
  requestId: string;
}

/**
 * Dispatch a new work order under a parent case. Settlement invalidates both
 * the children list and the parent's detail — parent `status_category` rolls
 * up when the first child arrives (new → assigned), so the sidebar updates
 * without the caller having to invalidate manually.
 *
 * Producer-route discipline (B.2.A I1, spec §3.9.1) — caller mints a fresh
 * uuid per attempt and threads it through `dispatch({ payload, requestId })`.
 */
export function useDispatchWorkOrder(parentId: string) {
  const qc = useQueryClient();
  const mutation = useMutation<WorkOrderRow, Error, DispatchWorkOrderVariables>({
    mutationFn: ({ payload, requestId }) =>
      apiFetch<WorkOrderRow>(`/tickets/${parentId}/dispatch`, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'X-Client-Request-Id': requestId },
      }),
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ticketKeys.children(parentId) }),
        // Audit-02 P1-5 FE-rollup: a new child changes `total`, so the
        // privileged rollup must refetch alongside the children list.
        qc.invalidateQueries({ queryKey: ticketKeys.childrenRollup(parentId) }),
        qc.invalidateQueries({ queryKey: ticketKeys.detail(parentId) }),
        qc.invalidateQueries({ queryKey: ticketKeys.lists() }),
      ]),
    ...withErrorHandling({ actionTitle: "Couldn't dispatch work order" }),
  });

  return {
    dispatch: mutation.mutateAsync,
    submitting: mutation.isPending,
    error: mutation.error,
  };
}

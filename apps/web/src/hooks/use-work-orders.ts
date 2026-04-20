import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';

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

export interface UseWorkOrdersResult {
  data: WorkOrderRow[];
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * Loads work-order children of a parent case.
 * Follows the project pattern: apiFetch + useState/useEffect + caller-driven refetch.
 */
export function useWorkOrders(parentId: string | null): UseWorkOrdersResult {
  const [data, setData] = useState<WorkOrderRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!parentId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<WorkOrderRow[]>(`/tickets/${parentId}/children`)
      .then((rows) => { if (!cancelled) setData(rows); })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e : new Error('Failed to load work orders'));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [parentId, nonce]);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, refetch };
}

export interface UseDispatchWorkOrderResult {
  dispatch: (dto: DispatchDto) => Promise<WorkOrderRow>;
  submitting: boolean;
  error: Error | null;
}

/**
 * Dispatches a new work order under the parent case. Caller is responsible for
 * calling refetch() on both the work-orders list and the parent ticket after success,
 * since the parent's status_category may have rolled up.
 */
export function useDispatchWorkOrder(parentId: string): UseDispatchWorkOrderResult {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const dispatch = useCallback(async (dto: DispatchDto) => {
    setSubmitting(true);
    setError(null);
    try {
      const row = await apiFetch<WorkOrderRow>(`/tickets/${parentId}/dispatch`, {
        method: 'POST',
        body: JSON.stringify(dto),
      });
      return row;
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error('Dispatch failed');
      setError(err);
      throw err;
    } finally {
      setSubmitting(false);
    }
  }, [parentId]);

  return { dispatch, submitting, error };
}

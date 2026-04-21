import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';

export interface ReclassifyImpactChild {
  id: string;
  title: string;
  status_category: string;
  is_in_progress: boolean;
  assignee: { kind: 'user' | 'vendor' | 'team'; id: string; name: string } | null;
}

export interface ReclassifyImpactActiveTimer {
  id: string;
  metric_name: string;
  elapsed_minutes: number;
  target_minutes: number;
}

export interface ReclassifyImpactDto {
  ticket: {
    id: string;
    current_request_type: { id: string; name: string };
    new_request_type: { id: string; name: string };
  };
  workflow: {
    current_instance: { id: string; definition_name: string; current_step: string } | null;
    will_be_cancelled: boolean;
    new_definition: { id: string; name: string } | null;
  };
  children: ReclassifyImpactChild[];
  sla: {
    active_timers: ReclassifyImpactActiveTimer[];
    will_be_stopped: boolean;
    new_policy: {
      id: string;
      name: string;
      metrics: Array<{ name: string; target_minutes: number }>;
    } | null;
  };
  routing: {
    current_assignment: {
      team?: { id: string; name: string };
      user?: { id: string; name: string };
      vendor?: { id: string; name: string };
    };
    new_decision: {
      team?: { id: string; name: string };
      user?: { id: string; name: string };
      vendor?: { id: string; name: string };
      rule_name: string;
      explanation: string;
    };
    current_user_will_become_watcher: boolean;
  };
}

export interface UseReclassifyPreviewResult {
  data: ReclassifyImpactDto | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * Fetches a preview of what will happen if `ticketId` is reclassified to
 * `newRequestTypeId`. Server endpoint is read-only and idempotent.
 * Returns null data when the inputs are incomplete.
 */
export function useReclassifyPreview(
  ticketId: string | null,
  newRequestTypeId: string | null,
): UseReclassifyPreviewResult {
  const [data, setData] = useState<ReclassifyImpactDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!ticketId || !newRequestTypeId) {
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<ReclassifyImpactDto>(`/tickets/${ticketId}/reclassify/preview`, {
      method: 'POST',
      body: JSON.stringify({ newRequestTypeId }),
    })
      .then((impact) => { if (!cancelled) setData(impact); })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e : new Error('Failed to load preview'));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ticketId, newRequestTypeId, nonce]);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, refetch };
}

export interface ReclassifyExecutePayload {
  newRequestTypeId: string;
  reason: string;
  acknowledgedChildrenInProgress?: boolean;
}

export interface UseReclassifyTicketResult {
  execute: (payload: ReclassifyExecutePayload) => Promise<unknown>;
  submitting: boolean;
  error: Error | null;
  reset: () => void;
}

/**
 * Executes a ticket reclassification. On success the caller should refetch the
 * ticket (and children / activity / SLA crossings) — this hook doesn't manage
 * those caches because the app doesn't use a global query cache.
 */
export function useReclassifyTicket(ticketId: string): UseReclassifyTicketResult {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const execute = useCallback(async (payload: ReclassifyExecutePayload) => {
    setSubmitting(true);
    setError(null);
    try {
      return await apiFetch(`/tickets/${ticketId}/reclassify`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error('Reclassify failed');
      setError(err);
      throw err;
    } finally {
      setSubmitting(false);
    }
  }, [ticketId]);

  const reset = useCallback(() => setError(null), []);

  return { execute, submitting, error, reset };
}

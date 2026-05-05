import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface Approval {
  id: string;
  target_entity_type: string;
  target_entity_id: string;
  approval_chain_id: string | null;
  step_number: number | null;
  parallel_group: string | null;
  approver_person_id: string | null;
  approver_team_id: string | null;
  status: string;
  requested_at: string;
  responded_at: string | null;
  comments: string | null;
  created_at: string;
}

export const approvalKeys = {
  all: ['approvals'] as const,
  lists: () => [...approvalKeys.all, 'list'] as const,
  pendingFor: (personId: string) => [...approvalKeys.lists(), 'pending', personId] as const,
  details: () => [...approvalKeys.all, 'detail'] as const,
  detail: (id: string) => [...approvalKeys.details(), id] as const,
} as const;

export function pendingApprovalsOptions(personId: string | null | undefined) {
  return queryOptions({
    queryKey: approvalKeys.pendingFor(personId ?? ''),
    queryFn: ({ signal }) => apiFetch<Approval[]>(`/approvals/pending/${personId}`, { signal }),
    enabled: Boolean(personId),
    staleTime: 10_000, // T1 — pending queue; agents act on this.
  });
}
export function usePendingApprovals(personId: string | null | undefined) {
  return useQuery(pendingApprovalsOptions(personId));
}

/**
 * Variables shape for `useRespondApproval`. `requestId` MUST be generated
 * once per attempt by the caller (e.g. `crypto.randomUUID()` inside the
 * Approve/Reject click handler) so React Query retries reuse it. Threaded
 * as `X-Client-Request-Id` so the backend constructs an idempotency key
 * of the form `approval.grant:${approvalId}:${requestId}` for the
 * `grant_booking_approval` RPC. See spec §3.3 + §10.1 of the outbox spec
 * (B.0.E.3).
 */
export interface RespondApprovalPayload {
  approvalId: string;
  status: 'approved' | 'rejected';
  comments?: string;
  requestId: string;
}

/** Approve/reject with optimistic removal from the pending list. */
export function useRespondApproval(personId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation<unknown, Error, RespondApprovalPayload, { previous?: Approval[] }>({
    mutationFn: ({ approvalId, status, comments, requestId }) =>
      apiFetch(`/approvals/${approvalId}/respond`, {
        method: 'POST',
        body: JSON.stringify({ status, comments }),
        headers: { 'X-Client-Request-Id': requestId },
      }),
    onMutate: async ({ approvalId }) => {
      if (!personId) return {};
      await qc.cancelQueries({ queryKey: approvalKeys.pendingFor(personId) });
      const previous = qc.getQueryData<Approval[]>(approvalKeys.pendingFor(personId));
      if (previous) {
        qc.setQueryData<Approval[]>(
          approvalKeys.pendingFor(personId),
          previous.filter((a) => a.id !== approvalId),
        );
      }
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous && personId) {
        qc.setQueryData(approvalKeys.pendingFor(personId), ctx.previous);
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: approvalKeys.all }),
  });
}

import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';

export interface UpdateTicketPayload {
  title?: string;
  description?: string;
  status?: string;
  status_category?: string;
  waiting_reason?: string | null;
  priority?: string;
  assigned_team_id?: string | null;
  assigned_user_id?: string | null;
  assigned_vendor_id?: string | null;
  tags?: string[];
  watchers?: string[];
  cost?: number | null;
}

export type AssignmentKind = 'team' | 'user' | 'vendor';

export interface AssignmentTarget {
  kind: AssignmentKind;
  id: string | null;
  /** Human-friendly label used when synthesizing the reassignment reason. */
  nextLabel: string | null;
  /** Human-friendly label of the current assignee, used for the reassignment reason. */
  previousLabel: string | null;
}

export interface UseTicketMutationArgs {
  ticketId: string;
  /** Refetch the ticket after a successful mutation. */
  refetch: () => void;
  /** Called with an optimistic patch overlay. Consumer merges it onto the displayed ticket. */
  onOptimistic: (overlay: Partial<UpdateTicketPayload> | null) => void;
  /** Fires when the server responds with an error, after rollback. Consumer may show inline state. */
  onError?: (field: string, error: Error) => void;
}

const ASSIGNMENT_FIELD: Record<AssignmentKind, keyof UpdateTicketPayload> = {
  team: 'assigned_team_id',
  user: 'assigned_user_id',
  vendor: 'assigned_vendor_id',
};

export function useTicketMutation({ ticketId, refetch, onOptimistic, onError }: UseTicketMutationArgs) {
  const { person } = useAuth();
  const [pending, setPending] = useState(false);

  const patch = useCallback(
    async (updates: Partial<UpdateTicketPayload>) => {
      onOptimistic(updates);
      setPending(true);
      try {
        await apiFetch(`/tickets/${ticketId}`, {
          method: 'PATCH',
          body: JSON.stringify(updates),
        });
        onOptimistic(null);
        refetch();
      } catch (err) {
        onOptimistic(null);
        const error = err instanceof Error ? err : new Error('Update failed');
        const field = Object.keys(updates)[0] ?? 'field';
        toast.error(`Failed to update ${field}: ${error.message}`);
        onError?.(field, error);
      } finally {
        setPending(false);
      }
    },
    [ticketId, onOptimistic, onError, refetch],
  );

  /**
   * Tiered assignment change.
   * - If the ticket currently has no assignee in that slot, send a silent PATCH.
   * - Otherwise, send POST /tickets/:id/reassign with a synthesized reason so
   *   routing_decisions captures the change.
   */
  const updateAssignment = useCallback(
    async (target: AssignmentTarget) => {
      const field = ASSIGNMENT_FIELD[target.kind];
      const isFirstAssignment = target.previousLabel === null;

      if (isFirstAssignment) {
        await patch({ [field]: target.id } as Partial<UpdateTicketPayload>);
        return;
      }

      const actorName = person ? `${person.first_name} ${person.last_name}`.trim() : 'an agent';
      const prevLabel = target.previousLabel ?? 'unassigned';
      const nextLabel = target.nextLabel ?? 'unassigned';
      const reason = `Reassigned ${target.kind} from ${prevLabel} to ${nextLabel} by ${actorName} via ticket sidebar`;

      const overlay: Partial<UpdateTicketPayload> = { [field]: target.id } as Partial<UpdateTicketPayload>;
      onOptimistic(overlay);
      setPending(true);
      try {
        await apiFetch(`/tickets/${ticketId}/reassign`, {
          method: 'POST',
          body: JSON.stringify({
            [field]: target.id,
            reason,
            actor_person_id: person?.id,
            rerun_resolver: false,
          }),
        });
        onOptimistic(null);
        refetch();
      } catch (err) {
        onOptimistic(null);
        const error = err instanceof Error ? err : new Error('Reassignment failed');
        toast.error(`Failed to reassign: ${error.message}`);
        onError?.(field, error);
      } finally {
        setPending(false);
      }
    },
    [patch, ticketId, person, onOptimistic, onError, refetch],
  );

  return { patch, updateAssignment, pending };
}

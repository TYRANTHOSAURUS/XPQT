import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { ticketKeys } from './keys';
import {
  ASSIGNMENT_FIELD,
  type ReassignVariables,
  type TicketDetail,
  type UpdateTicketPayload,
} from './types';

interface UpdateMutationContext {
  previous: TicketDetail | undefined;
}

/**
 * PATCH /tickets/:id with optimistic update + rollback.
 * Settlement invalidates detail and lists so list badges/rows stay consistent.
 */
export function useUpdateTicket(id: string) {
  const qc = useQueryClient();

  return useMutation<TicketDetail, Error, UpdateTicketPayload, UpdateMutationContext>({
    mutationFn: (updates) =>
      apiFetch<TicketDetail>(`/tickets/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(updates),
      }),

    onMutate: async (updates) => {
      await qc.cancelQueries({ queryKey: ticketKeys.detail(id) });
      const previous = qc.getQueryData<TicketDetail>(ticketKeys.detail(id));
      if (previous) {
        qc.setQueryData<TicketDetail>(ticketKeys.detail(id), { ...previous, ...updates });
      }
      return { previous };
    },

    onError: (_err, _updates, ctx) => {
      if (ctx?.previous) qc.setQueryData(ticketKeys.detail(id), ctx.previous);
    },

    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ticketKeys.detail(id) }),
        qc.invalidateQueries({ queryKey: ticketKeys.lists() }),
        qc.invalidateQueries({ queryKey: ticketKeys.activities(id) }),
      ]),
  });
}

interface ReassignMutationContext {
  previous: TicketDetail | undefined;
}

/**
 * Assignment changes that already have a current value go through
 * POST /tickets/:id/reassign so the server can record a routing_decisions row
 * with a human reason. First-time assignments use `useUpdateTicket` (silent PATCH).
 */
export function useReassignTicket(id: string) {
  const qc = useQueryClient();

  return useMutation<TicketDetail, Error, ReassignVariables, ReassignMutationContext>({
    mutationFn: (vars) => {
      const field = ASSIGNMENT_FIELD[vars.kind];
      return apiFetch<TicketDetail>(`/tickets/${id}/reassign`, {
        method: 'POST',
        body: JSON.stringify({
          [field]: vars.id,
          reason: vars.reason ?? `Reassigned ${vars.kind}`,
          actor_person_id: vars.actorPersonId,
          rerun_resolver: false,
        }),
      });
    },

    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: ticketKeys.detail(id) });
      const previous = qc.getQueryData<TicketDetail>(ticketKeys.detail(id));
      if (previous) {
        const field = ASSIGNMENT_FIELD[vars.kind];
        qc.setQueryData<TicketDetail>(ticketKeys.detail(id), {
          ...previous,
          [field]: vars.id,
        } as TicketDetail);
      }
      return { previous };
    },

    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(ticketKeys.detail(id), ctx.previous);
    },

    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ticketKeys.detail(id) }),
        qc.invalidateQueries({ queryKey: ticketKeys.lists() }),
        qc.invalidateQueries({ queryKey: ticketKeys.activities(id) }),
      ]),
  });
}

/** POST a comment/activity to a ticket. Invalidates the activity feed. */
export interface AddActivityVariables {
  content: string;
  visibility: 'internal' | 'external';
  attachments?: FormData;
}

export function useAddActivity(id: string) {
  const qc = useQueryClient();

  return useMutation<unknown, Error, FormData>({
    mutationFn: (formData) =>
      apiFetch(`/tickets/${id}/activities`, {
        method: 'POST',
        body: formData,
      }),
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ticketKeys.activities(id) }),
        qc.invalidateQueries({ queryKey: ticketKeys.detail(id) }),
      ]),
  });
}

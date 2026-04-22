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

/** Fields whose server-side handler appends a row to the activity feed. */
const ACTIVITY_GENERATING_FIELDS = new Set<keyof UpdateTicketPayload>([
  'status',
  'status_category',
  'waiting_reason',
  'assigned_team_id',
  'assigned_user_id',
  'assigned_vendor_id',
  'sla_id',
]);

function touchesActivityFeed(updates: UpdateTicketPayload): boolean {
  return Object.keys(updates).some(
    (k) => ACTIVITY_GENERATING_FIELDS.has(k as keyof UpdateTicketPayload),
  );
}

/**
 * PATCH /tickets/:id with optimistic update + rollback.
 *
 * Activity feed is only invalidated when the backend actually appends to it
 * (status / assignment / SLA / waiting-reason edits). Title/priority/tag/cost
 * edits don't generate activity rows — refetching the feed would be wasted
 * bandwidth (§6 "invalidate as high as correct, no higher").
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

    onSettled: (_data, _err, variables) => {
      const tasks: Promise<unknown>[] = [
        qc.invalidateQueries({ queryKey: ticketKeys.detail(id) }),
        qc.invalidateQueries({ queryKey: ticketKeys.lists() }),
      ];
      if (variables && touchesActivityFeed(variables)) {
        tasks.push(qc.invalidateQueries({ queryKey: ticketKeys.activities(id) }));
      }
      return Promise.all(tasks);
    },
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

/**
 * POST a comment/note to a ticket. Uploads attachments first (if any), then
 * creates the activity row referencing them. One mutation from the caller's
 * POV — both steps run under `isPending`.
 */
export interface AddActivityVariables {
  content: string;
  visibility: 'internal' | 'external';
  files: File[];
}

export interface AttachmentMeta {
  name: string;
  url?: string;
  path?: string;
  size: number;
  type: string;
}

export function useAddActivity(id: string) {
  const qc = useQueryClient();

  return useMutation<unknown, Error, AddActivityVariables>({
    mutationFn: async ({ content, visibility, files }) => {
      let attachments: AttachmentMeta[] = [];

      if (files.length > 0) {
        const formData = new FormData();
        files.forEach((file) => formData.append('files', file));
        attachments = await apiFetch<AttachmentMeta[]>(
          `/tickets/${id}/attachments`,
          { method: 'POST', body: formData },
        );
      }

      return apiFetch(`/tickets/${id}/activities`, {
        method: 'POST',
        body: JSON.stringify({
          activity_type: visibility === 'internal' ? 'internal_note' : 'external_comment',
          visibility,
          content: content.trim() || undefined,
          attachments,
        }),
      });
    },
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ticketKeys.activities(id) }),
        qc.invalidateQueries({ queryKey: ticketKeys.detail(id) }),
      ]),
  });
}

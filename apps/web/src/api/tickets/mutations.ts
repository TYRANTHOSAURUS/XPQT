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

interface UpdateWorkOrderSlaContext {
  previous: TicketDetail | undefined;
}

/**
 * PATCH /work-orders/:id/sla — change the executor SLA on a child work
 * order. Step 1c.10c made `PATCH /tickets/:id` case-only; the SLA edit
 * affordance for work_orders has to route here instead.
 *
 * Cache shape is shared with TicketDetail (work_orders are loaded through
 * the same ticket detail endpoint), so we invalidate the same ticket keys
 * the regular `useUpdateTicket` mutation does.
 */
// Narrow command response — codex round 1 nit: typing as TicketDetail was
// misleading because the backend returns a raw WorkOrderRow. The hook never
// reads the response (just invalidates the ticket detail cache), so a Pick
// of the columns the SLA edit actually changes is the honest contract.
type WorkOrderSlaResponse = Pick<TicketDetail, 'id' | 'sla_id'>;

export function useUpdateWorkOrderSla(id: string) {
  const qc = useQueryClient();

  return useMutation<WorkOrderSlaResponse, Error, string | null, UpdateWorkOrderSlaContext>({
    mutationFn: (slaId) =>
      apiFetch<WorkOrderSlaResponse>(`/work-orders/${id}/sla`, {
        method: 'PATCH',
        body: JSON.stringify({ sla_id: slaId }),
      }),

    onMutate: async (slaId) => {
      await qc.cancelQueries({ queryKey: ticketKeys.detail(id) });
      const previous = qc.getQueryData<TicketDetail>(ticketKeys.detail(id));
      if (previous) {
        qc.setQueryData<TicketDetail>(ticketKeys.detail(id), {
          ...previous,
          sla_id: slaId,
        });
      }
      return { previous };
    },

    onError: (_err, _slaId, ctx) => {
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

interface SetWorkOrderPlanContext {
  previous: TicketDetail | undefined;
}

/**
 * PATCH /work-orders/:id/plan — declare when a work_order is planned to
 * start (and optionally for how long). Mirrors the legacy plandate hook
 * but routes to the work-order surface; Step 1c.10c made the case-side
 * `PATCH /tickets/:id/plan` case-only-by-data, so anything that's a
 * work_order has to go through the WorkOrder controller.
 *
 * Cache shape is shared with TicketDetail (work_orders are loaded through
 * the same ticket detail endpoint).
 */
type SetWorkOrderPlanResponse = Pick<TicketDetail, 'id'>;

interface SetWorkOrderPlanPayload {
  planned_start_at: string | null;
  planned_duration_minutes?: number | null;
}

export function useSetWorkOrderPlan(id: string) {
  const qc = useQueryClient();

  return useMutation<SetWorkOrderPlanResponse, Error, SetWorkOrderPlanPayload, SetWorkOrderPlanContext>({
    mutationFn: (payload) =>
      apiFetch<SetWorkOrderPlanResponse>(`/work-orders/${id}/plan`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),

    onMutate: async (payload) => {
      await qc.cancelQueries({ queryKey: ticketKeys.detail(id) });
      const previous = qc.getQueryData<TicketDetail>(ticketKeys.detail(id));
      if (previous) {
        // Optimistically merge into the cached detail. Mirror the backend
        // rule: clearing the start clears the duration too.
        const nextDuration =
          payload.planned_start_at === null
            ? null
            : (payload.planned_duration_minutes ?? null);
        qc.setQueryData<TicketDetail>(ticketKeys.detail(id), {
          ...previous,
          planned_start_at: payload.planned_start_at,
          planned_duration_minutes: nextDuration,
        } as TicketDetail);
      }
      return { previous };
    },

    onError: (_err, _payload, ctx) => {
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

// ─────────────────────────────────────────────────────────────────────
// Slice 2 — work-order command surface (status / priority / assignment / reassign)
//
// Step 1c.10c made `PATCH /tickets/:id` and `POST /tickets/:id/reassign`
// case-only. The four hooks below are the work-order-side counterparts of
// `useUpdateTicket` / `useReassignTicket`. The desk detail sidebar
// dispatches by `ticket_kind` to either the case mutations or these.
//
// Cache shape is shared via `ticketKeys.detail(id)` because work_orders are
// loaded through the same detail endpoint. Each hook narrows its response
// type with `Pick<TicketDetail, 'id'>` to avoid field-coupling drift with
// the plandate workstream — the backend returns a raw WorkOrderRow and the
// FE only needs `id` after the mutation (the cache is invalidated, not
// read from the response).
// ─────────────────────────────────────────────────────────────────────

/**
 * Subset of writable fields on `PATCH /work-orders/:id/status`. Mirrors the
 * status-related fields of `UpdateTicketPayload`. Server requires at least
 * one field to be present.
 */
export interface UpdateWorkOrderStatusPayload {
  status?: string;
  status_category?: string;
  waiting_reason?: string | null;
}

interface UpdateWorkOrderStatusContext {
  previous: TicketDetail | undefined;
}

type WorkOrderStatusResponse = Pick<TicketDetail, 'id'>;

export function useUpdateWorkOrderStatus(id: string) {
  const qc = useQueryClient();

  return useMutation<
    WorkOrderStatusResponse,
    Error,
    UpdateWorkOrderStatusPayload,
    UpdateWorkOrderStatusContext
  >({
    mutationFn: (payload) =>
      apiFetch<WorkOrderStatusResponse>(`/work-orders/${id}/status`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),

    onMutate: async (payload) => {
      await qc.cancelQueries({ queryKey: ticketKeys.detail(id) });
      const previous = qc.getQueryData<TicketDetail>(ticketKeys.detail(id));
      if (previous) {
        qc.setQueryData<TicketDetail>(ticketKeys.detail(id), {
          ...previous,
          ...payload,
        } as TicketDetail);
      }
      return { previous };
    },

    onError: (_err, _payload, ctx) => {
      if (ctx?.previous) qc.setQueryData(ticketKeys.detail(id), ctx.previous);
    },

    // Status changes always emit a `status_changed` activity, so the
    // activity feed cache always needs invalidation.
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ticketKeys.detail(id) }),
        qc.invalidateQueries({ queryKey: ticketKeys.lists() }),
        qc.invalidateQueries({ queryKey: ticketKeys.activities(id) }),
      ]),
  });
}

interface UpdateWorkOrderPriorityContext {
  previous: TicketDetail | undefined;
}

type WorkOrderPriorityResponse = Pick<TicketDetail, 'id'>;

export function useUpdateWorkOrderPriority(id: string) {
  const qc = useQueryClient();

  return useMutation<
    WorkOrderPriorityResponse,
    Error,
    'low' | 'medium' | 'high' | 'critical',
    UpdateWorkOrderPriorityContext
  >({
    mutationFn: (priority) =>
      apiFetch<WorkOrderPriorityResponse>(`/work-orders/${id}/priority`, {
        method: 'PATCH',
        body: JSON.stringify({ priority }),
      }),

    onMutate: async (priority) => {
      await qc.cancelQueries({ queryKey: ticketKeys.detail(id) });
      const previous = qc.getQueryData<TicketDetail>(ticketKeys.detail(id));
      if (previous) {
        qc.setQueryData<TicketDetail>(ticketKeys.detail(id), {
          ...previous,
          priority,
        });
      }
      return { previous };
    },

    onError: (_err, _priority, ctx) => {
      if (ctx?.previous) qc.setQueryData(ticketKeys.detail(id), ctx.previous);
    },

    // Priority changes emit a `priority_changed` activity row.
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ticketKeys.detail(id) }),
        qc.invalidateQueries({ queryKey: ticketKeys.lists() }),
        qc.invalidateQueries({ queryKey: ticketKeys.activities(id) }),
      ]),
  });
}

export interface UpdateWorkOrderAssignmentPayload {
  assigned_team_id?: string | null;
  assigned_user_id?: string | null;
  assigned_vendor_id?: string | null;
}

interface UpdateWorkOrderAssignmentContext {
  previous: TicketDetail | undefined;
}

type WorkOrderAssignmentResponse = Pick<TicketDetail, 'id'>;

export function useUpdateWorkOrderAssignment(id: string) {
  const qc = useQueryClient();

  return useMutation<
    WorkOrderAssignmentResponse,
    Error,
    UpdateWorkOrderAssignmentPayload,
    UpdateWorkOrderAssignmentContext
  >({
    mutationFn: (payload) =>
      apiFetch<WorkOrderAssignmentResponse>(`/work-orders/${id}/assignment`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),

    // Optimistic update: we only have the id we're setting; the detail row
    // expands assignee ids into nested `assigned_team` / `assigned_agent` /
    // `assigned_vendor` objects (server does the join). We deliberately do
    // NOT touch those nested objects here — leaving them stale for one tick
    // is the honest representation of "we know the id changed but not its
    // expansion yet". The invalidation in onSettled refetches the truth.
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: ticketKeys.detail(id) });
      const previous = qc.getQueryData<TicketDetail>(ticketKeys.detail(id));
      return { previous };
    },

    onError: (_err, _payload, ctx) => {
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

interface ReassignWorkOrderContext {
  previous: TicketDetail | undefined;
}

type WorkOrderReassignResponse = Pick<TicketDetail, 'id'>;

/**
 * Audited reassignment for a work_order — `POST /work-orders/:id/reassign`
 * with a required reason. The server writes a `routing_decisions` row tagged
 * `entity_kind='work_order'` and an internal-visibility activity carrying
 * the reason. Mirrors `useReassignTicket` but routes to the work-order
 * surface.
 */
export function useReassignWorkOrder(id: string) {
  const qc = useQueryClient();

  return useMutation<
    WorkOrderReassignResponse,
    Error,
    ReassignVariables,
    ReassignWorkOrderContext
  >({
    mutationFn: (vars) => {
      const field = ASSIGNMENT_FIELD[vars.kind];
      return apiFetch<WorkOrderReassignResponse>(`/work-orders/${id}/reassign`, {
        method: 'POST',
        body: JSON.stringify({
          [field]: vars.id,
          reason: vars.reason ?? `Reassigned ${vars.kind}`,
          actor_person_id: vars.actorPersonId,
          rerun_resolver: false,
        }),
      });
    },

    // Same pessimistic stance as updateAssignment — don't fake the nested
    // expansion; let the refetch land the truth.
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: ticketKeys.detail(id) });
      const previous = qc.getQueryData<TicketDetail>(ticketKeys.detail(id));
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

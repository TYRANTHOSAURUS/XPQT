import { queryOptions } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

// GET /tickets/:id — joined shape from ticket.service.ts getById
export interface PortalTicketDetail {
  id: string;
  title: string;
  description: string | null;
  status: string;
  status_category: string;
  created_at: string;
  sla_resolution_due_at: string | null;
  sla_resolution_breached_at: string | null;
  requester_person_id: string | null;
  request_type?: { id: string; name: string; domain: string | null } | null;
  assigned_team?: { id: string; name: string } | null;
  assigned_agent?: {
    id: string;
    email: string;
    /**
     * Supabase returns relation rows as either an object or a single-element
     * array depending on the FK cardinality / discovery — handle both.
     */
    person?:
      | { first_name: string | null; last_name: string | null }
      | Array<{ first_name: string | null; last_name: string | null }>
      | null;
  } | null;
  location?: { id: string; name: string; type: string } | null;
}

// GET /tickets/:id/activities — activity rows with joined author person
export interface PortalActivity {
  id: string;
  activity_type: string;
  content?: string | null;
  metadata?: Record<string, unknown> | null;
  author?: { id: string; first_name: string | null; last_name: string | null } | null;
  created_at: string;
  visibility: string;
}

export interface PortalTicketListResponse {
  items: PortalListTicket[];
}

export interface PortalListTicket {
  id: string;
  title: string;
  status: string;
  status_category: string;
  created_at: string;
  request_type_name: string | null;
  sla_resolution_breached_at?: string | null;
}

/**
 * Per-module query key factory (per docs/react-query-guidelines.md). Use
 * via `portalTicketKeys.detail(id)` etc. so invalidation always matches
 * the source-of-truth options below.
 */
export const portalTicketKeys = {
  all: ['portal', 'tickets'] as const,
  detail: (id: string | undefined) => ['ticket', 'detail', id] as const,
  activities: (id: string | undefined) => ['ticket', 'activities', id] as const,
  myOpen: (personId: string) => ['portal', 'my-open-tickets', personId] as const,
};

export const portalTicketOptions = (id: string | undefined) =>
  queryOptions({
    queryKey: portalTicketKeys.detail(id),
    queryFn: ({ signal }) =>
      apiFetch<PortalTicketDetail>(`/tickets/${id}`, { signal }),
    enabled: Boolean(id),
    staleTime: 10_000,
  });

export const portalTicketActivitiesOptions = (id: string | undefined) =>
  queryOptions({
    queryKey: portalTicketKeys.activities(id),
    queryFn: ({ signal }) =>
      apiFetch<PortalActivity[]>(`/tickets/${id}/activities?visibility=external`, { signal }),
    enabled: Boolean(id),
    staleTime: 5_000,
  });

export const portalMyOpenTicketsOptions = (personId: string) =>
  queryOptions({
    queryKey: portalTicketKeys.myOpen(personId),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ requester_person_id: personId, limit: '4' });
      params.append('status_category', 'open');
      params.append('status_category', 'in_progress');
      return apiFetch<PortalTicketListResponse>(`/tickets?${params.toString()}`, { signal }).then(
        (res) => res.items ?? [],
      );
    },
    staleTime: 30_000,
    enabled: !!personId,
  });

// ─── DTO → UI helpers ────────────────────────────────────────────────

export interface ThreadEventInput {
  id: string;
  kind: 'message' | 'system';
  authorName?: string | null;
  authorRole?: 'requester' | 'assignee' | 'system';
  authorAvatarUrl?: string | null;
  body: string;
  createdAt: string;
}

/**
 * Translate raw activity rows into the thread-event shape rendered by
 * `<RequestThread>`. External comments and freeform notes become message
 * bubbles; everything else becomes a small system marker.
 */
export function activitiesToThreadEvents(
  acts: PortalActivity[] | undefined,
  requesterPersonId: string | null | undefined,
): ThreadEventInput[] {
  if (!acts) return [];
  return acts
    .filter((a) => a.activity_type !== 'system_event' || a.content)
    .map((a) => {
      if (
        a.activity_type === 'external_comment' ||
        a.activity_type === 'internal_note' ||
        (a.activity_type !== 'system_event' && a.content)
      ) {
        const authorName =
          [a.author?.first_name, a.author?.last_name].filter(Boolean).join(' ') || 'Support';
        const role =
          a.author?.id === requesterPersonId
            ? ('requester' as const)
            : ('assignee' as const);
        return {
          id: a.id,
          kind: 'message' as const,
          authorName,
          authorRole: role,
          body: a.content ?? '',
          createdAt: a.created_at,
        };
      }
      const systemBody =
        a.content ??
        String(
          (a.metadata as { event?: string } | null)?.event ?? a.activity_type,
        ).replaceAll('_', ' ');
      return {
        id: a.id,
        kind: 'system' as const,
        body: systemBody,
        createdAt: a.created_at,
      };
    });
}

export interface SlaSnapshot {
  progress: number;
  remainingLabel: string;
  breached: boolean;
}

/**
 * Compute SLA progress at a given moment. The caller passes `now` (from
 * `useNow()`) so the indicator stays live without forcing a refetch.
 */
export function deriveTicketSla(
  ticket: Pick<PortalTicketDetail, 'sla_resolution_due_at' | 'sla_resolution_breached_at' | 'created_at'>,
  now: number,
): SlaSnapshot | null {
  if (!ticket.sla_resolution_due_at) return null;
  const due = new Date(ticket.sla_resolution_due_at).getTime();
  const created = new Date(ticket.created_at).getTime();
  const total = Math.max(1, due - created);
  const used = Math.max(0, now - created);
  const progress = Math.min(1, used / total);
  if (ticket.sla_resolution_breached_at || now > due) {
    return { progress: 1, remainingLabel: 'Past due', breached: true };
  }
  const remaining = due - now;
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  const remainingLabel = hours > 0 ? `${hours}h ${minutes}m left` : `${minutes}m left`;
  return { progress, remainingLabel, breached: false };
}

/**
 * Produce a humanized assignee label and a description (team name) for
 * the request detail sidebar. Falls back to "Unassigned" when no agent
 * is set, and keeps the email visible only as a last resort.
 */
export function formatAssignee(
  ticket: Pick<PortalTicketDetail, 'assigned_agent' | 'assigned_team'>,
): { primary: string | null; description: string | null } {
  const agent = ticket.assigned_agent;
  if (!agent) return { primary: null, description: ticket.assigned_team?.name ?? null };
  const personRow = Array.isArray(agent.person) ? agent.person[0] : agent.person;
  const fullName = [personRow?.first_name, personRow?.last_name]
    .filter(Boolean)
    .join(' ')
    .trim();
  return {
    primary: fullName || agent.email,
    description: ticket.assigned_team?.name ?? null,
  };
}

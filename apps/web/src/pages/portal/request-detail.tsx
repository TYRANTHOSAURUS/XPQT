// apps/web/src/pages/portal/request-detail.tsx
import { useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient, queryOptions } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { PortalPage } from '@/components/portal/portal-page';
import { PortalFormHeader } from '@/components/portal/portal-form-header';
import { PortalRequestThread, type ThreadEvent } from '@/components/portal/portal-request-thread';
import { PortalRequestSidebar } from '@/components/portal/portal-request-sidebar';
import { derivePortalStatus } from '@/lib/portal-status';
import { ArrowLeft } from 'lucide-react';
import { toastError, toastSuccess } from '@/lib/toast';

// GET /tickets/:id — joined shape from ticket.service.ts getById
interface TicketDetail {
  id: string;
  title: string;
  description: string | null;
  status: string;
  status_category: string;
  created_at: string;
  sla_resolution_due_at: string | null;
  sla_resolution_breached_at: string | null;
  requester_person_id: string | null;
  // joined as "request_type" — only id, name, domain are selected by getById
  request_type?: { id: string; name: string; domain: string | null } | null;
  // joined as "assigned_team"
  assigned_team?: { id: string; name: string } | null;
  // joined as "assigned_agent" (not assigned_user)
  assigned_agent?: { id: string; email: string } | null;
  // joined as "location"
  location?: { id: string; name: string; type: string } | null;
}

// GET /tickets/:id/activities — activity rows with joined author person
interface Activity {
  id: string;
  activity_type: string;
  content?: string | null;
  metadata?: Record<string, unknown> | null;
  author?: { id: string; first_name: string | null; last_name: string | null } | null;
  created_at: string;
  visibility: string;
}

const ticketOptions = (id: string | undefined) =>
  queryOptions({
    queryKey: ['ticket', 'detail', id],
    queryFn: ({ signal }) => apiFetch<TicketDetail>(`/tickets/${id}`, { signal }),
    enabled: Boolean(id),
    staleTime: 10_000,
  });

const activitiesOptions = (id: string | undefined) =>
  queryOptions({
    queryKey: ['ticket', 'activities', id],
    queryFn: ({ signal }) =>
      apiFetch<Activity[]>(`/tickets/${id}/activities?visibility=external`, { signal }),
    enabled: Boolean(id),
    staleTime: 5_000,
  });

function deriveSla(
  ticket: TicketDetail,
): { progress: number; remainingLabel: string; breached: boolean } | null {
  if (!ticket.sla_resolution_due_at) return null;
  const due = new Date(ticket.sla_resolution_due_at).getTime();
  const created = new Date(ticket.created_at).getTime();
  const now = Date.now();
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

function activitiesToEvents(
  acts: Activity[] | undefined,
  requesterPersonId: string | null | undefined,
): ThreadEvent[] {
  if (!acts) return [];
  return acts
    .filter((a) => a.activity_type !== 'system_event' || a.content)
    .map((a) => {
      // External comments and internal notes become messages
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
      // System events become timeline markers
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

export function RequestDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();

  const { data: ticket, isPending: ticketPending } = useQuery(ticketOptions(id));
  const { data: activities, isPending: actsPending } = useQuery(activitiesOptions(id));

  const reply = useMutation<unknown, Error, string>({
    mutationFn: (body) =>
      apiFetch(`/tickets/${id}/activities`, {
        method: 'POST',
        body: JSON.stringify({
          activity_type: 'external_comment',
          visibility: 'external',
          content: body,
        }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ticket', 'activities', id] });
    },
  });

  const events = useMemo(
    () => activitiesToEvents(activities, ticket?.requester_person_id),
    [activities, ticket?.requester_person_id],
  );

  const sla = ticket ? deriveSla(ticket) : null;
  const isPending = ticketPending || actsPending;

  if (isPending) {
    return (
      <PortalPage>
        <div className="text-sm text-muted-foreground">Loading…</div>
      </PortalPage>
    );
  }

  if (!ticket) {
    return (
      <PortalPage>
        <div className="text-sm text-muted-foreground">Request not found.</div>
      </PortalPage>
    );
  }

  const threadEvents: ThreadEvent[] = [
    ...(ticket.description
      ? [
          {
            id: 'desc',
            kind: 'message' as const,
            authorName: 'You',
            authorRole: 'requester' as const,
            body: ticket.description,
            createdAt: ticket.created_at,
          },
        ]
      : []),
    ...events,
  ];

  return (
    <PortalPage>
      <Link
        to="/portal/requests"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground mb-3"
      >
        <ArrowLeft className="size-3.5" /> All requests
      </Link>

      <div className="grid gap-8 md:grid-cols-[1fr_280px]">
        <div className="min-w-0">
          <PortalFormHeader
            iconName={null}
            name={ticket.title}
            whatHappensNext={ticket.request_type?.name ?? null}
          />
          <div className="mt-6">
            <PortalRequestThread
              events={threadEvents}
              onReply={async (body) => {
                try {
                  await reply.mutateAsync(body);
                  toastSuccess('Reply sent');
                } catch (e) {
                  toastError("Couldn't send reply", {
                    error: e,
                    retry: () => reply.mutateAsync(body),
                  });
                }
              }}
            />
          </div>
        </div>

        <PortalRequestSidebar
          status={{
            label: derivePortalStatus(ticket.status_category, ticket.sla_resolution_breached_at).label,
            sla: sla ?? undefined,
          }}
          blocks={[
            {
              label: 'Assignee',
              value: ticket.assigned_agent ? (
                ticket.assigned_agent.email
              ) : (
                <span className="text-muted-foreground">Unassigned</span>
              ),
              description: ticket.assigned_team?.name,
            },
            {
              label: 'Location',
              value: ticket.location?.name ?? (
                <span className="text-muted-foreground">Unspecified</span>
              ),
            },
            {
              label: 'Service',
              value: ticket.request_type?.name ?? '—',
            },
          ]}
        />
      </div>
    </PortalPage>
  );
}

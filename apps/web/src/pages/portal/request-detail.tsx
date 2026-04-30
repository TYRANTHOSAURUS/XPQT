// apps/web/src/pages/portal/request-detail.tsx
import { useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useNow } from '@/lib/use-now';
import { PortalPage } from '@/components/portal/portal-page';
import { PortalFormHeader } from '@/components/portal/portal-form-header';
import {
  PortalRequestThread,
  PortalRequestReplyComposer,
  type ThreadEvent,
} from '@/components/portal/portal-request-thread';
import { PortalRequestSidebar } from '@/components/portal/portal-request-sidebar';
import { derivePortalStatus } from '@/lib/portal-status';
import { toastError, toastSuccess } from '@/lib/toast';
import {
  activitiesToThreadEvents,
  deriveTicketSla,
  formatAssignee,
  portalTicketActivitiesOptions,
  portalTicketKeys,
  portalTicketOptions,
} from '@/api/portal-tickets';

export function RequestDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const now = useNow(30_000);

  const { data: ticket, isPending: ticketPending } = useQuery(portalTicketOptions(id));
  const { data: activities, isPending: actsPending } = useQuery(
    portalTicketActivitiesOptions(id),
  );

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
      void qc.invalidateQueries({ queryKey: portalTicketKeys.activities(id) });
      toastSuccess('Reply sent');
    },
    onError: (e, body) => {
      toastError("Couldn't send reply", {
        error: e,
        retry: () => void reply.mutate(body),
      });
    },
  });

  const events = useMemo(
    () => activitiesToThreadEvents(activities, ticket?.requester_person_id),
    [activities, ticket?.requester_person_id],
  );

  const sla = ticket ? deriveTicketSla(ticket, now) : null;

  if (ticketPending) {
    return (
      <PortalPage>
        <Link
          to="/portal/requests"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground mb-3"
        >
          <ArrowLeft className="size-3.5" aria-hidden /> All requests
        </Link>
        <div className="text-sm text-muted-foreground" role="status" aria-live="polite">
          Loading…
        </div>
      </PortalPage>
    );
  }

  if (!ticket) {
    return (
      <PortalPage>
        <Link
          to="/portal/requests"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground mb-3"
        >
          <ArrowLeft className="size-3.5" aria-hidden /> All requests
        </Link>
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

  const assignee = formatAssignee(ticket);

  return (
    <PortalPage>
      <Link
        to="/portal/requests"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground mb-3"
      >
        <ArrowLeft className="size-3.5" aria-hidden /> All requests
      </Link>

      <div className="grid gap-8 md:grid-cols-[1fr_280px]">
        <div className="min-w-0">
          <PortalFormHeader
            iconName={null}
            name={ticket.title}
            whatHappensNext={ticket.request_type?.name ?? null}
          />
          <div className="mt-6">
            {actsPending ? (
              <div className="space-y-3" aria-busy="true" aria-live="polite">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <div className="portal-skeleton size-8 shrink-0 rounded-full" />
                    <div className="flex-1 space-y-2">
                      <div className="portal-skeleton h-3 w-1/3 rounded" />
                      <div className="portal-skeleton h-12 w-full rounded-lg" />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <PortalRequestThread events={threadEvents} />
            )}
            <PortalRequestReplyComposer onSubmit={(body) => reply.mutateAsync(body).then(() => undefined)} />
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
              value: assignee.primary ?? <span className="text-muted-foreground">Unassigned</span>,
              description: assignee.description ?? undefined,
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

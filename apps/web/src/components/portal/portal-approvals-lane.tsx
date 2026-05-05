import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Calendar,
  CheckCircle2,
  ExternalLink,
  FileText,
  Package,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import {
  usePendingApprovals,
  useRespondApproval,
  type Approval,
} from '@/api/approvals';
import { useAuth } from '@/providers/auth-provider';
import { Button } from '@/components/ui/button';
import { formatRelativeTime, formatFullTimestamp } from '@/lib/format';
import { toastError, toastSuccess } from '@/lib/toast';
import { cn } from '@/lib/utils';

type EntityKind = 'reservation' | 'booking_bundle' | 'ticket' | 'order' | 'other';

const ENTITY_LABEL: Record<EntityKind, string> = {
  reservation: 'Booking',
  booking_bundle: 'Booking + services',
  ticket: 'Request',
  order: 'Order',
  other: 'Item',
};

const ENTITY_ICON: Record<EntityKind, React.ComponentType<{ className?: string }>> = {
  reservation: Calendar,
  booking_bundle: Package,
  ticket: FileText,
  order: Package,
  other: ShieldCheck,
};

const ENTITY_TILE: Record<EntityKind, string> = {
  reservation: 'bg-purple-500/15 text-purple-600 dark:text-purple-400',
  booking_bundle: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  ticket: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  order: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  other: 'bg-muted text-muted-foreground',
};

function entityKind(type: string): EntityKind {
  if (type === 'reservation' || type === 'booking_bundle' || type === 'ticket' || type === 'order') {
    return type;
  }
  return 'other';
}

/**
 * For a given approval target, the requester-facing context page where
 * the approver can read more before deciding. Falls back to null for
 * entity types without a portal surface — the row's id chip is enough.
 */
function entityContextHref(type: string, id: string): string | null {
  switch (type) {
    case 'reservation':
      return `/portal/me/bookings/${id}`;
    case 'ticket':
      return `/portal/requests/${id}`;
    default:
      return null;
  }
}

/**
 * Pending-approvals lane for the portal home. Renders null when the user
 * has nothing to approve. When populated, shows a tight card with one
 * row per pending item — entity icon + label + relative time + inline
 * Approve / Reject buttons. Optimistic removal via the shared
 * `useRespondApproval` mutation.
 *
 * The persona JTBD is "approve or deny in seconds without opening 5
 * different tools" — so this stays a one-tap surface. Comments and
 * deeper context live on the entity's detail page (linked via
 * `entityContextHref`).
 */
export function PortalApprovalsLane() {
  const { person } = useAuth();
  const personId = person?.id ?? null;

  const { data: approvals = [], isPending } = usePendingApprovals(personId);
  const respond = useRespondApproval(personId);

  // Track per-row in-flight so individual rows disable independently.
  // RQ's single `respond.isPending` would disable every row at once.
  const [responding, setResponding] = useState<Record<string, boolean>>({});

  // Skeleton suppressed — empty (most common) and pending look the same
  // to the user; let activity panel below carry the loading rhythm.
  if (isPending || approvals.length === 0) return null;

  const handle = (approval: Approval, status: 'approved' | 'rejected') => {
    if (!personId) return;
    setResponding((prev) => ({ ...prev, [approval.id]: true }));
    // B.0.E.3 — mutation-attempt-scoped request id (spec §3.3). Each
    // tap gets a fresh id; React Query retries reuse it. The toast-retry
    // callback re-enters handle() and gets a new id (new logical attempt).
    const requestId = crypto.randomUUID();
    respond.mutate(
      { approvalId: approval.id, status, requestId },
      {
        onSuccess: () => {
          if (status === 'approved') {
            toastSuccess('Approved');
          } else {
            toastSuccess('Rejected');
          }
        },
        onError: (err) => {
          toastError("Couldn't record your decision", {
            error: err,
            retry: () => handle(approval, status),
          });
        },
        onSettled: () =>
          setResponding((prev) => ({ ...prev, [approval.id]: false })),
      },
    );
  };

  return (
    <aside className="rounded-xl border border-amber-500/40 bg-amber-500/5 overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-amber-500/20">
        <div className="inline-flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck className="size-3.5 text-amber-600 dark:text-amber-400" aria-hidden />
          Needs your approval
          <span className="rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-400 px-1.5 py-0.5 text-[10px] font-medium tabular-nums">
            {approvals.length}
          </span>
        </div>
      </div>

      <ul className="portal-stagger divide-y divide-amber-500/15">
        {approvals.map((a) => {
          const kind = entityKind(a.target_entity_type);
          const Icon = ENTITY_ICON[kind];
          const tile = ENTITY_TILE[kind];
          const ctxHref = entityContextHref(a.target_entity_type, a.target_entity_id);
          const inFlight = responding[a.id] ?? false;
          return (
            <li key={a.id} className="flex flex-col gap-2 px-4 py-3">
              <div className="flex items-start gap-3">
                <div
                  className={cn(
                    'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md',
                    tile,
                  )}
                >
                  <Icon className="size-3.5" aria-hidden />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium">
                    {ENTITY_LABEL[kind]}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    Requested{' '}
                    <time
                      dateTime={a.requested_at}
                      title={formatFullTimestamp(a.requested_at)}
                    >
                      {formatRelativeTime(a.requested_at)}
                    </time>
                  </div>
                </div>
                {ctxHref && (
                  <Link
                    to={ctxHref}
                    viewTransition
                    aria-label="View details"
                    className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                    style={{
                      transitionTimingFunction: 'var(--ease-portal)',
                      transitionDuration: 'var(--dur-portal-press)',
                    }}
                  >
                    <ExternalLink className="size-3.5" aria-hidden />
                  </Link>
                )}
              </div>
              <div className="flex items-center justify-end gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handle(a, 'rejected')}
                  disabled={inFlight}
                  className="h-7 gap-1 text-destructive hover:text-destructive"
                >
                  <XCircle className="size-3.5" aria-hidden />
                  Reject
                </Button>
                <Button
                  size="sm"
                  onClick={() => handle(a, 'approved')}
                  disabled={inFlight}
                  className="h-7 gap-1"
                >
                  <CheckCircle2 className="size-3.5" aria-hidden />
                  Approve
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

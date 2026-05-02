import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CheckCircle2, XCircle, Inbox } from 'lucide-react';
import { usePendingApprovals, useRespondApproval } from '@/api/approvals';
import { useReservationDetail } from '@/api/room-booking';
import { useAuth } from '@/providers/auth-provider';
import { formatFullTimestamp } from '@/lib/format';


/* ---------- Helpers ---------- */

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function entityTypeLabel(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1).replace(/_/g, ' ');
}

/* ---------- Main page ---------- */

export function ApprovalsPage() {
  const { person } = useAuth();
  const personId = person?.id;

  const { data: approvals, isPending: loading, error } = usePendingApprovals(personId);
  const respond = useRespondApproval(personId);

  const [comments, setComments] = useState<Record<string, string>>({});
  // Track per-approval in-flight so individual Approve/Reject buttons disable
  // independently. RQ's single respond.isPending flag would disable every row
  // at once during a mutation.
  const [responding, setResponding] = useState<Record<string, boolean>>({});

  const handleRespond = (approvalId: string, status: 'approved' | 'rejected') => {
    if (!personId) return;
    setResponding((prev) => ({ ...prev, [approvalId]: true }));
    respond.mutate(
      { approvalId, status, comments: comments[approvalId] },
      {
        onSuccess: () => {
          setComments((prev) => {
            const next = { ...prev };
            delete next[approvalId];
            return next;
          });
        },
        onSettled: () => setResponding((prev) => ({ ...prev, [approvalId]: false })),
      },
    );
  };

  // No person loaded yet (auth still hydrating)
  if (!personId) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-muted-foreground">
          {loading ? 'Loading...' : 'No person record linked to your account.'}
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-destructive">Failed to load approvals: {error instanceof Error ? error.message : String(error)}</p>
      </div>
    );
  }

  const items = approvals ?? [];

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Approvals</h1>
        <p className="text-muted-foreground mt-1">
          Pending approval requests for you or your teams
        </p>
      </div>

      {loading && items.length === 0 ? (
        <div className="flex items-center justify-center py-16">
          <p className="text-muted-foreground">Loading approvals...</p>
        </div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 gap-3">
            <Inbox className="h-10 w-10 text-muted-foreground/50" />
            <p className="text-lg font-medium text-muted-foreground">No pending approvals</p>
            <p className="text-sm text-muted-foreground">
              You're all caught up. New approval requests will appear here.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Pending
              <Badge variant="secondary" className="tabular-nums">
                {items.length}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Entity</TableHead>
                  <TableHead className="w-[140px]">Requested</TableHead>
                  <TableHead className="w-[100px]">Status</TableHead>
                  <TableHead className="min-w-[200px]">Comment</TableHead>
                  <TableHead className="w-[180px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((approval) => (
                  <TableRow key={approval.id}>
                    <TableCell>
                      <ApprovalEntityCell
                        type={approval.target_entity_type}
                        id={approval.target_entity_id}
                      />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {timeAgo(approval.requested_at)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          approval.status === 'pending'
                            ? 'outline'
                            : approval.status === 'approved'
                              ? 'default'
                              : 'destructive'
                        }
                        className="capitalize"
                      >
                        {approval.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Input
                        placeholder="Optional comment..."
                        className="h-8 text-sm"
                        value={comments[approval.id] ?? ''}
                        onChange={(e) =>
                          setComments((prev) => ({ ...prev, [approval.id]: e.target.value }))
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          className="gap-1.5 bg-green-600 hover:bg-green-700 text-white"
                          disabled={responding[approval.id]}
                          onClick={() => handleRespond(approval.id, 'approved')}
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          className="gap-1.5"
                          disabled={responding[approval.id]}
                          onClick={() => handleRespond(approval.id, 'rejected')}
                        >
                          <XCircle className="h-3.5 w-3.5" />
                          Reject
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/**
 * Renders the entity column. For reservations, fetches the booking detail
 * so the approver sees room + time + requester instead of "Reservation:
 * 12345..." with no context.
 */
function ApprovalEntityCell({ type, id }: { type: string; id: string }) {
  if (type === 'reservation') return <ReservationEntityCell id={id} />;
  // Post-canonicalisation (2026-05-02): the canonical value is now
  // 'booking' (booking-flow.service.ts:733). Legacy 'booking_bundle'
  // may still appear for approvals already pending at rollout time
  // — both route to the same cell since the id is a booking id either way.
  if (type === 'booking' || type === 'booking_bundle') return <BundleEntityCell id={id} />;
  if (type === 'ticket') {
    return (
      <div>
        <Link to={`/desk/tickets/${id}`} className="font-medium hover:underline">
          Ticket
        </Link>
        <span className="block text-xs text-muted-foreground font-mono mt-0.5">
          {id.slice(0, 8)}…
        </span>
      </div>
    );
  }
  return (
    <div>
      <span className="font-medium">{entityTypeLabel(type)}</span>
      <span className="block text-xs text-muted-foreground font-mono mt-0.5">
        {id.slice(0, 8)}…
      </span>
    </div>
  );
}

/**
 * Bundle approver cell.
 *
 * Post-canonicalisation (2026-05-02) the booking IS the bundle (00277:27)
 * and `target_entity_type='booking'` is the canonical value (the legacy
 * 'booking_bundle' value still arrives for in-flight pending approvals
 * during rollout, so both branches in `ApprovalEntityCell` route here).
 * The `useBundle` read endpoint is gone, so the rich line summary that
 * used to live here can't render today — we link to the booking detail
 * page using the approval target id (which IS the booking id) and let
 * the detail page surface room / time / status. The lines + total
 * preview will return when the backend ships replacement reads.
 */
function BundleEntityCell({ id }: { id: string }) {
  return (
    <div className="space-y-1">
      <Link
        to={`/desk/bookings?scope=bundles&id=${id}`}
        className="font-medium hover:underline"
      >
        Booking
      </Link>
      <span className="block text-xs text-muted-foreground font-mono mt-0.5">
        {id.slice(0, 8)}…
      </span>
    </div>
  );
}

function ReservationEntityCell({ id }: { id: string }) {
  const { data: r, isLoading } = useReservationDetail(id);
  if (isLoading) {
    return (
      <div>
        <span className="font-medium">Reservation</span>
        <span className="block text-xs text-muted-foreground mt-0.5">Loading…</span>
      </div>
    );
  }
  if (!r) {
    return (
      <div>
        <span className="font-medium">Reservation</span>
        <span className="block text-xs text-muted-foreground font-mono mt-0.5">
          {id.slice(0, 8)}…
        </span>
      </div>
    );
  }
  return (
    <div>
      <Link
        to={`/desk/bookings?scope=all&id=${r.id}`}
        className="font-medium hover:underline"
      >
        Booking
      </Link>
      <div className="text-xs text-muted-foreground tabular-nums mt-0.5">
        <time dateTime={r.start_at}>{formatFullTimestamp(r.start_at)}</time>
        {' · '}
        {typeof r.attendee_count === 'number' && (
          <span>
            {r.attendee_count} {r.attendee_count === 1 ? 'attendee' : 'attendees'}
          </span>
        )}
      </div>
    </div>
  );
}

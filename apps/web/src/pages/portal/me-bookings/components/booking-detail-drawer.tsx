import { useState } from 'react';
import { Pencil, X } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useReservationDetail, useCheckInBooking, useRestoreBooking } from '@/api/room-booking';
import { formatFullTimestamp } from '@/lib/format';
import { BookingStatusPill } from './booking-status-pill';
import { BookingEditForm } from './booking-edit-form';
import { CancelWithScopeDialog } from './cancel-with-scope-dialog';
import { toast } from 'sonner';

interface Props {
  reservationId: string | null;
  /** Called when the drawer should close (URL is what controls open state). */
  onClose: () => void;
  /** Optional joined display data — useful when the list passes through space names. */
  spaceName?: string | null;
}

/**
 * Right-side drawer per spec §4.2:
 *  - Detail (room, time, attendees, recurrence info)
 *  - Edit affordance (inline form)
 *  - Cancel with recurrence-scope prompt
 *  - Check-in / Restore inline actions
 *  - Calendar sync status pill (placeholder until Phase I ships)
 */
export function BookingDetailDrawer({ reservationId, onClose, spaceName }: Props) {
  const open = Boolean(reservationId);
  const { data: reservation, isPending } = useReservationDetail(reservationId ?? '');
  const [editing, setEditing] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  const checkIn = useCheckInBooking();
  const restore = useRestoreBooking();

  const onCheckIn = async () => {
    if (!reservation) return;
    try {
      await checkIn.mutateAsync(reservation.id);
      toast.success('Checked in');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Check-in failed');
    }
  };

  const onRestore = async () => {
    if (!reservation) return;
    try {
      await restore.mutateAsync(reservation.id);
      toast.success('Booking restored');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Restore failed');
    }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>{spaceName ?? 'Booking'}</SheetTitle>
          <SheetDescription>
            {reservation
              ? `Booked ${formatFullTimestamp(reservation.created_at)}`
              : 'Loading…'}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
          {isPending && !reservation && (
            <div className="text-sm text-muted-foreground">Loading…</div>
          )}

          {reservation && !editing && (
            <>
              <div className="flex items-center justify-between">
                <BookingStatusPill reservation={reservation} />
                {reservation.calendar_event_id && (
                  <Badge variant="outline" className="h-5 text-[10px]">
                    Mirrored to Outlook
                  </Badge>
                )}
              </div>

              <DetailRow label="When">
                <span className="tabular-nums">
                  {formatFullTimestamp(reservation.start_at)} →{' '}
                  {formatFullTimestamp(reservation.end_at)}
                </span>
              </DetailRow>

              <DetailRow label="Attendees">
                {reservation.attendee_count ?? 0} expected
                {reservation.attendee_person_ids.length > 0 && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    · {reservation.attendee_person_ids.length} internal
                  </span>
                )}
              </DetailRow>

              {reservation.check_in_required && (
                <DetailRow label="Check-in">
                  Required within {reservation.check_in_grace_minutes} minutes of start
                  {reservation.checked_in_at && (
                    <span className="ml-2 text-emerald-600 dark:text-emerald-400">
                      · checked in {formatFullTimestamp(reservation.checked_in_at)}
                    </span>
                  )}
                </DetailRow>
              )}

              {reservation.recurrence_series_id && (
                <DetailRow label="Recurrence">
                  Part of a series
                  {reservation.recurrence_index != null &&
                    ` · occurrence #${reservation.recurrence_index + 1}`}
                </DetailRow>
              )}

              {reservation.policy_snapshot.rule_evaluations &&
                reservation.policy_snapshot.rule_evaluations.length > 0 && (
                  <DetailRow label="Rules applied">
                    <ul className="space-y-1 text-xs text-muted-foreground">
                      {reservation.policy_snapshot.rule_evaluations
                        .filter((e) => e.matched)
                        .map((e) => (
                          <li key={e.rule_id}>
                            <code className="chip rounded bg-muted px-1.5 py-0.5 text-[10px]">
                              {e.effect}
                            </code>
                            {e.denial_message && <span className="ml-2">{e.denial_message}</span>}
                          </li>
                        ))}
                    </ul>
                  </DetailRow>
                )}

              <div className="flex flex-wrap gap-2 pt-2">
                {reservation.status === 'confirmed' && reservation.check_in_required && (
                  <Button size="sm" onClick={onCheckIn} disabled={checkIn.isPending}>
                    {checkIn.isPending ? 'Checking in…' : 'Check in'}
                  </Button>
                )}
                {reservation.status === 'cancelled' &&
                  reservation.cancellation_grace_until &&
                  new Date(reservation.cancellation_grace_until).getTime() > Date.now() && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={onRestore}
                      disabled={restore.isPending}
                    >
                      {restore.isPending ? 'Restoring…' : 'Restore'}
                    </Button>
                  )}
                {(reservation.status === 'confirmed' ||
                  reservation.status === 'pending_approval') && (
                  <>
                    <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                      <Pencil className="mr-1.5 size-3.5" /> Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setConfirmingCancel(true)}
                    >
                      <X className="mr-1.5 size-3.5" /> Cancel booking
                    </Button>
                  </>
                )}
              </div>
            </>
          )}

          {reservation && editing && (
            <BookingEditForm reservation={reservation} onClose={() => setEditing(false)} />
          )}
        </div>

        <CancelWithScopeDialog
          open={confirmingCancel}
          onOpenChange={setConfirmingCancel}
          reservation={reservation ?? null}
          isRecurring={Boolean(reservation?.recurrence_series_id)}
          onCancelled={onClose}
        />
      </SheetContent>
    </Sheet>
  );
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-3 text-sm">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

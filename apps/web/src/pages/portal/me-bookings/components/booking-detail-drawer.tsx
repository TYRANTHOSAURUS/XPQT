import { useState } from 'react';
import {
  CalendarClock, CheckCircle2, Pencil, RefreshCw, Users as UsersIcon, X,
} from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  useReservationDetail, useCheckInBooking, useRestoreBooking,
} from '@/api/room-booking';
import { formatFullTimestamp, formatRelativeTime } from '@/lib/format';
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

const TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});
const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
});

/**
 * Right-side drawer per spec §4.2 — detail / edit / cancel / check-in / restore.
 * Layout follows the Linear "list of decisions" pattern: a stack of label →
 * value rows separated by hairlines, with the action group living at the
 * bottom of the scrollable region.
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

  const isPast = reservation && new Date(reservation.end_at).getTime() < Date.now();

  const showCheckIn =
    !!reservation &&
    reservation.status === 'confirmed' &&
    reservation.check_in_required &&
    !reservation.checked_in_at;

  const showRestore =
    !!reservation &&
    reservation.status === 'cancelled' &&
    reservation.cancellation_grace_until !== null &&
    new Date(reservation.cancellation_grace_until!).getTime() > Date.now();

  const showEdit =
    !!reservation &&
    !isPast &&
    (reservation.status === 'confirmed' || reservation.status === 'pending_approval');

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-md p-0">
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle className="text-lg">{spaceName ?? 'Booking'}</SheetTitle>
          <SheetDescription>
            {reservation
              ? `Booked ${formatRelativeTime(reservation.created_at)}`
              : 'Loading…'}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto">
          {isPending && !reservation && (
            <div className="px-5 py-6 text-sm text-muted-foreground">Loading…</div>
          )}

          {reservation && !editing && (
            <div className="flex flex-col">
              {/* Status strip */}
              <div className="flex items-center justify-between gap-2 border-b px-5 py-3">
                <BookingStatusPill reservation={reservation} />
                {reservation.calendar_event_id && (
                  <Badge variant="outline" className="h-5 text-[10px]">
                    Mirrored to Outlook
                  </Badge>
                )}
              </div>

              {/* Meta rows */}
              <div className="divide-y">
                <DetailRow icon={<CalendarClock className="size-3.5" />} label="When">
                  <div className="text-sm tabular-nums">
                    {DATE_FORMATTER.format(new Date(reservation.start_at))}
                  </div>
                  <div className="text-xs text-muted-foreground tabular-nums">
                    {TIME_FORMATTER.format(new Date(reservation.start_at))} –{' '}
                    {TIME_FORMATTER.format(new Date(reservation.end_at))}
                  </div>
                </DetailRow>

                <DetailRow icon={<UsersIcon className="size-3.5" />} label="Attendees">
                  <div className="text-sm">
                    {reservation.attendee_count ?? 0} expected
                  </div>
                  {reservation.attendee_person_ids.length > 0 && (
                    <div className="text-xs text-muted-foreground">
                      {reservation.attendee_person_ids.length} internal · others external
                    </div>
                  )}
                </DetailRow>

                {reservation.check_in_required && (
                  <DetailRow icon={<CheckCircle2 className="size-3.5" />} label="Check-in">
                    {reservation.checked_in_at ? (
                      <div className="text-sm text-emerald-700 dark:text-emerald-400">
                        Checked in {formatRelativeTime(reservation.checked_in_at)}
                      </div>
                    ) : (
                      <div className="text-sm">
                        Required within {reservation.check_in_grace_minutes} minutes of start
                      </div>
                    )}
                  </DetailRow>
                )}

                {reservation.recurrence_series_id && (
                  <DetailRow icon={<RefreshCw className="size-3.5" />} label="Recurrence">
                    <div className="text-sm">Part of a series</div>
                    {reservation.recurrence_index != null && (
                      <div className="text-xs text-muted-foreground">
                        Occurrence #{reservation.recurrence_index + 1}
                      </div>
                    )}
                  </DetailRow>
                )}

                {reservation.policy_snapshot.rule_evaluations &&
                  reservation.policy_snapshot.rule_evaluations.some((e) => e.matched) && (
                    <DetailRow label="Rules applied">
                      <ul className="space-y-1 text-xs">
                        {reservation.policy_snapshot.rule_evaluations
                          .filter((e) => e.matched)
                          .map((e) => (
                            <li key={e.rule_id} className="flex items-start gap-2">
                              <code className="chip mt-0.5 rounded bg-muted px-1.5 py-0.5 text-[10px]">
                                {e.effect}
                              </code>
                              {e.denial_message && (
                                <span className="text-muted-foreground">{e.denial_message}</span>
                              )}
                            </li>
                          ))}
                      </ul>
                    </DetailRow>
                  )}
              </div>

              {/* Actions */}
              {(showCheckIn || showRestore || showEdit) && (
                <div className="border-t px-5 py-3">
                  <div className="flex flex-wrap gap-2">
                    {showCheckIn && (
                      <Button onClick={onCheckIn} disabled={checkIn.isPending}>
                        {checkIn.isPending ? 'Checking in…' : 'Check in'}
                      </Button>
                    )}
                    {showRestore && (
                      <Button
                        variant="outline"
                        onClick={onRestore}
                        disabled={restore.isPending}
                      >
                        {restore.isPending ? 'Restoring…' : 'Restore booking'}
                      </Button>
                    )}
                    {showEdit && (
                      <>
                        <Button variant="outline" onClick={() => setEditing(true)}>
                          <Pencil className="mr-1.5 size-3.5" /> Edit
                        </Button>
                        <Button
                          variant="ghost"
                          className="text-destructive hover:text-destructive hover:bg-destructive/10"
                          onClick={() => setConfirmingCancel(true)}
                        >
                          <X className="mr-1.5 size-3.5" /> Cancel booking
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* Footer: created/updated audit info */}
              <div className="border-t bg-muted/20 px-5 py-3 text-[11px] text-muted-foreground tabular-nums">
                Created {formatFullTimestamp(reservation.created_at)}
                {reservation.updated_at !== reservation.created_at && (
                  <span className="block">
                    Last updated {formatRelativeTime(reservation.updated_at)}
                  </span>
                )}
              </div>
            </div>
          )}

          {reservation && editing && (
            <div className="px-5 py-5">
              <BookingEditForm reservation={reservation} onClose={() => setEditing(false)} />
            </div>
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
  icon,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[120px_1fr] items-start gap-3 px-5 py-3">
      <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
        {icon}
        {label}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

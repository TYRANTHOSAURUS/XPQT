import { useState } from 'react';
import {
  CalendarClock, CheckCircle2, Pencil, RefreshCw, Users as UsersIcon, X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  useReservationDetail, useCheckInBooking, useRestoreBooking,
} from '@/api/room-booking';
import { formatFullTimestamp, formatRelativeTime } from '@/lib/format';
import { BookingStatusPill } from './booking-status-pill';
import { BookingEditForm } from './booking-edit-form';
import { BundleServicesSection } from './bundle-services-section';
import { CancelWithScopeDialog } from './cancel-with-scope-dialog';
import { toastError, toastSuccess } from '@/lib/toast';

const TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});
const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
});

export interface BookingDetailContentProps {
  reservationId: string | null;
  /** Called when nested cancel/edit/check-in flows want to dismiss the surface. */
  onDismiss?: () => void;
}

/**
 * Shared body of the booking detail surface. Renders status strip, meta rows,
 * bundle services, action buttons, and audit footer. Wrapped by:
 *   - BookingDetailDrawer (Sheet, portal)
 *   - BookingDetailPanel  (split-pane right side, desk)
 *   - BookingDetailPage   (full route, desk)
 *
 * Header chrome (title / ref / relative-time) is owned by each wrapper since
 * Sheet vs SettingsPageHeader vs inline panel header have different rules.
 */
export function BookingDetailContent({ reservationId, onDismiss }: BookingDetailContentProps) {
  const { data: reservation, isPending } = useReservationDetail(reservationId ?? '');
  const [editing, setEditing] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  const checkIn = useCheckInBooking();
  const restore = useRestoreBooking();

  if (isPending && !reservation) {
    return <div className="px-5 py-6 text-sm text-muted-foreground">Loading…</div>;
  }
  if (!reservation) return null;

  const isPast = new Date(reservation.end_at).getTime() < Date.now();

  const showCheckIn =
    reservation.status === 'confirmed' &&
    reservation.check_in_required &&
    !reservation.checked_in_at;

  const showRestore =
    reservation.status === 'cancelled' &&
    reservation.cancellation_grace_until !== null &&
    new Date(reservation.cancellation_grace_until!).getTime() > Date.now();

  const showEdit =
    !isPast && (reservation.status === 'confirmed' || reservation.status === 'pending_approval');

  const onCheckIn = async () => {
    try {
      await checkIn.mutateAsync(reservation.id);
      toastSuccess('Checked in');
    } catch (e) {
      toastError("Couldn't check in", { error: e, retry: onCheckIn });
    }
  };

  const onRestore = async () => {
    try {
      await restore.mutateAsync(reservation.id);
      toastSuccess('Booking restored');
    } catch (e) {
      toastError("Couldn't restore booking", { error: e, retry: onRestore });
    }
  };

  if (editing) {
    return (
      <div className="px-5 py-5">
        <BookingEditForm reservation={reservation} onClose={() => setEditing(false)} />
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-5 py-3">
        <BookingStatusPill reservation={reservation} />
        {reservation.calendar_event_id && (
          <Badge variant="outline" className="h-5 text-[10px]">
            Mirrored to Outlook
          </Badge>
        )}
      </div>

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
          <div className="text-sm">{reservation.attendee_count ?? 0} expected</div>
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

      {reservation.booking_bundle_id && (
        <BundleServicesSection bundleId={reservation.booking_bundle_id} />
      )}

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

      <div className="border-t bg-muted/20 px-5 py-3 text-[11px] text-muted-foreground tabular-nums">
        Created {formatFullTimestamp(reservation.created_at)}
        {reservation.updated_at !== reservation.created_at && (
          <span className="block">
            Last updated {formatRelativeTime(reservation.updated_at)}
          </span>
        )}
      </div>

      <CancelWithScopeDialog
        open={confirmingCancel}
        onOpenChange={setConfirmingCancel}
        reservation={reservation}
        isRecurring={Boolean(reservation.recurrence_series_id)}
        onCancelled={onDismiss}
      />
    </div>
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

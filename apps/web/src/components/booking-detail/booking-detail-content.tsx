import { useMemo, useState } from 'react';
import {
  ArrowLeftRight, CalendarClock, CheckCircle2, Layers, MapPin, Pencil, RefreshCw,
  Users as UsersIcon, X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { SpaceSelect } from '@/components/space-select';
import { Link } from 'react-router-dom';
import {
  useReservationDetail, useCheckInBooking, useRestoreBooking, useEditBooking,
  useReservationGroupSiblings,
} from '@/api/room-booking';
import { useSpaces } from '@/api/spaces';
import { useAuth } from '@/providers/auth-provider';
import { formatFullTimestamp, formatRelativeTime } from '@/lib/format';
import { NumberStepper } from '@/components/ui/number-stepper';
import { BookingStatusPill } from './booking-status-pill';
import { BookingEditForm } from './booking-edit-form';
import { BundleServicesSection } from './bundle-services-section';
import { BundleWorkOrdersSection } from './bundle-work-orders-section';
import { CancelWithScopeDialog } from './cancel-with-scope-dialog';
import { toastError, toastSuccess, toastUpdated } from '@/lib/toast';

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
  /**
   * Which surface this body is rendering inside. Drives sibling-chip link
   * targets (portal users can't reach `/desk/*`) and any other surface-
   * dependent affordance. Defaults to `'desk'` for back-compat with the
   * existing operator wrappers.
   */
  surface?: 'portal' | 'desk';
}

/**
 * Shared body of the booking detail surface. Renders status strip, meta rows,
 * bundle services, action buttons, and audit footer. Wrapped by:
 *   - MyBookingDetailPage (portal full route, /portal/me/bookings/:id)
 *   - BookingDetailPanel  (desk split-pane right side)
 *   - BookingDetailPage   (desk full route, /desk/bookings/:id)
 *
 * Header chrome (title / ref / relative-time) is owned by each wrapper since
 * the page header / inline panel header / portal back-link have different
 * rules.
 */
export function BookingDetailContent({
  reservationId,
  onDismiss,
  surface = 'desk',
}: BookingDetailContentProps) {
  const { data: reservation, isPending } = useReservationDetail(reservationId ?? '');
  const { data: spaces } = useSpaces();
  const { hasRole } = useAuth();
  const [editOpen, setEditOpen] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [changingRoom, setChangingRoom] = useState(false);
  const [nextSpaceId, setNextSpaceId] = useState<string>('');

  // Sibling chip targets must match the surface we're rendering inside —
  // portal users can't reach /desk/* routes (and vice versa).
  const siblingHrefBase =
    surface === 'portal' ? '/portal/me/bookings' : '/desk/bookings';

  // Build a "Building › Floor › Room" trail for the Where row. The
  // server-computed `space_path` (via the SQL `public.space_path` fn) is
  // authoritative — it avoids fetching the full tenant tree just to
  // walk parents. We fall back to a client-side walk via `useSpaces()`
  // for legacy reservation responses that pre-date the API change.
  const wherePath = useMemo(() => {
    if (!reservation) return null;
    if (reservation.space_path && reservation.space_path.length > 0) {
      return reservation.space_path;
    }
    if (!spaces) return null;
    const byId = new Map(spaces.map((s) => [s.id, s] as const));
    const trail: string[] = [];
    let cursor = byId.get(reservation.space_id);
    let safety = 8;
    while (cursor && safety-- > 0) {
      trail.unshift(cursor.name);
      if (!cursor.parent_id) break;
      cursor = byId.get(cursor.parent_id);
    }
    return trail.length > 0 ? trail : null;
  }, [reservation, spaces]);

  // Multi-room siblings — fetched only when this reservation has a group
  // so solo bookings don't pay the round-trip. The component below renders
  // a chip strip so the operator can navigate to any sibling room without
  // leaving the booking detail context.
  const groupSiblings = useReservationGroupSiblings(
    reservationId ?? '',
    Boolean(reservation?.multi_room_group_id),
  );

  // Service desk / admin is rendering this — they always need to SEE the
  // children of a booking (services, work orders, multi-room) even when
  // the booking is past or has nothing attached. The requester surface
  // hides empty sections to keep the page clean; the operator surface
  // never does, because "nothing here" is itself important information
  // for someone investigating a booking.
  const isOperator = hasRole('agent');

  const checkIn = useCheckInBooking();
  const restore = useRestoreBooking();
  const editBooking = useEditBooking();

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

  // Multi-room bookings promise atomic time + cancellation across siblings
  // (CLAUDE.md spec line). The current single-reservation PATCH/cancel
  // endpoints only operate on `this` reservation, which would silently
  // break that promise. Until group-scoped endpoints exist, gate the
  // mutating actions on multi-room bookings and route the user to the
  // desk for the change.
  const isMultiRoom = Boolean(reservation.multi_room_group_id);

  const isEditableStatus =
    !isPast && (reservation.status === 'confirmed' || reservation.status === 'pending_approval');
  const showEdit = isEditableStatus && !isMultiRoom;
  const showChangeRoom = showEdit; // same gate; rendered on the Where row
  const showMultiRoomLockedNotice = isEditableStatus && isMultiRoom;

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
        <DetailRow icon={<MapPin className="size-3.5" />} label="Where">
          {wherePath ? (
            <>
              <div className="text-sm">{wherePath[wherePath.length - 1]}</div>
              {wherePath.length > 1 && (
                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                  {wherePath.slice(0, -1).join(' › ')}
                </div>
              )}
            </>
          ) : (
            <div className="text-sm text-muted-foreground">Loading…</div>
          )}
          {showChangeRoom && (
            <Button
              variant="outline"
              size="sm"
              className="mt-2 h-7 text-xs"
              onClick={() => {
                setNextSpaceId(reservation.space_id);
                setChangingRoom(true);
              }}
            >
              <ArrowLeftRight className="mr-1 size-3" />
              Change room
            </Button>
          )}
          {showMultiRoomLockedNotice && (
            <div className="mt-1.5 text-[11px] text-muted-foreground">
              Multi-room bookings need to change rooms together — contact the desk.
            </div>
          )}
        </DetailRow>

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
          {showEdit ? (
            <div className="flex items-center gap-2">
              <NumberStepper
                value={reservation.attendee_count ?? 1}
                onChange={() => {
                  // Optimistic local change is no-op — onCommit drives the
                  // mutation. We rely on react-query to refresh the row.
                }}
                onCommit={async (next) => {
                  if (next === (reservation.attendee_count ?? 0)) return;
                  try {
                    await editBooking.mutateAsync({
                      id: reservation.id,
                      patch: { attendee_count: next },
                    });
                    toastUpdated('Attendee count');
                  } catch (e) {
                    toastError("Couldn't update attendees", { error: e });
                  }
                }}
                min={1}
                max={500}
                size="sm"
                aria-label="Attendees"
                suffix={(reservation.attendee_count ?? 1) === 1 ? 'person' : 'people'}
              />
              {reservation.attendee_person_ids.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  · {reservation.attendee_person_ids.length} internal
                </span>
              )}
            </div>
          ) : (
            <>
              <div className="text-sm">{reservation.attendee_count ?? 0} expected</div>
              {reservation.attendee_person_ids.length > 0 && (
                <div className="text-xs text-muted-foreground">
                  {reservation.attendee_person_ids.length} internal · others external
                </div>
              )}
            </>
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

        {reservation.multi_room_group_id && (
          <DetailRow icon={<Layers className="size-3.5" />} label="Multi-room">
            {groupSiblings.data && groupSiblings.data.items.length > 1 ? (
              <>
                <div className="text-sm">
                  Part of a {groupSiblings.data.items.length}-room group
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {groupSiblings.data.items.map((s) => {
                    const isCurrent = s.id === reservation.id;
                    return isCurrent ? (
                      <span
                        key={s.id}
                        className="inline-flex h-6 items-center rounded-full bg-foreground px-2.5 text-[11px] font-medium text-background"
                        aria-current="page"
                      >
                        {s.space_name ?? 'Room'}
                      </span>
                    ) : (
                      <Link
                        key={s.id}
                        to={`${siblingHrefBase}/${s.id}`}
                        className="inline-flex h-6 items-center rounded-full border bg-card px-2.5 text-[11px] [transition:background-color_120ms_var(--ease-snap)] hover:bg-accent/40"
                      >
                        {s.space_name ?? 'Room'}
                      </Link>
                    );
                  })}
                </div>
              </>
            ) : (
              <div className="text-sm">Part of a multi-room group</div>
            )}
            <div className="mt-1 text-xs text-muted-foreground">
              All rooms share the same start/end. To change time or cancel,
              contact the desk so all rooms are updated together.
            </div>
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

      <BundleServicesSection
        reservation={reservation}
        canEdit={showEdit}
        alwaysShow={isOperator}
      />

      {/* Work-orders / cases attached to this booking. Mounts only when
          a bundle exists (no bundle = no work orders). For operators,
          the header always renders with an explicit empty state so a
          dispatched-yet booking is distinguishable from a not-yet-
          dispatched one. Requesters see nothing when there are no
          tickets — work orders are an operator concept. */}
      {reservation.booking_bundle_id && (
        <BundleWorkOrdersSection
          bundleId={reservation.booking_bundle_id}
          alwaysShow={isOperator}
        />
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
                <Button variant="outline" onClick={() => setEditOpen(true)}>
                  <Pencil className="mr-1.5 size-3.5" /> Edit time
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

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit booking time</DialogTitle>
            <DialogDescription>
              Adjust the date, start, or duration. Attendees can be edited
              inline on the booking page; services have their own controls
              under "Services."
            </DialogDescription>
          </DialogHeader>
          <BookingEditForm
            reservation={reservation}
            onClose={() => setEditOpen(false)}
          />
        </DialogContent>
      </Dialog>

      <ChangeRoomDialog
        open={changingRoom}
        onOpenChange={(open) => {
          if (!open) {
            setChangingRoom(false);
            setNextSpaceId('');
          }
        }}
        currentSpaceId={reservation.space_id}
        nextSpaceId={nextSpaceId}
        onNextSpaceIdChange={setNextSpaceId}
        saving={editBooking.isPending}
        onConfirm={async () => {
          if (!nextSpaceId || nextSpaceId === reservation.space_id) {
            setChangingRoom(false);
            return;
          }
          try {
            await editBooking.mutateAsync({
              id: reservation.id,
              patch: { space_id: nextSpaceId },
            });
            toastUpdated('Room');
            setChangingRoom(false);
            setNextSpaceId('');
          } catch (e) {
            toastError("Couldn't change room", { error: e });
          }
        }}
      />
    </div>
  );
}

function ChangeRoomDialog({
  open,
  onOpenChange,
  currentSpaceId,
  nextSpaceId,
  onNextSpaceIdChange,
  saving,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentSpaceId: string;
  nextSpaceId: string;
  onNextSpaceIdChange: (id: string) => void;
  saving: boolean;
  onConfirm: () => Promise<void>;
}) {
  const disabled =
    saving || !nextSpaceId || nextSpaceId === currentSpaceId;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change room</DialogTitle>
          <DialogDescription>
            The booking moves to the new room at the same time. The server
            re-runs availability + rules and rejects the change if the new
            room is busy.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="change-room-select">New room</FieldLabel>
            <SpaceSelect
              id="change-room-select"
              value={nextSpaceId}
              onChange={onNextSpaceIdChange}
              typeFilter={['room']}
              placeholder="Pick a room"
              emptyLabel={null}
            />
            <FieldDescription>
              Services keep their relative timing. If your services were
              scoped to the old room, you may need to adjust them.
            </FieldDescription>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={disabled}>
            {saving ? 'Saving…' : 'Change room'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  // Stack on small screens — the 120px label column eats too much
  // horizontal inside a max-w-2xl portal page on a 390px iPhone.
  return (
    <div className="grid grid-cols-1 items-start gap-1 px-5 py-3 sm:grid-cols-[120px_1fr] sm:gap-3">
      <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
        {icon}
        {label}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

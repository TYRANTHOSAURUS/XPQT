import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { toastError, toastSuccess } from '@/lib/toast';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { PersonPicker } from '@/components/person-picker';
import { useCreateBooking, type SchedulerRoom } from '@/api/room-booking';
import { ApiError } from '@/lib/api';
import { formatFullTimestamp } from '@/lib/format';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  room: SchedulerRoom | null;
  startAtIso: string;
  endAtIso: string;
  /**
   * Operator's own person id — the safe default when the toolbar's
   * "Booking for" picker is empty. Used as the seed for the per-booking
   * picker inside this dialog.
   */
  currentUserPersonId: string;
  /**
   * Toolbar-scoped requester. When set, this dialog seeds with that person
   * (the common "operator runs through a queue of bookings on someone's
   * behalf" flow). The dialog still lets the operator override per booking,
   * because real desks routinely take a request "actually this one is for
   * Sarah" mid-queue and we don't want to make them go fix the toolbar.
   */
  toolbarBookForPersonId: string | null;
  onCreated?: () => void;
}

/**
 * Quick-create form fired when the operator releases a drag-create on an
 * empty cell. Composed from Field primitives per CLAUDE.md mandate.
 *
 * Implementation: rendered as a Dialog (centered) instead of a true
 * positioned Popover because the gesture's release point is unstable
 * during a drag — a centered modal avoids "popover lands off-screen on a
 * fast release".
 */
export function SchedulerCreatePopover({
  open,
  onOpenChange,
  room,
  startAtIso,
  endAtIso,
  currentUserPersonId,
  toolbarBookForPersonId,
  onCreated,
}: Props) {
  const [attendeeCount, setAttendeeCount] = useState(2);
  // Per-dialog requester. Seeded from the toolbar's "Booking for" when set,
  // else the operator's own person id. Editable inline so a desk agent can
  // book on behalf of one person without committing the rest of their
  // session to that requester.
  const [requesterPersonId, setRequesterPersonId] = useState<string>('');
  // Persist the last error inside the dialog so the operator can read it
  // without chasing a toast that fades. We clear it on every fresh attempt
  // so a successful retry leaves no stale alert.
  const [submitError, setSubmitError] = useState<string | null>(null);
  const create = useCreateBooking();

  useEffect(() => {
    if (!open) return;
    const seed = room?.min_attendees && room.min_attendees > 0 ? room.min_attendees : 2;
    setAttendeeCount(seed);
    setRequesterPersonId(toolbarBookForPersonId ?? currentUserPersonId);
    setSubmitError(null);
  }, [
    open,
    room?.space_id,
    room?.min_attendees,
    startAtIso,
    toolbarBookForPersonId,
    currentUserPersonId,
  ]);

  if (!room) return null;
  const overCapacity =
    typeof room.capacity === 'number' && room.capacity > 0 && attendeeCount > room.capacity;

  const submit = async () => {
    if (!requesterPersonId) {
      setSubmitError('Pick who this booking is for.');
      return;
    }
    setSubmitError(null);
    try {
      await create.mutateAsync({
        space_id: room.space_id,
        requester_person_id: requesterPersonId,
        start_at: startAtIso,
        end_at: endAtIso,
        attendee_count: attendeeCount,
        source: 'desk',
      });
      toastSuccess(`Booked ${room.name}`);
      onCreated?.();
      onOpenChange(false);
    } catch (e) {
      const message =
        e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Booking failed';
      // Show inline AND toast: inline keeps the explanation under the
      // button so the operator can read why it failed without losing the
      // dialog state; the toast catches eyes that are tracking the page.
      setSubmitError(message);
      toastError(`Couldn't book ${room.name}`, { error: e, retry: submit });
    }
  };

  const isSelf = requesterPersonId === currentUserPersonId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Book {room.name}</DialogTitle>
          <DialogDescription>
            {formatFullTimestamp(startAtIso)} – {formatFullTimestamp(endAtIso)}
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="scheduler-create-requester">Booking for</FieldLabel>
            <PersonPicker
              value={requesterPersonId || null}
              onChange={(id) => setRequesterPersonId(id || currentUserPersonId)}
              placeholder="Pick a person"
              clearLabel={isSelf ? null : 'Book as myself'}
            />
            <FieldDescription>
              {isSelf
                ? 'You — change to book on behalf of someone else.'
                : 'Switch back to yourself with the clear button below.'}
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="scheduler-create-attendees">Attendees</FieldLabel>
            <Input
              id="scheduler-create-attendees"
              type="number"
              inputMode="numeric"
              min={1}
              max={500}
              value={attendeeCount}
              onChange={(e) => setAttendeeCount(Math.max(1, Number(e.target.value || 1)))}
              className="tabular-nums"
            />
            <FieldDescription>
              {overCapacity ? (
                <span className="text-destructive">
                  Over capacity — room seats {room.capacity}.
                </span>
              ) : (
                <>
                  Capacity: <span className="tabular-nums">{room.capacity ?? '—'}</span>
                  {room.min_attendees && room.min_attendees > 0 ? (
                    <>
                      {' '}· Min:{' '}
                      <span className="tabular-nums">{room.min_attendees}</span>
                    </>
                  ) : null}
                </>
              )}
            </FieldDescription>
          </Field>
        </FieldGroup>

        {submitError && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          >
            <AlertTriangle className="size-3.5 shrink-0 translate-y-0.5" />
            <p className="leading-relaxed">{submitError}</p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending || !requesterPersonId}>
            {create.isPending ? 'Booking…' : 'Book'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { useCreateBooking, type RankedRoom } from '@/api/room-booking';
import { ApiError } from '@/lib/api';
import { formatFullTimestamp } from '@/lib/format';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  room: RankedRoom | null;
  startAtIso: string;
  endAtIso: string;
  requesterPersonId: string;
  bookForName?: string | null;
  onCreated?: () => void;
}

/**
 * Quick-create form fired when the operator releases a drag-create on an
 * empty cell. Composed from Field primitives per CLAUDE.md mandate.
 * The popover opens with (space_id, start_at, end_at) pre-filled and a
 * single editable input — attendee count — because the rest is implicit
 * from the gesture.
 *
 * Implementation: rendered as a Dialog (centered) instead of a true
 * positioned Popover because the gesture's release point is unstable
 * during a drag — a centered modal avoids "popover lands off-screen on a
 * fast release". UX-equivalent for keyboard users; better for everyone
 * else.
 */
export function SchedulerCreatePopover({
  open,
  onOpenChange,
  room,
  startAtIso,
  endAtIso,
  requesterPersonId,
  bookForName,
  onCreated,
}: Props) {
  const [attendeeCount, setAttendeeCount] = useState(2);
  const create = useCreateBooking();

  useEffect(() => {
    // Reset when re-opened on a different cell.
    if (open) setAttendeeCount(2);
  }, [open, room?.space_id, startAtIso]);

  if (!room) return null;

  const submit = async () => {
    try {
      await create.mutateAsync({
        space_id: room.space_id,
        requester_person_id: requesterPersonId,
        start_at: startAtIso,
        end_at: endAtIso,
        attendee_count: attendeeCount,
        source: 'desk',
      });
      toast.success(`Booked ${room.name}`);
      onCreated?.();
      onOpenChange(false);
    } catch (e) {
      const message =
        e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Booking failed';
      toast.error(message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Book {room.name}</DialogTitle>
          <DialogDescription>
            {bookForName ? `For ${bookForName}.` : 'For yourself.'}{' '}
            {formatFullTimestamp(startAtIso)} – {formatFullTimestamp(endAtIso)}
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
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
              Capacity: {room.capacity ?? 'unspecified'}.
            </FieldDescription>
          </Field>
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending}>
            {create.isPending ? 'Booking…' : 'Book'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

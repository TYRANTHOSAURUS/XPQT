import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useEditBooking } from '@/api/room-booking';
import type { Reservation } from '@/api/room-booking';
import { toast } from 'sonner';

interface Props {
  reservation: Reservation;
  onClose: () => void;
}

/**
 * Inline edit form inside the booking detail drawer. Spec §4.3:
 * editing time or room re-runs availability + rules, so we keep this
 * narrow — just the fields that don't need a fresh picker.
 *
 * Time fields are split into local-tz date + start + duration. The form
 * patches via `useEditBooking` (PATCH /reservations/:id), which the API
 * accepts only for non-recurring or for occurrence-overrides; the
 * "this and following / entire series" path lives in a dedicated dialog
 * (Phase G).
 */
export function BookingEditForm({ reservation, onClose }: Props) {
  const [date, setDate] = useState(toLocalDate(reservation.start_at));
  const [startTime, setStartTime] = useState(toLocalTime(reservation.start_at));
  const [durationMinutes, setDurationMinutes] = useState(
    durationMin(reservation.start_at, reservation.end_at),
  );
  const [attendeeCount, setAttendeeCount] = useState(reservation.attendee_count ?? 1);

  useEffect(() => {
    setDate(toLocalDate(reservation.start_at));
    setStartTime(toLocalTime(reservation.start_at));
    setDurationMinutes(durationMin(reservation.start_at, reservation.end_at));
    setAttendeeCount(reservation.attendee_count ?? 1);
  }, [reservation.id, reservation.start_at, reservation.end_at, reservation.attendee_count]);

  const edit = useEditBooking();

  const submit = async () => {
    const startIso = new Date(`${date}T${startTime}:00`).toISOString();
    if (!Number.isFinite(new Date(startIso).getTime())) {
      toast.error('Pick a valid date and time');
      return;
    }
    const endIso = new Date(
      new Date(startIso).getTime() + durationMinutes * 60_000,
    ).toISOString();

    try {
      await edit.mutateAsync({
        id: reservation.id,
        patch: {
          start_at: startIso,
          end_at: endIso,
          attendee_count: attendeeCount,
        },
      });
      toast.success('Booking updated');
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Update failed');
    }
  };

  return (
    <FieldGroup>
      <FieldSet>
        <FieldLegend variant="label">Time</FieldLegend>
        <div className="grid grid-cols-3 gap-2">
          <Field>
            <FieldLabel htmlFor="edit-date">Date</FieldLabel>
            <Input
              id="edit-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="text-sm tabular-nums"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="edit-time">Start</FieldLabel>
            <Input
              id="edit-time"
              type="time"
              step={900}
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className="text-sm tabular-nums"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="edit-duration">Duration</FieldLabel>
            <Input
              id="edit-duration"
              type="number"
              min={15}
              step={15}
              value={durationMinutes}
              onChange={(e) =>
                setDurationMinutes(Math.max(15, Number(e.target.value || 60)))
              }
            />
          </Field>
        </div>
        <FieldDescription>Changing time re-runs the rule resolver server-side.</FieldDescription>
      </FieldSet>

      <Field>
        <FieldLabel htmlFor="edit-attendees">Attendees</FieldLabel>
        <Input
          id="edit-attendees"
          type="number"
          min={1}
          value={attendeeCount}
          onChange={(e) => setAttendeeCount(Math.max(1, Number(e.target.value || 1)))}
        />
      </Field>

      <div className="flex justify-end gap-2 pt-2">
        <Button variant="outline" onClick={onClose} disabled={edit.isPending}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={edit.isPending}>
          {edit.isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </FieldGroup>
  );
}

function toLocalDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function toLocalTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mi}`;
}

function durationMin(startIso: string, endIso: string): number {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 60;
  return Math.round(ms / 60_000);
}

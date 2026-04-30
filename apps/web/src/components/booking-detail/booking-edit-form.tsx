import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
} from '@/components/ui/field';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { DateTimePicker } from '@/components/ui/date-time-picker';
import { useEditBooking } from '@/api/room-booking';
import type { Reservation } from '@/api/room-booking';
import { toastError, toastUpdated } from '@/lib/toast';

interface Props {
  reservation: Reservation;
  onClose: () => void;
}

const DURATION_OPTIONS = [15, 30, 45, 60, 90, 120, 180, 240];

/**
 * Booking time editor mounted inside the "Edit time" dialog on the booking
 * detail page. Scoped to date / start / duration only. Attendees is edited
 * inline on the page (NumberStepper); room is edited via the dedicated
 * "Change room" dialog. Editing time re-runs availability + rules
 * server-side per spec §4.3.
 */
export function BookingEditForm({ reservation, onClose }: Props) {
  const [date, setDate] = useState(toLocalDate(reservation.start_at));
  const [startTime, setStartTime] = useState(toLocalTime(reservation.start_at));
  const [durationMinutes, setDurationMinutes] = useState(
    durationMin(reservation.start_at, reservation.end_at),
  );

  useEffect(() => {
    setDate(toLocalDate(reservation.start_at));
    setStartTime(toLocalTime(reservation.start_at));
    setDurationMinutes(durationMin(reservation.start_at, reservation.end_at));
  }, [reservation.id, reservation.start_at, reservation.end_at]);

  const edit = useEditBooking();

  const startIso = useMemo(() => {
    const iso = date && startTime ? new Date(`${date}T${startTime}:00`).toISOString() : '';
    return Number.isFinite(new Date(iso).getTime()) ? iso : '';
  }, [date, startTime]);
  const canSubmit = startIso.length > 0 && !edit.isPending;

  const submit = async () => {
    if (!canSubmit) return;
    const endIso = new Date(
      new Date(startIso).getTime() + durationMinutes * 60_000,
    ).toISOString();

    try {
      await edit.mutateAsync({
        id: reservation.id,
        patch: {
          start_at: startIso,
          end_at: endIso,
        },
      });
      toastUpdated('Booking');
      onClose();
    } catch (e) {
      toastError("Couldn't update booking", { error: e, retry: submit });
    }
  };

  return (
    <FieldGroup>
      <FieldSet>
        <FieldLegend variant="label">When</FieldLegend>
        <Field>
          <FieldLabel htmlFor="edit-date">Date &amp; start</FieldLabel>
          <DateTimePicker
            id="edit-date"
            date={date}
            time={startTime}
            onDateChange={setDate}
            onTimeChange={setStartTime}
            minDate={new Date()}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="edit-duration">Duration</FieldLabel>
          <Select
            value={String(durationMinutes)}
            onValueChange={(v) => setDurationMinutes(Number(v))}
          >
            <SelectTrigger id="edit-duration">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DURATION_OPTIONS.map((m) => (
                <SelectItem key={m} value={String(m)}>
                  {formatDurationLabel(m)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <FieldDescription>Changing time re-runs the rule resolver server-side.</FieldDescription>
      </FieldSet>

      <div className="flex justify-end gap-2 pt-2">
        <Button variant="outline" onClick={onClose} disabled={edit.isPending}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={!canSubmit}>
          {edit.isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </FieldGroup>
  );
}

function formatDurationLabel(mins: number): string {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
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

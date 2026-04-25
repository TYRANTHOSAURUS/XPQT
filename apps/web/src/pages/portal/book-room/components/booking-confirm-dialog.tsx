import { useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldSeparator,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCreateBooking, useMultiRoomBooking } from '@/api/room-booking';
import type { RankedRoom, RecurrenceRule } from '@/api/room-booking';
import { formatFullTimestamp } from '@/lib/format';
import { toast } from 'sonner';
import { Sparkles } from 'lucide-react';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Primary room the user clicked Book on. */
  primaryRoom: RankedRoom | null;
  /** Optional additional rooms when in multi-room mode. */
  additionalRooms?: RankedRoom[];
  startAtIso: string;
  endAtIso: string;
  attendeeCount: number;
  /** Internal-attendee person ids (empty when the simple flow is used). */
  attendeePersonIds?: string[];
  /** Pre-existing recurrence rule (empty when the simple flow is used). */
  recurrenceRule?: RecurrenceRule | null;
  requesterPersonId: string;
  /**
   * Initially-expanded section based on which footer chip the user clicked.
   * Reserved for future use — Phase D ships every section in the dialog;
   * Phase G will collapse advanced sections and use this to auto-open one.
   */
  initialFocus?: 'identity' | 'attendees' | 'multi-room' | 'recurring';
  onBooked: () => void;
}

/**
 * Confirms a booking before submission. Per §4.3 we surface:
 *  - Identity (you / on-behalf — locked to current user in v1 portal)
 *  - Time + room recap
 *  - Internal attendees (read-only summary today; v1 portal sends the count)
 *  - Recurrence (Daily / Weekly + interval, end-after / end-by)
 *  - Multi-room recap
 *
 * Errors from the booking pipeline (deny / pending approval / 409 race)
 * surface as inline alerts that name the rule's `denial_message` per §4.10.
 */
export function BookingConfirmDialog({
  open,
  onOpenChange,
  primaryRoom,
  additionalRooms = [],
  startAtIso,
  endAtIso,
  attendeeCount,
  attendeePersonIds = [],
  recurrenceRule = null,
  requesterPersonId,
  initialFocus: _initialFocus,
  onBooked,
}: Props) {
  const [recurring, setRecurring] = useState<boolean>(Boolean(recurrenceRule));
  const [frequency, setFrequency] = useState<RecurrenceRule['frequency']>(
    recurrenceRule?.frequency ?? 'weekly',
  );
  const [interval, setIntervalValue] = useState<number>(recurrenceRule?.interval ?? 1);
  const [count, setCount] = useState<number>(recurrenceRule?.count ?? 8);

  // Re-seed every time the dialog opens with a new room (cancel-then-reopen
  // shouldn't carry stale recurrence picks).
  useEffect(() => {
    if (!open) return;
    setRecurring(Boolean(recurrenceRule));
    setFrequency(recurrenceRule?.frequency ?? 'weekly');
    setIntervalValue(recurrenceRule?.interval ?? 1);
    setCount(recurrenceRule?.count ?? 8);
  }, [open, recurrenceRule]);

  const createBooking = useCreateBooking();
  const multiBooking = useMultiRoomBooking();
  const submitting = createBooking.isPending || multiBooking.isPending;

  const isMultiRoom = additionalRooms.length > 0;
  const isApprovalRoute =
    primaryRoom?.rule_outcome?.effect === 'require_approval';

  const onConfirm = async () => {
    if (!primaryRoom) return;

    const recurrencePayload: RecurrenceRule | undefined = recurring
      ? { frequency, interval, count }
      : undefined;

    try {
      if (isMultiRoom) {
        await multiBooking.mutateAsync({
          space_ids: [primaryRoom.space_id, ...additionalRooms.map((r) => r.space_id)],
          requester_person_id: requesterPersonId,
          start_at: startAtIso,
          end_at: endAtIso,
          attendee_count: attendeeCount,
          attendee_person_ids: attendeePersonIds.length ? attendeePersonIds : undefined,
        });
      } else {
        await createBooking.mutateAsync({
          space_id: primaryRoom.space_id,
          requester_person_id: requesterPersonId,
          start_at: startAtIso,
          end_at: endAtIso,
          attendee_count: attendeeCount,
          attendee_person_ids: attendeePersonIds.length ? attendeePersonIds : undefined,
          recurrence_rule: recurrencePayload,
          source: 'portal',
        });
      }
      toast.success(isApprovalRoute ? 'Approval requested' : 'Booked');
      onBooked();
      onOpenChange(false);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to create booking';
      toast.error(message);
    }
  };

  const denialFromRoom = primaryRoom?.rule_outcome?.denial_message;
  const conflictAlternatives = extractAlternatives(
    createBooking.error ?? multiBooking.error,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isApprovalRoute ? 'Request approval to book' : 'Confirm booking'}
          </DialogTitle>
          <DialogDescription>
            {primaryRoom ? primaryRoom.name : '—'}
            {isMultiRoom ? ` and ${additionalRooms.length} more ${additionalRooms.length === 1 ? 'room' : 'rooms'}` : ''}
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="confirm-when">When</FieldLabel>
            <Input
              id="confirm-when"
              readOnly
              value={`${formatHuman(startAtIso)} → ${formatHuman(endAtIso)}`}
              className="text-sm tabular-nums"
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="confirm-attendees">Attendees</FieldLabel>
            <Input
              id="confirm-attendees"
              readOnly
              value={`${attendeeCount} ${attendeeCount === 1 ? 'person' : 'people'}${attendeePersonIds.length ? ` · ${attendeePersonIds.length} internal` : ''}`}
            />
            {attendeePersonIds.length > 0 && (
              <FieldDescription>
                Internal attendees see the booking on their calendar.
              </FieldDescription>
            )}
          </Field>

          {isApprovalRoute && denialFromRoom && (
            <div className="rounded-md border border-purple-500/30 bg-purple-500/5 px-3 py-2 text-xs text-purple-800 dark:text-purple-300">
              <Sparkles className="mr-1 inline size-3" />
              {denialFromRoom}
            </div>
          )}

          {isMultiRoom && (
            <FieldSet>
              <FieldLegend variant="label">Rooms in this booking</FieldLegend>
              <FieldDescription>
                All rooms book atomically — if one fails the whole group rolls back.
              </FieldDescription>
              <ul className="space-y-1 text-xs">
                {[primaryRoom, ...additionalRooms].filter(Boolean).map((r) => (
                  <li
                    key={r!.space_id}
                    className="flex items-center justify-between rounded-md border bg-card px-2 py-1.5"
                  >
                    <span>{r!.name}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {r!.capacity ?? '—'} cap
                    </span>
                  </li>
                ))}
              </ul>
            </FieldSet>
          )}

          {!isMultiRoom && (
            <>
              <FieldSeparator />
              <FieldSet>
                <FieldLegend variant="label">Recurrence</FieldLegend>
                <Field orientation="horizontal">
                  <Switch
                    id="confirm-recurring"
                    checked={recurring}
                    onCheckedChange={setRecurring}
                  />
                  <FieldLabel htmlFor="confirm-recurring" className="font-normal">
                    Make this a recurring booking
                  </FieldLabel>
                </Field>

                {recurring && (
                  <div className="grid grid-cols-3 gap-2">
                    <Field>
                      <FieldLabel htmlFor="confirm-recur-freq">Repeats</FieldLabel>
                      <Select
                        value={frequency}
                        onValueChange={(v) => setFrequency(v as RecurrenceRule['frequency'])}
                      >
                        <SelectTrigger id="confirm-recur-freq">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="daily">Daily</SelectItem>
                          <SelectItem value="weekly">Weekly</SelectItem>
                          <SelectItem value="monthly">Monthly</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="confirm-recur-interval">Every</FieldLabel>
                      <Input
                        id="confirm-recur-interval"
                        type="number"
                        min={1}
                        max={12}
                        value={interval}
                        onChange={(e) =>
                          setIntervalValue(Math.max(1, Number(e.target.value || 1)))
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="confirm-recur-count">Occurrences</FieldLabel>
                      <Input
                        id="confirm-recur-count"
                        type="number"
                        min={1}
                        max={365}
                        value={count}
                        onChange={(e) =>
                          setCount(Math.max(1, Number(e.target.value || 1)))
                        }
                      />
                    </Field>
                  </div>
                )}
              </FieldSet>
            </>
          )}

          {conflictAlternatives.length > 0 && (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs space-y-2"
            >
              <p className="font-medium text-destructive">
                Someone booked this slot before you. Try one of these:
              </p>
              <ul className="space-y-1">
                {conflictAlternatives.slice(0, 3).map((alt) => (
                  <li key={alt.space_id} className="flex justify-between">
                    <span>{alt.name}</span>
                    <span className="text-muted-foreground">
                      {alt.capacity ?? '—'} cap
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={submitting || !primaryRoom}>
            {submitting
              ? 'Submitting…'
              : isApprovalRoute
                ? 'Submit for approval'
                : isMultiRoom
                  ? 'Book all rooms'
                  : 'Confirm booking'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function extractAlternatives(error: unknown): RankedRoom[] {
  if (!(error instanceof ApiError)) return [];
  if (error.status !== 409) return [];
  const details = error.details;
  if (
    typeof details === 'object' &&
    details !== null &&
    'alternatives' in details &&
    Array.isArray((details as { alternatives?: unknown }).alternatives)
  ) {
    return (details as { alternatives: RankedRoom[] }).alternatives;
  }
  return [];
}

function formatHuman(iso: string): string {
  if (!iso) return '—';
  return formatFullTimestamp(iso) || '—';
}

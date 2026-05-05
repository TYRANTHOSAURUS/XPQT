import { useEffect, useState } from 'react';
import { toastError, toastSuccess } from '@/lib/toast';
import { AlertTriangle, ShieldAlert } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { InlineBanner } from '@/components/ui/inline-banner';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { useCreateBooking, type SchedulerRoom } from '@/api/room-booking';
import { formatFullTimestamp } from '@/lib/format';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  room: SchedulerRoom | null;
  startAtIso: string;
  endAtIso: string;
  requesterPersonId: string;
  bookForName?: string | null;
  /** The denial message from the rule, surfaced verbatim so the operator
   * sees what they're overriding. */
  denialMessage?: string | null;
  onCreated?: () => void;
}

/**
 * Override-with-reason dialog. Per spec §4.4: "clicking a denied cell
 * offers 'Override this rule? Reason: ___' with mandatory reason and
 * high-visibility audit." The reason is required (min 5 chars) and is
 * forwarded as `override_reason` on the create payload — the API gates
 * this on `rooms.override_rules` permission.
 *
 * High-visibility chrome: destructive accent + Shield icon + verbatim
 * denial message reproduction.
 */
export function SchedulerOverrideDialog({
  open,
  onOpenChange,
  room,
  startAtIso,
  endAtIso,
  requesterPersonId,
  bookForName,
  denialMessage,
  onCreated,
}: Props) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const create = useCreateBooking();

  useEffect(() => {
    if (open) {
      setReason('');
      setTouched(false);
    }
  }, [open]);

  if (!room) return null;

  const tooShort = reason.trim().length < 5;

  const submit = async () => {
    setTouched(true);
    if (tooShort) return;
    // B.0.E.3 — mutation-attempt-scoped request id (spec §3.3); React
    // Query retries reuse it. The toast retry callback re-enters submit()
    // and gets a fresh id, which is correct: an explicit user retry is a
    // new logical attempt, not a continuation of the prior one.
    const requestId = crypto.randomUUID();
    try {
      await create.mutateAsync({
        payload: {
          space_id: room.space_id,
          requester_person_id: requesterPersonId,
          start_at: startAtIso,
          end_at: endAtIso,
          attendee_count: 1,
          source: 'desk',
          override_reason: reason.trim(),
        },
        requestId,
      });
      toastSuccess(`Override booked: ${room.name}`);
      onCreated?.();
      onOpenChange(false);
    } catch (e) {
      toastError(`Couldn't book override for ${room.name}`, { error: e, retry: submit });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <ShieldAlert className="size-4" />
            Override rule for {room.name}?
          </DialogTitle>
          <DialogDescription>
            {bookForName ? `For ${bookForName}.` : 'For yourself.'}{' '}
            {formatFullTimestamp(startAtIso)} – {formatFullTimestamp(endAtIso)}
          </DialogDescription>
        </DialogHeader>

        {denialMessage && (
          <InlineBanner tone="destructive" icon={AlertTriangle}>
            <div className="font-medium text-destructive">Rule denial</div>
            <p className="mt-0.5 text-muted-foreground">{denialMessage}</p>
          </InlineBanner>
        )}

        <FieldGroup>
          <Field data-invalid={touched && tooShort ? '' : undefined}>
            <FieldLabel htmlFor="scheduler-override-reason">Reason</FieldLabel>
            <Textarea
              id="scheduler-override-reason"
              rows={3}
              placeholder="Why are you overriding this rule? This reason is logged and visible in the audit trail."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onBlur={() => setTouched(true)}
            />
            <FieldDescription>
              Required. The reason appears in the audit log and any compliance reports.
            </FieldDescription>
            {touched && tooShort && (
              <FieldError>Reason must be at least 5 characters.</FieldError>
            )}
          </Field>
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={submit} disabled={create.isPending || tooShort}>
            {create.isPending ? 'Overriding…' : 'Confirm override'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

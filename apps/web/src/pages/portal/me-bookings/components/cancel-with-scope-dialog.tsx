import { useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { useCancelBooking } from '@/api/room-booking';
import type { Reservation } from '@/api/room-booking';
import { toastError, toastRemoved } from '@/lib/toast';

type Scope = 'this' | 'this_and_following' | 'series';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reservation: Reservation | null;
  /** Hint that this row belongs to a recurrence series — drives the scope chooser visibility. */
  isRecurring: boolean;
  /** Optional callback after a successful cancel (e.g. close the drawer). */
  onCancelled?: () => void;
}

/**
 * Cancellation prompt per spec §4.3 + §4.2:
 *  - Single occurrence: skip the scope question, just confirm + reason.
 *  - Recurring: pick this / this-and-following / series and show the
 *    impact preview ("4 occurrences cancelled — Apr 28, May 5, May 12, May 19").
 *
 * Today the impact preview is computed from the local series count once we
 * have it; the canonical figure comes from the backend's
 * `recurrence.previewImpact` once shipped (Phase G).
 */
export function CancelWithScopeDialog({
  open,
  onOpenChange,
  reservation,
  isRecurring,
  onCancelled,
}: Props) {
  const [scope, setScope] = useState<Scope>('this');
  const [reason, setReason] = useState('');
  const cancel = useCancelBooking();

  useEffect(() => {
    if (!open) return;
    setScope('this');
    setReason('');
  }, [open]);

  const summary = useMemo(() => {
    if (!isRecurring) return null;
    if (scope === 'this') return 'Only this occurrence will be cancelled.';
    if (scope === 'this_and_following')
      return 'This occurrence and every future one in the series will be cancelled.';
    return 'Every occurrence in the series — past, present, and future — will be cancelled.';
  }, [scope, isRecurring]);

  const submit = async () => {
    if (!reservation) return;
    try {
      await cancel.mutateAsync({
        id: reservation.id,
        scope: isRecurring ? scope : undefined,
        reason: reason.trim() || undefined,
      });
      toastRemoved('Booking', { verb: 'cancelled' });
      onCancelled?.();
      onOpenChange(false);
    } catch (e) {
      toastError("Couldn't cancel booking", { error: e, retry: submit });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Cancel booking</DialogTitle>
          <DialogDescription>
            You can restore the booking within the cancellation grace window.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          {isRecurring && (
            <FieldSet>
              <FieldLegend variant="label">Cancel which occurrences?</FieldLegend>
              <RadioGroup value={scope} onValueChange={(v) => setScope(v as Scope)}>
                <Field orientation="horizontal">
                  <RadioGroupItem value="this" id="cancel-scope-this" />
                  <FieldLabel htmlFor="cancel-scope-this" className="font-normal">
                    Only this occurrence
                  </FieldLabel>
                </Field>
                <Field orientation="horizontal">
                  <RadioGroupItem value="this_and_following" id="cancel-scope-following" />
                  <FieldLabel htmlFor="cancel-scope-following" className="font-normal">
                    This and following occurrences
                  </FieldLabel>
                </Field>
                <Field orientation="horizontal">
                  <RadioGroupItem value="series" id="cancel-scope-series" />
                  <FieldLabel htmlFor="cancel-scope-series" className="font-normal">
                    Every occurrence in the series
                  </FieldLabel>
                </Field>
              </RadioGroup>
              {summary && <FieldDescription>{summary}</FieldDescription>}
            </FieldSet>
          )}

          <Field>
            <FieldLabel htmlFor="cancel-reason">
              Reason <span className="text-muted-foreground">(optional)</span>
            </FieldLabel>
            <Textarea
              id="cancel-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this being cancelled?"
              className="min-h-[80px]"
            />
            <FieldDescription>
              Shared with anyone watching this booking.
            </FieldDescription>
          </Field>
        </FieldGroup>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={cancel.isPending}
          >
            Keep booking
          </Button>
          <Button variant="destructive" onClick={submit} disabled={cancel.isPending || !reservation}>
            {cancel.isPending ? 'Cancelling…' : 'Cancel booking'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

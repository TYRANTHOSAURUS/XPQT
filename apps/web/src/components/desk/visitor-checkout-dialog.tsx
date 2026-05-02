/**
 * Checkout dialog — confirm pass return on visitor check-out.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §7.6
 *
 * Three outcomes:
 *   - "Returned" → pass goes back to available.
 *   - "Missing"  → pass marked lost (with reason).
 *   - "Skip"     → leave pass state alone for the loose-ends tile to
 *                  reconcile later.
 *
 * If the visitor has no pass assigned, the dialog still shows a confirm
 * affordance but skips the pass section entirely.
 */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Field, FieldLabel } from '@/components/ui/field';
import { useMarkCheckedOut } from '@/api/visitors/reception';
import { toastError, toastSuccess } from '@/lib/toast';

type PassDecision = 'returned' | 'missing' | 'skip';

interface CheckoutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  buildingId: string | null;
  visitorId: string;
  visitorLabel: string;
  /** True if the visitor currently holds a pass (drives the pass-return UI). */
  hasPass: boolean;
}

export function CheckoutDialog({
  open,
  onOpenChange,
  buildingId,
  visitorId,
  visitorLabel,
  hasPass,
}: CheckoutDialogProps) {
  const [decision, setDecision] = useState<PassDecision>('returned');
  const checkout = useMarkCheckedOut(buildingId);

  const handleConfirm = async () => {
    try {
      await checkout.mutateAsync({
        visitorId,
        checkout_source: 'reception',
        pass_returned:
          !hasPass || decision === 'skip'
            ? undefined
            : decision === 'returned',
      });
      toastSuccess(`${visitorLabel} checked out`);
      onOpenChange(false);
    } catch (err) {
      toastError("Couldn't check out the visitor", {
        error: err,
        retry: handleConfirm,
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Check out {visitorLabel}</DialogTitle>
          {hasPass ? (
            <DialogDescription>
              Did the visitor return their pass?
            </DialogDescription>
          ) : (
            <DialogDescription>
              Confirm the visitor has left.
            </DialogDescription>
          )}
        </DialogHeader>

        {hasPass && (
          <Field>
            <FieldLabel>Pass return</FieldLabel>
            <RadioGroup
              value={decision}
              onValueChange={(v) => setDecision(v as PassDecision)}
            >
              <Field orientation="horizontal">
                <RadioGroupItem value="returned" id="pass-returned" />
                <FieldLabel htmlFor="pass-returned" className="font-normal">
                  Returned — back into the pool
                </FieldLabel>
              </Field>
              <Field orientation="horizontal">
                <RadioGroupItem value="missing" id="pass-missing" />
                <FieldLabel htmlFor="pass-missing" className="font-normal">
                  Missing — mark the pass as lost
                </FieldLabel>
              </Field>
              <Field orientation="horizontal">
                <RadioGroupItem value="skip" id="pass-skip" />
                <FieldLabel htmlFor="pass-skip" className="font-normal">
                  Skip — reconcile later
                </FieldLabel>
              </Field>
            </RadioGroup>
          </Field>
        )}

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={checkout.isPending}
          >
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={checkout.isPending}>
            {checkout.isPending ? 'Checking out…' : 'Confirm check-out'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

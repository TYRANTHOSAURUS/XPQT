import { useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { toastSuccess } from '@/lib/toast';
import {
  Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import {
  Field, FieldDescription, FieldError, FieldGroup, FieldLabel,
} from '@/components/ui/field';
import { RequestTypePicker } from '@/components/request-type-picker';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { ReclassifyImpactPanel } from './reclassify-impact-panel';
import { useReclassifyPreview, useReclassifyTicket } from '@/hooks/use-reclassify';

interface ReclassifyTicketDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ticketId: string;
  currentRequestType: { id: string; name: string } | null;
  onReclassified: () => void;
}

type Stage = 'pick' | 'preview';

export function ReclassifyTicketDialog({
  open,
  onOpenChange,
  ticketId,
  currentRequestType,
  onReclassified,
}: ReclassifyTicketDialogProps) {
  const [stage, setStage] = useState<Stage>('pick');
  const [newTypeId, setNewTypeId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [ackInProgress, setAckInProgress] = useState(false);

  const preview = useReclassifyPreview(stage === 'preview' ? ticketId : null, newTypeId);
  const mutation = useReclassifyTicket(ticketId);

  const impact = preview.data;
  const hasInProgressChildren = (impact?.children ?? []).some((c) => c.is_in_progress);
  const reasonTrimmed = reason.trim();
  const reasonTooShort = reason.length > 0 && reasonTrimmed.length < 3;
  const canConfirm =
    stage === 'preview' &&
    !!impact &&
    reasonTrimmed.length >= 3 &&
    reason.length <= 500 &&
    (!hasInProgressChildren || ackInProgress) &&
    !mutation.submitting;

  function reset() {
    setStage('pick');
    setNewTypeId(null);
    setReason('');
    setAckInProgress(false);
    mutation.reset();
  }

  async function onConfirm() {
    if (!impact || !newTypeId) return;
    try {
      await mutation.execute({
        newRequestTypeId: newTypeId,
        reason: reasonTrimmed,
        acknowledgedChildrenInProgress: ackInProgress,
      });
      toastSuccess(`Reclassified to ${impact.ticket.new_request_type.name}`, {
        description: `${impact.children.length} work order${impact.children.length === 1 ? '' : 's'} closed.`,
      });
      reset();
      onOpenChange(false);
      onReclassified();
    } catch {
      // mutation.error is rendered in the banner; nothing else to do here.
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <SheetContent className="w-[720px] sm:max-w-[720px] lg:w-[760px] lg:max-w-[760px] flex flex-col gap-0">
        <SheetHeader>
          <SheetTitle>
            {stage === 'pick'
              ? 'Change request type'
              : `Change request type → ${impact?.ticket.new_request_type.name ?? ''}`}
          </SheetTitle>
          <SheetDescription>
            Current:{' '}
            <span className="text-foreground">
              {currentRequestType?.name ?? '(no type)'}
            </span>
          </SheetDescription>
        </SheetHeader>

        {mutation.error && (
          <div className="mx-6 mt-4 rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive flex items-start gap-2">
            <AlertCircle className="size-4 mt-0.5 flex-shrink-0" />
            <span>{mutation.error.message}</span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {stage === 'pick' && (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="reclassify-new-type">New request type</FieldLabel>
                <RequestTypePicker
                  id="reclassify-new-type"
                  value={newTypeId ?? ''}
                  onChange={(id) => setNewTypeId(id || null)}
                  excludeIds={currentRequestType ? [currentRequestType.id] : undefined}
                  placeholder="Pick a request type"
                />
                <FieldDescription>
                  Switching type will reset this ticket&apos;s workflow and SLA. You&apos;ll
                  see a full impact preview before confirming.
                </FieldDescription>
              </Field>
            </FieldGroup>
          )}

          {stage === 'preview' && (
            <>
              {preview.loading && (
                <p className="text-sm text-muted-foreground">Loading impact preview…</p>
              )}
              {preview.error && (
                <div className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
                  {preview.error.message}
                </div>
              )}
              {impact && (
                <>
                  <ReclassifyImpactPanel impact={impact} />
                  {hasInProgressChildren && (
                    <div className="mt-5 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
                      <FieldGroup>
                        <Field orientation="horizontal">
                          <Checkbox
                            id="ack-wip"
                            checked={ackInProgress}
                            onCheckedChange={(c) => setAckInProgress(c === true)}
                          />
                          <FieldLabel htmlFor="ack-wip" className="font-normal text-sm">
                            I understand work in progress will be stopped and the vendor notified.
                          </FieldLabel>
                        </Field>
                      </FieldGroup>
                    </div>
                  )}
                  <div className="mt-5">
                    <FieldGroup>
                      <Field>
                        <FieldLabel htmlFor="reclassify-reason">Reason (required)</FieldLabel>
                        <Textarea
                          id="reclassify-reason"
                          rows={3}
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          maxLength={500}
                          placeholder="Why is this being reclassified?"
                        />
                        <FieldDescription>
                          Shown on this ticket, on each closed child work order, and in the
                          audit log.
                        </FieldDescription>
                        {reasonTooShort && (
                          <FieldError>Reason must be at least 3 characters.</FieldError>
                        )}
                      </Field>
                    </FieldGroup>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        <SheetFooter className="border-t px-6 py-4">
          {stage === 'pick' ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={() => setStage('preview')} disabled={!newTypeId}>
                Preview →
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setStage('pick')}>
                ← Back
              </Button>
              <Button onClick={onConfirm} disabled={!canConfirm}>
                {mutation.submitting ? 'Reclassifying…' : 'Confirm reclassify'}
              </Button>
            </>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

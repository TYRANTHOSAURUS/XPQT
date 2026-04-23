import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';

const PAUSE_REASON_OPTIONS = [
  { value: 'requester', label: 'Waiting on requester', description: 'Ticket is awaiting a response from the person who opened it.' },
  { value: 'vendor', label: 'Waiting on vendor', description: 'An external vendor is working the ticket.' },
  { value: 'scheduled_work', label: 'Scheduled work', description: 'Work is booked for a future time — clock pauses until it starts.' },
];

interface SlaPauseReasonsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string[];
  onSave: (reasons: string[]) => void;
  saving?: boolean;
}

export function SlaPauseReasonsDialog({ open, onOpenChange, value, onSave, saving }: SlaPauseReasonsDialogProps) {
  const [selected, setSelected] = useState<string[]>(value);
  useEffect(() => { if (open) setSelected(value); }, [open, value]);

  const toggle = (v: string) =>
    setSelected((prev) => (prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Pause conditions</DialogTitle>
          <DialogDescription>
            When a ticket enters one of these waiting states, SLA timers pause until the state clears.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {PAUSE_REASON_OPTIONS.map((opt) => (
            <Field key={opt.value} orientation="horizontal" className="items-start">
              <Checkbox
                id={`pause-${opt.value}`}
                checked={selected.includes(opt.value)}
                onCheckedChange={() => toggle(opt.value)}
                className="mt-0.5"
              />
              <div className="flex flex-col gap-0.5">
                <FieldLabel htmlFor={`pause-${opt.value}`} className="font-medium">
                  {opt.label}
                </FieldLabel>
                <span className="text-xs text-muted-foreground">{opt.description}</span>
              </div>
            </Field>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => onSave(selected)} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

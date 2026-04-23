import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SlaThresholdRow, isThresholdValid } from '@/components/admin/sla-threshold-row';
import type { EscalationThreshold } from '@/api/sla-policies';

interface SlaThresholdsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: EscalationThreshold[];
  onSave: (thresholds: EscalationThreshold[]) => void;
  saving?: boolean;
}

export function SlaThresholdsDialog({ open, onOpenChange, value, onSave, saving }: SlaThresholdsDialogProps) {
  const [items, setItems] = useState<EscalationThreshold[]>(value);
  useEffect(() => { if (open) setItems(value); }, [open, value]);

  const add = () =>
    setItems((prev) => [
      ...prev,
      { at_percent: 100, timer_type: 'resolution', action: 'notify', target_type: 'user', target_id: null },
    ]);
  const update = (i: number, next: EscalationThreshold) =>
    setItems((prev) => prev.map((t, idx) => (idx === i ? next : t)));
  const remove = (i: number) => setItems((prev) => prev.filter((_, idx) => idx !== i));

  const allValid = items.every(isThresholdValid);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[780px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Escalation thresholds</DialogTitle>
          <DialogDescription>
            Fire actions when an SLA timer reaches a percent of its target. Thresholds apply to
            response, resolution, or both.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          {items.length === 0 && (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No thresholds yet. Add one to notify or escalate as SLA approaches breach.
            </p>
          )}
          {items.map((t, i) => (
            <SlaThresholdRow
              key={i}
              index={i}
              value={t}
              onChange={(next) => update(i, next)}
              onRemove={() => remove(i)}
            />
          ))}
          <Button variant="outline" size="sm" onClick={add} className="self-start gap-1.5 mt-1">
            <Plus className="size-3.5" />
            Add threshold
          </Button>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => onSave(items)} disabled={!allValid || saving}>
            {saving ? 'Saving…' : 'Save thresholds'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

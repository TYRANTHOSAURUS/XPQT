import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

interface KeyValue {
  key: string;
  value: string;
}

interface WebhookKeyValueDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  keyLabel: string;
  valueLabel: string;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  /** Current object state — key → value. */
  value: Record<string, string>;
  onSave: (next: Record<string, string>) => void;
  saving?: boolean;
}

/**
 * Generic key/value editor — used for both field_mapping (ticket field → JSONPath)
 * and ticket_defaults (ticket field → scalar default). Keeps values as strings;
 * callers can coerce if they need non-string defaults.
 */
export function WebhookKeyValueDialog({
  open,
  onOpenChange,
  title,
  description,
  keyLabel,
  valueLabel,
  keyPlaceholder,
  valuePlaceholder,
  value,
  onSave,
  saving,
}: WebhookKeyValueDialogProps) {
  const [rows, setRows] = useState<KeyValue[]>([]);

  useEffect(() => {
    if (!open) return;
    const next = Object.entries(value ?? {}).map(([k, v]) => ({
      key: k,
      value: typeof v === 'string' ? v : JSON.stringify(v),
    }));
    setRows(next.length > 0 ? next : [{ key: '', value: '' }]);
  }, [open, value]);

  const updateRow = (idx: number, patch: Partial<KeyValue>) =>
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  const addRow = () => setRows((prev) => [...prev, { key: '', value: '' }]);
  const removeRow = (idx: number) => setRows((prev) => prev.filter((_, i) => i !== idx));

  const handleSave = () => {
    const next: Record<string, string> = {};
    for (const r of rows) {
      const k = r.key.trim();
      if (!k) continue;
      next[k] = r.value;
    }
    onSave(next);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground px-1">
            <span className="flex-1">{keyLabel}</span>
            <span className="flex-1">{valueLabel}</span>
            <span className="w-8" />
          </div>

          {rows.map((row, idx) => (
            <div key={idx} className="flex items-start gap-2">
              <Input
                placeholder={keyPlaceholder ?? 'title'}
                className="font-mono text-xs flex-1"
                value={row.key}
                onChange={(e) => updateRow(idx, { key: e.target.value })}
              />
              <Input
                placeholder={valuePlaceholder ?? '$.issue.title'}
                className="font-mono text-xs flex-1"
                value={row.value}
                onChange={(e) => updateRow(idx, { value: e.target.value })}
              />
              <Button
                variant="ghost"
                size="sm"
                className="size-8 shrink-0"
                onClick={() => removeRow(idx)}
                disabled={rows.length === 1}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}

          <Button variant="outline" size="sm" onClick={addRow} className="self-start gap-1.5">
            <Plus className="size-3.5" />
            Add {keyLabel.toLowerCase()}
          </Button>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

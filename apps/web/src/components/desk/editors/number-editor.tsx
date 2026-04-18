import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface NumberEditorProps {
  value: number | null;
  /** Noun used in the empty-state affordance and input placeholder (e.g. "cost" → "+ Add cost"). */
  placeholder?: string;
  /** Prefix rendered inside the input (e.g. "$"). */
  prefix?: string;
  /** Formatter for the trigger-button display. */
  formatDisplay?: (value: number | null) => string;
  onChange: (next: number | null) => void;
  disabled?: boolean;
}

export function NumberEditor({
  value,
  placeholder = 'value',
  prefix,
  formatDisplay,
  onChange,
  disabled,
}: NumberEditorProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string>(value != null ? String(value) : '');
  const [error, setError] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(value != null ? String(value) : '');
      setError(false);
    }
  }, [open, value]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === '') {
      onChange(null);
      setOpen(false);
      return;
    }
    const parsed = Number(trimmed);
    if (Number.isNaN(parsed)) {
      setError(true);
      return;
    }
    onChange(parsed);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        render={
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              'h-8 w-full justify-start px-2 text-sm font-normal',
              value == null && 'text-muted-foreground',
            )}
          />
        }
      >
        {value == null
          ? `+ Add ${placeholder}`
          : formatDisplay
            ? formatDisplay(value)
            : `${prefix ?? ''}${value}`}
      </PopoverTrigger>
      <PopoverContent className="p-2 w-[200px]" align="start">
        <div className="flex items-center gap-1.5">
          {prefix && <span className="text-sm text-muted-foreground">{prefix}</span>}
          <Input
            type="number"
            value={draft}
            placeholder={placeholder}
            autoFocus
            onChange={(e) => { setDraft(e.target.value); setError(false); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commit(); }
              if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
            }}
            className={cn('h-8', error && 'border-red-500 focus-visible:ring-red-500/30')}
          />
        </div>
        <div className="flex justify-end gap-1.5 mt-2">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
          <Button size="sm" onClick={commit}>Save</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

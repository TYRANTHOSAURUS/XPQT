import { ReactNode, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface EntityOption {
  id: string;
  label: string;
  sublabel?: string | null;
}

export interface EntityPickerProps {
  /** Current selection id, or null if none. */
  value: string | null;
  /** All selectable options. For small lists we filter client-side; for large lists pass `onSearch`. */
  options: EntityOption[];
  /** Label shown in the trigger when nothing is selected. */
  placeholder?: string;
  /** What to render inside the trigger when a value IS selected. Defaults to the matched option's label. */
  renderValue?: (option: EntityOption | null) => ReactNode;
  /** Shown as the first command item; selecting it calls onChange(null). */
  clearLabel?: string | null;
  /** Optional custom filter function. Default: case-insensitive label substring match. */
  filter?: (option: EntityOption, query: string) => boolean;
  onChange: (next: EntityOption | null) => void;
  /** Disables the trigger. */
  disabled?: boolean;
  /** Width of the popover content. Defaults to the trigger's width. */
  contentWidth?: number;
}

const defaultFilter = (option: EntityOption, query: string) => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    option.label.toLowerCase().includes(q) ||
    (option.sublabel?.toLowerCase().includes(q) ?? false)
  );
};

export function EntityPicker({
  value,
  options,
  placeholder = 'Select…',
  renderValue,
  clearLabel,
  filter = defaultFilter,
  onChange,
  disabled,
  contentWidth,
}: EntityPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const selected = useMemo(() => options.find((o) => o.id === value) ?? null, [options, value]);
  const visible = useMemo(() => options.filter((o) => filter(o, query)), [options, query, filter]);

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(''); }}>
      <PopoverTrigger
        disabled={disabled}
        render={
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              'h-8 w-full justify-start px-2 text-sm font-normal',
              !selected && 'text-muted-foreground',
            )}
          />
        }
      >
        {renderValue ? renderValue(selected) : selected?.label ?? `+ ${placeholder}`}
      </PopoverTrigger>
      <PopoverContent className="p-1" align="start" style={contentWidth ? { width: contentWidth } : undefined}>
        <Command shouldFilter={false}>
          <CommandInput placeholder={placeholder} value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty className="py-4 text-center text-xs text-muted-foreground">
              No results.
            </CommandEmpty>
            <CommandGroup>
              {clearLabel && (
                <CommandItem
                  value="__clear__"
                  onSelect={() => { onChange(null); setOpen(false); }}
                  className="text-muted-foreground"
                >
                  {clearLabel}
                </CommandItem>
              )}
              {visible.map((option) => (
                <CommandItem
                  key={option.id}
                  value={`${option.label} ${option.sublabel ?? ''}`}
                  onSelect={() => { onChange(option); setOpen(false); }}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="truncate">{option.label}</span>
                  {option.sublabel && (
                    <span className="truncate text-[11px] text-muted-foreground">{option.sublabel}</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

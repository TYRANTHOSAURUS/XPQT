import { ReactNode, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { CheckIcon, XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PickerItemBody, type PickerOption } from './picker-item';

export type EntityOption = PickerOption;

export interface EntityPickerProps {
  /** Current selection id, or null if none. */
  value: string | null;
  /** All selectable options. For small lists we filter client-side; for large lists pass `onSearch`. */
  options: EntityOption[];
  /** Noun used in the empty-state affordance and search input (e.g. "team" → "+ Add team"). */
  placeholder?: string;
  /** What to render inside the trigger when a value IS selected. Defaults to the matched option's label. */
  renderValue?: (option: EntityOption | null) => ReactNode;
  /** Label for the clear action. Rendered as a footer button (not as a list item) and only when a value is selected. */
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
  placeholder = 'item',
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
        {renderValue ? renderValue(selected) : selected?.label ?? `+ Add ${placeholder}`}
      </PopoverTrigger>
      <PopoverContent
        className="p-0 min-w-[260px]"
        align="start"
        style={contentWidth ? { width: contentWidth } : undefined}
      >
        <Command shouldFilter={false}>
          <CommandInput placeholder={`Search ${placeholder}…`} value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty className="py-6 text-center text-xs text-muted-foreground">
              No results.
            </CommandEmpty>
            <CommandGroup>
              {visible.map((option) => {
                const isSelected = option.id === value;
                return (
                  <CommandItem
                    key={option.id}
                    value={`${option.label} ${option.sublabel ?? ''}`}
                    onSelect={() => { onChange(option); setOpen(false); }}
                    className="py-2"
                  >
                    <PickerItemBody
                      leading={option.leading}
                      label={option.label}
                      sublabel={option.sublabel}
                      trailing={isSelected ? <CheckIcon className="h-4 w-4 text-foreground" /> : null}
                    />
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
          {clearLabel && value !== null && (
            <>
              <CommandSeparator />
              <div className="p-1">
                <button
                  type="button"
                  onClick={() => { onChange(null); setOpen(false); }}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-sm text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground"
                >
                  <XIcon className="h-3.5 w-3.5" />
                  {clearLabel}
                </button>
              </div>
            </>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}

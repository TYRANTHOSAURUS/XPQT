import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { CheckIcon, PlusIcon, XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PickerItemBody, type PickerOption } from './picker-item';

export type MultiSelectOption = PickerOption;

export interface MultiSelectPickerProps {
  values: string[];
  options: MultiSelectOption[];
  /** Noun used in the empty-state affordance and search input (e.g. "label" → "+ Add label"). */
  placeholder?: string;
  /** When true, typing a query that doesn't match any option shows "Create \"…\"". */
  allowCreate?: boolean;
  /** When provided, selected values render as removable pills inside the trigger. */
  renderPills?: boolean;
  onChange: (next: string[]) => void;
  disabled?: boolean;
}

export function MultiSelectPicker({
  values,
  options,
  placeholder = 'item',
  allowCreate = false,
  renderPills = true,
  onChange,
  disabled,
}: MultiSelectPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const selectedSet = useMemo(() => new Set(values), [values]);

  const visibleOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        (o.sublabel?.toLowerCase().includes(q) ?? false),
    );
  }, [options, query]);

  const exactMatch = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return options.some((o) => o.label.toLowerCase() === q);
  }, [options, query]);

  const toggle = (id: string) => {
    if (selectedSet.has(id)) {
      onChange(values.filter((v) => v !== id));
    } else {
      onChange([...values, id]);
    }
  };

  const createFromQuery = () => {
    const q = query.trim();
    if (!q) return;
    if (!values.includes(q)) onChange([...values, q]);
    setQuery('');
  };

  const remove = (id: string) => onChange(values.filter((v) => v !== id));

  const selectedLabels = useMemo(() => {
    return values.map((v) => {
      const match = options.find((o) => o.id === v);
      return { id: v, label: match?.label ?? v };
    });
  }, [values, options]);

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(''); }}>
      <PopoverTrigger
        disabled={disabled}
        render={
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              'h-auto min-h-8 w-full justify-start px-2 py-1 text-sm font-normal',
              values.length === 0 && 'text-muted-foreground',
            )}
          />
        }
      >
        {values.length === 0 ? (
          <span>+ Add {placeholder}</span>
        ) : renderPills ? (
          <div className="flex flex-wrap gap-1">
            {selectedLabels.map((s) => (
              <Badge
                key={s.id}
                variant="secondary"
                className="text-xs gap-1"
                onClick={(e) => { e.stopPropagation(); remove(s.id); }}
              >
                {s.label}
                <XIcon className="h-3 w-3 opacity-60" />
              </Badge>
            ))}
          </div>
        ) : (
          <span>{values.length} selected</span>
        )}
      </PopoverTrigger>
      <PopoverContent className="p-0 min-w-[300px]" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={`Search ${placeholder}…`}
            value={query}
            onValueChange={setQuery}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && allowCreate && !exactMatch && query.trim()) {
                e.preventDefault();
                createFromQuery();
              }
            }}
          />
          <CommandList>
            <CommandEmpty className="py-4 text-center text-xs text-muted-foreground">
              {allowCreate && query.trim() ? (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 hover:text-foreground"
                  onClick={createFromQuery}
                >
                  <PlusIcon className="h-3 w-3" /> Create "{query.trim()}"
                </button>
              ) : (
                'No results.'
              )}
            </CommandEmpty>
            <CommandGroup>
              {visibleOptions.map((option) => {
                const checked = selectedSet.has(option.id);
                return (
                  <CommandItem
                    key={option.id}
                    value={`${option.label} ${option.sublabel ?? ''}`}
                    onSelect={() => toggle(option.id)}
                    className="py-2"
                  >
                    <PickerItemBody
                      leading={
                        <span className="flex items-center gap-2.5">
                          <span
                            className={cn(
                              'flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border border-input transition-colors',
                              checked && 'bg-primary border-primary text-primary-foreground',
                            )}
                          >
                            {checked && <CheckIcon className="h-3 w-3" />}
                          </span>
                          {option.leading}
                        </span>
                      }
                      label={option.label}
                      sublabel={option.sublabel}
                    />
                  </CommandItem>
                );
              })}
              {allowCreate && query.trim() && !exactMatch && (
                <CommandItem
                  value={`__create__${query}`}
                  onSelect={createFromQuery}
                  className="text-muted-foreground"
                >
                  <PlusIcon className="mr-2 h-3 w-3" />
                  Create "{query.trim()}"
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

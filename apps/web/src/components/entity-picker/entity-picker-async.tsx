import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronsUpDown, X, Loader2 } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getEntityAdapter } from './registry';
import type { EntityType } from './types';

/**
 * Async, adapter-backed combobox for picking a single entity by id.
 *
 * Why this exists alongside `@/components/desk/editors/entity-picker`:
 *   That one takes a pre-fetched static `options` array — fine for tickets'
 *   small per-row pickers but doesn't scale to "all persons in tenant" or
 *   "every catalog item." This one resolves an `entityType` to an adapter
 *   that owns the search + detail React Query options, so each call site
 *   gets the right caching + search behavior for free.
 *
 * Spec: docs/superpowers/specs/2026-04-27-visual-rule-builder-design.md §8.
 */
export interface EntityPickerAsyncProps {
  entityType: EntityType;
  value: string | null;
  onChange: (id: string | null) => void;
  /** Forwarded to the adapter's searchQueryOptions filter param. */
  filter?: Record<string, unknown>;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  allowClear?: boolean;
  /** Test/anchor id for the trigger button. */
  id?: string;
  /** Class on the trigger button. Combined with sensible defaults. */
  className?: string;
  /** Width override for the popover content. Default: trigger width. */
  contentWidth?: number | string;
}

export function EntityPickerAsync({
  entityType,
  value,
  onChange,
  filter,
  placeholder,
  disabled,
  required,
  allowClear = true,
  id,
  className,
  contentWidth,
}: EntityPickerAsyncProps) {
  const adapter = useMemo(() => getEntityAdapter(entityType), [entityType]);
  const fallbackId = useId();
  const triggerId = id ?? fallbackId;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  // Eager fetch the selected item so the trigger label is correct on mount /
  // when value changes from outside (URL state, parent form). Without this
  // the trigger flashes the raw UUID until the popover opens.
  const detail = useQuery({
    ...adapter.detailQueryOptions(value ?? ''),
    enabled: Boolean(value),
  });

  // Async search inside the popover. Pre-fetched lazily — the queryFn
  // doesn't run until the popover opens (we don't want every page mount
  // to fetch the entire directory).
  const search = useQuery({
    ...adapter.searchQueryOptions(query, filter),
    enabled: open,
  });

  // Debounce the search input → query. 200ms feels snappy without flooding
  // the server when the user types fast.
  const [pendingInput, setPendingInput] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setQuery(pendingInput), 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [pendingInput]);

  // Reset the input when the popover closes — feels more correct than
  // remembering the partial query across opens.
  useEffect(() => {
    if (!open) {
      setPendingInput('');
      setQuery('');
    }
  }, [open]);

  const selected = detail.data;
  const items = (search.data ?? []) as Array<{ id: string }>;

  const triggerLabel = selected
    ? adapter.renderSelected(selected as never)
    : <span className="text-muted-foreground">{placeholder ?? `Select ${adapter.noun}…`}</span>;

  return (
    <Popover open={open} onOpenChange={(next) => !disabled && setOpen(next)}>
      <PopoverTrigger
        id={triggerId}
        disabled={disabled}
        aria-required={required ? true : undefined}
        aria-invalid={required && !value ? true : undefined}
        render={
          <Button
            variant="outline"
            type="button"
            className={cn(
              'h-9 w-full justify-between font-normal',
              !selected && 'text-muted-foreground',
              className,
            )}
          />
        }
      >
        <span className="truncate flex-1 text-left">{triggerLabel}</span>
        <span className="flex items-center gap-1 shrink-0 text-muted-foreground">
          {allowClear && value ? (
            <span
              role="button"
              aria-label="Clear selection"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                onChange(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation();
                  onChange(null);
                }
              }}
              className="rounded-sm p-0.5 hover:bg-muted hover:text-foreground transition-colors"
            >
              <X className="size-3.5" />
            </span>
          ) : null}
          <ChevronsUpDown className="size-3.5 opacity-50" />
        </span>
      </PopoverTrigger>
      <PopoverContent
        className="p-0"
        style={contentWidth ? { width: typeof contentWidth === 'number' ? `${contentWidth}px` : contentWidth } : undefined}
        align="start"
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={adapter.searchPlaceholder}
            value={pendingInput}
            onValueChange={setPendingInput}
            autoFocus
          />
          <CommandList>
            {search.isFetching && items.length === 0 ? (
              <div className="flex items-center justify-center py-6 text-xs text-muted-foreground gap-2">
                <Loader2 className="size-3.5 animate-spin" />
                Searching…
              </div>
            ) : null}
            {!search.isFetching && items.length === 0 && (
              <CommandEmpty>No {adapter.noun} found.</CommandEmpty>
            )}
            {items.map((item) => (
              <CommandItem
                key={item.id}
                value={item.id}
                onSelect={() => {
                  onChange(item.id);
                  setOpen(false);
                }}
                className={cn(
                  'flex items-center gap-2',
                  item.id === value && 'bg-accent',
                )}
              >
                {adapter.renderListItem(item as never)}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

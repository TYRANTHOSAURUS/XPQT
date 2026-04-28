import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
  CommandSeparator,
} from '@/components/ui/command';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getEntityAdapter } from './registry';
import type { EntityType } from './types';

/**
 * Async, adapter-backed combobox for picking a single entity by id.
 *
 * Sprint 1A primitive consumed by the visual rule builder + future admin
 * sweeps. Coexists with `@/components/desk/editors/entity-picker` (static
 * pre-fetched options) — keep that one for ticket-side inline editors.
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
  const listboxId = `${triggerId}-listbox`;
  const statusId = `${triggerId}-status`;

  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pendingInput, setPendingInput] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');

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
    ...adapter.searchQueryOptions(debouncedQuery, filter),
    enabled: open,
  });

  // Debounce the search input → query. 200ms feels snappy without flooding
  // the server when the user types fast.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedQuery(pendingInput), 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [pendingInput]);

  // Reset input when popover closes — keeps state simple.
  useEffect(() => {
    if (!open) {
      setPendingInput('');
      setDebouncedQuery('');
    }
  }, [open]);

  // Local cache of the most recently picked item — guarantees the trigger
  // label is correct the instant the user picks, even if the detail query
  // hasn't yet seeded `detail.data`. Cleared when the value changes
  // externally to a different id (so we re-fetch the new id's detail).
  const [pickedItem, setPickedItem] = useState<{ id: string } | null>(null);
  useEffect(() => {
    if (pickedItem && pickedItem.id !== value) setPickedItem(null);
  }, [value, pickedItem]);

  const selected = (pickedItem ?? detail.data) as { id: string } | null | undefined;
  const items = (search.data ?? []) as Array<{ id: string }>;

  function handlePick(item: { id: string }) {
    // Seed the detail cache so any other consumer reading the same id
    // (parent form, table row, secondary picker) renders instantly without
    // a round-trip. Also stash locally as a render-now fallback.
    queryClient.setQueryData(adapter.detailQueryOptions(item.id).queryKey, item);
    setPickedItem(item);
    onChange(item.id);
    setOpen(false);
  }

  function handleClear(e: React.MouseEvent | React.KeyboardEvent) {
    e.stopPropagation();
    e.preventDefault();
    setPickedItem(null);
    onChange(null);
  }

  const triggerLabel = selected
    ? adapter.renderSelected(selected as never)
    : <span className="text-muted-foreground">{placeholder ?? `Select ${adapter.noun}…`}</span>;

  const statusMessage = (() => {
    if (!open) return '';
    if (search.isFetching) return `Searching ${adapter.noun} list…`;
    if (items.length === 0) return `No ${adapter.noun} found.`;
    return `${items.length} ${adapter.noun}${items.length === 1 ? '' : 's'} available.`;
  })();

  return (
    <Popover open={open} onOpenChange={(next) => !disabled && setOpen(next)}>
      <PopoverTrigger
        id={triggerId}
        disabled={disabled}
        aria-required={required ? true : undefined}
        aria-invalid={required && !value ? true : undefined}
        aria-controls={open ? listboxId : undefined}
        render={
          <Button
            variant="outline"
            type="button"
            role="combobox"
            aria-haspopup="listbox"
            aria-expanded={open}
            className={cn(
              'h-9 w-full justify-between font-normal',
              !selected && 'text-muted-foreground',
              className,
            )}
          />
        }
      >
        <span className="truncate flex-1 text-left">{triggerLabel}</span>
        <ChevronsUpDown className="size-3.5 opacity-50 shrink-0" />
      </PopoverTrigger>

      {/* Polite a11y status — empty until popover opens; SRs announce
          loading/results without flooding. */}
      <span id={statusId} aria-live="polite" className="sr-only">{statusMessage}</span>

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
          <CommandList id={listboxId} role="listbox" aria-label={`${adapter.noun} options`}>
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
                onSelect={() => handlePick(item)}
                className={cn(
                  'flex items-center gap-2',
                  item.id === value && 'bg-accent',
                )}
              >
                {adapter.renderListItem(item as never)}
              </CommandItem>
            ))}
          </CommandList>

          {/* Clear sits in the popover footer, NOT inside the trigger button.
              Avoids invalid nested interactive markup + double-fire. */}
          {allowClear && value ? (
            <>
              <CommandSeparator />
              <div className="p-1">
                <button
                  type="button"
                  onClick={handleClear}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') handleClear(e);
                  }}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-sm text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground"
                >
                  <X className="size-3.5" />
                  Clear selection
                </button>
              </div>
            </>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
  );
}

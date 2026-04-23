import { useEffect, useMemo, useState } from 'react';
import { CheckIcon, XIcon } from 'lucide-react';
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
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { PersonAvatar } from '@/components/person-avatar';
import { PickerItemBody } from '@/components/desk/editors/picker-item';
import {
  usePerson,
  usePersons,
  usePersonsSearch,
  type Person,
} from '@/api/persons';

export type { Person };

interface PersonPickerProps {
  value: string | null | undefined;
  onChange: (id: string) => void;
  /** Called with the full person object on selection, or null on clear. */
  onSelect?: (person: Person | null) => void;
  /** Exclude a person id from the list (e.g. self when picking a manager). */
  excludeId?: string | null;
  /** Text shown in the trigger when nothing is selected. */
  placeholder?: string;
  /** Label for the clear affordance inside the popover. Pass null to hide. */
  clearLabel?: string | null;
  disabled?: boolean;
}

function personLabel(p: Person): string {
  const name = `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim();
  return name || p.email || 'Unknown';
}

export function PersonPicker({
  value,
  onChange,
  onSelect,
  excludeId,
  placeholder = 'Select person...',
  clearLabel = 'Clear',
  disabled,
}: PersonPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  // Local cache of the currently selected person so we keep the label stable
  // across query changes without issuing an extra detail request.
  const [selectedCache, setSelectedCache] = useState<Person | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 200);
    return () => clearTimeout(t);
  }, [query]);

  // Browse view (no query) → top of directory. Search view → server-side match.
  const searchActive = debouncedQuery.length >= 2;
  const browse = usePersons();
  const search = usePersonsSearch(debouncedQuery);

  const results = searchActive ? search.data : browse.data;
  const loading = searchActive ? search.isFetching : browse.isFetching;

  // Resolve the selected label from whatever we have: local cache first, then
  // either list cache, then fall back to a single /persons/:id fetch. This
  // makes the picker robust on tenants with >100 persons where the selected
  // id may not appear in the browse/search view.
  const selectedId = value && value.length > 0 ? value : null;
  const fromList = useMemo<Person | null>(() => {
    if (!selectedId) return null;
    const lists: Person[][] = [browse.data ?? [], search.data ?? []];
    for (const list of lists) {
      const hit = list.find((p) => p.id === selectedId);
      if (hit) return hit;
    }
    return null;
  }, [selectedId, browse.data, search.data]);

  const detail = usePerson(selectedId && !selectedCache && !fromList ? selectedId : null);
  const selectedPerson: Person | null = selectedCache ?? fromList ?? detail.data ?? null;

  // Keep the cache fresh when we discover the selected person from any source.
  useEffect(() => {
    if (!selectedId) {
      if (selectedCache !== null) setSelectedCache(null);
      return;
    }
    if (selectedCache?.id === selectedId) return;
    const discovered = fromList ?? detail.data ?? null;
    if (discovered && discovered.id === selectedId) {
      setSelectedCache(discovered);
    }
  }, [selectedId, selectedCache, fromList, detail.data]);

  const visible = useMemo<Person[]>(() => {
    const list = results ?? [];
    return excludeId ? list.filter((p) => p.id !== excludeId) : list;
  }, [results, excludeId]);

  const handleSelect = (p: Person) => {
    setSelectedCache(p);
    onChange(p.id);
    onSelect?.(p);
    setOpen(false);
    setQuery('');
  };

  const handleClear = () => {
    setSelectedCache(null);
    onChange('');
    onSelect?.(null);
    setOpen(false);
    setQuery('');
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        render={
          <Button
            variant="ghost"
            size="sm"
            role="combobox"
            aria-expanded={open}
            className={cn(
              'h-8 w-full justify-start px-2 text-sm font-normal',
              !selectedPerson && 'text-muted-foreground',
            )}
          />
        }
      >
        {selectedPerson ? (
          <span className="flex min-w-0 items-center gap-2">
            <PersonAvatar size="sm" person={selectedPerson} />
            <span className="truncate">{personLabel(selectedPerson)}</span>
          </span>
        ) : (
          <span className="truncate">{placeholder}</span>
        )}
      </PopoverTrigger>
      <PopoverContent className="p-0 min-w-[260px]" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search by name or email…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {loading && (
              <div className="flex items-center justify-center py-6">
                <Spinner />
              </div>
            )}
            {!loading && visible.length === 0 && (
              <CommandEmpty className="py-6 text-center text-xs text-muted-foreground">
                {searchActive ? 'No people found.' : 'Type to search for more people.'}
              </CommandEmpty>
            )}
            {!loading && visible.length > 0 && (
              <CommandGroup>
                {visible.map((p) => {
                  const isSelected = p.id === selectedId;
                  return (
                    <CommandItem
                      key={p.id}
                      value={`${personLabel(p)} ${p.email ?? ''}`}
                      onSelect={() => handleSelect(p)}
                      className="py-2"
                    >
                      <PickerItemBody
                        leading={<PersonAvatar size="sm" person={p} />}
                        label={personLabel(p)}
                        sublabel={p.email ?? null}
                        trailing={isSelected ? <CheckIcon className="h-4 w-4 text-foreground" /> : null}
                      />
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
            {!loading && !searchActive && visible.length > 0 && (
              <div className="px-2 pb-2 pt-0 text-[11px] text-muted-foreground">
                Showing top {visible.length}. Type to search more.
              </div>
            )}
          </CommandList>
          {clearLabel && selectedId && (
            <>
              <CommandSeparator />
              <div className="p-1">
                <button
                  type="button"
                  onClick={handleClear}
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

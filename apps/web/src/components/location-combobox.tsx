import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { apiFetch } from '@/lib/api';

export interface Space {
  id: string;
  name: string;
  type: string;
  parent_id: string | null;
  active?: boolean;
}

interface Props {
  value: string | null;
  onChange: (spaceId: string | null) => void;
  typesFilter?: string[];
  placeholder?: string;
  disabled?: boolean;
  /**
   * When true, only active spaces are listed. Use for portal-scope
   * contexts (default_location, grant targets) where an inactive space
   * would be rejected by the server-side trigger anyway.
   */
  activeOnly?: boolean;
}

export function LocationCombobox({
  value,
  onChange,
  typesFilter,
  placeholder = 'Select location…',
  disabled,
  activeOnly,
}: Props) {
  const [open, setOpen] = useState(false);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [search, setSearch] = useState('');

  useEffect(() => {
    const params = new URLSearchParams();
    if (typesFilter?.length) params.set('types', typesFilter.join(','));
    if (search) params.set('search', search);
    if (activeOnly) params.set('active_only', 'true');
    apiFetch<Space[]>(`/spaces?${params.toString()}`).then(setSpaces).catch(() => setSpaces([]));
  }, [search, typesFilter?.join(','), activeOnly]);

  // If `value` is set but isn't in the filtered list — typical case:
  // activeOnly=true and the chosen space was archived after the form was saved
  // — fetch it explicitly so the user sees their current selection and can
  // decide to clear it. Without this, an admin loading an old record sees a
  // blank combobox and loses context for a field that's actually set.
  const [missingSelected, setMissingSelected] = useState<Space | null>(null);
  useEffect(() => {
    if (!value) { setMissingSelected(null); return; }
    if (spaces.some((s) => s.id === value)) { setMissingSelected(null); return; }
    let cancelled = false;
    apiFetch<Space>(`/spaces/${value}`)
      .then((s) => { if (!cancelled) setMissingSelected(s); })
      .catch(() => { if (!cancelled) setMissingSelected(null); });
    return () => { cancelled = true; };
  }, [value, spaces]);

  const selected = spaces.find((s) => s.id === value) ?? missingSelected;
  const displayList = useMemo(() => {
    if (!missingSelected) return spaces;
    if (spaces.some((s) => s.id === missingSelected.id)) return spaces;
    return [missingSelected, ...spaces];
  }, [spaces, missingSelected]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            role="combobox"
            disabled={disabled}
            aria-expanded={open}
            className="w-full justify-between font-normal"
          />
        }
      >
        <span className={cn('truncate', !selected && 'text-muted-foreground')}>
          {selected
            ? `${selected.name} (${selected.type})${selected.active === false ? ' — archived' : ''}`
            : placeholder}
        </span>
        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search locations…" value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>No matching location.</CommandEmpty>
            <CommandGroup>
              {displayList.map((s) => (
                <CommandItem
                  key={s.id}
                  value={s.id}
                  onSelect={() => {
                    onChange(s.id === value ? null : s.id);
                    setOpen(false);
                  }}
                >
                  <Check className={cn('mr-2 h-4 w-4', value === s.id ? 'opacity-100' : 'opacity-0')} />
                  <span className="flex-1">{s.name}</span>
                  <span className="text-xs text-muted-foreground">{s.type}</span>
                  {s.active === false && (
                    <span className="text-xs text-amber-600 ml-2">archived</span>
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

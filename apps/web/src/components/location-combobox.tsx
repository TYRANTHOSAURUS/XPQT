import { useMemo, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useSpaces, useSpaceDetail, type Space } from '@/api/spaces';
export type { Space };

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
  const [search, setSearch] = useState('');

  const { data: spacesData } = useSpaces({
    types: typesFilter ?? null,
    search: search || null,
    activeOnly: activeOnly ?? null,
  });
  const spaces = spacesData ?? [];

  // If `value` is set but isn't in the filtered list — typical case:
  // activeOnly=true and the chosen space was archived after the form was saved
  // — fetch it explicitly so the user sees their current selection. Without
  // this, an admin loading an old record sees a blank combobox and loses
  // context for a field that's actually set.
  const valueIsInList = !value || spaces.some((s) => s.id === value);
  const { data: missingSelectedData } = useSpaceDetail(valueIsInList ? null : value);
  const missingSelected = valueIsInList ? null : (missingSelectedData ?? null);

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

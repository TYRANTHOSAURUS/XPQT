import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, ChevronsUpDown } from 'lucide-react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useSpaces } from '@/api/spaces';
import type { Space } from '@/api/spaces';
import { cn } from '@/lib/utils';

/**
 * Search-filterable combobox of reservable rooms in the tenant. Lazy-
 * filters client-side once useSpaces resolves — typical tenant has
 * dozens of rooms, not thousands, so a single fetch is cheaper than
 * threading the picker's full ranking pipeline through the composer.
 *
 * Multi-building tenants get a chip-row filter above the search.
 * Capacity badges color the deviation when picked attendees > capacity.
 */
export function RoomPickerInline({
  value,
  attendeeCount,
  excludeIds = [],
  onChange,
}: {
  value: string | null;
  attendeeCount: number;
  /** Room ids to hide from the dropdown (e.g. additionals already added
   *  to a multi-room group). Prevents picking the same room twice. */
  excludeIds?: string[];
  onChange: (spaceId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [buildingFilter, setBuildingFilter] = useState<string | null>(null);
  const { data: spaces, isPending } = useSpaces();

  // Index every space by id once so the building lookup is O(depth) per
  // room instead of O(n) per room.
  const byId = useMemo(() => {
    const m = new Map<string, Space>();
    for (const s of spaces ?? []) m.set(s.id, s);
    return m;
  }, [spaces]);

  // Walk the parent chain and surface the first ancestor of type 'building'.
  const buildingFor = useCallback(
    (s: Space): Space | null => {
      let cur: Space | undefined = s;
      let hops = 0;
      while (cur && hops < 12) {
        if (cur.type === 'building') return cur;
        cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
        hops += 1;
      }
      return null;
    },
    [byId],
  );

  const excludeSet = useMemo(() => new Set(excludeIds), [excludeIds]);
  const reservable = useMemo<Space[]>(
    () =>
      (spaces ?? []).filter(
        (s) => s.reservable && s.active && !excludeSet.has(s.id),
      ),
    [spaces, excludeSet],
  );

  // Distinct buildings whose rooms are reservable. Alphabetical so the
  // chip order is stable across opens.
  const buildings = useMemo(() => {
    const seen = new Set<string>();
    const out: Space[] = [];
    for (const room of reservable) {
      const b = buildingFor(room);
      if (b && !seen.has(b.id)) {
        seen.add(b.id);
        out.push(b);
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, [reservable, buildingFor]);

  const filteredRooms = useMemo(() => {
    if (!buildingFilter) return reservable;
    return reservable.filter((r) => buildingFor(r)?.id === buildingFilter);
  }, [reservable, buildingFilter, buildingFor]);

  const selected = useMemo(
    () => reservable.find((r) => r.id === value) ?? null,
    [reservable, value],
  );

  // Reset building filter when the selection clears so the next pick
  // doesn't surprise the user with a hidden subset.
  useEffect(() => {
    if (!value) setBuildingFilter(null);
  }, [value]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="h-10 w-full justify-between font-normal"
          >
            <span className="truncate text-sm">
              {selected ? selected.name : isPending ? 'Loading rooms…' : 'Pick a room…'}
            </span>
            {selected?.capacity != null && (
              <span className="ml-2 shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {selected.capacity} cap
              </span>
            )}
            <ChevronsUpDown className="ml-2 size-3.5 shrink-0 opacity-50" />
          </Button>
        }
      />
      <PopoverContent
        className="p-0"
        align="start"
        style={{ width: 'var(--radix-popover-trigger-width)' }}
      >
        <Command>
          <CommandInput placeholder="Search rooms…" />
          {buildings.length > 1 && (
            <div className="flex flex-wrap items-center gap-1 border-b px-2 py-1.5">
              <button
                type="button"
                onClick={() => setBuildingFilter(null)}
                className={cn(
                  'rounded-full px-2 py-0.5 text-xs font-medium',
                  '[transition:background-color_140ms_var(--ease-snap),color_140ms_var(--ease-snap)]',
                  'active:translate-y-px',
                  buildingFilter === null
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted',
                )}
              >
                All
              </button>
              <span aria-hidden className="h-3 w-px bg-border" />
              {buildings.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => setBuildingFilter(b.id === buildingFilter ? null : b.id)}
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-xs font-medium',
                    '[transition:background-color_140ms_var(--ease-snap),color_140ms_var(--ease-snap),border-color_140ms_var(--ease-snap)]',
                    'active:translate-y-px',
                    buildingFilter === b.id
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {b.name}
                </button>
              ))}
            </div>
          )}
          <CommandList className="max-h-72">
            <CommandEmpty>
              {isPending ? 'Loading…' : 'No rooms match.'}
            </CommandEmpty>
            <CommandGroup>
              {filteredRooms.map((room) => {
                const isSel = room.id === value;
                return (
                  <CommandItem
                    key={room.id}
                    value={`${room.name} ${room.code ?? ''} ${room.type}`}
                    onSelect={() => {
                      onChange(room.id);
                      setOpen(false);
                    }}
                  >
                    <Check
                      className={cn(
                        'mr-2 size-4 shrink-0',
                        isSel ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{room.name}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {room.type.replace(/_/g, ' ')}
                        {room.code ? ` · ${room.code}` : ''}
                      </div>
                    </div>
                    {room.capacity != null && (
                      <CapacityBadge capacity={room.capacity} attendees={attendeeCount} />
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Capacity badge — neutral capacity figure in the room picker rows.
 * When the room is tight (capacity < attendees), surfaces an amber
 * AlertTriangle inline. The digit itself stays muted so tabular-nums
 * scan down the column cleanly; color is reserved for the deviation.
 *
 * Exported so AdditionalRoomsField can render the same indicator in
 * its own combobox without re-implementing the heuristic.
 */
export function CapacityBadge({
  capacity,
  attendees,
}: {
  capacity: number;
  attendees: number;
}) {
  const tight = attendees > 1 && capacity < attendees;
  return (
    <span
      className="ml-2 inline-flex shrink-0 items-center gap-0.5 text-xs tabular-nums text-muted-foreground"
      title={tight ? 'Smaller than attendee count' : undefined}
    >
      {tight && (
        <AlertTriangle
          className="size-3 text-amber-700 dark:text-amber-400"
          aria-hidden
        />
      )}
      {capacity}
    </span>
  );
}

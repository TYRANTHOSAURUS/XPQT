import { useMemo, useState } from 'react';
import { AlertTriangle, Plus, X } from 'lucide-react';
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
import type { Space } from '@/api/spaces';
import type { RecurrenceRule } from '@/api/room-booking';
import { CapacityBadge } from './room-picker-inline';

/**
 * Multi-room composer affordance — "+ Add another room" button + chip
 * list of selected additionals. Hidden when no primary room is set
 * yet (a multi-room group needs the primary first). When recurrence is
 * on, surfaces a soft note ABOVE the trigger so it's read before the
 * user clicks (the validation error blocks submit; this nudges resolve).
 */
export function AdditionalRoomsField({
  primaryId,
  additionalIds,
  spacesCache,
  attendeeCount,
  recurrence,
  onAdd,
  onRemove,
}: {
  primaryId: string | null;
  additionalIds: string[];
  spacesCache: Space[];
  attendeeCount: number;
  recurrence: RecurrenceRule | null;
  onAdd: (spaceId: string) => void;
  onRemove: (spaceId: string) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const byId = useMemo(() => {
    const m = new Map<string, Space>();
    for (const s of spacesCache) m.set(s.id, s);
    return m;
  }, [spacesCache]);

  if (!primaryId) return null;

  const atCap = additionalIds.length >= 9; // backend cap = 10 total
  const recurrenceConflict = additionalIds.length > 0 && recurrence != null;

  return (
    <div className="mt-2 flex flex-col gap-2">
      {additionalIds.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {additionalIds.map((id) => {
            const s = byId.get(id);
            return (
              <li
                key={id}
                className="group/chip inline-flex items-center gap-1.5 rounded-full bg-muted/60 px-2 py-0.5 text-[11px] tabular-nums duration-150 ease-[var(--ease-snap)] animate-in fade-in zoom-in-95"
              >
                <span className="text-foreground">{s?.name ?? 'Room'}</span>
                {s?.capacity != null && (
                  <span className="text-muted-foreground/70">{s.capacity}</span>
                )}
                <button
                  type="button"
                  onClick={() => onRemove(id)}
                  aria-label={`Remove ${s?.name ?? 'room'}`}
                  className="-mr-1 rounded-full p-0.5 text-muted-foreground opacity-60 [transition:opacity_120ms_var(--ease-snap)] hover:bg-muted hover:text-foreground hover:opacity-100 group-hover/chip:opacity-100"
                >
                  <X className="size-3" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {/* Recurrence-conflict note ABOVE the add trigger so user reads
          it before clicking. Below = easy to miss after they've already
          added another room. */}
      {recurrenceConflict && (
        <p
          role="status"
          aria-live="polite"
          className="flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400"
        >
          <AlertTriangle className="size-3 shrink-0" aria-hidden />
          Multi-room bookings can't recur. Drop a room or turn off recurrence.
        </p>
      )}
      <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 self-start px-2 text-xs active:translate-y-px"
              disabled={atCap}
              title={atCap ? 'Up to 10 rooms can be booked together' : undefined}
            >
              <Plus className="size-3.5" />
              {atCap ? 'Room limit reached (10)' : 'Add another room'}
            </Button>
          }
        />
        <PopoverContent
          className="p-0"
          align="start"
          style={{ width: 'min(360px, 90vw)' }}
        >
          <Command>
            <CommandInput placeholder="Search rooms…" />
            <CommandList className="max-h-72">
              <CommandEmpty>No more rooms match.</CommandEmpty>
              <CommandGroup>
                {spacesCache
                  .filter(
                    (s) =>
                      s.reservable &&
                      s.active &&
                      s.id !== primaryId &&
                      !additionalIds.includes(s.id),
                  )
                  .map((room) => (
                    <CommandItem
                      key={room.id}
                      value={`${room.name} ${room.code ?? ''} ${room.type}`}
                      onSelect={() => {
                        onAdd(room.id);
                        setPickerOpen(false);
                      }}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm">{room.name}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {room.type.replace(/_/g, ' ')}
                          {room.code ? ` · ${room.code}` : ''}
                        </div>
                      </div>
                      {room.capacity != null && (
                        <CapacityBadge
                          capacity={room.capacity}
                          attendees={attendeeCount}
                        />
                      )}
                    </CommandItem>
                  ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

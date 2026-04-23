import { useMemo, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
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
import { useBusinessHoursCalendars } from '@/api/sla-policies';

interface BusinessHoursPickerProps {
  value: string | null | undefined;
  onChange: (id: string | null) => void;
  placeholder?: string;
}

export function BusinessHoursPicker({ value, onChange, placeholder = 'Always on' }: BusinessHoursPickerProps) {
  const [open, setOpen] = useState(false);
  const { data } = useBusinessHoursCalendars();
  const selected = useMemo(() => (data ?? []).find((c) => c.id === value), [data, value]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="outline" size="sm" className="w-[260px] justify-between font-normal">
            <span className={cn('truncate', !selected && 'text-muted-foreground')}>
              {selected ? `${selected.name}` : placeholder}
            </span>
            <ChevronsUpDown className="size-3.5 opacity-50" />
          </Button>
        }
      />
      <PopoverContent className="w-[300px] p-0" align="end">
        <Command>
          <CommandInput placeholder="Search calendars…" />
          <CommandList>
            <CommandEmpty>No calendars</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="__none__"
                onSelect={() => { onChange(null); setOpen(false); }}
              >
                <span className="flex-1 text-muted-foreground">Always on (24/7)</span>
                {!value && <Check className="size-4" />}
              </CommandItem>
              {(data ?? []).map((c) => (
                <CommandItem
                  key={c.id}
                  value={`${c.name} ${c.time_zone}`}
                  onSelect={() => { onChange(c.id); setOpen(false); }}
                >
                  <div className="flex flex-col flex-1 min-w-0">
                    <span className="truncate">{c.name}</span>
                    <span className="text-xs text-muted-foreground">{c.time_zone}</span>
                  </div>
                  {value === c.id && <Check className="size-4" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

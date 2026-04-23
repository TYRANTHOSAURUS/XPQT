import { useMemo, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
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
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';

interface WorkflowSummary {
  id: string;
  name: string;
  status: 'draft' | 'published';
}

interface WorkflowDefinitionPickerProps {
  value: string | null | undefined;
  onChange: (id: string | null) => void;
  placeholder?: string;
}

export function WorkflowDefinitionPicker({ value, onChange, placeholder = 'Inherit from request type' }: WorkflowDefinitionPickerProps) {
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ['workflows', 'definitions-list'],
    queryFn: ({ signal }) => apiFetch<WorkflowSummary[]>('/workflows', { signal }),
    staleTime: 60_000,
  });
  const selected = useMemo(() => (data ?? []).find((w) => w.id === value), [data, value]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="outline" size="sm" className="w-[260px] justify-between font-normal">
            <span className={cn('truncate', !selected && 'text-muted-foreground')}>
              {selected ? selected.name : placeholder}
            </span>
            <ChevronsUpDown className="size-3.5 opacity-50" />
          </Button>
        }
      />
      <PopoverContent className="w-[300px] p-0" align="end">
        <Command>
          <CommandInput placeholder="Search workflows…" />
          <CommandList>
            <CommandEmpty>No workflows</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="__none__"
                onSelect={() => { onChange(null); setOpen(false); }}
              >
                <span className="flex-1 text-muted-foreground">Inherit from request type</span>
                {!value && <Check className="size-4" />}
              </CommandItem>
              {(data ?? []).map((w) => (
                <CommandItem
                  key={w.id}
                  value={`${w.name} ${w.status}`}
                  onSelect={() => { onChange(w.id); setOpen(false); }}
                >
                  <span className="flex-1 truncate">{w.name}</span>
                  <span className="text-xs text-muted-foreground mr-2">{w.status}</span>
                  {value === w.id && <Check className="size-4" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronsUpDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Spinner } from '@/components/ui/spinner';
import { apiFetch } from '@/lib/api';

export interface Person {
  id: string;
  first_name: string;
  last_name: string;
  email?: string | null;
  department?: string | null;
}

interface PersonComboboxProps {
  value: string;
  onChange: (id: string) => void;
  /** Called with the full person object on selection, or null on clear. */
  onSelect?: (person: Person | null) => void;
  excludeId?: string | null;
  placeholder?: string;
  className?: string;
  /** Optional type filter passed to /persons?type= */
  type?: string;
}

export function PersonCombobox({
  value,
  onChange,
  onSelect,
  excludeId,
  placeholder = 'Select person...',
  className,
  type,
}: PersonComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Person[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Person | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Resolve the label for the currently selected id
  useEffect(() => {
    if (!value) {
      setSelected(null);
      return;
    }
    if (selected?.id === value) return;
    let cancelled = false;
    apiFetch<Person[]>(type ? `/persons?type=${type}` : '/persons')
      .then((persons) => {
        if (cancelled) return;
        const p = persons.find((x) => x.id === value);
        if (p) setSelected(p);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [value, type, selected?.id]);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!open) return;
    if (!query.trim()) {
      setLoading(true);
      apiFetch<Person[]>(type ? `/persons?type=${type}` : '/persons')
        .then((data) => setResults(excludeId ? data.filter((p) => p.id !== excludeId) : data))
        .catch(() => setResults([]))
        .finally(() => setLoading(false));
      return;
    }
    setLoading(true);
    debounceRef.current = setTimeout(() => {
      apiFetch<Person[]>(`/persons?search=${encodeURIComponent(query)}`)
        .then((data) => setResults(excludeId ? data.filter((p) => p.id !== excludeId) : data))
        .catch(() => setResults([]))
        .finally(() => setLoading(false));
    }, 250);
  }, [query, open, excludeId, type]);

  const label = selected ? `${selected.first_name} ${selected.last_name}` : '';

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={<Button variant="outline" role="combobox" aria-expanded={open} className="flex-1 justify-between font-normal" />}
        >
          <span className={cn('truncate', !label && 'text-muted-foreground font-normal')}>
            {label || placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </PopoverTrigger>
        <PopoverContent className="w-[320px] p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Search by name..."
              value={query}
              onValueChange={setQuery}
            />
            <CommandList>
              {loading && (
                <div className="flex items-center justify-center py-6">
                  <Spinner />
                </div>
              )}
              {!loading && results.length === 0 && (
                <CommandEmpty>No people found.</CommandEmpty>
              )}
              {!loading && results.length > 0 && (
                <CommandGroup>
                  {results.map((p) => (
                    <CommandItem
                      key={p.id}
                      value={p.id}
                      onSelect={() => {
                        onChange(p.id);
                        setSelected(p);
                        onSelect?.(p);
                        setOpen(false);
                        setQuery('');
                      }}
                    >
                      <Check
                        className={cn(
                          'mr-2 h-4 w-4',
                          value === p.id ? 'opacity-100' : 'opacity-0',
                        )}
                      />
                      <span>{p.first_name} {p.last_name}</span>
                      {p.email && (
                        <span className="ml-2 text-xs text-muted-foreground">{p.email}</span>
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {value && (
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 shrink-0"
          onClick={() => {
            onChange('');
            setSelected(null);
            onSelect?.(null);
          }}
          aria-label="Clear selection"
        >
          <X className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

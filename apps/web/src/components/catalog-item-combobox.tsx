import { useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
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
import { useCatalogItems, type CatalogItem } from '@/api/catalog';
export type { CatalogItem };

interface CatalogItemComboboxProps {
  value: string;
  onChange: (id: string, item: CatalogItem | null) => void;
  /** IDs to hide from the list (e.g. items already on the menu) */
  excludeIds?: string[];
  placeholder?: string;
  className?: string;
  /** Render as a borderless trigger suitable for table cells */
  inline?: boolean;
}

export function CatalogItemCombobox({
  value,
  onChange,
  excludeIds = [],
  placeholder = 'Pick item...',
  className,
  inline = false,
}: CatalogItemComboboxProps) {
  const { data: items } = useCatalogItems();
  const [open, setOpen] = useState(false);

  const selected = items?.find((i) => i.id === value);
  const excludeSet = new Set(excludeIds);
  const available = (items ?? []).filter((i) => !excludeSet.has(i.id) || i.id === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant={inline ? 'ghost' : 'outline'}
            role="combobox"
            aria-expanded={open}
            className={cn(
              'justify-between font-normal',
              inline && 'h-8 w-full px-2 hover:bg-accent/50',
              className,
            )}
          />
        }
      >
        <span className={cn('truncate', !selected && 'text-muted-foreground')}>
          {selected ? selected.name : placeholder}
        </span>
        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent className="w-[320px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search items..." />
          <CommandList>
            <CommandEmpty>No items found.</CommandEmpty>
            <CommandGroup>
              {available.map((item) => (
                <CommandItem
                  key={item.id}
                  value={`${item.name} ${item.category} ${item.subcategory ?? ''}`}
                  onSelect={() => {
                    onChange(item.id, item);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn('mr-2 h-4 w-4', value === item.id ? 'opacity-100' : 'opacity-0')}
                  />
                  <div className="flex flex-col">
                    <span>{item.name}</span>
                    <span className="text-xs text-muted-foreground capitalize">
                      {item.category.replaceAll('_', ' ')}
                      {item.subcategory && ` · ${item.subcategory}`}
                    </span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

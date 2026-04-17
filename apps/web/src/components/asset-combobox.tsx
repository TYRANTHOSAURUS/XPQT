import { useEffect, useState } from 'react';
import { Check, ChevronsUpDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import { apiFetch } from '@/lib/api';

export interface Asset {
  id: string;
  name: string;
  serial_number?: string | null;
  asset_type?: { name: string } | null;
}

interface AssetComboboxProps {
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  className?: string;
  id?: string;
}

export function AssetCombobox({ value, onChange, placeholder = 'Select asset...', className, id }: AssetComboboxProps) {
  const [open, setOpen] = useState(false);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selected, setSelected] = useState<Asset | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<Asset[]>('/assets')
      .then((data) => { if (!cancelled) setAssets(data); })
      .catch(() => { if (!cancelled) setAssets([]); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!value) { setSelected(null); return; }
    const a = assets.find((x) => x.id === value);
    if (a) setSelected(a);
  }, [value, assets]);

  const label = selected ? selected.name : '';

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={<Button id={id} variant="outline" role="combobox" aria-expanded={open} className="flex-1 justify-between font-normal" />}
        >
          <span className={cn('truncate', !label && 'text-muted-foreground font-normal')}>
            {label || placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </PopoverTrigger>
        <PopoverContent className="w-[320px] p-0" align="start">
          <Command>
            <CommandInput placeholder="Search assets..." />
            <CommandList>
              <CommandEmpty>No assets found.</CommandEmpty>
              <CommandGroup>
                {assets.map((a) => (
                  <CommandItem
                    key={a.id}
                    value={`${a.name} ${a.serial_number ?? ''}`}
                    onSelect={() => { onChange(a.id); setSelected(a); setOpen(false); }}
                  >
                    <Check className={cn('mr-2 h-4 w-4', value === a.id ? 'opacity-100' : 'opacity-0')} />
                    <span className="truncate">{a.name}</span>
                    {a.serial_number && <span className="ml-2 text-xs text-muted-foreground">{a.serial_number}</span>}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {value && (
        <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={() => { onChange(''); setSelected(null); }} aria-label="Clear selection">
          <X className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

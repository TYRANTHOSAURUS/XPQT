import { useEffect, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { apiFetch } from '@/lib/api';

export interface Asset {
  id: string;
  name: string;
  tag: string | null;
  asset_type_id: string;
  assigned_space_id: string | null;
}

interface Props {
  value: string | null;
  onChange: (assetId: string | null, asset: Asset | null) => void;
  assetTypeFilter?: string[];
  spaceScope?: string | null;
  placeholder?: string;
  disabled?: boolean;
}

export function AssetCombobox({
  value,
  onChange,
  assetTypeFilter = [],
  spaceScope,
  placeholder = 'Select asset…',
  disabled,
}: Props) {
  const [open, setOpen] = useState(false);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [search, setSearch] = useState('');

  useEffect(() => {
    const params = new URLSearchParams();
    if (assetTypeFilter.length) params.set('asset_type_ids', assetTypeFilter.join(','));
    if (spaceScope) params.set('space_id', spaceScope);
    if (search) params.set('search', search);
    apiFetch<Asset[]>(`/assets?${params.toString()}`).then(setAssets).catch(() => setAssets([]));
  }, [search, assetTypeFilter.join(','), spaceScope]);

  const selected = assets.find((a) => a.id === value);

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
          {selected ? `${selected.name}${selected.tag ? ` (${selected.tag})` : ''}` : placeholder}
        </span>
        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search assets…" value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>No matching asset.</CommandEmpty>
            <CommandGroup>
              {assets.map((a) => (
                <CommandItem
                  key={a.id}
                  value={a.id}
                  onSelect={() => {
                    const next = a.id === value ? null : a.id;
                    onChange(next, next ? a : null);
                    setOpen(false);
                  }}
                >
                  <Check className={cn('mr-2 h-4 w-4', value === a.id ? 'opacity-100' : 'opacity-0')} />
                  <span className="flex-1">{a.name}</span>
                  {a.tag && <span className="text-xs text-muted-foreground">{a.tag}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

import { useMemo, useState } from 'react';
import { Check, ChevronsUpDown, Building2 } from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface OrgNode {
  id: string;
  name: string;
  code: string | null;
  parent_id: string | null;
}

interface Props {
  value: string | null;
  onChange: (id: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Allow clearing to "no organisation" (default true). */
  allowClear?: boolean;
  /** Restrict selection to nodes whose ids match this filter. */
  filter?: (node: OrgNode) => boolean;
}

function buildPath(node: OrgNode, byId: Map<string, OrgNode>): string {
  const segments: string[] = [];
  let cursor: OrgNode | undefined = node;
  let safety = 0;
  while (cursor && safety < 50) {
    segments.unshift(cursor.name);
    cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
    safety += 1;
  }
  return segments.join(' › ');
}

export function OrgNodeCombobox({
  value,
  onChange,
  placeholder = 'Select organisation…',
  disabled,
  allowClear = true,
  filter,
}: Props) {
  const [open, setOpen] = useState(false);
  const { data, loading } = useApi<OrgNode[]>('/org-nodes');

  const byId = useMemo(() => {
    const m = new Map<string, OrgNode>();
    for (const n of data ?? []) m.set(n.id, n);
    return m;
  }, [data]);

  const items = useMemo(() => {
    const list = (data ?? []).filter((n) => (filter ? filter(n) : true));
    return list
      .map((n) => ({ id: n.id, label: buildPath(n, byId) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [data, byId, filter]);

  const selectedLabel = value ? items.find((i) => i.id === value)?.label : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled || loading}
            className="w-full justify-between font-normal"
          />
        }
      >
        <span className="flex items-center gap-2 truncate">
          <Building2 className="size-4 text-muted-foreground" />
          <span className={cn('truncate', !selectedLabel && 'text-muted-foreground')}>
            {selectedLabel ?? placeholder}
          </span>
        </span>
        <ChevronsUpDown className="ml-2 size-4 opacity-50" />
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search organisations…" />
          <CommandList>
            <CommandEmpty>No organisations found.</CommandEmpty>
            <CommandGroup>
              {allowClear && (
                <CommandItem
                  value="__none__"
                  onSelect={() => {
                    onChange(null);
                    setOpen(false);
                  }}
                >
                  <Check className={cn('mr-2 size-4', value == null ? 'opacity-100' : 'opacity-0')} />
                  None
                </CommandItem>
              )}
              {items.map((item) => (
                <CommandItem
                  key={item.id}
                  value={item.label}
                  onSelect={() => {
                    onChange(item.id);
                    setOpen(false);
                  }}
                >
                  <Check className={cn('mr-2 size-4', value === item.id ? 'opacity-100' : 'opacity-0')} />
                  {item.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

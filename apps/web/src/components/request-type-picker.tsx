import { useMemo, useState } from 'react';
import { ChevronsUpDown, X } from 'lucide-react';
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
  CommandSeparator,
} from '@/components/ui/command';
import { Spinner } from '@/components/ui/spinner';
import { useCatalogTree, type CatalogCategoryNode } from '@/api/catalog';
import { useRequestTypes } from '@/api/request-types';

export interface RequestType {
  id: string;
  name: string;
  domain: string;
  fulfillment_strategy: 'asset' | 'location' | 'fixed' | 'auto';
  requires_asset: boolean;
  asset_required: boolean;
  asset_type_filter: string[];
  requires_location: boolean;
  location_required: boolean;
}

interface FlatGroup {
  categoryId: string;
  path: string[];
  items: { id: string; name: string; description: string | null }[];
}

function flattenTree(tree: CatalogCategoryNode[]): FlatGroup[] {
  const groups: FlatGroup[] = [];
  const walk = (node: CatalogCategoryNode, parentPath: string[]) => {
    const path = [...parentPath, node.name];
    if (node.request_types.length > 0) {
      groups.push({
        categoryId: node.id,
        path,
        items: node.request_types
          .slice()
          .sort((a, b) => a.display_order - b.display_order || a.name.localeCompare(b.name))
          .map((rt) => ({ id: rt.id, name: rt.name, description: rt.description })),
      });
    }
    node.children
      .slice()
      .sort((a, b) => a.display_order - b.display_order || a.name.localeCompare(b.name))
      .forEach((child) => walk(child, path));
  };
  tree
    .slice()
    .sort((a, b) => a.display_order - b.display_order || a.name.localeCompare(b.name))
    .forEach((root) => walk(root, []));
  return groups;
}

interface RequestTypePickerProps {
  value: string;
  onChange: (id: string, requestType: RequestType | null) => void;
  /** Scope the picker to a single category subtree (and its descendants). */
  rootCategoryId?: string | null;
  /** Hide these request type ids from the list (e.g. the current type when reclassifying). */
  excludeIds?: string[];
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  id?: string;
  /** Hide the clear button. */
  required?: boolean;
}

export function RequestTypePicker({
  value,
  onChange,
  rootCategoryId,
  excludeIds,
  placeholder = 'Select a request type…',
  className,
  disabled,
  id,
  required,
}: RequestTypePickerProps) {
  const [open, setOpen] = useState(false);

  const { data: tree, isPending: treeLoading } = useCatalogTree();
  const { data: flat } = useRequestTypes() as { data: RequestType[] | undefined };

  const scopedTree = useMemo(() => {
    if (!tree) return [];
    if (!rootCategoryId) return tree;
    const find = (nodes: CatalogCategoryNode[]): CatalogCategoryNode | null => {
      for (const node of nodes) {
        if (node.id === rootCategoryId) return node;
        const hit = find(node.children);
        if (hit) return hit;
      }
      return null;
    };
    const root = find(tree);
    return root ? [root] : [];
  }, [tree, rootCategoryId]);

  const groups = useMemo(() => {
    const raw = flattenTree(scopedTree);
    if (!excludeIds || excludeIds.length === 0) return raw;
    const excluded = new Set(excludeIds);
    return raw
      .map((g) => ({ ...g, items: g.items.filter((i) => !excluded.has(i.id)) }))
      .filter((g) => g.items.length > 0);
  }, [scopedTree, excludeIds]);

  const selected = useMemo(() => {
    if (!value) return null;
    const rt = flat?.find((r) => r.id === value);
    const group = groups.find((g) => g.items.some((i) => i.id === value));
    const catalogItem = group?.items.find((i) => i.id === value);
    if (!rt && !catalogItem) return null;
    return {
      rt: rt ?? null,
      name: rt?.name ?? catalogItem?.name ?? '',
      path: group?.path ?? [],
    };
  }, [value, flat, groups]);

  const label = selected
    ? selected.path.length > 0
      ? `${selected.path.join(' › ')} › ${selected.name}`
      : selected.name
    : '';

  const handleSelect = (rtId: string) => {
    const rt = flat?.find((r) => r.id === rtId) ?? null;
    onChange(rtId, rt);
    setOpen(false);
  };

  const handleClear = () => onChange('', null);

  return (
    <div className={cn('flex w-full items-center gap-2', className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              id={id}
              variant="outline"
              role="combobox"
              aria-expanded={open}
              disabled={disabled}
              className="flex-1 justify-between gap-2 font-normal min-w-0"
            />
          }
        >
          <span className={cn('truncate', !label && 'text-muted-foreground')}>
            {label || placeholder}
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </PopoverTrigger>
        <PopoverContent className="w-[min(440px,calc(100vw-2rem))] p-0" align="start">
          <Command>
            <CommandInput placeholder="Search request types..." />
            <CommandList>
              {treeLoading ? (
                <div className="flex items-center justify-center py-6">
                  <Spinner />
                </div>
              ) : groups.length === 0 ? (
                <CommandEmpty>No request types available.</CommandEmpty>
              ) : (
                <>
                  <CommandEmpty>No matching request types.</CommandEmpty>
                  {groups.map((g, idx) => (
                    <div key={g.categoryId}>
                      {idx > 0 && <CommandSeparator />}
                      <CommandGroup heading={g.path.join(' › ')}>
                        {g.items.map((item) => {
                          const searchValue = [item.name, ...g.path, item.description ?? '']
                            .join(' ')
                            .toLowerCase();
                          const isSelected = value === item.id;
                          return (
                            <CommandItem
                              key={item.id}
                              value={searchValue}
                              data-checked={isSelected || undefined}
                              onSelect={() => handleSelect(item.id)}
                            >
                              <div className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate">{item.name}</span>
                                {item.description && (
                                  <span className="truncate text-xs text-muted-foreground">
                                    {item.description}
                                  </span>
                                )}
                              </div>
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                    </div>
                  ))}
                </>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {value && !disabled && !required && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-9 w-9 shrink-0"
          onClick={handleClear}
          aria-label="Clear selection"
        >
          <X className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

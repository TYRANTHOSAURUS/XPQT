import { useMemo, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useSpaceTree } from '@/api/spaces';
import { flattenTree, pathTo } from '@/components/admin/space-tree/build-tree';
import { SPACE_TYPE_LABELS, SpaceTypeIcon } from '@/components/admin/space-type-icon';
export type { Space } from '@/api/spaces';

interface SpaceSelectProps {
  value: string;
  onChange: (id: string) => void;
  /** Restrict selectable types (e.g. ['site', 'building']). Empty/omitted = all types selectable. Non-matching types still render as parent headers so the hierarchy stays visible. */
  typeFilter?: string[];
  /** Placeholder shown when no value is selected. */
  placeholder?: string;
  /** Label for the empty option. Set to null to hide the empty option entirely. */
  emptyLabel?: string | null;
  /** Optional id for accessibility wiring. */
  id?: string;
  className?: string;
}

export function SpaceSelect({
  value,
  onChange,
  typeFilter,
  placeholder = 'Select a location...',
  emptyLabel = 'No location',
  id,
  className,
}: SpaceSelectProps) {
  const { data: tree = [] } = useSpaceTree();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const isSelectable = (type: string) =>
    !typeFilter || typeFilter.length === 0 || typeFilter.includes(type);

  const triggerLabel = useMemo(() => {
    if (!value) return null;
    const path = pathTo(tree, value);
    if (path.length === 0) return null;
    if (path.length === 1) return path[0].name;
    const ancestors = path.slice(0, -1).map((n) => n.name).join(' / ');
    return `${ancestors} / ${path[path.length - 1].name}`;
  }, [tree, value]);

  const allRows = useMemo(() => flattenTree(tree), [tree]);

  const rows = useMemo(() => {
    if (!search.trim()) return allRows;
    const lower = search.toLowerCase();
    // While searching, only show direct name matches — no ancestor padding,
    // since `triggerLabel`-style breadcrumbs are rendered inline below.
    return allRows.filter((n) => n.name.toLowerCase().includes(lower));
  }, [allRows, search]);

  const breadcrumbFor = (id: string): string => {
    const path = pathTo(tree, id);
    if (path.length <= 1) return '';
    return path
      .slice(0, -1)
      .map((n) => n.name)
      .join(' / ');
  };

  const handleSelect = (nextId: string) => {
    onChange(nextId);
    setOpen(false);
    setSearch('');
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            role="combobox"
            id={id}
            aria-expanded={open}
            className={cn('w-full justify-between font-normal', className)}
          />
        }
      >
        <span className={cn('truncate', !triggerLabel && 'text-muted-foreground')}>
          {triggerLabel ?? placeholder}
        </span>
        <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[--radix-popover-trigger-width] min-w-[320px] overflow-hidden p-0">
        <div className="border-b p-2">
          <Input
            placeholder="Search locations…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
        </div>
        <div className="max-h-[320px] overflow-y-auto">
          <ul className="py-1">
            {emptyLabel !== null && !search.trim() && (
              <li>
                <button
                  type="button"
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted/60',
                    value === '' && 'bg-muted',
                  )}
                  onClick={() => handleSelect('')}
                >
                  <Check className={cn('size-4', value === '' ? 'opacity-100' : 'opacity-0')} />
                  <span className="text-muted-foreground">{emptyLabel}</span>
                </button>
              </li>
            )}
            {rows.length === 0 && (
              <li className="px-3 py-4 text-sm text-muted-foreground">No matching locations.</li>
            )}
            {rows.map((n) => {
              const selectable = isSelectable(n.type);
              const isSelected = value === n.id;
              const indent = search.trim() ? 0 : n.depth;
              const breadcrumb = search.trim() ? breadcrumbFor(n.id) : '';
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    disabled={!selectable}
                    style={{ paddingLeft: `${12 + indent * 16}px` }}
                    className={cn(
                      'flex w-full items-center gap-2 py-1.5 pr-3 text-left text-sm',
                      selectable
                        ? 'hover:bg-muted/60'
                        : 'cursor-default text-muted-foreground/80',
                      isSelected && 'bg-muted',
                    )}
                    onClick={() => selectable && handleSelect(n.id)}
                  >
                    <Check
                      className={cn(
                        'size-4 shrink-0',
                        selectable && isSelected ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                    <SpaceTypeIcon type={n.type} className="size-3.5 shrink-0 opacity-70" />
                    <span className="min-w-0 flex-1 truncate">
                      {breadcrumb && (
                        <span className="text-muted-foreground">{breadcrumb} / </span>
                      )}
                      <span>{n.name}</span>
                    </span>
                    <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                      {SPACE_TYPE_LABELS[n.type]}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </PopoverContent>
    </Popover>
  );
}

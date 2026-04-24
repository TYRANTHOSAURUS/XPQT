import { useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { useSpaceTree } from '@/api/spaces';
import { allowedChildTypes, type SpaceType } from '@prequest/shared';
import { SPACE_TYPE_LABELS, SpaceTypeIcon } from './space-type-icon';
import { flattenTree, pathTo } from './space-tree/build-tree';

interface Props {
  /** The type of the node we're moving/creating. Used to filter valid parents. */
  childType: SpaceType;
  value: string | null;
  onChange: (parentId: string | null) => void;
  /** IDs to exclude (e.g. self and descendants when moving). */
  excludeIds?: ReadonlySet<string>;
  disabled?: boolean;
}

function canAcceptChild(parentType: SpaceType, childType: SpaceType): boolean {
  return allowedChildTypes(parentType).includes(childType);
}

export function SpaceParentPicker({
  childType,
  value,
  onChange,
  excludeIds,
  disabled,
}: Props) {
  const { data: tree = [] } = useSpaceTree();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const label = useMemo(() => {
    if (value === null) return 'Root (no parent)';
    if (!value) return 'Select a parent';
    const node = pathTo(tree, value).at(-1);
    return node ? node.name : 'Select a parent';
  }, [value, tree]);

  const rows = useMemo(() => {
    const flat = flattenTree(tree);
    return flat
      .filter((n) => !excludeIds?.has(n.id))
      .filter((n) => canAcceptChild(n.type, childType))
      .filter((n) => (search ? n.name.toLowerCase().includes(search.toLowerCase()) : true));
  }, [tree, excludeIds, childType, search]);

  const rootAllowed = allowedChildTypes(null).includes(childType);

  return (
    <Popover open={open} onOpenChange={disabled ? undefined : setOpen}>
      <PopoverTrigger
        render={
          <Button variant="outline" className="justify-between w-full" />
        }
      >
        <span className="truncate">{label}</span>
        <ChevronRight className="size-4 opacity-50" />
      </PopoverTrigger>
      <PopoverContent align="start" className="p-0 w-[360px]">
        <div className="p-2 border-b">
          <Input
            placeholder="Search parents…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
        </div>
        <ScrollArea className="max-h-[320px]">
          <ul className="py-1">
            {rootAllowed && (
              <li>
                <button
                  type="button"
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted/60',
                    value === null && 'bg-muted',
                  )}
                  onClick={() => { onChange(null); setOpen(false); }}
                >
                  <span className="text-muted-foreground">Root (tenant top-level)</span>
                </button>
              </li>
            )}
            {rows.length === 0 && (
              <li className="px-3 py-4 text-sm text-muted-foreground">No valid parents</li>
            )}
            {rows.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  style={{ paddingLeft: `${12 + n.depth * 16}px` }}
                  className={cn(
                    'flex w-full items-center gap-2 pr-3 py-1.5 text-left text-sm hover:bg-muted/60',
                    value === n.id && 'bg-muted',
                  )}
                  onClick={() => { onChange(n.id); setOpen(false); }}
                >
                  <SpaceTypeIcon type={n.type} className="size-3.5" />
                  <span className="truncate">{n.name}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {SPACE_TYPE_LABELS[n.type]}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

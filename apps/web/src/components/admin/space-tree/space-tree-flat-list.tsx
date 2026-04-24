import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { SpaceTreeNode } from '@/api/spaces';
import { flattenTree, pathTo } from './build-tree';
import { SpaceTypeIcon } from '../space-type-icon';

interface Props {
  tree: SpaceTreeNode[];
  query: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function SpaceTreeFlatList({ tree, query, selectedId, onSelect }: Props) {
  const rows = useMemo(() => {
    const flat = flattenTree(tree);
    const q = query.trim().toLowerCase();
    return flat.filter((n) => {
      if (!q) return true;
      return (
        n.name.toLowerCase().includes(q) ||
        (n.code ?? '').toLowerCase().includes(q)
      );
    });
  }, [tree, query]);

  if (rows.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground">No matches.</div>;
  }

  return (
    <ul className="flex-1 overflow-auto py-1">
      {rows.map((n) => {
        const path = pathTo(tree, n.id);
        const breadcrumb = path.slice(0, -1).map((p) => p.name).join(' › ');
        return (
          <li key={n.id}>
            <button
              type="button"
              onClick={() => onSelect(n.id)}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/50',
                selectedId === n.id && 'bg-accent/40',
              )}
            >
              <SpaceTypeIcon type={n.type} />
              <div className="flex-1 min-w-0">
                <div className="truncate text-sm">{n.name}</div>
                {breadcrumb && (
                  <div className="truncate text-[11px] text-muted-foreground">{breadcrumb}</div>
                )}
              </div>
              {n.code && <Badge variant="outline" className="font-mono text-[11px]">{n.code}</Badge>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

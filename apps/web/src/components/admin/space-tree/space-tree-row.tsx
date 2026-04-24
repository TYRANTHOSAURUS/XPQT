import { ChevronRight, Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { FlatNode } from './build-tree';
import { SpaceTypeIcon } from '../space-type-icon';

interface Props {
  node: FlatNode;
  isExpanded: boolean;
  isSelected: boolean;
  onSelect: () => void;
  onToggleExpand: () => void;
  onAddChild: () => void;
}

export function SpaceTreeRow({
  node, isExpanded, isSelected, onSelect, onToggleExpand, onAddChild,
}: Props) {
  const hasChildren = node.childCount > 0;
  return (
    <div
      role="treeitem"
      aria-expanded={hasChildren ? isExpanded : undefined}
      aria-selected={isSelected}
      tabIndex={isSelected ? 0 : -1}
      onClick={onSelect}
      className={cn(
        'group flex items-center gap-2 pr-2 py-1.5 cursor-pointer select-none rounded-md',
        'hover:bg-muted/50',
        isSelected && 'bg-accent/40 border-l-2 border-l-primary',
      )}
      style={{ paddingLeft: `${8 + node.depth * 16}px` }}
    >
      <button
        type="button"
        aria-label={isExpanded ? 'Collapse' : 'Expand'}
        onClick={(e) => { e.stopPropagation(); onToggleExpand(); }}
        className={cn(
          'inline-flex size-4 items-center justify-center text-muted-foreground transition-transform',
          !hasChildren && 'invisible',
          isExpanded && 'rotate-90',
        )}
      >
        <ChevronRight className="size-4" />
      </button>
      <SpaceTypeIcon type={node.type} />
      <span className="flex-1 truncate text-sm">{node.name}</span>
      {node.code && (
        <Badge variant="outline" className="font-mono text-[11px] px-1.5 py-0">{node.code}</Badge>
      )}
      {hasChildren && (
        <span className="text-xs text-muted-foreground tabular-nums" aria-label={`${node.childCount} children`}>
          {node.childCount}
        </span>
      )}
      <button
        type="button"
        aria-label="Add child"
        onClick={(e) => { e.stopPropagation(); onAddChild(); }}
        className="inline-flex size-5 items-center justify-center text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground"
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  );
}

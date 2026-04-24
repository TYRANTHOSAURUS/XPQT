import { ChevronRight, Pencil, MoveRight, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { Space, SpaceTreeNode } from '@/api/spaces';
import { pathTo } from '../space-tree/build-tree';
import { SPACE_TYPE_LABELS, SpaceTypeIcon } from '../space-type-icon';


interface Props {
  space: Space;
  tree: SpaceTreeNode[];
  onNavigate: (id: string | null) => void;
  onEdit: () => void;
  onMove: () => void;
  onArchive: () => void;
}

export function SpaceDetailHeader({ space, tree, onNavigate, onEdit, onMove, onArchive }: Props) {
  const path = pathTo(tree, space.id).slice(0, -1);
  const truncated = path.length > 4;
  const visible = truncated ? [path[0], ...path.slice(-2)] : path;

  return (
    <div className="border-b px-6 py-4">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-xs text-muted-foreground">
        <button type="button" className="hover:text-foreground" onClick={() => onNavigate(null)}>All spaces</button>
        {visible.map((n, i) => (
          <span key={n.id} className="flex items-center gap-1">
            <ChevronRight className="size-3" />
            {truncated && i === 1 && <span className="text-muted-foreground">…</span>}
            {truncated && i === 1 && <ChevronRight className="size-3" />}
            <button type="button" className="hover:text-foreground truncate max-w-[160px]" onClick={() => onNavigate(n.id)}>
              {n.name}
            </button>
          </span>
        ))}
      </nav>

      <div className="mt-2 flex items-start gap-3">
        <SpaceTypeIcon type={space.type} className="size-5 mt-1" />
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-semibold tracking-tight truncate">{space.name}</h1>
          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="secondary">{SPACE_TYPE_LABELS[space.type]}</Badge>
            {space.code && <span className="font-mono">{space.code}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={<Button variant="ghost" size="icon" onClick={onEdit}><Pencil className="size-4" /></Button>}
            />
            <TooltipContent>Edit</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={<Button variant="ghost" size="icon" onClick={onMove}><MoveRight className="size-4" /></Button>}
            />
            <TooltipContent>Move</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={<Button variant="ghost" size="icon" onClick={onArchive}><Trash2 className="size-4" /></Button>}
            />
            <TooltipContent>Archive</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

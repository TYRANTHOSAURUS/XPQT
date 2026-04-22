import { ChevronRight, Building2, Users, MapPin, Wrench } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export interface OrgNodeListItem {
  id: string;
  name: string;
  code: string | null;
  parent_id: string | null;
  member_count: number;
  location_grant_count: number;
  team_count: number;
}

interface OrgNodeTreeProps {
  nodes: OrgNodeListItem[];
}

interface TreeNode extends OrgNodeListItem {
  children: TreeNode[];
}

function buildTree(nodes: OrgNodeListItem[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const n of nodes) byId.set(n.id, { ...n, children: [] });
  const roots: TreeNode[] = [];
  for (const n of byId.values()) {
    if (n.parent_id && byId.has(n.parent_id)) {
      byId.get(n.parent_id)!.children.push(n);
    } else {
      roots.push(n);
    }
  }
  const sortRecursive = (list: TreeNode[]) => {
    list.sort((a, b) => a.name.localeCompare(b.name));
    list.forEach((c) => sortRecursive(c.children));
  };
  sortRecursive(roots);
  return roots;
}

function Row({ node, depth }: { node: TreeNode; depth: number }) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;
  return (
    <>
      <div
        className="group flex items-center gap-3 py-2 pr-2 hover:bg-muted/50 rounded-md"
        style={{ paddingLeft: `${depth * 20 + 8}px` }}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={cn(
            'inline-flex size-4 items-center justify-center text-muted-foreground transition-transform',
            !hasChildren && 'invisible',
            expanded && 'rotate-90',
          )}
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          <ChevronRight className="size-4" />
        </button>
        <Building2 className="size-4 text-muted-foreground" />
        <Link
          to={`/admin/organisations/${node.id}`}
          className="flex-1 truncate text-sm font-medium hover:underline"
        >
          {node.name}
        </Link>
        {node.code && <Badge variant="outline" className="font-mono text-xs">{node.code}</Badge>}
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title="Members">
          <Users className="size-3" /> {node.member_count}
        </span>
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title="Location grants">
          <MapPin className="size-3" /> {node.location_grant_count}
        </span>
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title="Teams attached">
          <Wrench className="size-3" /> {node.team_count}
        </span>
      </div>
      {expanded && node.children.map((child) => (
        <Row key={child.id} node={child} depth={depth + 1} />
      ))}
    </>
  );
}

export function OrgNodeTree({ nodes }: OrgNodeTreeProps) {
  const tree = buildTree(nodes);
  if (tree.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-0.5">
      {tree.map((root) => (
        <Row key={root.id} node={root} depth={0} />
      ))}
    </div>
  );
}

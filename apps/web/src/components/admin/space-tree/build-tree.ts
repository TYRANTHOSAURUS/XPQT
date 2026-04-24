import type { SpaceTreeNode } from '@/api/spaces';
import type { SpaceType } from '@prequest/shared';

export interface FlatNode {
  id: string;
  name: string;
  code: string | null;
  type: SpaceType;
  parentId: string | null;
  depth: number;
  childIds: string[];
  childCount: number;
}

/** Flatten a nested tree into a depth-annotated array (pre-order). */
export function flattenTree(
  roots: SpaceTreeNode[],
  collapsedIds?: Set<string>,
  depth = 0,
  acc: FlatNode[] = [],
): FlatNode[] {
  for (const node of roots) {
    acc.push({
      id: node.id,
      name: node.name,
      code: node.code,
      type: node.type,
      parentId: node.parent_id,
      depth,
      childIds: node.children.map((c) => c.id),
      childCount: node.child_count,
    });
    if (!collapsedIds?.has(node.id)) {
      flattenTree(node.children, collapsedIds, depth + 1, acc);
    }
  }
  return acc;
}

export function findNode(
  roots: SpaceTreeNode[],
  id: string,
): SpaceTreeNode | null {
  for (const n of roots) {
    if (n.id === id) return n;
    const child = findNode(n.children, id);
    if (child) return child;
  }
  return null;
}

export function pathTo(
  roots: SpaceTreeNode[],
  id: string,
): SpaceTreeNode[] {
  const path: SpaceTreeNode[] = [];
  const walk = (nodes: SpaceTreeNode[]): boolean => {
    for (const n of nodes) {
      path.push(n);
      if (n.id === id) return true;
      if (walk(n.children)) return true;
      path.pop();
    }
    return false;
  };
  walk(roots);
  return path;
}

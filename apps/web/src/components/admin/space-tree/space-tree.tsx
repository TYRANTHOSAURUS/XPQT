import { useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { SpaceTreeNode } from '@/api/spaces';
import type { SpaceType } from '@prequest/shared';
import { flattenTree } from './build-tree';
import { SpaceTreeRow } from './space-tree-row';
import type { SpaceTreeState } from './use-space-tree-state';

interface Props {
  tree: SpaceTreeNode[];
  state: SpaceTreeState;
  onAddChild: (parentId: string, parentType: SpaceType) => void;
}

export function SpaceTree({ tree, state, onAddChild }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);

  const collapsed = useMemo(() => {
    const s = new Set<string>();
    const walk = (nodes: SpaceTreeNode[]) => {
      for (const n of nodes) {
        if (!state.expandedIds.has(n.id)) s.add(n.id);
        walk(n.children);
      }
    };
    walk(tree);
    return s;
  }, [tree, state.expandedIds]);

  const rows = useMemo(() => flattenTree(tree, collapsed), [tree, collapsed]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 32,
    overscan: 12,
  });

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!state.selectedId) return;
    const index = rows.findIndex((r) => r.id === state.selectedId);
    if (index === -1) return;
    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        const next = rows[Math.min(index + 1, rows.length - 1)];
        if (next) state.setSelectedId(next.id);
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        const prev = rows[Math.max(index - 1, 0)];
        if (prev) state.setSelectedId(prev.id);
        break;
      }
      case 'ArrowRight': {
        e.preventDefault();
        if (!state.expandedIds.has(state.selectedId)) state.toggleExpanded(state.selectedId);
        break;
      }
      case 'ArrowLeft': {
        e.preventDefault();
        if (state.expandedIds.has(state.selectedId)) state.toggleExpanded(state.selectedId);
        else {
          const parentId = rows[index].parentId;
          if (parentId) state.setSelectedId(parentId);
        }
        break;
      }
    }
  };

  return (
    <div
      ref={parentRef}
      role="tree"
      aria-label="Spaces"
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="relative overflow-auto flex-1 outline-none"
    >
      <div style={{ height: rowVirtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
        {rowVirtualizer.getVirtualItems().map((vi) => {
          const node = rows[vi.index];
          return (
            <div
              key={node.id}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vi.start}px)`,
              }}
            >
              <SpaceTreeRow
                node={node}
                isExpanded={state.expandedIds.has(node.id)}
                isSelected={state.selectedId === node.id}
                onSelect={() => state.setSelectedId(node.id)}
                onToggleExpand={() => state.toggleExpanded(node.id)}
                onAddChild={() => onAddChild(node.id, node.type)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

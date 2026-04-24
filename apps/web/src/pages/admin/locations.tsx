import { useState, useMemo, useEffect } from 'react';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react';
import type { SpaceType } from '@prequest/shared';
import { useSpaceTree, type SpaceTreeNode } from '@/api/spaces';
import { SpaceTreeSearch } from '@/components/admin/space-tree/space-tree-search';
import { SpaceTree } from '@/components/admin/space-tree/space-tree';
import { SpaceTreeFlatList } from '@/components/admin/space-tree/space-tree-flat-list';
import { useSpaceTreeState } from '@/components/admin/space-tree/use-space-tree-state';
import { SpaceDetail } from '@/components/admin/space-detail/space-detail';
import { SpaceFormDialog } from '@/components/admin/space-form';

// Note: this page deliberately deviates from the standard admin "Index + detail"
// shape in CLAUDE.md because the data is a hierarchical tree (1-100 buildings,
// many floors/wings/rooms), which does not fit the "list of decisions" pattern.
// Deviation is documented in docs/superpowers/specs/2026-04-24-locations-spaces-ux-design.md.
export function LocationsPage() {
  const { data: tree = [], isLoading } = useSpaceTree();
  const state = useSpaceTreeState(tree);
  const [rootCreateOpen, setRootCreateOpen] = useState(false);
  const [childCreate, setChildCreate] = useState<{ id: string; type: SpaceType } | null>(null);

  const handleAddChild = (parentId: string, parentType: SpaceType) =>
    setChildCreate({ id: parentId, type: parentType });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        document.querySelector<HTMLInputElement>('input[placeholder="Search name or code…"]')?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const matchCount = useMemo(() => {
    if (state.mode !== 'flat' || !state.searchQuery.trim()) return null;
    const q = state.searchQuery.toLowerCase();
    let count = 0;
    const walk = (nodes: SpaceTreeNode[]) => {
      for (const n of nodes) {
        if (n.name.toLowerCase().includes(q) || (n.code ?? '').toLowerCase().includes(q)) count++;
        walk(n.children);
      }
    };
    walk(tree);
    return count;
  }, [state.mode, state.searchQuery, tree]);

  return (
    <div className="h-[calc(100vh-4rem)] flex flex-col">
      <div className="flex items-center justify-between px-6 py-3 border-b">
        <div>
          <h1 className="text-lg font-semibold">Locations &amp; Spaces</h1>
          <p className="text-xs text-muted-foreground">Sites, buildings, wings, floors, rooms, and desks</p>
        </div>
        <Button size="sm" onClick={() => setRootCreateOpen(true)}>
          <Plus className="size-3.5" /> Add site
        </Button>
      </div>

      <ResizablePanelGroup orientation="horizontal" className="flex-1">
        <ResizablePanel defaultSize={28} minSize={20} maxSize={45} className="flex flex-col">
          <SpaceTreeSearch
            value={state.searchQuery}
            onChange={state.setSearchQuery}
            mode={state.mode}
            onModeChange={state.setMode}
          />
          {isLoading ? (
            <div className="p-4 text-sm text-muted-foreground">Loading…</div>
          ) : tree.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">
              No spaces yet.{' '}
              <button type="button" className="underline" onClick={() => setRootCreateOpen(true)}>
                Add your first site
              </button>
              .
            </div>
          ) : state.mode === 'flat' ? (
            <>
              {matchCount !== null && (
                <div className="px-3 py-1.5 text-xs text-muted-foreground border-b">{matchCount} matches</div>
              )}
              <SpaceTreeFlatList
                tree={tree}
                query={state.searchQuery}
                selectedId={state.selectedId}
                onSelect={(id) => state.setSelectedId(id)}
              />
            </>
          ) : (
            <SpaceTree tree={tree} state={state} onAddChild={handleAddChild} />
          )}
        </ResizablePanel>

        <ResizableHandle />

        <ResizablePanel defaultSize={72} className="flex flex-col overflow-hidden">
          <SpaceDetail spaceId={state.selectedId} onNavigate={state.setSelectedId} />
        </ResizablePanel>
      </ResizablePanelGroup>

      <SpaceFormDialog
        open={rootCreateOpen}
        onOpenChange={setRootCreateOpen}
        mode={{ kind: 'create', parentId: null, parentType: null }}
      />

      {childCreate && (
        <SpaceFormDialog
          open={Boolean(childCreate)}
          onOpenChange={(o) => !o && setChildCreate(null)}
          mode={{ kind: 'create', parentId: childCreate.id, parentType: childCreate.type }}
        />
      )}
    </div>
  );
}

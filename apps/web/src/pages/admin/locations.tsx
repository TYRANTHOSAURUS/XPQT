import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
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

const RAIL_KEY = 'pq.admin.locations.rail-width';
const RAIL_DEFAULT = 320;
const RAIL_MIN = 220;
const RAIL_MAX = 560;

const clamp = (n: number) => Math.max(RAIL_MIN, Math.min(RAIL_MAX, n));

function readSavedRail(): number {
  try {
    const raw = localStorage.getItem(RAIL_KEY);
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) ? clamp(n) : RAIL_DEFAULT;
  } catch {
    return RAIL_DEFAULT;
  }
}

export function LocationsPage() {
  const { data: tree = [], isLoading } = useSpaceTree();
  const state = useSpaceTreeState(tree);
  const [rootCreateOpen, setRootCreateOpen] = useState(false);
  const [childCreate, setChildCreate] = useState<{ id: string; type: SpaceType } | null>(null);
  const [railWidth, setRailWidth] = useState<number>(() => readSavedRail());
  const railWidthRef = useRef(railWidth);
  railWidthRef.current = railWidth;

  const handleRailDragStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = railWidthRef.current;
    let latest = startWidth;
    const onMove = (ev: PointerEvent) => {
      latest = clamp(startWidth + ev.clientX - startX);
      setRailWidth(latest);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      try { localStorage.setItem(RAIL_KEY, String(latest)); } catch { /* ignore quota */ }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  }, []);

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
    <div className="-mx-6 -mb-6 flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between border-b px-6 py-3">
        <div>
          <h1 className="text-lg font-semibold">Locations &amp; Spaces</h1>
          <p className="text-xs text-muted-foreground">Sites, buildings, wings, floors, rooms, and desks</p>
        </div>
        <Button size="sm" onClick={() => setRootCreateOpen(true)}>
          <Plus className="size-3.5" /> Add site
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside
          style={{ width: railWidth }}
          className="flex shrink-0 flex-col border-r"
        >
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
        </aside>

        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize tree panel"
          onPointerDown={handleRailDragStart}
          className="group relative -mr-px w-1 shrink-0 cursor-col-resize select-none bg-transparent transition-colors hover:bg-primary/30"
        >
          <div className="absolute inset-y-0 left-0 w-px bg-border group-hover:bg-primary/40" />
        </div>

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <SpaceDetail spaceId={state.selectedId} onNavigate={state.setSelectedId} />
        </main>
      </div>

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

import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, CornerDownRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { apiFetch } from '@/lib/api';

interface SpaceSummary {
  id: string;
  name: string;
  type: string;
}

interface SpaceNode extends SpaceSummary {
  has_children: boolean;
  active: boolean;
}

interface PortalSpacesResponse {
  parent: SpaceSummary;
  children: SpaceNode[];
}

// Canonical depth ordering of spaces.type values. Values not listed are
// treated as leaf-level (room-depth). Kept in sync with 00004_spaces.sql.
const TYPE_RANK: Record<string, number> = {
  site: 0,
  building: 1,
  floor: 2,
  room: 3,
  meeting_room: 3,
  common_area: 3,
  storage_room: 3,
  technical_room: 3,
  parking_space: 3,
  desk: 4,
};

function typeRank(type: string): number {
  return TYPE_RANK[type] ?? 3;
}

export function satisfiesGranularity(selectedType: string, granularity: string | null): boolean {
  if (!granularity) return true;
  return typeRank(selectedType) >= typeRank(granularity);
}

interface Props {
  /** Root of the drill (must be in the user's authorized set). */
  rootSpace: SpaceSummary;
  /** Required depth from request_types.location_granularity. */
  granularity: string;
  /** Emitted when the user picks a space that satisfies the granularity. */
  onPick: (space: SpaceSummary) => void;
  /** Current selection (if any) — used to pre-expand the chain back to root. */
  selected?: SpaceSummary | null;
}

/**
 * Breadcrumb-style drill-down over the space hierarchy, backed by
 * /portal/spaces?under=<id>. One level loaded at a time; stops when the user
 * selects a space that satisfies the required granularity.
 */
export function PortalLocationDrilldown({ rootSpace, granularity, onPick, selected }: Props) {
  const [path, setPath] = useState<SpaceSummary[]>([rootSpace]);
  const [children, setChildren] = useState<SpaceNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadChildren = useCallback(async (parentId: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<PortalSpacesResponse>(
        `/portal/spaces?under=${encodeURIComponent(parentId)}`,
      );
      setChildren(res.children);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load spaces');
      setChildren([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load (children of root).
  useEffect(() => {
    setPath([rootSpace]);
    void loadChildren(rootSpace.id);
  }, [rootSpace.id, rootSpace, loadChildren]);

  const navigateTo = useCallback(
    (space: SpaceNode | SpaceSummary, index?: number) => {
      if (typeof index === 'number') {
        // Breadcrumb click: truncate back to that index.
        setPath((prev) => prev.slice(0, index + 1));
      } else {
        setPath((prev) => [...prev, space]);
      }
      void loadChildren(space.id);
    },
    [loadChildren],
  );

  const handleSelect = (space: SpaceNode) => {
    if (satisfiesGranularity(space.type, granularity)) {
      onPick(space);
    } else if (space.has_children) {
      navigateTo(space);
    }
  };

  const currentNode = path[path.length - 1];

  return (
    <div className="rounded-md border">
      <div className="flex items-center gap-1 flex-wrap px-3 py-2 border-b text-sm">
        <CornerDownRight className="h-3.5 w-3.5 text-muted-foreground" />
        {path.map((node, i) => (
          <div key={node.id} className="flex items-center gap-1">
            <button
              type="button"
              className={`hover:underline ${i === path.length - 1 ? 'font-medium' : 'text-muted-foreground'}`}
              onClick={() => navigateTo(node, i)}
            >
              {node.name}
            </button>
            {i < path.length - 1 && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
          </div>
        ))}
      </div>

      <div className="p-3">
        <p className="text-xs text-muted-foreground mb-2">
          Select a <span className="font-medium capitalize">{granularity.replace('_', ' ')}</span> inside <span className="font-medium">{currentNode.name}</span>
        </p>

        {loading && (
          <div className="flex items-center gap-2 text-muted-foreground text-sm py-4">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        )}

        {error && !loading && (
          <p className="text-sm text-destructive">{error}</p>
        )}

        {!loading && !error && children.length === 0 && (
          <p className="text-sm text-muted-foreground py-3">
            No sub-locations inside {currentNode.name}.
          </p>
        )}

        <div className="flex flex-col divide-y">
          {children.map((child) => {
            const ok = satisfiesGranularity(child.type, granularity);
            const isSelected = selected?.id === child.id;
            return (
              <div key={child.id} className="flex items-center justify-between py-1.5">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{child.name}</span>
                    <Badge variant="outline" className="text-xs capitalize shrink-0">
                      {child.type.replace('_', ' ')}
                    </Badge>
                    {isSelected && <Badge className="text-xs shrink-0">Selected</Badge>}
                  </div>
                </div>
                <div className="flex gap-1">
                  {child.has_children && !ok && (
                    <Button size="sm" variant="ghost" onClick={() => navigateTo(child)}>
                      Open <ChevronRight className="h-3 w-3" />
                    </Button>
                  )}
                  {ok && (
                    <Button
                      size="sm"
                      variant={isSelected ? 'secondary' : 'default'}
                      onClick={() => handleSelect(child)}
                    >
                      {isSelected ? 'Selected' : 'Select'}
                    </Button>
                  )}
                  {child.has_children && ok && (
                    <Button size="sm" variant="ghost" onClick={() => navigateTo(child)}>
                      Open
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

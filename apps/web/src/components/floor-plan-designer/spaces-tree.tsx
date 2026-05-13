import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type { DesignerState } from './types';

type ChildSpace = { id: string; name: string; type: string; capacity: number | null };

type Props = { floorSpaceId: string; state: DesignerState; dispatch: React.Dispatch<any> };

export function SpacesTree({ floorSpaceId, state, dispatch }: Props) {
  const children = useQuery({
    queryKey: ['spaces', 'children', floorSpaceId],
    queryFn: () => apiFetch<ChildSpace[]>(`/spaces/${floorSpaceId}/children`),
    staleTime: 60_000,
  });
  const drawnIds = new Set(state.polygons.map((p) => p.space_id).filter(Boolean));

  return (
    <div className="border-r border-border bg-background p-4 overflow-y-auto">
      <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Spaces on this floor</div>
      <p className="mb-3 text-[11px] leading-snug text-muted-foreground">
        Green dot = polygon drawn. Click a space here to highlight its polygon on the canvas, or draw a new shape and link it from the inspector.
      </p>
      {children.isLoading && (
        <div className="text-sm text-muted-foreground">Loading…</div>
      )}
      {(children.data ?? []).map((s) => {
        const isDrawn = drawnIds.has(s.id);
        const idx = state.polygons.findIndex((p) => p.space_id === s.id);
        const selected = idx >= 0 && idx === state.selectedPolygonIndex;
        return (
          <button
            key={s.id}
            onClick={() => dispatch({ type: 'select-polygon', index: idx >= 0 ? idx : null })}
            className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm ${selected ? 'bg-muted' : 'hover:bg-muted/50'}`}
          >
            <span className="flex items-center gap-2">
              <span className={`inline-block h-2 w-2 rounded-full ${isDrawn ? 'bg-emerald-400' : 'bg-muted-foreground/30'}`} />
              <span className={isDrawn ? 'text-foreground' : 'text-muted-foreground'}>{s.name}</span>
            </span>
            {s.capacity !== null && (
              <span className="tabular-nums text-xs text-muted-foreground">{s.capacity}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

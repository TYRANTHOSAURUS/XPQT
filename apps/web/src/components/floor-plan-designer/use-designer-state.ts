import { useReducer, useEffect, useRef } from 'react';
import type { DesignerState, ToolKind } from './types';
import type { DraftResponse, Polygon } from '@/api/floor-plans/types';
import { useUpdateDraft } from '@/api/floor-plans/hooks';
import { toast } from '@/lib/toast';

type Action =
  | { type: 'hydrate'; draft: DraftResponse }
  | { type: 'select-polygon'; index: number | null }
  | { type: 'set-tool'; tool: ToolKind }
  | { type: 'add-polygon'; polygon: Polygon }
  | { type: 'update-polygon'; index: number; patch: Partial<Polygon> }
  | { type: 'remove-polygon'; index: number }
  | { type: 'set-image'; imagePath: string; previewUrl: string | null; widthPx: number; heightPx: number }
  | { type: 'start-drawing'; polygon: Polygon }
  | { type: 'commit-drawing' }
  | { type: 'cancel-drawing' }
  | { type: 'server-sync'; updatedAt: string };

function reducer(state: DesignerState, action: Action): DesignerState {
  switch (action.type) {
    case 'hydrate':
      return {
        draftId: action.draft.id,
        updatedAt: action.draft.updated_at,
        imageUrl: action.draft.image_url,
        previewUrl: null,
        widthPx: action.draft.width_px,
        heightPx: action.draft.height_px,
        polygons: action.draft.polygons,
        labels: action.draft.labels,
        selectedPolygonIndex: null,
        activeTool: 'select',
        inProgressPolygon: null,
      };
    case 'select-polygon': return { ...state, selectedPolygonIndex: action.index };
    case 'set-tool':       return { ...state, activeTool: action.tool, inProgressPolygon: null };
    case 'add-polygon':    return { ...state, polygons: [...state.polygons, action.polygon] };
    case 'update-polygon': return {
      ...state,
      polygons: state.polygons.map((p, i) => i === action.index ? { ...p, ...action.patch } : p),
    };
    case 'remove-polygon': return {
      ...state,
      polygons: state.polygons.filter((_, i) => i !== action.index),
      selectedPolygonIndex: state.selectedPolygonIndex === action.index ? null : state.selectedPolygonIndex,
    };
    case 'set-image':
      // imagePath is persisted to server; previewUrl is local-only signed URL for display
      return { ...state, imageUrl: action.imagePath, previewUrl: action.previewUrl, widthPx: action.widthPx, heightPx: action.heightPx };
    case 'start-drawing':  return { ...state, inProgressPolygon: action.polygon };
    case 'commit-drawing': return state.inProgressPolygon
      ? { ...state, polygons: [...state.polygons, state.inProgressPolygon], inProgressPolygon: null }
      : state;
    case 'cancel-drawing': return { ...state, inProgressPolygon: null };
    case 'server-sync':    return { ...state, updatedAt: action.updatedAt };
  }
}

const INITIAL: DesignerState = {
  draftId: '',
  updatedAt: '',
  imageUrl: null,
  previewUrl: null,
  widthPx: null,
  heightPx: null,
  polygons: [],
  labels: [],
  selectedPolygonIndex: null,
  activeTool: 'select',
  inProgressPolygon: null,
};

export function useDesignerState(floorSpaceId: string, draft: DraftResponse | undefined) {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const updateDraft = useUpdateDraft(floorSpaceId);
  const lastSyncedRef = useRef<string>('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (draft && draft.id !== state.draftId) dispatch({ type: 'hydrate', draft });
  }, [draft, state.draftId]);

  useEffect(() => {
    if (!state.draftId || !state.updatedAt) return;
    const snapshot = JSON.stringify({
      polygons: state.polygons,
      labels: state.labels,
      imageUrl: state.imageUrl,
      widthPx: state.widthPx,
      heightPx: state.heightPx,
    });
    if (snapshot === lastSyncedRef.current) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      lastSyncedRef.current = snapshot;
      try {
        const data = await updateDraft.mutateAsync({
          patch: {
            polygons: state.polygons,
            labels: state.labels,
            image_url: state.imageUrl,
            width_px: state.widthPx ?? undefined,
            height_px: state.heightPx ?? undefined,
          },
          ifMatch: state.updatedAt,
        });
        dispatch({ type: 'server-sync', updatedAt: data.updated_at });
      } catch (err: unknown) {
        const e = err as Record<string, unknown>;
        if (e?.['code'] === 'floor_plan.draft.stale_update' || e?.['status'] === 409) {
          toast.warning('Another change happened', {
            description: 'This draft was modified elsewhere. Reload to see the latest.',
            action: { label: 'Reload', onClick: () => window.location.reload() },
          });
        }
        // other errors handled by mutation's onError
      }
    }, 500);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [state.polygons, state.labels, state.imageUrl, state.widthPx, state.heightPx, state.draftId, state.updatedAt, updateDraft]);

  return { state, dispatch, isSaving: updateDraft.isPending } as const;
}

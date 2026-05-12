import { useReducer, useEffect, useRef } from 'react';
import type { DesignerState, ToolKind } from './types';
import type { DraftResponse, Label, Polygon } from '@/api/floor-plans/types';
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
  | { type: 'server-sync'; updatedAt: string }
  | { type: 'undo' }
  | { type: 'redo' };

/** The subset of DesignerState tracked in the undo/redo history. */
type HistoryEntry = {
  polygons: Polygon[];
  labels: Label[];
  imageUrl: string | null;
  previewUrl: string | null;
  widthPx: number | null;
  heightPx: number | null;
};

type StateWithHistory = DesignerState & {
  _history: HistoryEntry[];
  _historyIndex: number;
};

const HISTORY_MAX = 50;

function snapshotEntry(s: DesignerState): HistoryEntry {
  return {
    polygons: s.polygons,
    labels: s.labels,
    imageUrl: s.imageUrl,
    previewUrl: s.previewUrl,
    widthPx: s.widthPx,
    heightPx: s.heightPx,
  };
}

function pushHistory(state: StateWithHistory): { _history: HistoryEntry[]; _historyIndex: number } {
  // Truncate forward branch if re-doing after undos
  const trimmed = state._history.slice(0, state._historyIndex + 1);
  const entry = snapshotEntry(state);
  const next = [...trimmed, entry].slice(-HISTORY_MAX);
  return { _history: next, _historyIndex: next.length - 1 };
}

function applyEntry(state: StateWithHistory, entry: HistoryEntry): StateWithHistory {
  return { ...state, ...entry };
}

function reducer(state: StateWithHistory, action: Action): StateWithHistory {
  switch (action.type) {
    case 'hydrate':
      return {
        ...state,
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
        _history: [],
        _historyIndex: -1,
      };
    case 'select-polygon': return { ...state, selectedPolygonIndex: action.index };
    case 'set-tool':       return { ...state, activeTool: action.tool, inProgressPolygon: null };
    case 'add-polygon': {
      const hist = pushHistory(state);
      return { ...state, ...hist, polygons: [...state.polygons, action.polygon] };
    }
    case 'update-polygon': {
      const hist = pushHistory(state);
      return {
        ...state,
        ...hist,
        polygons: state.polygons.map((p, i) => i === action.index ? { ...p, ...action.patch } : p),
      };
    }
    case 'remove-polygon': {
      const hist = pushHistory(state);
      return {
        ...state,
        ...hist,
        polygons: state.polygons.filter((_, i) => i !== action.index),
        selectedPolygonIndex: state.selectedPolygonIndex === action.index ? null : state.selectedPolygonIndex,
      };
    }
    case 'set-image': {
      const hist = pushHistory(state);
      // imagePath is persisted to server; previewUrl is local-only signed URL for display
      return { ...state, ...hist, imageUrl: action.imagePath, previewUrl: action.previewUrl, widthPx: action.widthPx, heightPx: action.heightPx };
    }
    case 'start-drawing':  return { ...state, inProgressPolygon: action.polygon };
    case 'commit-drawing': {
      if (!state.inProgressPolygon) return state;
      const hist = pushHistory(state);
      return { ...state, ...hist, polygons: [...state.polygons, state.inProgressPolygon], inProgressPolygon: null };
    }
    case 'cancel-drawing': return { ...state, inProgressPolygon: null };
    case 'server-sync':    return { ...state, updatedAt: action.updatedAt };
    case 'undo': {
      if (state._historyIndex < 0) return state;
      const entry = state._history[state._historyIndex];
      if (!entry) return state;
      return applyEntry({ ...state, _historyIndex: state._historyIndex - 1 }, entry);
    }
    case 'redo': {
      const nextIndex = state._historyIndex + 1;
      if (nextIndex >= state._history.length) return state;
      // Move forward to the entry after current
      const entry = state._history[nextIndex];
      if (!entry) return state;
      return applyEntry({ ...state, _historyIndex: nextIndex }, entry);
    }
  }
}

const INITIAL: StateWithHistory = {
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
  _history: [],
  _historyIndex: -1,
};

export function useDesignerState(floorSpaceId: string, draft: DraftResponse | undefined) {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const updateDraft = useUpdateDraft(floorSpaceId);
  // '__init__' = special sentinel so the first run-through after hydrate
  // doesn't echo the server-provided draft back as an autosave.
  const lastSyncedRef = useRef<string>('__init__');
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
    // Skip autosave on initial hydrate. The first computed snapshot equals
    // exactly what the server just sent us; sending it back would (a) echo
    // any malformed polygons that survived seeding, and (b) burn If-Match
    // CAS for no reason. Set the ref to the initial snapshot when hydrated.
    if (lastSyncedRef.current === '__init__') {
      lastSyncedRef.current = snapshot;
      return;
    }
    if (snapshot === lastSyncedRef.current) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        // Build the patch with undefined values dropped (otherwise the
        // optimistic-update spread on the client would nuke previously-set
        // width/height in the cache).
        const patch: Record<string, unknown> = {
          polygons: state.polygons,
          labels: state.labels,
        };
        if (state.imageUrl !== null && state.imageUrl !== undefined) patch.image_url = state.imageUrl;
        if (state.widthPx !== null && state.widthPx !== undefined) patch.width_px = state.widthPx;
        if (state.heightPx !== null && state.heightPx !== undefined) patch.height_px = state.heightPx;
        const data = await updateDraft.mutateAsync({
          patch: patch as Partial<DraftResponse>,
          ifMatch: state.updatedAt,
        });
        // Update lastSynced AFTER success so a failed PATCH doesn't pretend it synced.
        lastSyncedRef.current = snapshot;
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
  }, [state.polygons, state.labels, state.imageUrl, state.widthPx, state.heightPx, state.draftId, state.updatedAt, updateDraft, dispatch]);

  const canUndo = state._historyIndex >= 0;
  const canRedo = state._historyIndex + 1 < state._history.length;

  return { state, dispatch, isSaving: updateDraft.isPending, canUndo, canRedo } as const;
}

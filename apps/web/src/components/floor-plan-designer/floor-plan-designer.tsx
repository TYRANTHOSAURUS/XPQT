import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { useFloorPlanDraft } from '@/api/floor-plans/hooks';
import { useDesignerState } from './use-designer-state';
import { useImageUpload } from './use-image-upload';
import { SpacesTree } from './spaces-tree';
import { ToolDock } from './tool-dock';
import { PolygonInspector } from './polygon-inspector';
import { DesignerCanvas } from './designer-canvas';
import { PublishDialog } from './publish-dialog';
import { HistoryDialog } from './history-dialog';
import { Button } from '@/components/ui/button';
import { toast } from '@/lib/toast';
import type { ToolKind } from './types';

type Props = { floorSpaceId: string; floorName: string; backTo: string };

export function FloorPlanDesigner({ floorSpaceId, floorName, backTo }: Props) {
  const draft = useFloorPlanDraft(floorSpaceId);
  const { state, dispatch, isSaving } = useDesignerState(floorSpaceId, draft.data);
  const [publishOpen, setPublishOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Tenant ID comes from the loaded draft (already tenant-scoped)
  const tenantId = draft.data?.tenant_id ?? '';
  const { upload } = useImageUpload(tenantId, floorSpaceId);

  // Trigger file input when image-upload tool is activated
  useEffect(() => {
    if (state.activeTool === 'image-upload') {
      fileInputRef.current?.click();
    }
  }, [state.activeTool]);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset input so the same file can be re-selected if needed
    e.target.value = '';
    // Switch back to select tool whether upload succeeds or not
    dispatch({ type: 'set-tool', tool: 'select' });
    if (!file) return;

    const result = await upload(file);
    if (!result) return;

    if (state.polygons.length > 0) {
      toast.warning('Image replaced', {
        description: 'Verify polygon positions before publishing.',
      });
    }
    dispatch({
      type: 'set-image',
      imagePath: result.path,
      previewUrl: result.previewUrl,
      widthPx: result.widthPx,
      heightPx: result.heightPx,
    });
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const tools: Record<string, ToolKind> = {
        v: 'select',
        p: 'draw-polygon',
        r: 'draw-rectangle',
        s: 'stamp-seat',
        i: 'image-upload',
      };
      const tool = tools[e.key.toLowerCase()];
      if (tool) {
        dispatch({ type: 'set-tool', tool });
        return;
      }
      if (
        e.key === 'Enter' &&
        state.inProgressPolygon &&
        state.inProgressPolygon.points.length >= 3
      ) {
        dispatch({ type: 'commit-drawing' });
      }
      if (e.key === 'Escape') {
        dispatch({ type: 'cancel-drawing' });
      }
      if (
        (e.key === 'Backspace' || e.key === 'Delete') &&
        state.selectedPolygonIndex !== null
      ) {
        dispatch({ type: 'remove-polygon', index: state.selectedPolygonIndex });
      }
      // Undo / redo (B.12)
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: 'undo' });
      } else if (
        (e.metaKey || e.ctrlKey) &&
        (e.key === 'Z' || (e.key === 'z' && e.shiftKey))
      ) {
        e.preventDefault();
        dispatch({ type: 'redo' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch, state.inProgressPolygon, state.selectedPolygonIndex]);

  if (draft.isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }
  if (!draft.data) {
    return <div className="p-6 text-sm text-muted-foreground">No draft.</div>;
  }

  return (
    <div className="flex h-screen w-screen flex-col bg-background">
      {/* Hidden file input for image upload (B.10) */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        className="sr-only"
        onChange={handleFileChange}
      />
      {/* custom topbar — designer is shell-exempt per CLAUDE.md */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
        <div className="flex items-center gap-3">
          <Link
            to={backTo}
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="h-4 w-4" />
            Floor plans
          </Link>
          <span className="text-sm text-muted-foreground">·</span>
          <span className="text-sm font-medium">{floorName}</span>
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                isSaving ? 'bg-amber-400' : 'bg-emerald-400'
              }`}
            />
            {isSaving ? 'saving…' : 'saved'}
          </span>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => setHistoryOpen(true)} size="sm" variant="outline">
            History
          </Button>
          <Button onClick={() => setPublishOpen(true)} size="sm">
            Publish
          </Button>
        </div>
      </header>

      <div className="grid flex-1 grid-cols-[240px_1fr_244px] overflow-hidden">
        <SpacesTree floorSpaceId={floorSpaceId} state={state} dispatch={dispatch} />
        <div className="relative flex flex-col overflow-hidden">
          <ToolDock activeTool={state.activeTool} dispatch={dispatch} />
          <DesignerCanvas state={state} dispatch={dispatch} />
        </div>
        <PolygonInspector floorSpaceId={floorSpaceId} state={state} dispatch={dispatch} />
      </div>

      <PublishDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        floorSpaceId={floorSpaceId}
        draft={draft.data}
      />
      <HistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        floorSpaceId={floorSpaceId}
      />
    </div>
  );
}

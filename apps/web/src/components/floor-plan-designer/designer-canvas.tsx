import { useRef, useState } from 'react';
import { ZoomPanLayer } from '@/components/floor-plan/zoom-pan-layer';
import { PolygonShape } from '@/components/floor-plan/polygon-shape';
import { polygonToSvgPath } from '@/components/floor-plan/lib/polygon-geometry';
import { snap } from './lib/snapping';
import type { DesignerState, ToolKind } from './types';
import type { Point } from '@/api/floor-plans/types';
import { selectTool } from './tools/select-tool';
import { drawPolygonTool } from './tools/draw-polygon-tool';
import { drawRectangleTool } from './tools/draw-rectangle-tool';
import { stampSeatTool } from './tools/stamp-seat-tool';
import type { Tool } from './tools/tool';

const TOOL_MAP: Record<ToolKind, Tool> = {
  'select':         selectTool,   // no-op tool — canvas drives select/drag directly
  'draw-polygon':   drawPolygonTool,
  'draw-rectangle': drawRectangleTool,
  'stamp-seat':     stampSeatTool,
  'image-upload':   selectTool,   // upload triggered from B.10 button, not pointer
};

type Props = { state: DesignerState; dispatch: React.Dispatch<any> };

type DragSession = {
  index: number;
  startWorldX: number;
  startWorldY: number;
  originalPoints: Point[];
};

function findPolygonIndex(target: EventTarget | null): number | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest('[data-polygon-index]');
  if (!el) return null;
  const v = el.getAttribute('data-polygon-index');
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function DesignerCanvas({ state, dispatch }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<DragSession | null>(null);
  const [dragPreview, setDragPreview] = useState<{ index: number; dx: number; dy: number } | null>(null);

  const toWorld = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { worldX: 0, worldY: 0 };
    const inv = pt.matrixTransform(ctm.inverse());
    const snapped = snap({ x: inv.x, y: inv.y }, state.polygons);
    return { worldX: snapped.x, worldY: snapped.y };
  };

  const tool = TOOL_MAP[state.activeTool];

  // Use previewUrl for display (fresh signed URL from upload), fall back to imageUrl (storage path won't display)
  const displayImageUrl = state.previewUrl ?? undefined;

  return (
    <div className="flex-1 relative overflow-hidden">
      <ZoomPanLayer>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${state.widthPx ?? 1000} ${state.heightPx ?? 1000}`}
          className="w-full h-full"
          // Right-click finishes an in-progress polygon (>=3 points). Otherwise the
          // browser context menu is suppressed by ZoomPanLayer's onContextMenu.
          onContextMenu={(e) => {
            if (
              state.activeTool === 'draw-polygon' &&
              state.inProgressPolygon &&
              state.inProgressPolygon.points.length >= 3
            ) {
              e.preventDefault();
              dispatch({ type: 'commit-drawing' });
            }
          }}
          onPointerDown={(e) => {
            // Right-click while a polygon is in progress: prevent ZoomPanLayer
            // from starting a pan so the contextmenu handler can finish cleanly.
            if (e.button === 2 && state.inProgressPolygon) {
              e.stopPropagation();
              return;
            }
            if (e.button !== 0) return;

            if (state.activeTool === 'select' || state.activeTool === 'image-upload') {
              const hitIndex = findPolygonIndex(e.target);
              if (hitIndex == null) {
                // Empty click — deselection handled by onClick below.
                return;
              }
              // Click on a polygon: select + start a potential drag session.
              const world = toWorld(e);
              e.currentTarget.setPointerCapture(e.pointerId);
              dispatch({ type: 'select-polygon', index: hitIndex });
              dragRef.current = {
                index: hitIndex,
                startWorldX: world.worldX,
                startWorldY: world.worldY,
                originalPoints: state.polygons[hitIndex]?.points ?? [],
              };
              return;
            }

            // Drawing tools.
            e.currentTarget.setPointerCapture(e.pointerId);
            tool.onPointerDown?.({ state, dispatch, ...toWorld(e) });
          }}
          onPointerMove={(e) => {
            if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
            if (state.activeTool === 'select' || state.activeTool === 'image-upload') {
              if (!dragRef.current) return;
              const world = toWorld(e);
              const dx = world.worldX - dragRef.current.startWorldX;
              const dy = world.worldY - dragRef.current.startWorldY;
              setDragPreview({ index: dragRef.current.index, dx, dy });
              return;
            }
            tool.onPointerMove?.({ state, dispatch, ...toWorld(e) });
          }}
          onPointerUp={(e) => {
            if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;

            if ((state.activeTool === 'select' || state.activeTool === 'image-upload') && dragRef.current) {
              // Commit the translation if the user actually dragged.
              const session = dragRef.current;
              if (dragPreview && (Math.abs(dragPreview.dx) > 0.5 || Math.abs(dragPreview.dy) > 0.5)) {
                const dx = dragPreview.dx;
                const dy = dragPreview.dy;
                dispatch({
                  type: 'update-polygon',
                  index: session.index,
                  patch: {
                    points: session.originalPoints.map((p) => ({ x: p.x + dx, y: p.y + dy })),
                  },
                });
              }
              dragRef.current = null;
              setDragPreview(null);
              e.currentTarget.releasePointerCapture(e.pointerId);
              return;
            }

            tool.onPointerUp?.({ state, dispatch, ...toWorld(e) });
            e.currentTarget.releasePointerCapture(e.pointerId);
          }}
          // Empty-area click deselects in select mode.
          onClick={(e) => {
            if (state.activeTool !== 'select' && state.activeTool !== 'image-upload') return;
            if (findPolygonIndex(e.target) !== null) return;
            if (state.selectedPolygonIndex != null) {
              dispatch({ type: 'select-polygon', index: null });
            }
          }}
        >
          {displayImageUrl && (
            <image
              href={displayImageUrl}
              x="0" y="0"
              width={state.widthPx ?? 1000}
              height={state.heightPx ?? 1000}
              opacity={0.35}
            />
          )}
          {state.polygons.map((poly, i) => {
            const dragged = dragPreview?.index === i;
            const translate = dragged
              ? `translate(${dragPreview.dx} ${dragPreview.dy})`
              : undefined;
            return (
              <g
                key={i}
                data-polygon-index={i}
                transform={translate}
                style={state.activeTool === 'select' ? { cursor: 'grab' } : undefined}
              >
                <PolygonShape
                  spaceId={poly.space_id || `pending-${i}`}
                  points={poly.points}
                  renderHint={poly.render_hint ?? 'default'}
                  name={poly.space_id ? '' : `Polygon ${i + 1}`}
                  capacity={null}
                  state="available"
                  selected={i === state.selectedPolygonIndex}
                  onClick={() => {
                    // Polygon's onClick still fires after pointer cycle in select
                    // mode (no drag). Confirms the selection set by pointer-down.
                    dispatch({ type: 'select-polygon', index: i });
                  }}
                />
              </g>
            );
          })}
          {state.inProgressPolygon && (
            <path
              d={polygonToSvgPath(state.inProgressPolygon.points)}
              fill="rgba(245, 158, 11, 0.1)"
              stroke="#f59e0b"
              strokeWidth={1.5}
              strokeDasharray="4 3"
            />
          )}
        </svg>
      </ZoomPanLayer>

      {/* Gesture hint — bottom-right of canvas. Small + unobtrusive. */}
      <div className="pointer-events-none absolute bottom-2 right-2 rounded-md bg-background/80 px-2 py-1 text-[10px] text-muted-foreground shadow-sm backdrop-blur-sm">
        Pan: middle-click drag · Zoom: scroll · Finish polygon: Enter or right-click
      </div>
    </div>
  );
}

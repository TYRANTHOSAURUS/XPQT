import { useRef } from 'react';
import { ZoomPanLayer } from '@/components/floor-plan/zoom-pan-layer';
import { PolygonShape } from '@/components/floor-plan/polygon-shape';
import { polygonToSvgPath } from '@/components/floor-plan/lib/polygon-geometry';
import { snap } from './lib/snapping';
import type { DesignerState, ToolKind } from './types';
import { selectTool } from './tools/select-tool';
import { drawPolygonTool } from './tools/draw-polygon-tool';
import { drawRectangleTool } from './tools/draw-rectangle-tool';
import { stampSeatTool } from './tools/stamp-seat-tool';
import type { Tool } from './tools/tool';

const TOOL_MAP: Record<ToolKind, Tool> = {
  'select':         selectTool,
  'draw-polygon':   drawPolygonTool,
  'draw-rectangle': drawRectangleTool,
  'stamp-seat':     stampSeatTool,
  'image-upload':   selectTool, // upload triggered from B.10 button, not pointer
};

type Props = { state: DesignerState; dispatch: React.Dispatch<any> };

export function DesignerCanvas({ state, dispatch }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);

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
          // Left-click only — middle/right buttons fall through to ZoomPanLayer
          // for pan. Capture the pointer on the SVG so drag-to-draw works even
          // when the cursor leaves the SVG mid-drag.
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            tool.onPointerDown?.({ state, dispatch, ...toWorld(e) });
          }}
          onPointerMove={(e) => {
            if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
            tool.onPointerMove?.({ state, dispatch, ...toWorld(e) });
          }}
          onPointerUp={(e) => {
            if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
            tool.onPointerUp?.({ state, dispatch, ...toWorld(e) });
            e.currentTarget.releasePointerCapture(e.pointerId);
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
          {state.polygons.map((poly, i) => (
            <PolygonShape
              key={i}
              spaceId={poly.space_id || `pending-${i}`}
              points={poly.points}
              renderHint={poly.render_hint ?? 'default'}
              name={poly.space_id ? '' : `Polygon ${i + 1}`}
              capacity={null}
              state="available"
              selected={i === state.selectedPolygonIndex}
              onClick={() => dispatch({ type: 'select-polygon', index: i })}
            />
          ))}
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
    </div>
  );
}

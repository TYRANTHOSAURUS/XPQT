import { useState } from 'react';
import {
  EdgeLabelRenderer,
  getSmoothStepPath,
  type EdgeProps,
} from 'reactflow';
import { X } from 'lucide-react';
import { useGraphStore } from './graph-store';
import { cn } from '@/lib/utils';

export interface WorkflowEdgeData {
  condition?: string;
  label?: string;
  tone?: 'default' | 'success' | 'danger';
  runtimeActive?: boolean;
  readOnly?: boolean;
}

export function WorkflowEdge(props: EdgeProps<WorkflowEdgeData>) {
  const {
    id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
    source, target, sourceHandleId, markerEnd, selected, data,
  } = props;

  const disconnect = useGraphStore((s) => s.disconnect);
  const [hovered, setHovered] = useState(false);

  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
    borderRadius: 6,
    offset: 18,
  });

  const tone = data?.tone ?? 'default';
  const runtimeActive = !!data?.runtimeActive;
  const readOnly = !!data?.readOnly;

  const strokeBase =
    tone === 'success' ? '#10b981'
      : tone === 'danger' ? '#ef4444'
        : '#94a3b8';
  const strokeHighlight =
    tone === 'success' ? '#059669'
      : tone === 'danger' ? '#dc2626'
        : '#475569';

  const active = selected || hovered || runtimeActive;
  const stroke = active ? strokeHighlight : strokeBase;
  const strokeWidth = active ? 2.25 : 1.75;

  const onEnter = () => setHovered(true);
  const onLeave = () => setHovered(false);

  return (
    <>
      {/* Wide transparent hit path — the only element that receives pointer
          events. Explicit pointer-events:stroke bypasses SVG's default
          visiblePainted rule which would drop events on a transparent stroke. */}
      <path
        id={`${id}-hit`}
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={28}
        style={{ pointerEvents: 'stroke', cursor: readOnly ? 'default' : 'pointer' }}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
      />

      {/* Visible line — no pointer events so the hit path owns hover. */}
      <path
        id={id}
        d={path}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        markerEnd={markerEnd}
        className="react-flow__edge-path pointer-events-none"
        style={{ transition: 'stroke 150ms, stroke-width 150ms' }}
      />

      {/* Animated dashed overlay — subtle flow indicator */}
      <path
        d={path}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeDasharray="4 6"
        strokeLinecap="round"
        className={cn(
          'pointer-events-none',
          runtimeActive ? 'wf-edge-flow-fast' : 'wf-edge-flow',
        )}
        style={{ opacity: runtimeActive ? 0.9 : 0.55 }}
      />

      <EdgeLabelRenderer>
        <div
          className="nodrag nopan absolute"
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
          }}
          onMouseEnter={onEnter}
          onMouseLeave={onLeave}
        >
          <div className="flex items-center gap-1.5">
            {data?.label && (
              <span
                className={cn(
                  'rounded border bg-background px-1.5 py-0.5 text-[10px] font-medium leading-none shadow-sm',
                  tone === 'success' && 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
                  tone === 'danger' && 'border-red-500/40 text-red-600 dark:text-red-400',
                  tone === 'default' && 'border-border text-muted-foreground',
                )}
              >
                {data.label}
              </span>
            )}
            {!readOnly && (
              <button
                type="button"
                aria-label="Remove connection"
                title="Remove connection"
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  disconnect(source, target, sourceHandleId ?? undefined);
                }}
                onMouseDown={(e) => e.stopPropagation()}
                className={cn(
                  'flex h-5 w-5 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm',
                  'transition-all duration-100',
                  'hover:bg-destructive hover:text-destructive-foreground hover:border-destructive hover:scale-110',
                  'focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring',
                  hovered || selected ? 'opacity-100' : 'opacity-0',
                )}
              >
                <X className="h-3 w-3" strokeWidth={2.5} />
              </button>
            )}
          </div>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

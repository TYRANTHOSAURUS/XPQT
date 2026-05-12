import { useRef, useCallback } from 'react';
import type { CrowdHeatmapBucket } from '@/api/floor-plans/types';

export type TimeScrubberValue = { start: Date; end: Date };

type Props = {
  value: TimeScrubberValue;
  onChange: (next: TimeScrubberValue) => void;
  heatmap: CrowdHeatmapBucket[];
  /** First hour shown on the strip (inclusive). Default 7. */
  rangeStart?: number;
  /** Last hour shown on the strip (exclusive). Default 19. */
  rangeEnd?: number;
};

const SVG_H = 56;
const BAR_H_MAX = 28;
const TICK_Y = SVG_H - 10;
const LABEL_Y = SVG_H - 2;
const SNAP_MINUTES = 15;

function minutesFromMidnight(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

function minutesToDate(base: Date, minutes: number): Date {
  const d = new Date(base);
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return d;
}

/** Interpolate green → amber → red by occupancy 0..1 */
function heatColor(occupancy: number): string {
  if (occupancy < 0.5) {
    // green (#22c55e) → amber (#f59e0b)
    const t = occupancy * 2;
    const r = Math.round(34 + (245 - 34) * t);
    const g = Math.round(197 + (158 - 197) * t);
    const b = Math.round(94 + (11 - 94) * t);
    return `rgb(${r},${g},${b})`;
  } else {
    // amber (#f59e0b) → red (#ef4444)
    const t = (occupancy - 0.5) * 2;
    const r = Math.round(245 + (239 - 245) * t);
    const g = Math.round(158 + (68 - 158) * t);
    const b = Math.round(11 + (68 - 11) * t);
    return `rgb(${r},${g},${b})`;
  }
}

export function TimeScrubber({
  value,
  onChange,
  heatmap,
  rangeStart = 7,
  rangeEnd = 19,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef<'start' | 'end' | null>(null);
  // stable refs so pointer handlers don't close over stale values
  const valueRef = useRef(value);
  valueRef.current = value;

  const totalMinutes = (rangeEnd - rangeStart) * 60;

  // x (0..1) → minutes from midnight (clamped to range)
  const xToMinutes = useCallback(
    (xFraction: number): number => {
      const raw = rangeStart * 60 + xFraction * totalMinutes;
      return Math.max(rangeStart * 60, Math.min(rangeEnd * 60, raw));
    },
    [rangeStart, rangeEnd, totalMinutes],
  );

  const minutesToX = useCallback(
    (minutes: number): number => {
      return (minutes - rangeStart * 60) / totalMinutes;
    },
    [rangeStart, totalMinutes],
  );

  const getSvgXFraction = useCallback((e: PointerEvent | React.PointerEvent<SVGSVGElement>): number => {
    const svg = svgRef.current;
    if (!svg) return 0;
    const rect = svg.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<SVGElement>, target: 'start' | 'end') => {
      e.currentTarget.setPointerCapture(e.pointerId);
      dragging.current = target;
    },
    [],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!dragging.current) return;
      const xFrac = getSvgXFraction(e);
      const rawMin = xToMinutes(xFrac);
      const snappedMin = Math.round(rawMin / SNAP_MINUTES) * SNAP_MINUTES;
      const cur = valueRef.current;
      const curStartMin = minutesFromMidnight(cur.start);
      const curEndMin = minutesFromMidnight(cur.end);
      const durationMin = curEndMin - curStartMin;

      if (dragging.current === 'start') {
        // Move whole window, preserving duration
        const newStart = Math.max(rangeStart * 60, Math.min(rangeEnd * 60 - durationMin, snappedMin));
        const newEnd = newStart + durationMin;
        onChange({
          start: minutesToDate(cur.start, newStart),
          end: minutesToDate(cur.end, newEnd),
        });
      } else {
        // Resize end (minimum 15 min)
        const newEnd = Math.max(curStartMin + SNAP_MINUTES, Math.min(rangeEnd * 60, snappedMin));
        onChange({
          start: cur.start,
          end: minutesToDate(cur.end, newEnd),
        });
      }
    },
    [getSvgXFraction, xToMinutes, onChange, rangeStart, rangeEnd],
  );

  const handlePointerUp = useCallback(() => {
    dragging.current = null;
  }, []);

  const startMin = minutesFromMidnight(value.start);
  const endMin = minutesFromMidnight(value.end);
  const startX = minutesToX(startMin);
  const endX = minutesToX(endMin);

  // Build heatmap bars: one per bucket
  const bars = heatmap.map((bucket, i) => {
    const bucketDate = new Date(bucket.bucket);
    const bucketMin = minutesFromMidnight(bucketDate);
    // Assume each bucket is 1 hour wide unless we can derive it
    const nextBucket = heatmap[i + 1];
    const nextMin = nextBucket
      ? minutesFromMidnight(new Date(nextBucket.bucket))
      : bucketMin + 60;
    const x1 = minutesToX(bucketMin);
    const x2 = minutesToX(nextMin);
    if (x2 <= 0 || x1 >= 1) return null;
    const clampedX1 = Math.max(0, x1);
    const clampedX2 = Math.min(1, x2);
    return { x: clampedX1, width: clampedX2 - clampedX1, occupancy: bucket.occupancy };
  }).filter(Boolean) as { x: number; width: number; occupancy: number }[];

  // Now line
  const nowMin = minutesFromMidnight(new Date());
  const nowX = minutesToX(nowMin);
  const showNow = nowX >= 0 && nowX <= 1;

  // Hour tick labels
  const ticks: number[] = [];
  for (let h = rangeStart; h <= rangeEnd; h++) ticks.push(h);

  const pad2 = (n: number) => String(n).padStart(2, '0');
  const fmtTime = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

  return (
    <div className="select-none">
      <svg
        ref={svgRef}
        viewBox={`0 0 1 ${SVG_H}`}
        preserveAspectRatio="none"
        className="w-full cursor-col-resize"
        style={{ height: SVG_H }}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
      >
        {/* Heatmap bars */}
        {bars.map((bar, i) => (
          <rect
            key={i}
            x={bar.x}
            y={SVG_H - BAR_H_MAX * bar.occupancy - TICK_Y + TICK_Y - BAR_H_MAX * bar.occupancy}
            width={bar.width}
            height={BAR_H_MAX * bar.occupancy}
            fill={heatColor(bar.occupancy)}
            opacity={0.6}
            style={{ transform: `translateY(${TICK_Y - BAR_H_MAX}px)` }}
          />
        ))}

        {/* Selection range shading */}
        <rect
          x={startX}
          y={0}
          width={endX - startX}
          height={TICK_Y}
          fill="hsl(var(--foreground) / 0.08)"
          rx={0.005}
        />

        {/* Now line */}
        {showNow && (
          <line
            x1={nowX}
            y1={0}
            x2={nowX}
            y2={TICK_Y}
            stroke="#ef4444"
            strokeWidth={0.004}
            strokeDasharray="0.012 0.008"
          />
        )}

        {/* Hour ticks */}
        {ticks.map((h) => {
          const tx = minutesToX(h * 60);
          return (
            <g key={h}>
              <line
                x1={tx}
                y1={TICK_Y}
                x2={tx}
                y2={TICK_Y + 4}
                stroke="hsl(var(--muted-foreground) / 0.4)"
                strokeWidth={0.003}
              />
              <text
                x={tx}
                y={LABEL_Y}
                fontSize={0.035}
                textAnchor="middle"
                fill="hsl(var(--muted-foreground))"
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {h}
              </text>
            </g>
          );
        })}

        {/* Start thumb (draggable) */}
        <g
          style={{ cursor: 'ew-resize' }}
          onPointerDown={(e) => handlePointerDown(e, 'start')}
        >
          <line
            x1={startX}
            y1={0}
            x2={startX}
            y2={TICK_Y}
            stroke="hsl(var(--foreground))"
            strokeWidth={0.006}
          />
          <circle cx={startX} cy={TICK_Y / 2} r={0.018} fill="hsl(var(--foreground))" />
        </g>

        {/* End resize handle (smaller) */}
        <g
          style={{ cursor: 'ew-resize' }}
          onPointerDown={(e) => handlePointerDown(e, 'end')}
        >
          <line
            x1={endX}
            y1={0}
            x2={endX}
            y2={TICK_Y}
            stroke="hsl(var(--foreground) / 0.6)"
            strokeWidth={0.004}
          />
          <circle cx={endX} cy={TICK_Y / 2} r={0.012} fill="hsl(var(--foreground) / 0.6)" />
        </g>
      </svg>

      {/* Time readout */}
      <div className="flex justify-end mt-1">
        <span className="text-xs tabular-nums text-muted-foreground">
          selected: {fmtTime(value.start)} → {fmtTime(value.end)}
        </span>
      </div>
    </div>
  );
}

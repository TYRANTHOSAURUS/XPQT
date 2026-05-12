import { polygonArea, polygonCentroid, polygonToSvgPath, isValidPolygon } from './lib/polygon-geometry';
import { STATE_PALETTE, type AvailabilityState } from './lib/availability-state';
import type { Point, RenderHint } from '../../api/floor-plans/types';
import { useNow } from '../../lib/use-now';

const LABEL_AREA_THRESHOLD = 6000;
const FREE_IN_THRESHOLD_MS = 30 * 60_000; // 30 minutes

type Props = {
  spaceId: string;
  points: Point[];
  renderHint: RenderHint;
  name: string;
  capacity: number | null;
  state: AvailabilityState;
  selected?: boolean;
  onClick?: (spaceId: string) => void;
  /** ISO timestamp when the space becomes free; from availability data. */
  freeAt?: string | null;
  /** True when `now` is within the selected booking window. */
  isCurrentWindow?: boolean;
};

export function PolygonShape({ spaceId, points, renderHint, name, capacity, state, selected, onClick, freeAt, isCurrentWindow }: Props) {
  const now = useNow(60_000);
  // Defensive: skip rendering when polygon shape is malformed. Better an
  // invisible polygon than NaN-laced SVG attributes that crash React.
  if (!isValidPolygon(points) || points.length < 1) return null;
  const palette = STATE_PALETTE[state];
  const area = polygonArea(points);
  const renderAsSeat = renderHint === 'seat' || (renderHint === 'default' && area < LABEL_AREA_THRESHOLD);
  const centroid = polygonCentroid(points);

  // Compute free-in-N badge text (only for labeled rectangles, not seat circles)
  const freeInLabel = (() => {
    if (renderAsSeat) return null;
    if (state !== 'booked') return null;
    if (!isCurrentWindow) return null;
    if (!freeAt) return null;
    const diff = Date.parse(freeAt) - now;
    if (diff <= 0 || diff >= FREE_IN_THRESHOLD_MS) return null;
    const mins = Math.ceil(diff / 60_000);
    return `free in ${mins}m`;
  })();

  if (renderAsSeat) {
    return (
      <g
        role="button"
        tabIndex={0}
        aria-label={`${name}${capacity ? `, ${capacity} seats` : ''}, ${state}`}
        onClick={() => onClick?.(spaceId)}
        onKeyDown={(e) => e.key === 'Enter' && onClick?.(spaceId)}
        style={{ cursor: 'pointer' }}
      >
        <circle
          cx={centroid.x} cy={centroid.y} r={11}
          fill={palette.fill} stroke={palette.outline}
          strokeWidth={selected ? 2 : 1.4}
        />
        <circle cx={centroid.x} cy={centroid.y} r={3.5} fill={palette.dot} />
      </g>
    );
  }

  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={`${name}${capacity ? `, ${capacity} seats` : ''}, ${state}${freeInLabel ? `, ${freeInLabel}` : ''}`}
      onClick={() => onClick?.(spaceId)}
      onKeyDown={(e) => e.key === 'Enter' && onClick?.(spaceId)}
      style={{ cursor: 'pointer' }}
    >
      <path
        d={polygonToSvgPath(points)}
        fill={palette.fill} stroke={palette.outline}
        strokeWidth={selected ? 2 : 1.5}
      />
      <circle cx={points[0].x + 16} cy={points[0].y + 16} r={5} fill={palette.dot} />
      <text x={centroid.x} y={freeInLabel ? centroid.y - 7 : centroid.y} textAnchor="middle" fontSize={13} fontWeight={500} fill="#1c1917">{name}</text>
      {freeInLabel && (
        <text x={centroid.x} y={centroid.y + 9} textAnchor="middle" fontSize={10} fill="#78716c">{freeInLabel}</text>
      )}
    </g>
  );
}

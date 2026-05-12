import { polygonArea, polygonCentroid, polygonToSvgPath } from './lib/polygon-geometry';
import { STATE_PALETTE, type AvailabilityState } from './lib/availability-state';
import type { Point, RenderHint } from '../../api/floor-plans/types';

const LABEL_AREA_THRESHOLD = 6000;

type Props = {
  spaceId: string;
  points: Point[];
  renderHint: RenderHint;
  name: string;
  capacity: number | null;
  state: AvailabilityState;
  selected?: boolean;
  onClick?: (spaceId: string) => void;
};

export function PolygonShape({ spaceId, points, renderHint, name, capacity, state, selected, onClick }: Props) {
  const palette = STATE_PALETTE[state];
  const area = polygonArea(points);
  const renderAsSeat = renderHint === 'seat' || (renderHint === 'default' && area < LABEL_AREA_THRESHOLD);
  const centroid = polygonCentroid(points);

  if (renderAsSeat) {
    return (
      <g
        role="button"
        tabIndex={0}
        aria-label={`${name}: ${state}`}
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
      aria-label={`${name}: ${state}, capacity ${capacity ?? 'unknown'}`}
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
      <text x={centroid.x} y={centroid.y} textAnchor="middle" fontSize={13} fontWeight={500} fill="#1c1917">{name}</text>
    </g>
  );
}

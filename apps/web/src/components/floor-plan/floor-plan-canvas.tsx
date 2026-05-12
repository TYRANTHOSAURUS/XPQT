import { useMemo } from 'react';
import { PolygonShape } from './polygon-shape';
import { polygonCentroid } from './lib/polygon-geometry';
import type { PublishedFloorPlan } from '../../api/floor-plans/types';
import type { AvailabilityState } from './lib/availability-state';

type SpaceState = { spaceId: string; state: AvailabilityState; freeAt?: string | null };

type Props = {
  plan: PublishedFloorPlan;
  states?: SpaceState[];
  selectedSpaceId?: string | null;
  onSpaceClick?: (spaceId: string) => void;
  /** Pass true when the canvas is showing the current time window (now is within from..to). */
  isCurrentWindow?: boolean;
  /** Display name for the floor — used in the region aria-label for keyboard users. */
  floorName?: string;
};

export function FloorPlanCanvas({ plan, states, selectedSpaceId, onSpaceClick, isCurrentWindow, floorName }: Props) {
  const stateMap = useMemo(() => {
    const m = new Map<string, SpaceState>();
    states?.forEach((s) => m.set(s.spaceId, s));
    return m;
  }, [states]);

  // Sort spaces by centroid Y then X so Tab order matches top-to-bottom, left-to-right reading.
  const sortedSpaces = useMemo(
    () =>
      [...plan.spaces].sort((a, b) => {
        const ca = polygonCentroid(a.floor_plan_polygon.points);
        const cb = polygonCentroid(b.floor_plan_polygon.points);
        return ca.y !== cb.y ? ca.y - cb.y : ca.x - cb.x;
      }),
    [plan.spaces],
  );

  return (
    <svg
      viewBox={`0 0 ${plan.floor.width_px} ${plan.floor.height_px}`}
      role="region"
      aria-label={`Floor plan: ${floorName ?? 'floor'}`}
      style={{ width: '100%', height: '100%', display: 'block' }}
    >
      <defs>
        <pattern id="partial-stripes" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">
          <rect width="8" height="8" fill="#f0fdf4" />
          <line x1="0" y1="0" x2="0" y2="8" stroke="#fca5a5" strokeWidth="3.5" />
        </pattern>
      </defs>
      <image href={plan.floor.image_url} x="0" y="0" width={plan.floor.width_px} height={plan.floor.height_px} />
      {sortedSpaces.map((s) => {
        const entry = stateMap.get(s.id);
        return (
          <PolygonShape
            key={s.id}
            spaceId={s.id}
            points={s.floor_plan_polygon.points}
            renderHint={s.floor_plan_render_hint}
            name={s.name}
            capacity={s.capacity}
            state={entry?.state ?? 'not_bookable'}
            selected={selectedSpaceId === s.id}
            onClick={onSpaceClick}
            freeAt={entry?.freeAt}
            isCurrentWindow={isCurrentWindow}
          />
        );
      })}
    </svg>
  );
}

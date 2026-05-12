import { useMemo } from 'react';
import { PolygonShape } from './polygon-shape';
import type { PublishedFloorPlan } from '../../api/floor-plans/types';
import type { AvailabilityState } from './lib/availability-state';

type SpaceState = { spaceId: string; state: AvailabilityState };

type Props = {
  plan: PublishedFloorPlan;
  states?: SpaceState[];
  selectedSpaceId?: string | null;
  onSpaceClick?: (spaceId: string) => void;
};

export function FloorPlanCanvas({ plan, states, selectedSpaceId, onSpaceClick }: Props) {
  const stateMap = useMemo(() => {
    const m = new Map<string, AvailabilityState>();
    states?.forEach((s) => m.set(s.spaceId, s.state));
    return m;
  }, [states]);

  return (
    <svg
      viewBox={`0 0 ${plan.floor.width_px} ${plan.floor.height_px}`}
      role="img"
      aria-label="Floor plan"
      style={{ width: '100%', height: '100%', display: 'block' }}
    >
      <defs>
        <pattern id="partial-stripes" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">
          <rect width="8" height="8" fill="#f0fdf4" />
          <line x1="0" y1="0" x2="0" y2="8" stroke="#fca5a5" strokeWidth="3.5" />
        </pattern>
      </defs>
      <image href={plan.floor.image_url} x="0" y="0" width={plan.floor.width_px} height={plan.floor.height_px} />
      {plan.spaces.map((s) => (
        <PolygonShape
          key={s.id}
          spaceId={s.id}
          points={s.floor_plan_polygon.points}
          renderHint={s.floor_plan_render_hint}
          name={s.name}
          capacity={s.capacity}
          state={stateMap.get(s.id) ?? 'not_bookable'}
          selected={selectedSpaceId === s.id}
          onClick={onSpaceClick}
        />
      ))}
    </svg>
  );
}

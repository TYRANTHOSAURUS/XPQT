import { useState, useMemo } from 'react';
import { FloorPlanCanvas } from '@/components/floor-plan/floor-plan-canvas';
import { FloorSwitcher } from '@/components/floor-plan/floor-switcher';
import { TimeScrubber } from '@/components/floor-plan/time-scrubber';
import type { TimeScrubberValue } from '@/components/floor-plan/time-scrubber';
import {
  useFloorPlanPublished,
  useFloorAvailability,
  useFloorAvailabilityRealtime,
  useBuildingFloors,
} from '@/api/floor-plans/hooks';
import type { AvailabilityState } from '@/api/floor-plans/types';
import type { SchedulerWindowState } from '../hooks/use-scheduler-window';
import type { SchedulerRoom, Reservation } from '@/api/room-booking';

type Props = {
  /** Scheduler's current state — we reuse building/floor + date bounds. */
  winState: SchedulerWindowState;
  /** ISO start of the visible window (from useSchedulerWindow). */
  startAtIso: string;
  /** ISO end of the visible window (from useSchedulerWindow). */
  endAtIso: string;
  /** All scheduler rooms in scope — used for name lookup on click. */
  rooms: SchedulerRoom[];
  /** Reservations indexed by space_id — used to find an existing booking. */
  reservationsBySpaceId: Map<string, Reservation[]>;
  /** Called when an occupied polygon is clicked (opens booking detail). */
  onOpenBookingDetail: (r: Reservation) => void;
  /** Called when an empty polygon is clicked (opens new-booking composer). */
  onNewBooking: (spaceId: string, startAtIso: string, endAtIso: string) => void;
};

function mapAvailability(
  spaces: Array<{ id: string; state: AvailabilityState; free_at?: string | null }>,
) {
  return spaces.map((s) => ({
    spaceId: s.id,
    state: s.state,
    freeAt: s.free_at ?? null,
  }));
}

function buildOccupancyByFloor(floorId: string, heatmap: Array<{ occupancy: number }>): Record<string, number> {
  if (!heatmap.length) return {};
  const avg = heatmap.reduce((sum, b) => sum + b.occupancy, 0) / heatmap.length;
  return { [floorId]: avg };
}

/**
 * Scheduler floor-plan view tab (E.1). Embeds FloorPlanCanvas + TimeScrubber
 * + FloorSwitcher reusing the scheduler's existing building/floor state.
 *
 * Time window binding: the scheduler's startAtIso/endAtIso are day-level
 * (e.g. 07:00–19:00). We use them as the initial TimeScrubber range and let
 * the operator refine to a sub-window on the floor view without affecting the
 * timeline tab's state.
 */
export function SchedulerFloorView({
  winState,
  startAtIso,
  endAtIso,
  reservationsBySpaceId,
  onOpenBookingDetail,
  onNewBooking,
}: Props) {
  const buildingId = winState.buildingId ?? '';
  const { data: floors = [] } = useBuildingFloors(buildingId);

  // Local floor selection — starts from scheduler's floorId or first floor.
  const [localFloorId, setLocalFloorId] = useState<string>(
    () => winState.floorId ?? '',
  );
  const effectiveFloorId = localFloorId || floors[0]?.id || '';

  // Local time window — defaults to the scheduler's visible window; operator
  // can refine independently without touching the timeline tab.
  const [timeWindow, setTimeWindow] = useState<TimeScrubberValue>(() => ({
    start: new Date(startAtIso),
    end: new Date(endAtIso),
  }));

  const floorPlan = useFloorPlanPublished(effectiveFloorId);
  const availability = useFloorAvailability(
    effectiveFloorId,
    timeWindow.start.toISOString(),
    timeWindow.end.toISOString(),
  );
  useFloorAvailabilityRealtime(effectiveFloorId);

  const states = useMemo(() => {
    if (!availability.data?.spaces) return [];
    return mapAvailability(availability.data.spaces);
  }, [availability.data?.spaces]);

  const occupancyByFloorId = useMemo(() => {
    if (!effectiveFloorId || !availability.data?.crowd_heatmap) return {};
    return buildOccupancyByFloor(effectiveFloorId, availability.data.crowd_heatmap);
  }, [effectiveFloorId, availability.data?.crowd_heatmap]);

  const heatmap = availability.data?.crowd_heatmap ?? [];

  const now = new Date();
  const isCurrentWindow =
    timeWindow.start <= now && now <= timeWindow.end;

  function handleSpaceClick(spaceId: string) {
    const reservations = reservationsBySpaceId.get(spaceId) ?? [];
    // Find a reservation that overlaps the current time window.
    const active = reservations.find((r) => {
      const rStart = new Date(r.effective_start_at).getTime();
      const rEnd = new Date(r.effective_end_at).getTime();
      const winStart = timeWindow.start.getTime();
      const winEnd = timeWindow.end.getTime();
      return rStart < winEnd && rEnd > winStart;
    });
    if (active) {
      onOpenBookingDetail(active);
    } else {
      onNewBooking(spaceId, timeWindow.start.toISOString(), timeWindow.end.toISOString());
    }
  }

  if (!buildingId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
        <p>Select a building to view the floor plan.</p>
      </div>
    );
  }

  if (floors.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
        <p>No floors found for this building.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {/* Floor + time controls */}
      <div className="flex items-center gap-3 border-b px-4 py-2">
        <FloorSwitcher
          buildingId={buildingId}
          selectedFloorId={effectiveFloorId}
          onFloorChange={setLocalFloorId}
          occupancyByFloorId={occupancyByFloorId}
        />
      </div>

      {/* Time scrubber */}
      <div className="border-b px-4 py-2">
        <TimeScrubber
          value={timeWindow}
          onChange={setTimeWindow}
          heatmap={heatmap}
          rangeStart={winState.dayStartHour}
          rangeEnd={winState.dayEndHour}
        />
      </div>

      {/* Floor plan canvas */}
      <div className="relative flex-1 min-h-0 overflow-hidden bg-muted/20">
        {floorPlan.isLoading || availability.isLoading ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            Loading floor plan…
          </div>
        ) : !floorPlan.data ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm font-medium">No floor plan published yet</p>
            <p className="max-w-xs text-xs text-muted-foreground">
              Publish a floor plan for this floor in Admin → Floor Plans to enable this view.
            </p>
          </div>
        ) : (
          <FloorPlanCanvas
            plan={floorPlan.data}
            states={states}
            onSpaceClick={handleSpaceClick}
            isCurrentWindow={isCurrentWindow}
          />
        )}
      </div>
    </div>
  );
}

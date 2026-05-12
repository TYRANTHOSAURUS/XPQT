/**
 * PortalBookFloor — /portal/book/floor and /portal/book/floor/:floorSpaceId
 *
 * Mobile-first floor-plan booking surface. Shows the published floor plan for
 * a selected building/floor with live availability overlay. Tapping a space on
 * mobile opens the <BookingSheet> bottom sheet; on desktop opens the full
 * BookingComposerModal pre-seeded with the space and time window.
 *
 * URL params:
 *   ?building=<id>   — active building id (optional, defaults to person's default location)
 *   ?floor=<id>      — active floor space id (defaults to first floor of building)
 *   ?from=<iso>      — window start (defaults to now rounded to nearest 15 min)
 *   ?to=<iso>        — window end (defaults to from + 60 min)
 *
 * D.5 — floor-plan booking surface.
 */
import { useState, useMemo, useCallback, useEffect } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Maximize2, Map } from 'lucide-react';
import { PortalPage } from '@/components/portal/portal-page';
import { usePortal } from '@/providers/portal-provider';
import { useAuth } from '@/providers/auth-provider';
import { FloorPlanCanvas } from '@/components/floor-plan/floor-plan-canvas';
import { ZoomPanLayer } from '@/components/floor-plan/zoom-pan-layer';
import { FloorSwitcher } from '@/components/floor-plan/floor-switcher';
import { TimeScrubber } from '@/components/floor-plan/time-scrubber';
import { BookingComposerModal } from '@/components/booking-composer-v2/booking-composer-modal';
import { draftFromComposerSeed } from '@/components/booking-composer-v2/booking-draft';
import {
  useFloorPlanPublished,
  useFloorAvailability,
  useFloorAvailabilityRealtime,
  useBuildingFloors,
} from '@/api/floor-plans/hooks';
import type { AvailabilityState } from '@/components/floor-plan/lib/availability-state';
import type { TimeScrubberValue } from '@/components/floor-plan/time-scrubber';
import { BookingSheet } from './booking-sheet';
import { useRealtimeStatus } from '@/lib/use-realtime-status';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function roundTo15(date: Date): Date {
  const ms = 15 * 60 * 1000;
  return new Date(Math.round(date.getTime() / ms) * ms);
}

function defaultWindow(): { start: Date; end: Date } {
  const start = roundTo15(new Date());
  return { start, end: new Date(start.getTime() + 60 * 60 * 1000) };
}

/** Map SpaceAvailability[] from the API into the SpaceState[] shape FloorPlanCanvas expects */
function mapAvailabilityToStates(
  spaces: Array<{ space_id: string; state: AvailabilityState; free_at?: string | null }>,
): Array<{ spaceId: string; state: AvailabilityState; freeAt?: string | null }> {
  return spaces.map((s) => ({ spaceId: s.space_id, state: s.state, freeAt: s.free_at ?? null }));
}

/** Build occupancy-by-floor-id from heatmap data (average occupancy for the window) */
function buildOccupancyByFloor(
  floorId: string,
  occupancy: number,
): Record<string, number> {
  return { [floorId]: occupancy };
}

// Minimal media query hook — avoids adding a dependency
function useIsMobile(): boolean {
  if (typeof window === 'undefined') return false;
  // We read this lazily on render; good enough for progressive enhancement
  return window.matchMedia('(max-width: 767px)').matches;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PortalBookFloor() {
  const { data: portal } = usePortal();
  const { person } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const isMobile = useIsMobile();

  // ---------------------------------------------------------------------------
  // Derive building list from authorized locations
  // ---------------------------------------------------------------------------
  const buildings = useMemo(() => {
    const locs = portal?.authorized_locations ?? [];
    return locs
      .filter((l) => l.type === 'building' || l.type === 'site')
      .map((l) => ({ id: l.id, name: l.name }));
  }, [portal?.authorized_locations]);

  // Default building: person's default location, or first building
  const defaultBuildingId = useMemo(() => {
    const def = portal?.default_location;
    if (def && (def.type === 'building' || def.type === 'site')) return def.id;
    return buildings[0]?.id ?? null;
  }, [portal?.default_location, buildings]);

  // URL-param-controlled building
  const [buildingId, setBuildingId] = useState<string>(() => {
    return searchParams.get('building') ?? defaultBuildingId ?? '';
  });

  // Floors for the selected building
  const { data: floors = [] } = useBuildingFloors(buildingId);

  // URL-param-controlled floor
  const [floorId, setFloorId] = useState<string>(() => {
    return searchParams.get('floor') ?? '';
  });

  // Resolve effective floor — use URL param, or first floor available
  const effectiveFloorId = floorId || floors[0]?.id || '';

  // ---------------------------------------------------------------------------
  // Time window
  // ---------------------------------------------------------------------------
  const [timeWindow, setTimeWindow] = useState<TimeScrubberValue>(() => {
    const fromParam = searchParams.get('from');
    const toParam = searchParams.get('to');
    if (fromParam && toParam) {
      return { start: new Date(fromParam), end: new Date(toParam) };
    }
    return defaultWindow();
  });

  function handleTimeChange(next: TimeScrubberValue) {
    setTimeWindow(next);
    setSearchParams(
      (p) => {
        p.set('from', next.start.toISOString());
        p.set('to', next.end.toISOString());
        return p;
      },
      { replace: true },
    );
  }

  function handleFloorChange(id: string) {
    setFloorId(id);
    setSearchParams(
      (p) => {
        p.set('floor', id);
        return p;
      },
      { replace: true },
    );
  }

  function handleBuildingChange(id: string) {
    setBuildingId(id);
    setFloorId(''); // reset floor when building changes
    setSearchParams(
      (p) => {
        p.set('building', id);
        p.delete('floor');
        return p;
      },
      { replace: true },
    );
  }

  // ---------------------------------------------------------------------------
  // Data queries
  // ---------------------------------------------------------------------------
  const { data: publishedPlan } = useFloorPlanPublished(effectiveFloorId);
  const availability = useFloorAvailability(
    effectiveFloorId,
    timeWindow.start.toISOString(),
    timeWindow.end.toISOString(),
  );
  useFloorAvailabilityRealtime(effectiveFloorId);

  // Heatmap average occupancy for the floor switcher
  const avgOccupancy = useMemo(() => {
    const buckets = availability.data?.heatmap ?? [];
    if (!buckets.length) return 0;
    return buckets.reduce((acc, b) => acc + b.occupancy, 0) / buckets.length;
  }, [availability.data]);

  const spaceStates = useMemo(
    () => mapAvailabilityToStates(availability.data?.spaces ?? []),
    [availability.data],
  );

  const occupancyByFloorId = useMemo(
    () => buildOccupancyByFloor(effectiveFloorId, avgOccupancy),
    [effectiveFloorId, avgOccupancy],
  );

  // True when "now" falls within the selected time window — enables free-in-N badges.
  const isCurrentWindow = useMemo(() => {
    const now = Date.now();
    return now >= timeWindow.start.getTime() && now < timeWindow.end.getTime();
  }, [timeWindow]);

  // ---------------------------------------------------------------------------
  // Space selection + modals
  // ---------------------------------------------------------------------------
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);

  const requesterPersonId = person?.id ?? null;

  const handleSpaceClick = useCallback(
    (spaceId: string) => {
      setSelectedSpaceId(spaceId);
      if (isMobile) {
        setSheetOpen(true);
      } else {
        setComposerOpen(true);
      }
    },
    [isMobile],
  );

  // Fit-to-screen: reset by re-mounting ZoomPanLayer via key
  const [zoomKey, setZoomKey] = useState(0);

  // Realtime connection status dot — hidden for the first 30s in 'open' state.
  const realtimeStatus = useRealtimeStatus();
  const [dotVisible, setDotVisible] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDotVisible(true), 30_000);
    return () => clearTimeout(t);
  }, []);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const hasPlan = publishedPlan != null;

  return (
    <PortalPage width="wide" bleed="none">
      {/* Breadcrumb */}
      <div className="mb-4 flex items-center gap-2">
        <Link
          to="/portal/rooms"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> Book a room
        </Link>
      </div>

      {/* Header */}
      <header className="mb-4">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
            Floor plan
          </h1>
          {/* Realtime status dot — hidden when open (first 30s) */}
          {(dotVisible || realtimeStatus !== 'open') && (
            <span
              aria-label={`Realtime: ${realtimeStatus}`}
              className={[
                'inline-block size-1.5 rounded-full flex-shrink-0 self-center',
                realtimeStatus === 'open' ? 'bg-emerald-500' :
                realtimeStatus === 'reconnecting' ? 'bg-amber-400' :
                'bg-red-500',
                // Hide green dot until 30s have elapsed
                realtimeStatus === 'open' && !dotVisible ? 'hidden' : '',
              ].join(' ')}
            />
          )}
        </div>
        <p className="mt-1 text-sm text-muted-foreground text-pretty">
          Tap a room to book it for the selected time window.
        </p>
      </header>

      {/* Floor switcher + building picker */}
      {buildingId && (
        <div className="mb-3">
          <FloorSwitcher
            buildingId={buildingId}
            selectedFloorId={effectiveFloorId}
            onFloorChange={handleFloorChange}
            occupancyByFloorId={occupancyByFloorId}
            buildings={buildings.length > 1 ? buildings : undefined}
            selectedBuildingId={buildingId}
            onBuildingChange={handleBuildingChange}
          />
        </div>
      )}

      {/* Time scrubber */}
      <div className="mb-4">
        <TimeScrubber
          value={timeWindow}
          onChange={handleTimeChange}
          heatmap={availability.data?.heatmap ?? []}
        />
      </div>

      {/* Floor plan canvas or empty state */}
      {!effectiveFloorId || !hasPlan ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
          <Map className="size-10 text-muted-foreground/50" />
          <p className="text-base font-medium">No floor plan published</p>
          <p className="text-sm text-muted-foreground max-w-xs text-pretty">
            This floor doesn't have a published plan yet.
          </p>
          <Link
            to="/portal/rooms"
            className="inline-flex h-7 items-center rounded-[min(var(--radius-md),12px)] border border-border bg-background px-2.5 text-[0.8rem] font-medium text-foreground hover:bg-muted transition-colors"
          >
            Browse rooms in list view
          </Link>
        </div>
      ) : (
        <div className="relative w-full rounded-xl border bg-muted/30 overflow-hidden" style={{ aspectRatio: '16/9', minHeight: '300px' }}>
          <ZoomPanLayer key={zoomKey} minScale={0.25} maxScale={8}>
            <FloorPlanCanvas
              plan={publishedPlan}
              states={spaceStates}
              selectedSpaceId={selectedSpaceId}
              onSpaceClick={handleSpaceClick}
              isCurrentWindow={isCurrentWindow}
            />
          </ZoomPanLayer>

          {/* Fit-to-screen FAB */}
          <button
            type="button"
            onClick={() => setZoomKey((k) => k + 1)}
            aria-label="Reset zoom"
            className="absolute bottom-4 right-4 flex size-9 items-center justify-center rounded-full bg-background/90 shadow-sm border border/50 hover:bg-background transition-colors"
          >
            <Maximize2 className="size-4" />
          </button>
        </div>
      )}

      {/* Mobile bottom sheet */}
      <BookingSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        spaceId={selectedSpaceId}
        plan={publishedPlan ?? null}
        requesterPersonId={requesterPersonId ?? ''}
      />

      {/* Desktop composer modal — pre-seeded with selected space + window */}
      {composerOpen && selectedSpaceId && requesterPersonId && (
        <BookingComposerModal
          open={composerOpen}
          onOpenChange={(o) => {
            if (!o) {
              setComposerOpen(false);
              setSelectedSpaceId(null);
            }
          }}
          mode="self"
          entrySource="portal"
          callerPersonId={requesterPersonId}
          hostFirstName={person?.first_name ?? null}
          initialDraft={draftFromComposerSeed({
            spaceId: selectedSpaceId,
            startAt: timeWindow.start.toISOString(),
            endAt: timeWindow.end.toISOString(),
            attendeeCount: 1,
            templateId: null,
            costCenterId: null,
            hostPersonId: requesterPersonId,
          })}
          onBooked={(reservationId) => {
            setComposerOpen(false);
            setSelectedSpaceId(null);
            if (reservationId) {
              navigate(`/portal/me/bookings/${reservationId}`);
            } else {
              navigate('/portal/me/bookings');
            }
          }}
        />
      )}
    </PortalPage>
  );
}

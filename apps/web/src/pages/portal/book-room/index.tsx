import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, ArrowRight } from 'lucide-react';
import { InlineBanner } from '@/components/ui/inline-banner';
import { PortalPage } from '@/components/portal/portal-page';
import { usePortal } from '@/providers/portal-provider';
import { useAuth } from '@/providers/auth-provider';
import { usePicker } from '@/api/room-booking';
import type { RankedRoom } from '@/api/room-booking';

/**
 * Module-scope empty array so `picker.data?.rooms ?? EMPTY_ROOMS` returns
 * the same reference every render — needed for the realtime-availability
 * memo to be stable when there are zero results.
 */
const EMPTY_ROOMS: RankedRoom[] = [];
import { BookingCriteriaBar } from './components/booking-criteria-bar';
import { BookingResultsList } from './components/booking-results-list';
import { BundleTemplatePicker } from './components/bundle-template-picker';
import { FloorPlanPicker } from './components/floor-plan-picker';
import { RealtimeAvailabilityPill } from './components/realtime-availability-pill';
import { BookingProgressiveActions } from './components/booking-progressive-actions';
import { BookingComposerModal } from '@/components/booking-composer-v2/booking-composer-modal';
import { draftFromComposerSeed } from '@/components/booking-composer-v2/booking-draft';
import { templateServicesToPickerSelections } from '@/components/booking-composer/state';
import type { BundleTemplate } from '@/api/bundle-templates';
import { usePickerState } from './hooks/use-picker-state';
import { useRealtimeAvailability } from './hooks/use-realtime-availability';

/**
 * Portal hybrid-C booking flow per spec §4.1. The picker is a single page;
 * results are ranked + live, and progressive disclosure footers expand
 * into find-time / multi-room / recurring without leaving the page.
 */
export function BookRoomPage() {
  const { data: portal } = usePortal();
  const { person, hasRole } = useAuth();
  const navigate = useNavigate();

  const sites = useMemo(() => {
    const locs = portal?.authorized_locations ?? [];
    return locs
      .filter((l) => l.type === 'site' || l.type === 'building')
      .map((l) => ({ id: l.id, name: l.name }));
  }, [portal?.authorized_locations]);

  const initialSiteId = useMemo(() => {
    const cur = portal?.current_location;
    if (cur && (cur.type === 'site' || cur.type === 'building')) return cur.id;
    return sites[0]?.id ?? null;
  }, [portal?.current_location, sites]);

  const { state, update, input, startAtIso, endAtIso } = usePickerState({
    siteId: initialSiteId,
  });

  const picker = usePicker(input);
  const rooms = picker.data?.rooms ?? EMPTY_ROOMS;

  const visibleSpaceIds = useMemo(() => rooms.map((r) => r.space_id), [rooms]);
  useRealtimeAvailability(visibleSpaceIds, input, picker.isSuccess);

  const [pendingPrimary, setPendingPrimary] = useState<RankedRoom | null>(null);
  const [pendingExtras, setPendingExtras] = useState<RankedRoom[]>([]);
  const [activeTemplate, setActiveTemplate] = useState<BundleTemplate | null>(null);

  const onBook = (room: RankedRoom) => {
    setPendingPrimary(room);
    setPendingExtras([]);
  };

  const showRestricted = hasRole('agent');
  // Gate the page on a real person id — submitting with an empty string
  // would 422 server-side. While auth is still resolving, render the
  // skeleton-equivalent (the picker stays disabled until a person is
  // available).
  const requesterPersonId = person?.id ?? null;

  const widenSearch = () => {
    update('mustHaveAmenities', []);
    update('attendeeCount', 1);
  };

  const onPickTemplate = (template: BundleTemplate | null) => {
    setActiveTemplate(template);
    if (!template) return;
    // Apply room-shape defaults from the template payload. Services are
    // forwarded to the booking-confirm dialog via `initialTemplateServices`
    // when the user clicks Book on a room.
    const payload = template.payload ?? {};
    if (payload.default_duration_minutes != null) {
      update('durationMinutes', payload.default_duration_minutes);
    }
    if (payload.room_criteria?.must_have_amenities?.length) {
      update('mustHaveAmenities', payload.room_criteria.must_have_amenities);
    }
  };

  return (
    <PortalPage>
      {/* Top breadcrumb row */}
      <div className="mb-4 flex items-center justify-between">
        <Link
          to="/portal"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> Portal home
        </Link>
        <Link
          to="/portal/me/bookings"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          My bookings
          <ArrowRight className="size-3.5" />
        </Link>
      </div>

      {/* Hero */}
      <header className="mb-6 max-w-2xl">
        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
          Book a room
        </h1>
        <p className="mt-2 text-base text-muted-foreground text-pretty">
          Pick a time and we'll rank rooms by what fits — capacity, amenities,
          and how often your team uses each space.
        </p>
      </header>

      <BundleTemplatePicker
        selectedId={activeTemplate?.id ?? null}
        onSelect={onPickTemplate}
      />

      <BookingCriteriaBar state={state} onChange={update} sites={sites} />

      <RealtimeAvailabilityPill
        matchCount={rooms.length}
        isLive={picker.isSuccess && rooms.length > 0}
        isFetching={picker.isFetching}
        sort={state.sort}
        onSortChange={(v) => update('sort', v)}
      />

      {state.view === 'list' ? (
        <BookingResultsList
          rooms={rooms}
          isPending={picker.isPending && !picker.data}
          isFetching={picker.isFetching}
          requestedStartIso={startAtIso}
          requestedEndIso={endAtIso}
          showRestricted={showRestricted}
          onBook={onBook}
          onWidenSearch={widenSearch}
        />
      ) : (
        <FloorPlanPicker
          rooms={rooms}
          showRestricted={showRestricted}
          onBook={onBook}
        />
      )}

      {picker.isError && (
        <div className="mt-4">
          <InlineBanner tone="destructive" icon={AlertTriangle} role="alert">
            <span className="text-destructive">
              {picker.error instanceof Error ? picker.error.message : 'Picker error'}
            </span>
          </InlineBanner>
        </div>
      )}

      <BookingProgressiveActions
        attendeeCount={0}
        multiRoomCount={pendingExtras.length}
        recurring={false}
        topRoomName={rooms[0]?.name ?? null}
        disabled={rooms.length === 0}
        onAddAttendees={() => {
          if (!rooms[0]) return;
          setPendingPrimary(rooms[0]);
        }}
        onAddRoom={() => {
          if (!rooms[0]) return;
          setPendingPrimary(rooms[0]);
          setPendingExtras(rooms.slice(1, 2));
        }}
        onMakeRecurring={() => {
          if (!rooms[0]) return;
          setPendingPrimary(rooms[0]);
        }}
      />

      {pendingPrimary && requesterPersonId && (
        <BookingComposerModal
          open={Boolean(pendingPrimary)}
          onOpenChange={(o) => {
            if (!o) {
              setPendingPrimary(null);
              setPendingExtras([]);
            }
          }}
          mode="self"
          entrySource="portal"
          callerPersonId={requesterPersonId}
          hostFirstName={person?.first_name ?? null}
          initialDraft={draftFromComposerSeed({
            spaceId: pendingPrimary.space_id,
            startAt: startAtIso,
            endAt: endAtIso,
            attendeeCount: state.attendeeCount,
            templateId: activeTemplate?.id ?? null,
            costCenterId: activeTemplate?.payload?.default_cost_center_id ?? null,
            services: activeTemplate?.payload?.services
              ? templateServicesToPickerSelections(
                  activeTemplate.payload.services,
                  state.attendeeCount,
                )
              : undefined,
            hostPersonId: requesterPersonId,
          })}
          onBooked={(reservationId) => {
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

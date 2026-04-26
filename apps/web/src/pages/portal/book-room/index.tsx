import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { PortalPage } from '@/components/portal/portal-page';
import { usePortal } from '@/providers/portal-provider';
import { useAuth } from '@/providers/auth-provider';
import { usePicker } from '@/api/room-booking';
import type { RankedRoom } from '@/api/room-booking';
import { BookingCriteriaBar } from './components/booking-criteria-bar';
import { BookingResultsList } from './components/booking-results-list';
import { FloorPlanPicker } from './components/floor-plan-picker';
import { RealtimeAvailabilityPill } from './components/realtime-availability-pill';
import { BookingProgressiveActions } from './components/booking-progressive-actions';
import { BookingConfirmDialog } from './components/booking-confirm-dialog';
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
  const rooms = picker.data?.rooms ?? [];

  const visibleSpaceIds = useMemo(() => rooms.map((r) => r.space_id), [rooms]);
  useRealtimeAvailability(visibleSpaceIds, input, picker.isSuccess);

  const [pendingPrimary, setPendingPrimary] = useState<RankedRoom | null>(null);
  const [pendingExtras, setPendingExtras] = useState<RankedRoom[]>([]);
  const [dialogFocus, setDialogFocus] = useState<
    'identity' | 'attendees' | 'multi-room' | 'recurring' | undefined
  >(undefined);

  const onBook = (room: RankedRoom) => {
    setPendingPrimary(room);
    setPendingExtras([]);
    setDialogFocus('identity');
  };

  const showRestricted = hasRole('agent');
  const requesterPersonId = person?.id ?? '';

  const widenSearch = () => {
    update('mustHaveAmenities', []);
    update('attendeeCount', 1);
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
        <div
          role="alert"
          className="mt-4 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-xs text-destructive"
        >
          {picker.error instanceof Error ? picker.error.message : 'Picker error'}
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
          setDialogFocus('attendees');
        }}
        onAddRoom={() => {
          if (!rooms[0]) return;
          setPendingPrimary(rooms[0]);
          setPendingExtras(rooms.slice(1, 2));
          setDialogFocus('multi-room');
        }}
        onMakeRecurring={() => {
          if (!rooms[0]) return;
          setPendingPrimary(rooms[0]);
          setDialogFocus('recurring');
        }}
      />

      <BookingConfirmDialog
        open={Boolean(pendingPrimary)}
        onOpenChange={(o) => {
          if (!o) {
            setPendingPrimary(null);
            setPendingExtras([]);
          }
        }}
        primaryRoom={pendingPrimary}
        additionalRooms={pendingExtras}
        startAtIso={startAtIso}
        endAtIso={endAtIso}
        attendeeCount={state.attendeeCount}
        attendeePersonIds={[]}
        recurrenceRule={null}
        requesterPersonId={requesterPersonId}
        initialFocus={dialogFocus}
        onBooked={() => {
          // Success — picker auto-invalidates via the mutation hook.
        }}
      />
    </PortalPage>
  );
}

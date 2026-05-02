import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AlertTriangle, CalendarClock, Check, ChevronLeft, ChevronRight, Loader2, MapPin, Sparkles } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
  FieldSeparator,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { NumberStepper } from '@/components/ui/number-stepper';
import { Skeleton } from '@/components/ui/skeleton';
import { PersonPicker } from '@/components/person-picker';
import { useCreateBooking, useMultiRoomBooking } from '@/api/room-booking';
import { spacesListOptions } from '@/api/spaces';
import type { Space } from '@/api/spaces';
import { useCostCenters } from '@/api/cost-centers';
import { usePerson } from '@/api/persons';
import { useCreateInvitation } from '@/api/visitors';
import { VisitorsSection } from './sections/visitors-section';
import { formatCurrency } from '@/lib/format';
import { cn } from '@/lib/utils';
import { toast, toastError, toastSuccess } from '@/lib/toast';
import { InlineBanner } from '@/components/ui/inline-banner';
import { ServicePickerBody } from './service-picker-sheet';
import {
  composerReducer,
  initialState,
  validateForSubmit,
  type ComposerEntrySource,
  type ComposerMode,
  type ComposerState,
  type InitialComposerState,
} from './state';
import { buildBookingPayload, buildMultiRoomBookingPayload } from './submit';
import {
  combineLocalDateTime,
  estimateOccurrences,
  extractAlternatives,
  isoToLocalDate,
  isoToLocalTime,
  nextQuarterHour,
} from './helpers';
import { DateTimePicker } from '@/components/ui/date-time-picker';
import { RoomPickerInline } from './sections/room-picker-inline';
import { AdditionalRoomsField } from './sections/additional-rooms-field';
import { RecurrenceField } from './sections/recurrence-field';

export interface BookingComposerProps {
  /** When the wrapper opens/closes the composer. */
  open: boolean;
  onOpenChange: (open: boolean) => void;

  mode: ComposerMode;
  entrySource: ComposerEntrySource;

  /** Logged-in person id — implicit requester in self mode, fallback in
   *  operator mode if the picker is left empty. */
  callerPersonId: string;

  /** Pre-selections from the entry point (e.g. drag-create on the
   *  scheduler pre-picks spaceId/startAt/endAt; the desk-list button
   *  passes nothing). */
  initial?: InitialComposerState;

  /** When provided, the room picker is hidden and the title shows the
   *  fixed room. Used by the scheduler entry which already pre-selected.
   *  Structural — accepts both `RankedRoom` (portal picker) and
   *  `SchedulerRoom` (desk scheduler) without a type-cast at the seam. */
  fixedRoom?: {
    space_id: string;
    name: string;
    capacity?: number | null;
    rule_outcome?: { effect?: string; denial_message?: string | null } | null;
  } | null;

  /** Fired after a successful booking lands. The wrapper typically
   *  navigates / closes / refreshes the underlying list. */
  onBooked?: (reservationId: string) => void;
}

/**
 * Brain of the unified booking flow. Shared across:
 *   - Desk-list "+ New booking" sheet
 *   - Desk scheduler drag-create dialog
 *   - (Phase 2) Portal /portal/book-room
 *
 * Renders the same sections regardless of surface — the wrapper picks
 * Dialog vs Sheet vs Popover. Multi-room atomic groups supported via
 * additionalSpaceIds (handleSubmit branches on the count); recurrence +
 * multi-room is mutually exclusive (validateForSubmit gates, backend
 * controller rejects). Services on multi-room attach to the PRIMARY
 * room only per backend semantics.
 */
export function BookingComposer({
  open,
  onOpenChange,
  mode,
  entrySource,
  callerPersonId,
  initial,
  fixedRoom,
  onBooked,
}: BookingComposerProps) {
  // Compose the seed: explicit `initial` from the wrapper + a `fixedRoom`
  // override for spaceId so the scheduler's pre-selected cell carries
  // through without the wrapper having to thread spaceId twice.
  const composedSeed = useMemo<InitialComposerState>(
    () => ({
      ...(initial ?? {}),
      spaceId: fixedRoom?.space_id ?? initial?.spaceId ?? null,
    }),
    [initial, fixedRoom?.space_id],
  );

  const [state, dispatch] = useReducer(composerReducer, initialState(composedSeed));

  // Re-seed on open so cancelled sessions don't leak state.
  useEffect(() => {
    if (open) {
      dispatch({ type: 'RESET', partial: initialState(composedSeed) });
      // RESET also clears the manual-CC-edit flag — a fresh open is a
      // fresh derivation context, so the next requester pick should
      // re-prefill from their profile.
      ccManuallyEditedRef.current = false;
    }
    // composedSeed is captured by useMemo + reference equality on its
    // dep set; RESET fires only on edge-trigger of `open` so a stable
    // wrapper doesn't re-bias mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Operator-mode selected person — used to fetch their default cost-center
  // code (we map code → id below).
  const requesterPersonId = state.requesterPersonId;
  const { data: requesterPerson } = usePerson(
    mode === 'operator' && requesterPersonId ? requesterPersonId : null,
  );

  const { data: costCenters } = useCostCenters({ active: true });
  const costCentersList = costCenters ?? [];

  // Read the spaces cache to surface room metadata (capacity, name) on
  // top-level UX — capacity warning, header summary, etc. Skipped when
  // `fixedRoom` is set (scheduler drag-create already supplied the room
  // shape, no need to over-fetch). When the inline picker is the source
  // of state.spaceId, the picker has already mounted useSpaces() so this
  // call hits the same QueryClient cache.
  const { data: spacesCache } = useQuery({
    ...spacesListOptions(),
    enabled: !fixedRoom,
  });
  const pickedRoom = useMemo(() => {
    if (fixedRoom) {
      return {
        space_id: fixedRoom.space_id,
        name: fixedRoom.name,
        capacity: fixedRoom.capacity ?? null,
      };
    }
    if (!state.spaceId || !spacesCache) return null;
    const s = spacesCache.find((sp) => sp.id === state.spaceId);
    return s
      ? { space_id: s.id, name: s.name, capacity: s.capacity ?? null }
      : null;
  }, [fixedRoom, state.spaceId, spacesCache]);

  // Track whether the operator manually edited the cost-center, so we
  // can re-derive the default when the "Booking for" person changes
  // WITHOUT clobbering an explicit operator choice. Codex flagged the
  // one-shot prefill as stale-on-requester-change on the holistic review.
  const ccManuallyEditedRef = useRef(false);

  // Resolve person.cost_center (code) → cost_center_id whenever the
  // requester person changes (re-derives), unless the operator has
  // explicitly picked a CC.
  useEffect(() => {
    if (mode !== 'operator') return;
    if (ccManuallyEditedRef.current) return;
    if (!requesterPerson?.cost_center) {
      // No default available — clear so we don't carry the previous
      // requester's CC into a new requester's bundle.
      if (state.costCenterId) {
        dispatch({ type: 'SET_COST_CENTER', costCenterId: null });
      }
      return;
    }
    const match = costCentersList.find((cc) => cc.code === requesterPerson.cost_center);
    if (match) {
      if (match.id !== state.costCenterId) {
        dispatch({ type: 'SET_COST_CENTER', costCenterId: match.id });
      }
    } else {
      // Requester carries a code that doesn't match any active CC —
      // clear rather than retain the previous requester's id (codex
      // flagged this stale carry-over on the holistic re-review).
      if (state.costCenterId) {
        dispatch({ type: 'SET_COST_CENTER', costCenterId: null });
      }
    }
    // Intentionally NOT depending on state.costCenterId — that would
    // re-fire and reseed when the operator manually clears it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, requesterPerson?.cost_center, costCentersList]);

  // Quick-create UX: time defaults to "next quarter-hour, 1h duration"
  // when the wrapper didn't pre-seed.
  useEffect(() => {
    if (!open) return;
    if (state.startAt && state.endAt) return;
    const start = nextQuarterHour();
    const end = new Date(start.getTime() + 60 * 60_000);
    dispatch({ type: 'SET_TIME', startAt: start.toISOString(), endAt: end.toISOString() });
  }, [open, state.startAt, state.endAt]);

  const validationError = useMemo(() => validateForSubmit(state, mode), [state, mode]);

  const createBooking = useCreateBooking();
  const createMultiRoom = useMultiRoomBooking();
  const createInvitation = useCreateInvitation();
  const submitting = createBooking.isPending || createMultiRoom.isPending;

  // Walk the spaces tree from a child up to its enclosing building.
  // Used by the visitors flush after a booking lands — visitor invitations
  // need a building_id, but the composer only knows the room. The cache
  // is the same one rendering the picker, so this is a synchronous lookup.
  //
  // Preference: BUILDING wins over SITE. The reception today view filters
  // on exact `building_id` equality, and reception's picker (likewise the
  // most common user-mental-model) anchors on the building, not the site.
  // Returning a site when a building exists higher in the chain produces
  // a visitor whose building_id doesn't match the receptionist's filter
  // → invisible in /desk/visitors. Walk to the top, remember any building
  // we passed, only return a site if no building exists in the chain.
  // Edge case: if the room IS itself the building (rare but possible),
  // we return the room id — the closure handles that via the same loop.
  const resolveBuildingId = useCallback(
    (spaceId: string | null): string | null => {
      if (!spaceId || !spacesCache) return null;
      const byId = new Map<string, Space>();
      for (const s of spacesCache) byId.set(s.id, s);
      let cursor: Space | undefined = byId.get(spaceId);
      let fallbackSiteId: string | null = null;
      let depth = 0;
      while (cursor && depth < 10) {
        if (cursor.type === 'building') return cursor.id;
        if (cursor.type === 'site' && fallbackSiteId === null) {
          // Remember the closest site but keep walking — a building
          // higher up the chain is still preferred, since reception
          // typically scopes its today view to a building.
          fallbackSiteId = cursor.id;
        }
        if (!cursor.parent_id) break;
        cursor = byId.get(cursor.parent_id);
        depth += 1;
      }
      return fallbackSiteId;
    },
    [spacesCache],
  );
  // Drill-down view inside the composer — services live here as a
  // sub-pane, NOT a stacked Sheet. Single primary CTA (the composer
  // footer's Book button) regardless of which pane the user is on.
  // Entry: "Browse services" / "Edit" sets view='services'. Exit: the
  // back chevron sets view='main'. Reopening the composer always lands
  // on main.
  const [view, setView] = useState<'main' | 'services'>('main');
  useEffect(() => {
    if (open) setView('main');
  }, [open]);
  // When drilling into the services pane, scroll the surrounding
  // overflow container (DialogContent/SheetContent) back to the top so
  // the user lands on the pane title rather than mid-form. The pane
  // itself doesn't own the scroll context, so we look up to the
  // closest scrollable ancestor.
  const servicesPaneRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (view !== 'services') return;
    const el = servicesPaneRef.current;
    if (!el) return;
    let node: HTMLElement | null = el.parentElement;
    while (node) {
      const overflowY = getComputedStyle(node).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') {
        node.scrollTop = 0;
        return;
      }
      node = node.parentElement;
    }
  }, [view]);
  // Submit-success beat — after the mutation lands we hold the button
  // in a 'success' state for ~260ms before closing. Anchors the "yes
  // it worked" feedback to where the user clicked, so the toast that
  // appears in the corner reads as confirmation rather than the only
  // signal anything happened. Reduced-motion users skip the beat
  // entirely (emil: don't make them stare at a static green button).
  const [submitState, setSubmitState] = useState<'idle' | 'success'>('idle');
  const submitBtnRef = useRef<HTMLButtonElement | null>(null);
  // Track the success-beat timeout so an ESC dismiss / parent-driven
  // close mid-beat doesn't fire stale onBooked navigation against a
  // wrapper that already moved on.
  const successTimerRef = useRef<number | null>(null);
  // Reset success state whenever the wrapper re-opens (so a re-used
  // composer instance doesn't briefly flash the previous success).
  useEffect(() => {
    if (open) setSubmitState('idle');
  }, [open]);
  // Clean up the success timer on unmount so a mid-beat dismiss (ESC,
  // backdrop click, parent state change) doesn't fire post-unmount.
  useEffect(() => {
    return () => {
      if (successTimerRef.current != null) {
        window.clearTimeout(successTimerRef.current);
        successTimerRef.current = null;
      }
    };
  }, []);
  // Same cleanup if `open` flips false externally during the beat.
  useEffect(() => {
    if (!open && successTimerRef.current != null) {
      window.clearTimeout(successTimerRef.current);
      successTimerRef.current = null;
    }
  }, [open]);

  // Approval-route detection: when the picked room's `rule_outcome.effect`
  // is `require_approval`, the booking lands as `pending_approval`. We
  // adapt the title + CTA copy + show the explanatory denial message.
  const isApprovalRoute = fixedRoom?.rule_outcome?.effect === 'require_approval';
  const approvalDenialMessage = fixedRoom?.rule_outcome?.denial_message ?? null;

  // Cost preview — sum of selected services. `per_person` lines multiply
  // by attendees on the backend, so mirror that here so the preview
  // matches the actual landed total. `unit_price` is null until the
  // picker resolves the current menu offer; those lines show as 0
  // until confirmed.
  const servicesTotal = useMemo(() => {
    return state.services.reduce((sum, s) => {
      if (s.unit_price == null || !Number.isFinite(s.unit_price)) return sum;
      switch (s.unit) {
        case 'per_person':
          return sum + s.unit_price * s.quantity * Math.max(1, state.attendeeCount);
        case 'flat_rate':
          return sum + s.unit_price;
        case 'per_item':
        default:
          return sum + s.unit_price * s.quantity;
      }
    }, 0);
  }, [state.services, state.attendeeCount]);

  // Annualised projection — when the booking is recurring, multiply the
  // single-occurrence services cost by the estimated occurrences so the
  // user sees the ongoing cost commitment, not just the first meeting.
  // Mirrors the backend's `estimateAnnualisedOccurrences` including the
  // `until` bound (so a 'weekly until 6 weeks from now' rule projects
  // 6, not 52 / yr).
  const annualisedOccurrences = useMemo(() => {
    if (!state.recurrence || !state.startAt) return 0;
    return estimateOccurrences(
      state.recurrence.frequency,
      state.recurrence.interval,
      state.recurrence.count ?? 0,
      state.recurrence.until ?? null,
      state.startAt,
    );
  }, [state.recurrence, state.startAt]);
  const annualisedTotal = annualisedOccurrences * servicesTotal;

  // Capacity check: warn when the picked room is smaller than the
  // attendee count. Operators in particular routinely book on behalf
  // of a room that's tight — surfacing this client-side before submit
  // saves a "yes I confirm" round-trip.
  const capacityWarning = useMemo(() => {
    if (
      pickedRoom?.capacity != null &&
      pickedRoom.capacity < state.attendeeCount
    ) {
      return {
        roomCapacity: pickedRoom.capacity,
        attendees: state.attendeeCount,
        roomName: pickedRoom.name,
      };
    }
    return null;
  }, [pickedRoom, state.attendeeCount]);

  // True when at least one selected service has a resolved unit_price.
  // Template seeds carry unit_price=null until the user opens the picker
  // and confirms; until then we prefer 'Pending pricing' over a misleading
  // €0 footer.
  const hasResolvedPricing = useMemo(
    () => state.services.some((s) => s.unit_price != null),
    [state.services],
  );

  // Time-change wrapper. Whenever the booking moves to a new start time,
  // any selected service whose lead_time_hours no longer fits is silently
  // dropped and the user is told what was removed. This pairs with the
  // picker's lead-time gate (service-picker-sheet.tsx) so a user can't
  // arrive at the Book button with a stale invalid selection. The picker
  // prevents NEW invalid picks; this handles EXISTING valid picks that
  // become invalid because the meeting was moved closer to "now".
  //
  // Reads services through a ref so back-to-back time changes always see
  // the latest list (closure capture would otherwise re-add a just-dropped
  // service when two changes happen in the same render). dispatch is
  // stable, so the callback identity never changes — handlers don't
  // re-bind on every services edit.
  const servicesRef = useRef(state.services);
  useEffect(() => {
    servicesRef.current = state.services;
  }, [state.services]);

  const dispatchTimeChange = useCallback(
    (startAt: string | null, endAt: string | null) => {
      const services = servicesRef.current;
      if (startAt && services.length > 0) {
        const startMs = new Date(startAt).getTime();
        if (Number.isFinite(startMs)) {
          const hoursUntilStart = (startMs - Date.now()) / 3_600_000;
          const dropped: typeof services = [];
          const kept: typeof services = [];
          for (const s of services) {
            if (
              typeof s.lead_time_hours === 'number' &&
              s.lead_time_hours > hoursUntilStart
            ) {
              dropped.push(s);
            } else {
              kept.push(s);
            }
          }
          if (dropped.length > 0) {
            dispatch({ type: 'SET_SERVICES', services: kept });
            // Update the ref synchronously so a SECOND change in the same
            // tick doesn't re-add the just-dropped items via stale state.
            servicesRef.current = kept;
            const names = dropped.map((s) => s.name).join(', ');
            toast.message(
              dropped.length === 1
                ? `Removed ${dropped[0].name}`
                : `Removed ${dropped.length} services`,
              {
                description: `Insufficient lead time for the new meeting time · ${names}`,
              },
            );
          }
        }
      }
      dispatch({ type: 'SET_TIME', startAt, endAt });
    },
    [],
  );

  // Lead-time defense in depth. The picker gate prevents new invalid picks,
  // and `dispatchTimeChange` drops invalid picks when the time moves. This
  // memo only fires if both fail — surfaces a banner pointing the user to
  // the inconsistency.
  const leadTimeWarnings = useMemo(() => {
    if (!state.startAt || state.services.length === 0) return [] as Array<{ name: string; needHours: number }>;
    const startMs = new Date(state.startAt).getTime();
    if (Number.isNaN(startMs)) return [];
    const hoursUntilStart = (startMs - Date.now()) / 3_600_000;
    if (hoursUntilStart <= 0) return [];
    return state.services
      .filter((s) => {
        const lead = s.lead_time_hours;
        return typeof lead === 'number' && lead > hoursUntilStart;
      })
      .map((s) => ({
        name: s.name,
        needHours: s.lead_time_hours ?? 0,
      }));
  }, [state.startAt, state.services]);

  // Surface the 409 alternatives a server-side conflict-guard returns,
  // so a portal user who lost a race can rebook in one click instead of
  // re-running the picker.
  const conflictAlternatives = useMemo(
    () => extractAlternatives(createBooking.error),
    [createBooking.error],
  );

  /**
   * Submit the booking. `overrides` lets callers (the conflict-alternative
   * one-click rebook in particular) inject a different spaceId without
   * waiting for the reducer's next render — the reducer-set value is
   * captured by `state` in the closure here, so a `dispatch + setTimeout`
   * pattern is racy. Codex flagged this on the holistic review.
   */
  const handleSubmit = async (overrides?: { spaceId?: string }) => {
    const effectiveState: ComposerState = overrides?.spaceId
      ? { ...state, spaceId: overrides.spaceId }
      : state;
    // Re-validate with the override applied. The rebook path supplies a
    // valid spaceId so the original 'spaceId required' validationError
    // resolves; OTHER validation (attendees, requester) must still
    // block. Codex flagged that an unconditional bypass when overrides
    // exist let an invalid form one-click rebook.
    const overrideValidation = validateForSubmit(effectiveState, mode);
    if (overrideValidation) return;
    try {
      let reservationId: string | undefined;
      let bookingBundleId: string | null | undefined;
      if (effectiveState.additionalSpaceIds.length > 0) {
        const payload = buildMultiRoomBookingPayload({
          state: effectiveState,
          mode,
          entrySource,
          callerPersonId,
        });
        if (!payload) return;
        const result = await createMultiRoom.mutateAsync(payload);
        // Surface the primary's reservation id for the onBooked callback
        // so navigation lands on a useful page.
        const primary = (result as { reservations?: Array<{ id: string; booking_bundle_id?: string | null }> })?.reservations?.[0];
        reservationId = primary?.id;
        bookingBundleId = primary?.booking_bundle_id ?? null;
      } else {
        const payload = buildBookingPayload({
          state: effectiveState,
          mode,
          entrySource,
          callerPersonId,
        });
        if (!payload) return;
        const result = await createBooking.mutateAsync(payload);
        reservationId = (result as { id?: string })?.id;
        bookingBundleId = (result as { booking_bundle_id?: string | null })?.booking_bundle_id ?? null;
      }

      // Visitors flush — POST each pending invitation now that the
      // reservation exists. We carry booking_bundle_id (when the
      // reservation has one) and reservation_id back so the invite is
      // cascaded if the booking is later cancelled. Failures don't roll
      // back the booking — surface a per-row toast and leave the
      // successful invites in place. The host's expected list is
      // invalidated on each success via the mutation's onSuccess.
      if (effectiveState.visitors.length > 0 && reservationId) {
        const buildingId = resolveBuildingId(effectiveState.spaceId);
        if (buildingId && effectiveState.startAt) {
          for (const v of effectiveState.visitors) {
            try {
              await createInvitation.mutateAsync({
                first_name: v.first_name,
                last_name: v.last_name,
                email: v.email,
                phone: v.phone,
                company: v.company,
                visitor_type_id: v.visitor_type_id,
                expected_at: effectiveState.startAt,
                expected_until: effectiveState.endAt ?? undefined,
                building_id: buildingId,
                meeting_room_id: effectiveState.spaceId ?? undefined,
                booking_bundle_id: bookingBundleId ?? undefined,
                reservation_id: reservationId,
                co_host_person_ids:
                  v.co_host_persons && v.co_host_persons.length > 0
                    ? v.co_host_persons.map((c) => c.id)
                    : undefined,
                notes_for_visitor: v.notes_for_visitor,
                notes_for_reception: v.notes_for_reception,
              });
            } catch (err) {
              toastError(
                `Couldn't invite ${v.first_name}`,
                { error: err },
              );
            }
          }
        } else {
          toastError("Couldn't invite visitors", {
            description:
              "We couldn't resolve the room's building. Re-invite from /portal/visitors/invite.",
          });
        }
      }

      toastSuccess(
        isApprovalRoute
          ? 'Approval requested'
          : effectiveState.additionalSpaceIds.length > 0
            ? `Booked ${effectiveState.additionalSpaceIds.length + 1} rooms`
            : 'Booked',
      );
      // Reduced-motion users skip the beat entirely — toast is the
      // sole signal. Otherwise: anchor the green-check 'Booked!' state
      // for 260ms so the action lands visually before the dialog/sheet
      // collapses out from under the user. Re-focus the Submit button
      // (the rebook-from-conflict path fires this from the conflict
      // banner button — without re-focusing, the beat happens off the
      // user's attention and reads as orphaned).
      const reduce =
        typeof window !== 'undefined' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduce) {
        onOpenChange(false);
        if (reservationId) onBooked?.(reservationId);
        return;
      }
      setSubmitState('success');
      submitBtnRef.current?.focus();
      successTimerRef.current = window.setTimeout(() => {
        successTimerRef.current = null;
        onOpenChange(false);
        if (reservationId) onBooked?.(reservationId);
      }, 260);
    } catch (e) {
      toastError(
        isApprovalRoute
          ? "Couldn't request approval"
          : effectiveState.additionalSpaceIds.length > 0
            ? "Couldn't book the rooms"
            : "Couldn't book the room",
        { error: e, retry: () => handleSubmit(overrides) },
      );
    }
  };

  const onDate = state.startAt ? state.startAt.slice(0, 10) : null;

  return (
    <FieldGroup>
      {view === 'services' && (
        <div
          // Drill-down pane. Has its OWN footer ("Add to booking" /
          // "Cancel") so the user has a clear "I'm done picking, take
          // me back to confirm the booking" affordance. The composer's
          // main footer (Book + Cancel) is hidden in this view — that
          // earlier design read as "Book is committing my services
          // mid-pick" and confused users.
          //
          // animate-in: subtle fade + 4px slide from the right so the
          // pane reads as "we drilled in" without a heavy modal-on-modal
          // feel.
          key="services-view"
          ref={servicesPaneRef}
          className="flex flex-col gap-5 animate-in fade-in slide-in-from-right-1 duration-200 ease-[var(--ease-smooth)]"
        >
          <button
            type="button"
            onClick={() => setView('main')}
            aria-label="Back to booking details"
            className="-ml-2 inline-flex h-7 w-fit items-center gap-1 rounded-md px-2 text-[13px] font-medium text-muted-foreground transition-[background-color,color,transform] duration-150 ease-[var(--ease-snap)] hover:bg-accent hover:text-foreground active:translate-y-px focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <ChevronLeft className="size-4" aria-hidden />
            Back
          </button>
          <div>
            <h3 className="text-base font-semibold tracking-tight">
              {state.services.length > 0 ? 'Edit services' : 'Add services'}
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Catering, AV, and room setup we'll arrange for your meeting.
            </p>
          </div>
          <ServicePickerBody
            deliverySpaceId={state.spaceId}
            onDate={onDate}
            attendeeCount={state.attendeeCount}
            bookingStartAt={state.startAt}
            bookingEndAt={state.endAt}
            selections={state.services}
            onSelectionsChange={(services) =>
              dispatch({ type: 'SET_SERVICES', services })
            }
          />
          {/* Drilldown-specific footer. Single primary "Add to booking"
              CTA that just navigates back — selections are already in
              state via ServicePickerBody's controlled onSelectionsChange,
              so this button confirms intent ("I'm done picking") rather
              than committing data. The actual booking commit lives on
              the main view's Book button, by design. */}
          <div className="sticky bottom-0 -mx-1 flex items-center justify-end gap-2 border-t bg-background/85 px-1 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur-md sm:static sm:border-t-0 sm:bg-transparent sm:pb-0 sm:backdrop-blur-none">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => setView('main')}
              className="min-w-[10rem]"
            >
              {state.services.length === 0
                ? 'Done'
                : `Add ${state.services.length} to booking`}
            </Button>
          </div>
        </div>
      )}

      {view === 'main' && (
        <>
      {/* Operator: who is this for? */}
      {mode === 'operator' && (
        <Field>
          <FieldLabel htmlFor="composer-requester">Booking for</FieldLabel>
          <PersonPicker
            value={state.requesterPersonId}
            onChange={(id) => dispatch({ type: 'SET_REQUESTER', personId: id })}
            excludeId={null}
            placeholder="Pick a person…"
          />
          <FieldDescription>
            Their cost center, rule universe, and calendar are used. Defaults
            to you if left empty.
          </FieldDescription>
        </Field>
      )}

      {/* Time + room recap. Date + start use one combined picker; end is a
          time-only input on the same date. This sidesteps the historical
          `<input type="datetime-local">` minimum-width bug that pushed the
          modal into horizontal scroll on locales whose long format eats more
          than `1fr` of a 2xl Dialog (the previous shape was 2 datetime-local
          inputs in a `grid-cols-[1fr_1fr]`). It also matches /portal/order. */}
      <FieldSet>
        <FieldLegend variant="label">When + where</FieldLegend>
        <Field>
          <FieldLabel htmlFor="composer-start-date">
            <CalendarClock className="size-3.5" />
            Date &amp; start
          </FieldLabel>
          <DateTimePicker
            id="composer-start-date"
            date={isoToLocalDate(state.startAt)}
            time={isoToLocalTime(state.startAt)}
            onDateChange={(nextDate) => {
              // Date change: preserve current start-time and duration; the
              // booking shifts to the same time-of-day on the new date.
              const startIso = combineLocalDateTime(
                nextDate,
                isoToLocalTime(state.startAt) || '09:00',
              );
              if (!startIso) return;
              const dur =
                state.startAt && state.endAt
                  ? new Date(state.endAt).getTime() -
                    new Date(state.startAt).getTime()
                  : 60 * 60_000;
              const endIso = new Date(
                new Date(startIso).getTime() + Math.max(15 * 60_000, dur),
              ).toISOString();
              dispatchTimeChange(startIso, endIso);
            }}
            onTimeChange={(nextTime) => {
              const startIso = combineLocalDateTime(
                isoToLocalDate(state.startAt) || isoToLocalDate(new Date().toISOString()),
                nextTime,
              );
              if (!startIso) return;
              const dur =
                state.startAt && state.endAt
                  ? new Date(state.endAt).getTime() -
                    new Date(state.startAt).getTime()
                  : 60 * 60_000;
              const endIso = new Date(
                new Date(startIso).getTime() + Math.max(15 * 60_000, dur),
              ).toISOString();
              dispatchTimeChange(startIso, endIso);
            }}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="composer-end">End</FieldLabel>
          <Input
            id="composer-end"
            type="time"
            step={900}
            value={isoToLocalTime(state.endAt)}
            onChange={(e) => {
              const endIso = combineLocalDateTime(
                isoToLocalDate(state.endAt) || isoToLocalDate(state.startAt),
                e.target.value,
              );
              // End-time changes don't affect lead time (start unchanged)
              // but route through dispatchTimeChange anyway to keep one
              // entry point for time mutations — the filter is a no-op
              // when start hasn't moved.
              dispatchTimeChange(state.startAt, endIso);
            }}
            className="h-10 w-32 tabular-nums"
          />
        </Field>
        {fixedRoom ? (
          <Field>
            <FieldLabel>
              <MapPin className="size-3.5" />
              Room
            </FieldLabel>
            <div className="flex items-center justify-between rounded-md border bg-card px-3 py-2">
              <span className="text-sm font-medium">{fixedRoom.name}</span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {fixedRoom.capacity != null ? `${fixedRoom.capacity} cap` : '—'}
              </span>
            </div>
          </Field>
        ) : (
          <Field>
            <FieldLabel htmlFor="composer-space">
              <MapPin className="size-3.5" />
              Room
            </FieldLabel>
            <RoomPickerInline
              value={state.spaceId}
              attendeeCount={state.attendeeCount}
              excludeIds={state.additionalSpaceIds}
              onChange={(spaceId) => dispatch({ type: 'SET_SPACE', spaceId })}
            />
            <AdditionalRoomsField
              primaryId={state.spaceId}
              additionalIds={state.additionalSpaceIds}
              spacesCache={spacesCache ?? []}
              attendeeCount={state.attendeeCount}
              recurrence={state.recurrence}
              onAdd={(spaceId) => dispatch({ type: 'ADD_ROOM', spaceId })}
              onRemove={(spaceId) => dispatch({ type: 'REMOVE_ROOM', spaceId })}
            />
          </Field>
        )}
      </FieldSet>

      <FieldSeparator />

      {/* Attendees */}
      <Field>
        <FieldLabel htmlFor="composer-attendees">Attendees</FieldLabel>
        <NumberStepper
          id="composer-attendees"
          value={state.attendeeCount}
          onChange={(n) =>
            dispatch({ type: 'SET_ATTENDEES', count: n })
          }
          min={1}
          max={500}
          aria-label="Attendees"
          suffix={state.attendeeCount === 1 ? 'person' : 'people'}
        />
      </Field>

      {/* Services — collapsed summary row that drills into the picker
          (`view='services'`). Empty state shows a neutral "Add services"
          tile so requesters who don't need any can ignore it; filled state
          shows a one-line summary with names + total. The full editor
          lives in the drill-down pane, not inline — keeps the modal short
          for the 80% case (booking with no services). */}
      <FieldSet>
        <FieldLegend variant="label">Services</FieldLegend>
        <FieldDescription>
          Optional. Catering, AV, and room setup for your meeting.
        </FieldDescription>
        {state.services.length === 0 ? (
          <button
            type="button"
            onClick={() => setView('services')}
            disabled={!state.spaceId || !onDate}
            className="group/svc flex w-full items-center justify-between gap-3 rounded-md border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-60 [transition-duration:120ms] [transition-timing-function:var(--ease-snap)]"
          >
            <div className="flex items-center gap-2.5">
              <Sparkles className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0">
                <div className="text-sm font-medium">Add services</div>
                <div className="text-xs text-muted-foreground">
                  Browse catering, AV, room setup
                </div>
              </div>
            </div>
            <ChevronRight
              className="size-4 shrink-0 text-muted-foreground/60 [transition:transform_120ms_var(--ease-snap)] group-hover/svc:translate-x-0.5"
              aria-hidden
            />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setView('services')}
            className="group/svc flex w-full items-center justify-between gap-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-2.5 text-left transition-colors hover:bg-primary/10 [transition-duration:120ms] [transition-timing-function:var(--ease-snap)]"
            aria-label={`Edit ${state.services.length} services`}
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <Sparkles className="size-4 shrink-0 text-primary" aria-hidden />
              <div className="min-w-0">
                <div className="text-sm font-medium">
                  {state.services.length} service{state.services.length !== 1 ? 's' : ''}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {state.services
                    .map((s) =>
                      s.name === 'Template item' && s.unit_price == null
                        ? 'From template'
                        : s.name,
                    )
                    .slice(0, 3)
                    .join(' · ')}
                  {state.services.length > 3 ? ` +${state.services.length - 3} more` : ''}
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {hasResolvedPricing ? (
                <div className="flex flex-col items-end leading-tight">
                  <span className="text-sm font-semibold tabular-nums">
                    {formatCurrency(servicesTotal)}
                  </span>
                  {annualisedOccurrences > 0 && annualisedTotal > 0 && (
                    <span
                      className="text-[10px] text-muted-foreground tabular-nums"
                      title={`${annualisedOccurrences} occurrences over the next year`}
                    >
                      ~{formatCurrency(annualisedTotal)}/yr
                    </span>
                  )}
                </div>
              ) : (
                <Skeleton className="h-4 w-16" />
              )}
              <ChevronRight
                className="size-4 text-muted-foreground/60 [transition:transform_120ms_var(--ease-snap)] group-hover/svc:translate-x-0.5"
                aria-hidden
              />
            </div>
          </button>
        )}
      </FieldSet>

      {/* Visitors — pre-register people coming to this meeting. Hidden
          until the booking has a building anchor (which is implicit from
          the picked room). The section enqueues PendingVisitor rows in
          composer state; the flush in `handleSubmit` POSTs them after the
          reservation lands so each invite carries booking_bundle_id +
          reservation_id for cascade. */}
      <VisitorsSection
        visitors={state.visitors}
        bookingDefaults={{
          expected_at: state.startAt ?? undefined,
          expected_until: state.endAt ?? undefined,
          building_id: resolveBuildingId(state.spaceId) ?? undefined,
          meeting_room_id: state.spaceId ?? undefined,
        }}
        disabled={!state.spaceId || !state.startAt}
        disabledReason={
          !state.spaceId
            ? 'Pick a room first — visitors are anchored to a building.'
            : !state.startAt
              ? 'Pick a start time first.'
              : undefined
        }
        onAdd={(visitor) => dispatch({ type: 'ADD_VISITOR', visitor })}
        onUpdate={(visitor) => dispatch({ type: 'UPDATE_VISITOR', visitor })}
        onRemove={(localId) => dispatch({ type: 'REMOVE_VISITOR', localId })}
      />

      {/* Cost center — operator mode + has services */}
      {mode === 'operator' && state.services.length > 0 && (
        <Field>
          <FieldLabel htmlFor="composer-cc">Cost center</FieldLabel>
          <Select
            value={state.costCenterId ?? '__none__'}
            onValueChange={(v) => {
              ccManuallyEditedRef.current = true;
              dispatch({
                type: 'SET_COST_CENTER',
                costCenterId: v === '__none__' ? null : v,
              });
            }}
          >
            <SelectTrigger id="composer-cc">
              <SelectValue placeholder="Pick a cost center" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">No cost center</SelectItem>
              {costCentersList.map((cc) => (
                <SelectItem key={cc.id} value={cc.id}>
                  {cc.code} — {cc.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {requesterPerson?.cost_center && (
            <FieldDescription>
              Defaulted from {requesterPerson.first_name}'s profile (
              {requesterPerson.cost_center}).
            </FieldDescription>
          )}
        </Field>
      )}

      <FieldSeparator />

      {/* Recurrence */}
      <RecurrenceField
        rule={state.recurrence}
        onChange={(rule) => dispatch({ type: 'SET_RECURRENCE', rule })}
      />

      {/* Approval-route advisory. Neutral chrome with a purple Sparkles
          icon to telegraph the routing tier without screaming "error". */}
      {isApprovalRoute && approvalDenialMessage && (
        <InlineBanner
          tone="info"
          icon={Sparkles}
          iconClassName="text-purple-700 dark:text-purple-400"
        >
          {approvalDenialMessage}
        </InlineBanner>
      )}

      {/* Capacity warning — picked room is smaller than attendees. Soft
          (non-blocking; the user might know better than the listed
          capacity, e.g. standing-only event). Neutral chrome, amber icon
          — anything louder reads as a form error. role=status because
          this recomputes mid-edit (attendee/room change). */}
      {capacityWarning && (
        <InlineBanner
          tone="info"
          icon={AlertTriangle}
          iconClassName="text-amber-700 dark:text-amber-400"
          role="status"
        >
          <strong className="font-medium">Tight fit.</strong>{' '}
          {capacityWarning.roomName} seats {capacityWarning.roomCapacity}, you
          have {capacityWarning.attendees}.
        </InlineBanner>
      )}

      {/* Lead-time warnings — pre-empts a submit-time 422. With the picker
          gate + dispatchTimeChange auto-deselect, this is defense in depth:
          it should rarely fire. Polite live region — assertive role would
          re-announce noisily across the recomputes that happen on every
          attendee/service change. Fade-in so it doesn't pop into view. */}
      {leadTimeWarnings.length > 0 && (
        <InlineBanner
          tone="warning"
          icon={AlertTriangle}
          role="status"
          className="duration-150 ease-[var(--ease-smooth)] animate-in fade-in"
        >
          <p className="font-medium">Some services need more notice</p>
          <ul className="mt-1 space-y-0.5">
            {leadTimeWarnings.slice(0, 3).map((w) => (
              <li key={w.name}>
                {w.name} needs {w.needHours}h advance notice. Move the meeting later or remove this service.
              </li>
            ))}
          </ul>
        </InlineBanner>
      )}

      {/* Conflict alternatives — visible after a 409 race. Each row is a
          one-click rebook: dispatches SET_SPACE then re-submits without
          the user having to re-open the room picker. */}
      {conflictAlternatives.length > 0 && !fixedRoom && (
        <InlineBanner tone="destructive" icon={AlertTriangle} role="alert">
          <p className="font-medium text-destructive">
            Someone booked this slot before you. Try one of these:
          </p>
          <ul className="mt-1.5 space-y-1">
            {conflictAlternatives.slice(0, 3).map((alt) => (
              <li key={alt.space_id}>
                <button
                  type="button"
                  onClick={() => {
                    // Pass the alternative directly so buildBookingPayload
                    // sees the new spaceId without depending on reducer
                    // timing. Also dispatch so the rest of the composer
                    // reflects the new pick.
                    dispatch({ type: 'SET_SPACE', spaceId: alt.space_id });
                    void handleSubmit({ spaceId: alt.space_id });
                  }}
                  className="flex w-full items-center justify-between gap-3 rounded px-2 py-1.5 text-left outline-none [transition:background-color_120ms_var(--ease-snap)] hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-destructive/40 active:translate-y-px"
                >
                  <span className="truncate font-medium">{alt.name}</span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {alt.capacity ?? '—'} cap
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[10px] text-muted-foreground">
            Click any room above to rebook with the same time + services.
          </p>
        </InlineBanner>
      )}
      {/* When fixedRoom is set (scheduler drag-create), one-click rebook
          would override the operator's deliberate cell pick — fall back to
          the read-only summary they had before. */}
      {conflictAlternatives.length > 0 && fixedRoom && (
        <InlineBanner tone="destructive" icon={AlertTriangle} role="alert">
          <p className="font-medium text-destructive">
            Someone booked this slot before you. Try one of these:
          </p>
          <ul className="mt-1.5 space-y-1">
            {conflictAlternatives.slice(0, 3).map((alt) => (
              <li key={alt.space_id} className="flex justify-between">
                <span>{alt.name}</span>
                <span className="text-muted-foreground tabular-nums">
                  {alt.capacity ?? '—'} cap
                </span>
              </li>
            ))}
          </ul>
        </InlineBanner>
      )}

        </>
      )}

      {/* Footer: error + submit. Only rendered on the main view —
          the services drilldown has its own footer ("Add to booking" /
          Cancel) so the user has a clear non-committing affordance to
          return. Sticky on mobile so it's always reachable without
          scrolling through a long form (services + recurrence + warnings
          can push it well below the fold). The calling sheet/dialog wraps
          the composer in an overflow-y-auto container, so we pin to the
          bottom of THAT scroll context with `sticky bottom-0` and a
          bg/border so the form content scrolls underneath cleanly. We
          deliberately do NOT use a negative margin to bleed the bg to
          the wrapper's full width — the three mount points (Sheet px-5,
          portal Dialog p-6, scheduler Dialog p-6) all have different
          paddings, and any single -mx value triggered a horizontal scroll
          on at least one of them. Content-width is good enough; the bg
          still covers the scrolling content underneath because that
          content lives in the same padded box. pb honors iOS
          home-indicator safe area. */}
      {view === 'main' && (
      <div className="flex flex-col gap-2 border-t bg-background/85 backdrop-blur-md pt-3 sm:border-t-0 sm:bg-transparent sm:backdrop-blur-none sm:pt-2
                      pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:pb-0
                      sticky bottom-0 sm:static">
        {/* Reserved-height slot prevents the footer from jumping 16px
            on every keystroke that flips validity. Content swaps via
            key-driven crossfade so two messages never overlap mid-fade
            (emil pass). */}
        <div className="relative min-h-[1.25rem]" aria-live="polite">
          {(() => {
            // This footer only renders on the main view, so the
            // lead-time conflicts banner (rendered above in the same
            // view) is always reachable by scrolling.
            const leadTimeMsg =
              leadTimeWarnings.length > 0
                ? 'Resolve the lead-time conflicts above before submitting.'
                : null;
            const msg = validationError ?? leadTimeMsg;
            return msg ? (
              <p
                key={msg}
                className="text-xs text-amber-700 duration-150 ease-[var(--ease-smooth)] animate-in fade-in dark:text-amber-300"
              >
                {msg}
              </p>
            ) : null;
          })()}
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            // Cancel is locked through both the submitting AND success
            // beat — once the mutation succeeded the user can't undo by
            // closing the composer mid-celebration.
            disabled={submitting || submitState === 'success'}
          >
            Cancel
          </Button>
          <Button
            ref={submitBtnRef}
            type="button"
            onClick={() => void handleSubmit()}
            disabled={
              Boolean(validationError) ||
              submitting ||
              submitState === 'success' ||
              leadTimeWarnings.length > 0
            }
            // Lock min-width so the label crossfade between 'Book' /
            // 'Booking…' / 'Submit for approval' / 'Book + 3 services'
            // / 'Booked!' doesn't reflow the footer on every state flip.
            // emil pass: submit reflow is the biggest 'this app is
            // amateurish' tell. Success beat replaces background with
            // an emerald snap (no fade — the snap IS the signal) and
            // the icon zooms in 75ms after so the eye lands on the
            // color first, then watches the check resolve.
            className={cn(
              'min-w-[10rem]',
              submitState === 'success' &&
                'border-emerald-500/60 bg-emerald-500 text-white hover:bg-emerald-500',
            )}
          >
            {submitState === 'success' ? (
              <Check
                className="mr-1 size-4 delay-75 duration-200 ease-[var(--ease-snap)] animate-in zoom-in-75"
                aria-hidden
              />
            ) : submitting ? (
              <Loader2 className="mr-1 size-4 animate-spin" />
            ) : null}
            {submitState === 'success'
              ? isApprovalRoute
                ? 'Requested!'
                : state.additionalSpaceIds.length > 0
                  ? `Booked ${state.additionalSpaceIds.length + 1}!`
                  : 'Booked!'
              : submitting
                ? isApprovalRoute
                  ? 'Submitting…'
                  : 'Booking…'
                : leadTimeWarnings.length > 0
                  ? 'Resolve conflicts above'
                  : isApprovalRoute
                    ? 'Submit for approval'
                    : 'Book'}
          </Button>
        </div>
      </div>
      )}

    </FieldGroup>
  );
}

/** Re-export for consumers that pass through. */
export type { ComposerEntrySource, ComposerMode } from './state';

/** Trick to satisfy typecheck on the ComposerState type when the wrapper
 *  imports something. */
export type { ComposerState };

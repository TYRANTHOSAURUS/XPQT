import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AlertTriangle, CalendarClock, Loader2, MapPin, Sparkles } from 'lucide-react';
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
import { useCostCenters } from '@/api/cost-centers';
import { usePerson } from '@/api/persons';
import { formatCurrency } from '@/lib/format';
import { toastError, toastSuccess } from '@/lib/toast';
import { ServicePickerSheet } from './service-picker-sheet';
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
  estimateOccurrences,
  extractAlternatives,
  isoToLocalInput,
  nextQuarterHour,
} from './helpers';
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
  const submitting = createBooking.isPending || createMultiRoom.isPending;
  const [pickerOpen, setPickerOpen] = useState(false);

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

  // Lead-time pre-flight: surface a warning when a selected service's
  // lead_time_hours exceeds the gap between now and booking start. The
  // bundle service still enforces this on submit (rule resolver's
  // `lead_time_remaining_hours` gate); surfacing client-side gives the
  // user a chance to adjust the booking time or drop the line BEFORE
  // they hit "Book" and see a 422.
  const leadTimeWarnings = useMemo(() => {
    if (!state.startAt || state.services.length === 0) return [] as Array<{ name: string; needHours: number }>;
    const startMs = new Date(state.startAt).getTime();
    if (Number.isNaN(startMs)) return [];
    const hoursUntilStart = (startMs - Date.now()) / 3_600_000;
    // Only warn when start is in the future — past bookings are validation
    // errors handled elsewhere.
    if (hoursUntilStart <= 0) return [];
    return state.services
      .filter((s) => {
        // ServicePickerSheet's PickerSelection doesn't carry lead_time_hours
        // today — the picker tracks it on AvailableServiceItem. To avoid
        // re-fetching the catalog inside the composer, leverage the fact
        // that the picker has already applied lead-time visibility (lead-
        // time-violating items shouldn't appear). Until we plumb lead_time
        // onto PickerSelection, this warning fires only when lead_time
        // metadata exists on the selection (future expansion).
        const lead = (s as { lead_time_hours?: number | null }).lead_time_hours;
        return typeof lead === 'number' && lead > hoursUntilStart;
      })
      .map((s) => ({
        name: s.name,
        needHours: (s as { lead_time_hours?: number }).lead_time_hours ?? 0,
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
        reservationId = (result as { reservations?: Array<{ id: string }> })?.reservations?.[0]?.id;
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
      }
      toastSuccess(
        isApprovalRoute
          ? 'Approval requested'
          : effectiveState.additionalSpaceIds.length > 0
            ? `Booked ${effectiveState.additionalSpaceIds.length + 1} rooms`
            : 'Booked',
      );
      onOpenChange(false);
      if (reservationId) onBooked?.(reservationId);
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

      {/* Time + room recap */}
      <FieldSet>
        <FieldLegend variant="label">When + where</FieldLegend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr]">
          <Field>
            <FieldLabel htmlFor="composer-start">
              <CalendarClock className="size-3.5" />
              Start
            </FieldLabel>
            <Input
              id="composer-start"
              type="datetime-local"
              value={isoToLocalInput(state.startAt)}
              onChange={(e) => {
                const startIso = e.target.value
                  ? new Date(e.target.value).toISOString()
                  : null;
                if (!startIso || !state.endAt) {
                  dispatch({ type: 'SET_TIME', startAt: startIso, endAt: state.endAt });
                  return;
                }
                // Preserve duration when start moves.
                const oldStart = state.startAt ? new Date(state.startAt).getTime() : 0;
                const oldEnd = new Date(state.endAt).getTime();
                const dur = oldStart > 0 ? oldEnd - oldStart : 60 * 60_000;
                const endIso = new Date(new Date(startIso).getTime() + dur).toISOString();
                dispatch({ type: 'SET_TIME', startAt: startIso, endAt: endIso });
              }}
              className="h-10 tabular-nums"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="composer-end">End</FieldLabel>
            <Input
              id="composer-end"
              type="datetime-local"
              value={isoToLocalInput(state.endAt)}
              onChange={(e) => {
                const endIso = e.target.value
                  ? new Date(e.target.value).toISOString()
                  : null;
                dispatch({ type: 'SET_TIME', startAt: state.startAt, endAt: endIso });
              }}
              className="h-10 tabular-nums"
            />
          </Field>
        </div>
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

      {/* Services */}
      <FieldSet>
        <FieldLegend variant="label">Add to this booking</FieldLegend>
        <FieldDescription>
          Catering, AV, room setup. Optional. Each spawns a work order.
        </FieldDescription>
        {state.services.length === 0 ? (
          <Button
            type="button"
            variant="outline"
            className="h-10"
            onClick={() => setPickerOpen(true)}
            disabled={!state.spaceId || !onDate}
          >
            <Sparkles className="size-3.5" />
            Browse services
          </Button>
        ) : (
          <div className="rounded-md border bg-card divide-y">
            {state.services.map((s) => {
              // Template seeds carry a placeholder name + null unit_price
              // until the picker fetches the current menu offer. Render
              // those as a single "from template" chip rather than a
              // misleading "Template item × N · —".
              const isTemplateSeed = s.name === 'Template item' && s.unit_price == null;
              return (
                <div
                  key={s.catalog_item_id}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                >
                  <div className="min-w-0">
                    {isTemplateSeed ? (
                      <div className="text-sm italic text-muted-foreground">
                        From template — open picker to confirm
                      </div>
                    ) : (
                      <>
                        <div className="truncate text-sm font-medium">{s.name}</div>
                        <div className="text-[11px] text-muted-foreground">
                          × {s.quantity}
                        </div>
                      </>
                    )}
                  </div>
                  {!isTemplateSeed && (
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {formatCurrency(s.unit_price)}
                    </span>
                  )}
                </div>
              );
            })}
            <div className="flex items-center justify-between px-3 py-2">
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => setPickerOpen(true)}
                >
                  Edit
                </Button>
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {state.services.length} item{state.services.length !== 1 ? 's' : ''}
                </span>
              </div>
              <div className="flex items-baseline gap-2">
                {hasResolvedPricing ? (
                  <>
                    {annualisedOccurrences > 0 && annualisedTotal > 0 && (
                      <span
                        className="text-[11px] text-muted-foreground tabular-nums"
                        title={`${annualisedOccurrences} occurrences over the next year`}
                      >
                        est. {formatCurrency(annualisedTotal)}/yr
                      </span>
                    )}
                    <span className="text-sm font-semibold tabular-nums">
                      {formatCurrency(servicesTotal)}
                    </span>
                  </>
                ) : (
                  <Skeleton className="h-4 w-20" />
                )}
              </div>
            </div>
          </div>
        )}
      </FieldSet>

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

      {/* Approval-route banner. Same neutral/icon-tinted shape as the
          capacity warning so all four banner kinds (approval, capacity,
          lead-time, conflict) read as one family. Animate-in slide-from-
          top so warnings emerging mid-edit don't flicker. */}
      {isApprovalRoute && approvalDenialMessage && (
        <div className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-xs text-foreground duration-200 ease-[var(--ease-smooth)] animate-in fade-in slide-in-from-top-1">
          <Sparkles
            className="size-3.5 shrink-0 text-purple-700 dark:text-purple-400"
            aria-hidden
          />
          <span>{approvalDenialMessage}</span>
        </div>
      )}

      {/* Capacity warning — picked room is smaller than attendees. Soft
          (non-blocking; the user might know better than the listed
          capacity, e.g. standing-only event). One line, neutral type,
          color only on the icon — anything louder reads as a form error. */}
      {capacityWarning && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-xs text-foreground duration-200 ease-[var(--ease-smooth)] animate-in fade-in slide-in-from-top-1"
        >
          <AlertTriangle
            className="size-3.5 shrink-0 text-amber-700 dark:text-amber-400"
            aria-hidden
          />
          <span>
            <strong className="font-medium">Tight fit.</strong>{' '}
            {capacityWarning.roomName} seats {capacityWarning.roomCapacity}, you
            have {capacityWarning.attendees}.
          </span>
        </div>
      )}

      {/* Lead-time warnings — pre-empts a submit-time 422. Polite live
          region — these recompute on every attendee/service change and
          assertive role would re-announce noisily. */}
      {leadTimeWarnings.length > 0 && (
        <div
          role="status"
          aria-live="polite"
          className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-300 duration-200 ease-[var(--ease-smooth)] animate-in fade-in slide-in-from-top-1"
        >
          <p className="flex items-center gap-1 font-medium">
            <AlertTriangle className="size-3.5" />
            Some services need more notice
          </p>
          <ul className="space-y-0.5">
            {leadTimeWarnings.slice(0, 3).map((w) => (
              <li key={w.name}>
                {w.name} requires {w.needHours}h lead time. Move the meeting later or drop the line.
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Conflict alternatives — visible after a 409 race. Each row is a
          one-click rebook: dispatches SET_SPACE then re-submits without
          the user having to re-open the room picker. */}
      {conflictAlternatives.length > 0 && !fixedRoom && (
        <div
          role="alert"
          className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs duration-200 ease-[var(--ease-smooth)] animate-in fade-in slide-in-from-top-1"
        >
          <p className="font-medium text-destructive">
            Someone booked this slot before you. Try one of these:
          </p>
          <ul className="space-y-1">
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
                  className="flex w-full items-center justify-between gap-3 rounded px-2 py-1.5 text-left transition-colors hover:bg-destructive/10"
                  style={{
                    transitionDuration: '120ms',
                    transitionTimingFunction: 'var(--ease-snap)',
                  }}
                >
                  <span className="truncate font-medium">{alt.name}</span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {alt.capacity ?? '—'} cap
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="text-[10px] text-muted-foreground">
            Click any room above to rebook with the same time + services.
          </p>
        </div>
      )}
      {/* When fixedRoom is set (scheduler drag-create), one-click rebook
          would override the operator's deliberate cell pick — fall back to
          the read-only summary they had before. */}
      {conflictAlternatives.length > 0 && fixedRoom && (
        <div
          role="alert"
          className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs duration-200 ease-[var(--ease-smooth)] animate-in fade-in slide-in-from-top-1"
        >
          <p className="font-medium text-destructive">
            Someone booked this slot before you. Try one of these:
          </p>
          <ul className="space-y-1">
            {conflictAlternatives.slice(0, 3).map((alt) => (
              <li key={alt.space_id} className="flex justify-between">
                <span>{alt.name}</span>
                <span className="text-muted-foreground tabular-nums">
                  {alt.capacity ?? '—'} cap
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Footer: error + submit. Sticky on mobile so it's always
          reachable without scrolling through a long form (services +
          recurrence + warnings can push it well below the fold). The
          calling sheet/dialog wraps the composer in an overflow-y-auto
          container, so we pin to the bottom of THAT scroll context with
          `sticky bottom-0` and a bg/border so the form content scrolls
          underneath cleanly. No negative-margin bleed because the two
          mounts (Sheet px-5, Dialog p-4) have different paddings —
          codex flagged a 4px horizontal scroll trigger. Reverts to
          inline on sm+ (the desktop dialog isn't tall enough to need
          stickiness). pb honors iOS home-indicator safe area. */}
      <div className="flex flex-col gap-2 border-t bg-background/85 backdrop-blur-md pt-3 sm:border-t-0 sm:bg-transparent sm:backdrop-blur-none sm:pt-2
                      pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:pb-0
                      sticky bottom-0 sm:static -mx-4 px-4 sm:mx-0 sm:px-0">
        {/* Reserved-height slot prevents the footer from jumping 16px
            on every keystroke that flips validity. Always rendered;
            content swaps with fade. */}
        <p
          className="min-h-[1.25rem] text-xs text-amber-700 transition-opacity duration-150 ease-[var(--ease-smooth)] dark:text-amber-400"
          aria-live="polite"
        >
          {validationError ??
            (leadTimeWarnings.length > 0
              ? 'Resolve the lead-time conflicts above before submitting.'
              : '')}
        </p>
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={
              Boolean(validationError) ||
              submitting ||
              leadTimeWarnings.length > 0
            }
            // Lock min-width so the label crossfade between 'Book' /
            // 'Booking…' / 'Submit for approval' / 'Book + 3 services'
            // doesn't reflow the footer on every state flip. emil pass:
            // submit reflow is the biggest 'this app is amateurish' tell.
            className="min-w-[10rem]"
          >
            {submitting ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
            {submitting
              ? isApprovalRoute
                ? 'Submitting…'
                : 'Booking…'
              : isApprovalRoute
                ? 'Submit for approval'
                : state.services.length > 0
                  ? `Book + ${state.services.length} service${state.services.length === 1 ? '' : 's'}`
                  : 'Book'}
          </Button>
        </div>
      </div>

      <ServicePickerSheet
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        deliverySpaceId={state.spaceId}
        onDate={onDate}
        attendeeCount={state.attendeeCount}
        bookingStartAt={state.startAt}
        bookingEndAt={state.endAt}
        initialSelections={state.services}
        onConfirm={async (selections) => {
          dispatch({ type: 'SET_SERVICES', services: selections });
          setPickerOpen(false);
        }}
        title={state.services.length > 0 ? 'Edit services' : 'Add services'}
        subtitle="Defaults to your meeting time and attendee count."
      />
    </FieldGroup>
  );
}

/** Re-export for consumers that pass through. */
export type { ComposerEntrySource, ComposerMode } from './state';

/** Trick to satisfy typecheck on the ComposerState type when the wrapper
 *  imports something. */
export type { ComposerState };

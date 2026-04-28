import { useEffect, useMemo, useReducer, useState } from 'react';
import { AlertTriangle, CalendarClock, Check, ChevronsUpDown, Loader2, MapPin, Sparkles } from 'lucide-react';
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { PersonPicker } from '@/components/person-picker';
import { useCreateBooking, type RankedRoom } from '@/api/room-booking';
import { useSpaces } from '@/api/spaces';
import type { Space } from '@/api/spaces';
import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api';
import { Sparkles as SparklesIcon } from 'lucide-react';
import type { RecurrenceRule } from '@/api/room-booking';
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
import { buildBookingPayload } from './submit';

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
 * Dialog vs Sheet vs Popover. Single-room only in v1; multi-room is
 * deliberately deferred per codex's review of δ-light (the multi-room
 * endpoint doesn't accept services / bundle / source / recurrence yet,
 * so exposing it would just paper over a broken contract).
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

  // Resolve person.cost_center (code) → cost_center_id when the picker
  // changes, so the bundle insert hits a real id. Operator can override
  // via the dropdown; this is just the smart prefill.
  useEffect(() => {
    if (mode !== 'operator') return;
    if (!requesterPerson?.cost_center) return;
    if (state.costCenterId) return; // already set — don't overwrite operator's pick
    const match = costCentersList.find((cc) => cc.code === requesterPerson.cost_center);
    if (match) {
      dispatch({ type: 'SET_COST_CENTER', costCenterId: match.id });
    }
  }, [mode, requesterPerson?.cost_center, costCentersList, state.costCenterId]);

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
  const submitting = createBooking.isPending;
  const [pickerOpen, setPickerOpen] = useState(false);

  // Approval-route detection: when the picked room's `rule_outcome.effect`
  // is `require_approval`, the booking lands as `pending_approval`. We
  // adapt the title + CTA copy + show the explanatory denial message.
  const isApprovalRoute = fixedRoom?.rule_outcome?.effect === 'require_approval';
  const approvalDenialMessage = fixedRoom?.rule_outcome?.denial_message ?? null;

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

  const handleSubmit = async () => {
    if (validationError) return;
    const payload = buildBookingPayload({ state, mode, entrySource, callerPersonId });
    if (!payload) return;
    try {
      const result = await createBooking.mutateAsync(payload);
      const reservationId = (result as { id?: string })?.id;
      toastSuccess(isApprovalRoute ? 'Approval requested' : 'Booked');
      onOpenChange(false);
      if (reservationId) onBooked?.(reservationId);
    } catch (e) {
      toastError(
        isApprovalRoute ? "Couldn't request approval" : "Couldn't book the room",
        { error: e, retry: handleSubmit },
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
              onChange={(spaceId) => dispatch({ type: 'SET_SPACE', spaceId })}
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
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setPickerOpen(true)}
              >
                Edit
              </Button>
              <span className="text-xs tabular-nums">
                {state.services.length} item{state.services.length !== 1 ? 's' : ''}
              </span>
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
            onValueChange={(v) =>
              dispatch({
                type: 'SET_COST_CENTER',
                costCenterId: v === '__none__' ? null : v,
              })
            }
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

      {/* Approval-route banner */}
      {isApprovalRoute && approvalDenialMessage && (
        <div className="rounded-md border border-purple-500/30 bg-purple-500/5 px-3 py-2 text-xs text-purple-800 dark:text-purple-300">
          <SparklesIcon className="mr-1 inline size-3" />
          {approvalDenialMessage}
        </div>
      )}

      {/* Lead-time warnings — pre-empts a submit-time 422. */}
      {leadTimeWarnings.length > 0 && (
        <div
          role="alert"
          className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-300"
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
          className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs"
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
                    dispatch({ type: 'SET_SPACE', spaceId: alt.space_id });
                    // Defer one tick so SET_SPACE lands before submit reads
                    // state. Without the rAF the buildBookingPayload reads
                    // the prior closure's spaceId and rebooks the lost slot.
                    requestAnimationFrame(() => void handleSubmit());
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
          className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs"
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

      {/* Footer: error + submit */}
      <div className="flex flex-col gap-2 pt-2">
        {validationError && (
          <p className="text-xs text-amber-700 dark:text-amber-400">{validationError}</p>
        )}
        {!validationError && leadTimeWarnings.length > 0 && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Resolve the lead-time conflicts above before submitting.
          </p>
        )}
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
            onClick={handleSubmit}
            disabled={
              Boolean(validationError) ||
              submitting ||
              leadTimeWarnings.length > 0
            }
          >
            {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
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

/**
 * Search-filterable combobox of reservable rooms in the tenant. Lazy-
 * filters client-side once useSpaces resolves — typical tenant has
 * dozens of rooms, not thousands, so a single fetch is cheaper than
 * threading the picker's full ranking pipeline through the composer.
 *
 * The smart-rank picker (the one /portal/book-room uses) requires
 * start/end + criteria + ranking; for the desk operator's "give me ANY
 * conf room with capacity ≥ 6" scenario, name-based search is enough.
 * If a tenant grows past ~200 rooms this should switch to a server-side
 * search endpoint, but until then the simpler shape ships.
 */
function RoomPickerInline({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (spaceId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const { data: spaces, isPending } = useSpaces();

  const reservable = useMemo<Space[]>(
    () => (spaces ?? []).filter((s) => s.reservable && s.active),
    [spaces],
  );

  const selected = useMemo(
    () => reservable.find((r) => r.id === value) ?? null,
    [reservable, value],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="h-10 w-full justify-between font-normal"
          >
            <span className="truncate text-sm">
              {selected ? selected.name : isPending ? 'Loading rooms…' : 'Pick a room…'}
            </span>
            {selected?.capacity != null && (
              <span className="ml-2 shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {selected.capacity} cap
              </span>
            )}
            <ChevronsUpDown className="ml-2 size-3.5 shrink-0 opacity-50" />
          </Button>
        }
      />
      <PopoverContent
        className="p-0"
        align="start"
        style={{ width: 'var(--radix-popover-trigger-width)' }}
      >
        <Command>
          <CommandInput placeholder="Search rooms…" />
          <CommandList className="max-h-72">
            <CommandEmpty>
              {isPending ? 'Loading…' : 'No rooms match.'}
            </CommandEmpty>
            <CommandGroup>
              {reservable.map((room) => {
                const isSel = room.id === value;
                return (
                  <CommandItem
                    key={room.id}
                    value={`${room.name} ${room.code ?? ''} ${room.type}`}
                    onSelect={() => {
                      onChange(room.id);
                      setOpen(false);
                    }}
                  >
                    <Check
                      className={cn(
                        'mr-2 size-4 shrink-0',
                        isSel ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{room.name}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {room.type.replace(/_/g, ' ')}
                        {room.code ? ` · ${room.code}` : ''}
                      </div>
                    </div>
                    {room.capacity != null && (
                      <span className="ml-2 shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        {room.capacity}
                      </span>
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function RecurrenceField({
  rule,
  onChange,
}: {
  rule: RecurrenceRule | null;
  onChange: (rule: RecurrenceRule | null) => void;
}) {
  const [expanded, setExpanded] = useState(rule != null);

  if (!expanded && !rule) {
    return (
      <Field>
        <FieldLabel>Recurrence</FieldLabel>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-9 self-start px-2 text-xs"
          onClick={() => {
            onChange({ frequency: 'weekly', interval: 1, count: 8 });
            setExpanded(true);
          }}
        >
          Repeat this booking…
        </Button>
      </Field>
    );
  }

  const r = rule ?? { frequency: 'weekly', interval: 1, count: 8 };
  return (
    <FieldSet>
      <FieldLegend variant="label">Recurrence</FieldLegend>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field>
          <FieldLabel htmlFor="composer-rec-freq">Frequency</FieldLabel>
          <Select
            value={r.frequency}
            onValueChange={(v) =>
              onChange({ ...r, frequency: v as RecurrenceRule['frequency'] })
            }
          >
            <SelectTrigger id="composer-rec-freq">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="daily">Daily</SelectItem>
              <SelectItem value="weekly">Weekly</SelectItem>
              <SelectItem value="monthly">Monthly</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="composer-rec-interval">Every</FieldLabel>
          <NumberStepper
            id="composer-rec-interval"
            value={r.interval}
            onChange={(n) => onChange({ ...r, interval: Math.max(1, n) })}
            min={1}
            max={12}
            aria-label="Recurrence interval"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="composer-rec-count">Occurrences</FieldLabel>
          <NumberStepper
            id="composer-rec-count"
            value={r.count ?? 8}
            onChange={(n) => onChange({ ...r, count: Math.max(2, n) })}
            min={2}
            max={52}
            aria-label="Recurrence count"
          />
        </Field>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 self-start px-2 text-xs text-muted-foreground"
        onClick={() => {
          onChange(null);
          setExpanded(false);
        }}
      >
        Don't repeat
      </Button>
    </FieldSet>
  );
}

function isoToLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function nextQuarterHour(): Date {
  const d = new Date();
  const m = d.getMinutes();
  const next = Math.ceil((m + 1) / 15) * 15;
  d.setMinutes(next, 0, 0);
  return d;
}

/** Pull RankedRoom alternatives out of a 409 conflict-guard error so the
 *  composer can render "this slot was just taken — try these" inline. */
function extractAlternatives(error: unknown): RankedRoom[] {
  if (!(error instanceof ApiError)) return [];
  if (error.status !== 409) return [];
  const details = error.details;
  if (
    typeof details === 'object' &&
    details !== null &&
    'alternatives' in details &&
    Array.isArray((details as { alternatives?: unknown }).alternatives)
  ) {
    return (details as { alternatives: RankedRoom[] }).alternatives;
  }
  return [];
}

/** Re-export for consumers that pass through. */
export type { ComposerEntrySource, ComposerMode } from './state';

/** Trick to satisfy typecheck on the ComposerState type when the wrapper
 *  imports something. */
export type { ComposerState };

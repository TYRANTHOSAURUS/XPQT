import { useEffect, useMemo, useReducer, useState } from 'react';
import { CalendarClock, Loader2, MapPin, Sparkles } from 'lucide-react';
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
import { PersonPicker } from '@/components/person-picker';
import { useCreateBooking } from '@/api/room-booking';
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

  const handleSubmit = async () => {
    if (validationError) return;
    const payload = buildBookingPayload({ state, mode, entrySource, callerPersonId });
    if (!payload) return;
    try {
      const result = await createBooking.mutateAsync(payload);
      const reservationId = (result as { id?: string })?.id;
      toastSuccess('Booked');
      onOpenChange(false);
      if (reservationId) onBooked?.(reservationId);
    } catch (e) {
      toastError("Couldn't book the room", { error: e, retry: handleSubmit });
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
            <RoomFinderHint
              onPickRoom={() => {
                // For δ-light we hard-require the wrapper to pass a fixedRoom
                // OR to use the room-picker page. The composer doesn't yet
                // render an inline picker — Phase 2 (portal refactor) will
                // fold the room-finder in. For now, surface a hint.
              }}
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
            {state.services.map((s) => (
              <div
                key={s.catalog_item_id}
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{s.name}</div>
                  <div className="text-[11px] text-muted-foreground">
                    × {s.quantity}
                  </div>
                </div>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {formatCurrency(s.unit_price)}
                </span>
              </div>
            ))}
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

      {/* Footer: error + submit */}
      <div className="flex flex-col gap-2 pt-2">
        {validationError && (
          <p className="text-xs text-amber-700 dark:text-amber-400">{validationError}</p>
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
            disabled={Boolean(validationError) || submitting}
          >
            {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
            {submitting ? 'Booking…' : 'Book'}
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

function RoomFinderHint({ onPickRoom: _ }: { onPickRoom: () => void }) {
  return (
    <div className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      Use the room finder on{' '}
      <a className="underline decoration-dotted" href="/portal/book-room">
        /portal/book-room
      </a>
      , then come back here. Inline room search ships in the next slice.
    </div>
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

/** Re-export for consumers that pass through. */
export type { ComposerEntrySource, ComposerMode } from './state';

/** Trick to satisfy typecheck on the ComposerState type when the wrapper
 *  imports something. */
export type { ComposerState };

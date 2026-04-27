import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldSeparator,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCreateBooking, useMultiRoomBooking } from '@/api/room-booking';
import type {
  RankedRoom,
  RecurrenceRule,
  ServiceLinePayload,
} from '@/api/room-booking';
import { formatCurrency, formatFullTimestamp } from '@/lib/format';
import { toastError, toastSuccess } from '@/lib/toast';
import { Sparkles } from 'lucide-react';
import { ServiceSection, type ServiceSelection } from './service-section';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Primary room the user clicked Book on. */
  primaryRoom: RankedRoom | null;
  /** Optional additional rooms when in multi-room mode. */
  additionalRooms?: RankedRoom[];
  startAtIso: string;
  endAtIso: string;
  attendeeCount: number;
  /** Internal-attendee person ids (empty when the simple flow is used). */
  attendeePersonIds?: string[];
  /** Pre-existing recurrence rule (empty when the simple flow is used). */
  recurrenceRule?: RecurrenceRule | null;
  requesterPersonId: string;
  /**
   * Initially-expanded section based on which footer chip the user clicked.
   * Reserved for future use — Phase D ships every section in the dialog;
   * Phase G will collapse advanced sections and use this to auto-open one.
   */
  initialFocus?: 'identity' | 'attendees' | 'multi-room' | 'recurring';
  /**
   * Active bundle template id, when the user picked a template chip on
   * /portal/rooms. Forwarded to the backend so `bundle.template_id` lands
   * on the new bundle.
   */
  templateId?: string | null;
  /**
   * Template-defined service lines staged on the dialog open. Seeded as
   * pre-selected ServiceSelections without unit prices — the user expands
   * the section to confirm prices, but quantities show pre-filled.
   */
  templateServices?: Array<{
    catalog_item_id: string;
    menu_id?: string | null;
    quantity?: number;
    quantity_per_attendee?: number;
  }> | null;
  /** Default cost center carried in from the active template. */
  templateCostCenterId?: string | null;
  onBooked: () => void;
}

/**
 * Confirms a booking before submission. Per §4.3 we surface:
 *  - Identity (you / on-behalf — locked to current user in v1 portal)
 *  - Time + room recap
 *  - Internal attendees (read-only summary today; v1 portal sends the count)
 *  - Recurrence (Daily / Weekly + interval, end-after / end-by)
 *  - Multi-room recap
 *
 * Errors from the booking pipeline (deny / pending approval / 409 race)
 * surface as inline alerts that name the rule's `denial_message` per §4.10.
 */
export function BookingConfirmDialog({
  open,
  onOpenChange,
  primaryRoom,
  additionalRooms = [],
  startAtIso,
  endAtIso,
  attendeeCount,
  attendeePersonIds = [],
  recurrenceRule = null,
  requesterPersonId,
  initialFocus: _initialFocus,
  templateId = null,
  templateServices = null,
  templateCostCenterId = null,
  onBooked,
}: Props) {
  const [recurring, setRecurring] = useState<boolean>(Boolean(recurrenceRule));
  const [frequency, setFrequency] = useState<RecurrenceRule['frequency']>(
    recurrenceRule?.frequency ?? 'weekly',
  );
  const [interval, setIntervalValue] = useState<number>(recurrenceRule?.interval ?? 1);
  const [count, setCount] = useState<number>(recurrenceRule?.count ?? 8);

  // Service section state — three independent open/selection pairs so each
  // section fetches + caches its own item list per (location, on_date).
  const [cateringOpen, setCateringOpen] = useState(false);
  const [avOpen, setAvOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [cateringSelections, setCateringSelections] = useState<ServiceSelection[]>([]);
  const [avSelections, setAvSelections] = useState<ServiceSelection[]>([]);
  const [setupSelections, setSetupSelections] = useState<ServiceSelection[]>([]);

  // Re-seed every time the dialog opens with a new room (cancel-then-reopen
  // shouldn't carry stale recurrence picks or service selections). When a
  // bundle template is active, seed all three sections with the template's
  // pre-selected services — quantities show in the input so the user can
  // tweak before submitting; unit prices are filled in once they expand a
  // section and the lazy-fetch lands.
  //
  // The dependency list intentionally excludes `attendeeCount`: the
  // per-attendee multiplier is recomputed at submit time (see servicesPayload
  // below), so we don't wipe selections when the user changes the headcount
  // on the dialog. Including it here would re-seed (clearing manual tweaks)
  // every keystroke in the attendees field.
  useEffect(() => {
    if (!open) return;
    setRecurring(Boolean(recurrenceRule));
    setFrequency(recurrenceRule?.frequency ?? 'weekly');
    setIntervalValue(recurrenceRule?.interval ?? 1);
    setCount(recurrenceRule?.count ?? 8);

    const seeds = (templateServices ?? []).map<ServiceSelection>((s) => ({
      catalog_item_id: s.catalog_item_id,
      menu_id: s.menu_id ?? '',
      quantity:
        s.quantity_per_attendee != null
          ? Math.max(1, Math.round(s.quantity_per_attendee * Math.max(1, attendeeCount)))
          : (s.quantity ?? 1),
      unit_price: null, // resolved when the user expands the section
      unit: null,
      name: 'Template item',
    }));
    // For v1 every template service lands in the catering section as a
    // visual seed — the section component looks up by catalog_item_id when
    // the user expands it, so the qty input shows correctly there. We could
    // bucket by service_type with a second probe, but that adds a query
    // before the user even opens a section.
    setCateringOpen(seeds.length > 0);
    setAvOpen(false);
    setSetupOpen(false);
    setCateringSelections(seeds);
    setAvSelections([]);
    setSetupSelections([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- attendeeCount intentionally omitted
  }, [open, recurrenceRule, primaryRoom?.space_id, templateServices]);

  const createBooking = useCreateBooking();
  const multiBooking = useMultiRoomBooking();
  const submitting = createBooking.isPending || multiBooking.isPending;

  const isMultiRoom = additionalRooms.length > 0;
  const isApprovalRoute =
    primaryRoom?.rule_outcome?.effect === 'require_approval';

  const allServiceSelections = useMemo(
    () => [...cateringSelections, ...avSelections, ...setupSelections],
    [cateringSelections, avSelections, setupSelections],
  );
  const hasServices = allServiceSelections.length > 0;
  const servicesPayload = useMemo<ServiceLinePayload[]>(
    () =>
      allServiceSelections.map((s) => ({
        catalog_item_id: s.catalog_item_id,
        menu_id: s.menu_id,
        quantity: s.quantity,
      })),
    [allServiceSelections],
  );
  const servicesTotal = useMemo(
    () =>
      allServiceSelections.reduce((sum, s) => {
        if (s.unit_price == null) return sum;
        if (s.unit === 'flat_rate') return sum + s.unit_price;
        if (s.unit === 'per_person') {
          return sum + s.unit_price * s.quantity * Math.max(1, attendeeCount);
        }
        return sum + s.unit_price * s.quantity;
      }, 0),
    [allServiceSelections, attendeeCount],
  );
  const annualisedOccurrences = recurring ? estimateOccurrences(frequency, interval, count) : 0;
  const annualisedTotal = recurring ? servicesTotal * annualisedOccurrences : 0;

  // Service sections only render in single-room mode — composite multi-room
  // bookings need the sub-project 4 reception flow and we'd rather hide the
  // affordance entirely than half-support it.
  const showServiceSections = !isMultiRoom && Boolean(primaryRoom);

  const onConfirm = async () => {
    if (!primaryRoom) return;

    const recurrencePayload: RecurrenceRule | undefined = recurring
      ? { frequency, interval, count }
      : undefined;

    try {
      if (isMultiRoom) {
        // The multi-room endpoint atomically books a group of rooms but
        // does NOT yet support recurrence (by design — the conflict-guard
        // semantics for "atomic group across multiple occurrences" need
        // their own design). The recurrence toggle is hidden in the UI
        // when isMultiRoom, so this should never fire — but we defend
        // against future edits (parent prop + state interactions) by
        // failing loudly here rather than silently dropping the rule.
        if (recurring) {
          throw new Error(
            'Recurrence on multi-room bookings is not supported yet. Book a single room or turn off recurrence.',
          );
        }
        await multiBooking.mutateAsync({
          space_ids: [primaryRoom.space_id, ...additionalRooms.map((r) => r.space_id)],
          requester_person_id: requesterPersonId,
          start_at: startAtIso,
          end_at: endAtIso,
          attendee_count: attendeeCount,
          attendee_person_ids: attendeePersonIds.length ? attendeePersonIds : undefined,
        });
      } else {
        await createBooking.mutateAsync({
          space_id: primaryRoom.space_id,
          requester_person_id: requesterPersonId,
          start_at: startAtIso,
          end_at: endAtIso,
          attendee_count: attendeeCount,
          attendee_person_ids: attendeePersonIds.length ? attendeePersonIds : undefined,
          recurrence_rule: recurrencePayload,
          source: 'portal',
          services: servicesPayload.length > 0 ? servicesPayload : undefined,
          bundle:
            servicesPayload.length > 0
              ? {
                  bundle_type: 'meeting',
                  template_id: templateId ?? undefined,
                  cost_center_id: templateCostCenterId ?? undefined,
                }
              : undefined,
        });
      }
      toastSuccess(
        isApprovalRoute
          ? 'Approval requested'
          : hasServices
            ? `Booked · ${pluralize(servicesPayload.length, 'service')} added`
            : 'Booked',
      );
      onBooked();
      onOpenChange(false);
    } catch (e) {
      toastError(isApprovalRoute ? "Couldn't request approval" : "Couldn't book the room", {
        error: e,
        retry: onConfirm,
      });
    }
  };

  const denialFromRoom = primaryRoom?.rule_outcome?.denial_message;
  const conflictAlternatives = extractAlternatives(
    createBooking.error ?? multiBooking.error,
  );

  const onDate = startAtIso ? startAtIso.slice(0, 10) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isApprovalRoute ? 'Request approval to book' : 'Confirm booking'}
          </DialogTitle>
          <DialogDescription>
            {primaryRoom ? primaryRoom.name : '—'}
            {isMultiRoom ? ` and ${additionalRooms.length} more ${additionalRooms.length === 1 ? 'room' : 'rooms'}` : ''}
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="confirm-when">When</FieldLabel>
            <Input
              id="confirm-when"
              readOnly
              value={`${formatHuman(startAtIso)} → ${formatHuman(endAtIso)}`}
              className="text-sm tabular-nums"
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="confirm-attendees">Attendees</FieldLabel>
            <Input
              id="confirm-attendees"
              readOnly
              value={`${attendeeCount} ${attendeeCount === 1 ? 'person' : 'people'}${attendeePersonIds.length ? ` · ${attendeePersonIds.length} internal` : ''}`}
            />
            {attendeePersonIds.length > 0 && (
              <FieldDescription>
                Internal attendees see the booking on their calendar.
              </FieldDescription>
            )}
          </Field>

          {isApprovalRoute && denialFromRoom && (
            <div className="rounded-md border border-purple-500/30 bg-purple-500/5 px-3 py-2 text-xs text-purple-800 dark:text-purple-300">
              <Sparkles className="mr-1 inline size-3" />
              {denialFromRoom}
            </div>
          )}

          {isMultiRoom && (
            <FieldSet>
              <FieldLegend variant="label">Rooms in this booking</FieldLegend>
              <FieldDescription>
                All rooms book atomically — if one fails the whole group rolls back.
              </FieldDescription>
              <ul className="space-y-1 text-xs">
                {[primaryRoom, ...additionalRooms].filter(Boolean).map((r) => (
                  <li
                    key={r!.space_id}
                    className="flex items-center justify-between rounded-md border bg-card px-2 py-1.5"
                  >
                    <span>{r!.name}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {r!.capacity ?? '—'} cap
                    </span>
                  </li>
                ))}
              </ul>
            </FieldSet>
          )}

          {showServiceSections && (
            <>
              <FieldSeparator />
              <FieldSet>
                <FieldLegend variant="label">Add to this booking</FieldLegend>
                <FieldDescription>
                  Optional. Catering, AV, or room setup — each spawns a work order on submit.
                </FieldDescription>
                <div className="space-y-2">
                  <ServiceSection
                    serviceType="catering"
                    title="Catering"
                    description="Food & drinks"
                    open={cateringOpen}
                    onOpenChange={setCateringOpen}
                    deliverySpaceId={primaryRoom?.space_id ?? null}
                    onDate={onDate}
                    attendeeCount={attendeeCount}
                    selections={cateringSelections}
                    onChangeSelections={setCateringSelections}
                  />
                  <ServiceSection
                    serviceType="av_equipment"
                    title="AV / equipment"
                    description="Projectors, mics, screens"
                    open={avOpen}
                    onOpenChange={setAvOpen}
                    deliverySpaceId={primaryRoom?.space_id ?? null}
                    onDate={onDate}
                    attendeeCount={attendeeCount}
                    selections={avSelections}
                    onChangeSelections={setAvSelections}
                  />
                  <ServiceSection
                    serviceType="facilities_services"
                    title="Room setup"
                    description="Layout, tables, signage"
                    open={setupOpen}
                    onOpenChange={setSetupOpen}
                    deliverySpaceId={primaryRoom?.space_id ?? null}
                    onDate={onDate}
                    attendeeCount={attendeeCount}
                    selections={setupSelections}
                    onChangeSelections={setSetupSelections}
                  />
                </div>
                {hasServices && (
                  <div className="mt-3 flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2 text-sm">
                    <span className="text-muted-foreground">
                      {pluralize(allServiceSelections.length, 'service line')} ·{' '}
                      <span className="tabular-nums">{formatCurrency(servicesTotal)}</span>
                      {recurring && annualisedOccurrences > 0 ? (
                        <span
                          className="ml-2 text-xs text-muted-foreground"
                          title={`${annualisedOccurrences} occurrences over the next year`}
                        >
                          · {formatCurrency(annualisedTotal)} annualised
                        </span>
                      ) : null}
                    </span>
                  </div>
                )}
              </FieldSet>
              <FieldSeparator />
              <FieldSet>
                <FieldLegend variant="label">Recurrence</FieldLegend>
                <Field orientation="horizontal">
                  <Switch
                    id="confirm-recurring"
                    checked={recurring}
                    onCheckedChange={setRecurring}
                  />
                  <FieldLabel htmlFor="confirm-recurring" className="font-normal">
                    Make this a recurring booking
                  </FieldLabel>
                </Field>

                {recurring && (
                  <div className="grid grid-cols-3 gap-2">
                    <Field>
                      <FieldLabel htmlFor="confirm-recur-freq">Repeats</FieldLabel>
                      <Select
                        value={frequency}
                        onValueChange={(v) => setFrequency(v as RecurrenceRule['frequency'])}
                      >
                        <SelectTrigger id="confirm-recur-freq">
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
                      <FieldLabel htmlFor="confirm-recur-interval">Every</FieldLabel>
                      <Input
                        id="confirm-recur-interval"
                        type="number"
                        min={1}
                        max={12}
                        value={interval}
                        onChange={(e) =>
                          setIntervalValue(Math.max(1, Number(e.target.value || 1)))
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="confirm-recur-count">Occurrences</FieldLabel>
                      <Input
                        id="confirm-recur-count"
                        type="number"
                        min={1}
                        max={365}
                        value={count}
                        onChange={(e) =>
                          setCount(Math.max(1, Number(e.target.value || 1)))
                        }
                      />
                    </Field>
                  </div>
                )}
              </FieldSet>
            </>
          )}

          {conflictAlternatives.length > 0 && (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs space-y-2"
            >
              <p className="font-medium text-destructive">
                Someone booked this slot before you. Try one of these:
              </p>
              <ul className="space-y-1">
                {conflictAlternatives.slice(0, 3).map((alt) => (
                  <li key={alt.space_id} className="flex justify-between">
                    <span>{alt.name}</span>
                    <span className="text-muted-foreground">
                      {alt.capacity ?? '—'} cap
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={submitting || !primaryRoom}>
            {submitting
              ? 'Submitting…'
              : isApprovalRoute
                ? 'Submit for approval'
                : isMultiRoom
                  ? 'Book all rooms'
                  : 'Confirm booking'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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

function formatHuman(iso: string): string {
  if (!iso) return '—';
  return formatFullTimestamp(iso) || '—';
}

function pluralize(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/**
 * Mirrors the backend's `estimateAnnualisedOccurrences`. Inline so the
 * dialog can preview annualised cost without an extra round-trip — the
 * canonical number comes from `CostService.computeBundleCost` after the
 * bundle lands.
 */
function estimateOccurrences(
  frequency: RecurrenceRule['frequency'],
  interval: number,
  count: number,
): number {
  if (count > 0) return count;
  const safeInterval = Math.max(1, interval);
  switch (frequency) {
    case 'daily':
      return Math.floor(365 / safeInterval);
    case 'weekly':
      return Math.floor(52 / safeInterval);
    case 'monthly':
      return Math.floor(12 / safeInterval);
    default:
      return 0;
  }
}

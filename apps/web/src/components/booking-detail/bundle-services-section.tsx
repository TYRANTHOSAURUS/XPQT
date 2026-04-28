import { useId, useMemo, useState } from 'react';
import { CheckCircle2, Clock, Radio, Truck, Pencil, Plus, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  useBundle,
  useCancelBundleLine,
  useEditBundleLine,
  type BundleLine,
} from '@/api/booking-bundles';
import { useAttachReservationServices, type Reservation } from '@/api/room-booking';
import {
  ServicePickerSheet,
  type PickerSelection,
} from '@/components/booking-composer/service-picker-sheet';
import { formatCurrency, formatTimeShort } from '@/lib/format';
import { toastError, toastRemoved, toastSuccess, toastUpdated } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useRealtimeBundle } from './use-realtime-bundle';

const FULFILLED = new Set<NonNullable<BundleLine['fulfillment_status']>>([
  'confirmed',
  'preparing',
  'delivered',
]);
const FROZEN_FOR_EDIT = new Set<NonNullable<BundleLine['fulfillment_status']>>([
  'preparing',
  'delivered',
  'cancelled',
]);

interface Props {
  reservation: Reservation;
  /** True when the requester / host / admin is viewing — gates +/edit/cancel buttons. */
  canEdit: boolean;
}

/**
 * Services attached to a booking. Two states:
 *
 *   1. **No bundle yet** — booking was made without services. Renders an
 *      empty-state row with a "+ Add services" CTA that opens the picker
 *      sheet and lazy-creates the bundle on confirm.
 *   2. **Bundle exists** — renders each line with its fulfillment status,
 *      service window, per-line cost, an inline Pencil → edit affordance
 *      (qty stepper + window pickers), and a Cancel-line affordance. The
 *      header gains a "+ Add more" button that opens the same picker.
 *
 * The picker sheet is shared across this component and the future booking
 * composer; mobile-bottom-sheet rendering comes from the sheet primitive.
 */
export function BundleServicesSection({ reservation, canEdit }: Props) {
  const bundleId = reservation.booking_bundle_id;
  const onDate = reservation.start_at.slice(0, 10);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [editingLineId, setEditingLineId] = useState<string | null>(null);
  const [confirmingLine, setConfirmingLine] = useState<BundleLine | null>(null);

  const attach = useAttachReservationServices(reservation.id);

  const handleAdd = async (selections: PickerSelection[]) => {
    try {
      await attach.mutateAsync({
        services: selections.map((s) => ({
          catalog_item_id: s.catalog_item_id,
          menu_id: s.menu_id,
          quantity: s.quantity,
          service_window_start_at: s.service_window_start_at ?? null,
          service_window_end_at: s.service_window_end_at ?? null,
        })),
      });
      toastSuccess(
        selections.length === 1
          ? `${selections[0].name} added`
          : `${selections.length} services added`,
      );
      setPickerOpen(false);
    } catch (e) {
      toastError("Couldn't add services", { error: e, retry: () => handleAdd(selections) });
    }
  };

  // No bundle yet — empty-state with CTA.
  if (!bundleId) {
    if (!canEdit) return null;
    return (
      <>
        <div className="border-t">
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="group flex w-full items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-accent/30"
            style={{ transitionDuration: '120ms', transitionTimingFunction: 'var(--ease-snap)' }}
          >
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10">
              <Sparkles className="size-4 text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">Add services</div>
              <div className="text-xs text-muted-foreground">
                Catering, AV, supplies, or anything else for this booking.
              </div>
            </div>
            <Plus className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          </button>
        </div>

        <ServicePickerSheet
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          deliverySpaceId={reservation.space_id}
          onDate={onDate}
          attendeeCount={reservation.attendee_count ?? 1}
          bookingStartAt={reservation.start_at}
          bookingEndAt={reservation.end_at}
          onConfirm={handleAdd}
          submitting={attach.isPending}
          subtitle="Defaults to your meeting time and attendee count."
        />
      </>
    );
  }

  return (
    <BundleServicesContent
      reservation={reservation}
      bundleId={bundleId}
      canEdit={canEdit}
      pickerOpen={pickerOpen}
      onPickerOpenChange={setPickerOpen}
      onAddServices={handleAdd}
      addPending={attach.isPending}
      editingLineId={editingLineId}
      onEditingLineIdChange={setEditingLineId}
      confirmingLine={confirmingLine}
      onConfirmingLineChange={setConfirmingLine}
    />
  );
}

interface ContentProps {
  reservation: Reservation;
  bundleId: string;
  canEdit: boolean;
  pickerOpen: boolean;
  onPickerOpenChange: (open: boolean) => void;
  onAddServices: (selections: PickerSelection[]) => Promise<void>;
  addPending: boolean;
  editingLineId: string | null;
  onEditingLineIdChange: (id: string | null) => void;
  confirmingLine: BundleLine | null;
  onConfirmingLineChange: (line: BundleLine | null) => void;
}

function BundleServicesContent({
  reservation,
  bundleId,
  canEdit,
  pickerOpen,
  onPickerOpenChange,
  onAddServices,
  addPending,
  editingLineId,
  onEditingLineIdChange,
  confirmingLine,
  onConfirmingLineChange,
}: ContentProps) {
  const onDate = reservation.start_at.slice(0, 10);
  const { data, isLoading, error } = useBundle(bundleId);
  const cancelLine = useCancelBundleLine(bundleId);
  const editLine = useEditBundleLine(bundleId, reservation.id);

  // Live status updates: keep the section's status pills + service windows
  // fresh while the user looks at it. The picker / detail page are the
  // surfaces most likely to be open while a vendor advances a line through
  // ordered → confirmed → preparing → delivered.
  const orderIds = useMemo(
    () => (data?.orders ?? []).map((o) => o.id),
    [data?.orders],
  );
  useRealtimeBundle(bundleId, orderIds, { enabled: orderIds.length > 0 });

  if (isLoading) {
    return <div className="border-t px-5 py-3 text-xs text-muted-foreground">Loading services…</div>;
  }

  if (error) {
    return (
      <div className="border-t px-5 py-3 text-xs text-destructive">
        Couldn't load services: {(error as Error).message}
      </div>
    );
  }

  if (!data) return null;

  const lines = data.lines ?? [];
  if (lines.length === 0 && !canEdit) return null;

  const total = lines.reduce(
    (sum, l) => sum + (l.line_total != null && Number.isFinite(l.line_total) ? Number(l.line_total) : 0),
    0,
  );

  const handleConfirmCancel = async () => {
    if (!confirmingLine) return;
    try {
      await cancelLine.mutateAsync({ lineId: confirmingLine.id });
      toastRemoved('Service line', { verb: 'cancelled' });
      onConfirmingLineChange(null);
    } catch (err) {
      toastError("Couldn't cancel line", { error: err });
    }
  };

  return (
    <div className="border-t">
      <div className="flex items-center justify-between gap-3 px-5 pt-3 pb-1">
        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Services ({lines.length})
          </span>
          {orderIds.length > 0 && (
            <span
              className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-emerald-700 dark:text-emerald-400"
              title="Status updates arrive automatically while this view is open"
            >
              <Radio className="size-3 animate-pulse" aria-hidden />
              Live
            </span>
          )}
        </div>
        {canEdit && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => onPickerOpenChange(true)}
          >
            <Plus className="size-3.5" />
            Add more
          </Button>
        )}
      </div>

      <ul className="px-5 pb-2">
        {lines.map((line) => (
          <ServiceLineRow
            key={line.id}
            line={line}
            canEdit={canEdit}
            editing={editingLineId === line.id}
            onStartEdit={() => onEditingLineIdChange(line.id)}
            onCancelEdit={() => onEditingLineIdChange(null)}
            onSaveEdit={async (patch) => {
              try {
                await editLine.mutateAsync({ lineId: line.id, patch });
                toastUpdated('Service line');
                onEditingLineIdChange(null);
              } catch (err) {
                toastError("Couldn't update line", { error: err });
              }
            }}
            saving={editLine.isPending}
            onRequestCancel={() => onConfirmingLineChange(line)}
          />
        ))}
      </ul>

      <div className="flex items-center justify-between px-5 py-2 text-xs text-muted-foreground">
        <span>Status: {prettyBundleStatus(data.status_rollup)}</span>
        <span className="tabular-nums">{formatCurrency(total)}</span>
      </div>

      <ConfirmDialog
        open={confirmingLine !== null}
        onOpenChange={(open) => !open && onConfirmingLineChange(null)}
        title={`Cancel "${confirmingLine?.catalog_item_name ?? 'this service'}"?`}
        description="The work-order ticket and any reserved asset will be cancelled too. This cannot be undone."
        confirmLabel="Cancel line"
        destructive
        onConfirm={handleConfirmCancel}
      />

      <ServicePickerSheet
        open={pickerOpen}
        onOpenChange={onPickerOpenChange}
        deliverySpaceId={reservation.space_id}
        onDate={onDate}
        attendeeCount={reservation.attendee_count ?? 1}
        bookingStartAt={reservation.start_at}
        bookingEndAt={reservation.end_at}
        onConfirm={onAddServices}
        submitting={addPending}
        title="Add services"
        subtitle="Defaults to your meeting time and attendee count."
      />
    </div>
  );
}

interface ServiceLineRowProps {
  line: BundleLine;
  canEdit: boolean;
  editing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: (patch: {
    quantity?: number;
    service_window_start_at?: string | null;
    service_window_end_at?: string | null;
  }) => Promise<void>;
  saving: boolean;
  onRequestCancel: () => void;
}

function ServiceLineRow({
  line,
  canEdit,
  editing,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  saving,
  onRequestCancel,
}: ServiceLineRowProps) {
  const status = line.fulfillment_status ?? 'ordered';
  const isFulfilled = FULFILLED.has(status);
  const isCancelled = status === 'cancelled';
  const canEditThisLine = canEdit && !FROZEN_FOR_EDIT.has(status);
  const canCancelThisLine = canEdit && !isCancelled && !isFulfilled;

  if (editing) {
    return (
      <li className="flex flex-col gap-3 border-b py-3 last:border-b-0">
        <ServiceLineEditor
          line={line}
          saving={saving}
          onSave={onSaveEdit}
          onCancel={onCancelEdit}
        />
      </li>
    );
  }

  return (
    <li className="group/line flex items-start gap-3 border-b py-2 last:border-b-0">
      <FulfillmentIcon status={status} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span
            className={cn(
              'truncate text-sm font-medium',
              isCancelled && 'line-through text-muted-foreground',
            )}
          >
            {line.catalog_item_name ?? 'Service item'} × {line.quantity}
          </span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {formatCurrency(line.line_total)}
          </span>
        </div>
        <div className="text-[11px] text-muted-foreground">
          {prettyStatus(status)}
          {line.service_window_start_at && (
            <span className="ml-2 tabular-nums">
              · {formatTimeShort(line.service_window_start_at)}
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {canEditThisLine && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Edit this line"
            className="size-7 opacity-0 group-hover/line:opacity-100 focus-visible:opacity-100 text-muted-foreground hover:text-foreground"
            onClick={onStartEdit}
          >
            <Pencil className="size-3.5" />
          </Button>
        )}
        {canCancelThisLine ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Cancel this line"
            className="size-7 opacity-0 group-hover/line:opacity-100 focus-visible:opacity-100 text-muted-foreground hover:text-destructive"
            onClick={onRequestCancel}
          >
            <X className="size-4" />
          </Button>
        ) : isFulfilled ? (
          <span
            className="text-[10px] uppercase tracking-wider text-muted-foreground"
            title="Already fulfilled — contact the fulfillment team to change"
          >
            Fulfilled
          </span>
        ) : null}
      </div>
    </li>
  );
}

function ServiceLineEditor({
  line,
  saving,
  onSave,
  onCancel,
}: {
  line: BundleLine;
  saving: boolean;
  onSave: (patch: {
    quantity?: number;
    service_window_start_at?: string | null;
    service_window_end_at?: string | null;
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const [qty, setQty] = useState(line.quantity);
  const [start, setStart] = useState(toLocalDateTimeInput(line.service_window_start_at));
  const [end, setEnd] = useState(toLocalDateTimeInput(line.service_window_end_at));

  const submit = async () => {
    const patch: {
      quantity?: number;
      service_window_start_at?: string | null;
      service_window_end_at?: string | null;
    } = {};
    if (qty !== line.quantity && qty >= 1) patch.quantity = qty;
    const startIso = start ? new Date(start).toISOString() : null;
    const endIso = end ? new Date(end).toISOString() : null;
    if (startIso !== line.service_window_start_at) patch.service_window_start_at = startIso;
    if (endIso !== line.service_window_end_at) patch.service_window_end_at = endIso;
    if (Object.keys(patch).length === 0) {
      onCancel();
      return;
    }
    await onSave(patch);
  };

  const reactId = useId();
  const qtyId = `${reactId}-qty`;
  const startId = `${reactId}-start`;
  const endId = `${reactId}-end`;

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">
          {line.catalog_item_name ?? 'Service item'}
        </span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={onCancel}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-7 px-3 text-xs"
            onClick={submit}
            disabled={saving || qty < 1}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
      <FieldGroup
        data-slot="field-group"
        className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-3"
      >
        <FieldDescription className="col-span-full -mb-1 text-[10px] uppercase tracking-wider">
          Times shown in your browser's timezone ({browserTimezone()}). Save will store
          this exact wall-clock instant in UTC on the booking.
        </FieldDescription>
        <Field>
          <FieldLabel
            htmlFor={qtyId}
            className="text-[11px] uppercase tracking-wider text-muted-foreground"
          >
            Quantity
          </FieldLabel>
          <Input
            id={qtyId}
            type="number"
            min={1}
            step={1}
            value={qty}
            onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
            className="h-11 text-sm tabular-nums sm:h-9"
          />
        </Field>
        <Field>
          <FieldLabel
            htmlFor={startId}
            className="text-[11px] uppercase tracking-wider text-muted-foreground"
          >
            Start
          </FieldLabel>
          <Input
            id={startId}
            type="datetime-local"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className="h-11 text-sm tabular-nums sm:h-9"
          />
        </Field>
        <Field>
          <FieldLabel
            htmlFor={endId}
            className="text-[11px] uppercase tracking-wider text-muted-foreground"
          >
            End
          </FieldLabel>
          <Input
            id={endId}
            type="datetime-local"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className="h-11 text-sm tabular-nums sm:h-9"
          />
        </Field>
      </FieldGroup>
    </>
  );
}

/** Resolve the browser's IANA timezone, e.g. "Europe/Amsterdam". Falls
 *  back to the abbreviation if the runtime can't expose the IANA name. */
function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
  } catch {
    return 'local';
  }
}

/**
 * Convert an ISO timestamp to the local string `<input type="datetime-local">`
 * expects (YYYY-MM-DDTHH:mm). Empty string for null. Browser-local tz —
 * cross-tz editing is a known v1 limitation; the editor surfaces the
 * caller's tz inline so a NL booking edited from US shows "3:00 AM your
 * time = 9:00 AM Amsterdam" rather than silently mis-saving. Phase F's
 * tz-aware picker will replace this.
 */
function toLocalDateTimeInput(iso: string | null): string {
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

function FulfillmentIcon({
  status,
}: {
  status: NonNullable<BundleLine['fulfillment_status']>;
}) {
  switch (status) {
    case 'delivered':
      return <CheckCircle2 className="mt-0.5 size-4 text-emerald-600" />;
    case 'cancelled':
      return <X className="mt-0.5 size-4 text-muted-foreground" />;
    case 'preparing':
    case 'confirmed':
      return <Truck className="mt-0.5 size-4 text-amber-600" />;
    case 'ordered':
    default:
      return <Clock className="mt-0.5 size-4 text-muted-foreground" />;
  }
}

function prettyStatus(status: NonNullable<BundleLine['fulfillment_status']>): string {
  switch (status) {
    case 'ordered':
      return 'Ordered';
    case 'confirmed':
      return 'Confirmed';
    case 'preparing':
      return 'Preparing';
    case 'delivered':
      return 'Delivered';
    case 'cancelled':
      return 'Cancelled';
    default:
      return 'Pending';
  }
}

function prettyBundleStatus(rollup: string): string {
  switch (rollup) {
    case 'pending_approval':
      return 'Awaiting approval';
    case 'partially_cancelled':
      return 'Partially cancelled';
    case 'cancelled':
      return 'Cancelled';
    case 'completed':
      return 'Completed';
    case 'confirmed':
    default:
      return 'Confirmed';
  }
}

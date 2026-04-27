import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
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
import { Switch } from '@/components/ui/switch';
import { DateTimePicker } from '@/components/ui/date-time-picker';
import { SpaceSelect } from '@/components/space-select';
import { useCreateStandaloneOrder } from '@/api/orders';
import { useCostCenters } from '@/api/cost-centers';
import { ServiceSection, type ServiceSelection } from '@/pages/portal/book-room/components/service-section';
import { formatCurrency } from '@/lib/format';
import { toastError, toastSuccess } from '@/lib/toast';

/**
 * `/portal/order` — services-only order flow. No reservation; the bundle
 * lands as `primary_reservation_id=null`. Common shapes:
 *   - Office party catering for the breakroom
 *   - Weekly snack delivery
 *   - Equipment loan for an off-site demo
 *
 * Recurrence is forward-compat in v1 (the column ships, the toggle is
 * disabled with "Coming soon"). When sub-project 2.5 generalises the
 * recurrence engine, lift this toggle without a schema migration.
 */
export function PortalOrderPage() {
  const navigate = useNavigate();
  const createStandalone = useCreateStandaloneOrder();

  const [deliverySpaceId, setDeliverySpaceId] = useState<string>('');
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState<string>(today);
  const [startTime, setStartTime] = useState<string>('09:00');
  const [endTime, setEndTime] = useState<string>('10:00');

  const [cateringOpen, setCateringOpen] = useState(false);
  const [avOpen, setAvOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [cateringSelections, setCateringSelections] = useState<ServiceSelection[]>([]);
  const [avSelections, setAvSelections] = useState<ServiceSelection[]>([]);
  const [setupSelections, setSetupSelections] = useState<ServiceSelection[]>([]);
  const [costCenterId, setCostCenterId] = useState<string>('');
  const { data: costCenters } = useCostCenters({ active: true });

  // Reset selections when the location changes — different location =
  // different menus = different items.
  useEffect(() => {
    setCateringOpen(false);
    setAvOpen(false);
    setSetupOpen(false);
    setCateringSelections([]);
    setAvSelections([]);
    setSetupSelections([]);
  }, [deliverySpaceId]);

  const startAtIso = useMemo(() => combineIso(date, startTime), [date, startTime]);
  const endAtIso = useMemo(() => combineIso(date, endTime), [date, endTime]);

  const allSelections = [...cateringSelections, ...avSelections, ...setupSelections];
  const total = useMemo(
    () =>
      allSelections.reduce((sum, s) => {
        if (s.unit_price == null) return sum;
        if (s.unit === 'flat_rate') return sum + s.unit_price;
        // Standalone orders have no attendee count yet — `per_person` falls
        // back to quantity × unit_price (the picker can ask for an attendee
        // count when the user selects a per_person item; future work).
        return sum + s.unit_price * s.quantity;
      }, 0),
    [allSelections],
  );

  const canSubmit =
    Boolean(deliverySpaceId) &&
    Boolean(startAtIso) &&
    Boolean(endAtIso) &&
    allSelections.length > 0 &&
    Date.parse(endAtIso) > Date.parse(startAtIso);

  const onSubmit = async () => {
    if (!canSubmit) return;
    try {
      await createStandalone.mutateAsync({
        delivery_space_id: deliverySpaceId,
        requested_for_start_at: startAtIso,
        requested_for_end_at: endAtIso,
        cost_center_id: costCenterId || null,
        lines: allSelections.map((s) => ({
          catalog_item_id: s.catalog_item_id,
          menu_id: s.menu_id,
          quantity: s.quantity,
        })),
      });
      toastSuccess('Order placed', {
        action: { label: 'View requests', onClick: () => navigate('/portal/requests') },
      });
      navigate('/portal/requests');
    } catch (err) {
      toastError("Couldn't place order", { error: err, retry: onSubmit });
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Place an order</h1>
        <p className="text-sm text-muted-foreground">
          Order catering, equipment, or setup without booking a room.
        </p>
      </header>

      <FieldGroup>
        <FieldSet>
          <FieldLegend variant="label">Where</FieldLegend>
          <FieldDescription>Drop-off location for this order.</FieldDescription>
          <Field>
            <FieldLabel htmlFor="order-location">Location</FieldLabel>
            <SpaceSelect
              id="order-location"
              value={deliverySpaceId}
              onChange={setDeliverySpaceId}
              typeFilter={['site', 'building', 'floor', 'room']}
              placeholder="Pick a location"
              emptyLabel={null}
            />
          </Field>
        </FieldSet>

        <FieldSeparator />

        <FieldSet>
          <FieldLegend variant="label">When</FieldLegend>
          <FieldDescription>Delivery / service window.</FieldDescription>
          <Field>
            <FieldLabel htmlFor="order-date">Date</FieldLabel>
            <DateTimePicker
              id="order-date"
              date={date}
              time={startTime}
              onDateChange={setDate}
              onTimeChange={setStartTime}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="order-end">Ends</FieldLabel>
            <Input
              id="order-end"
              type="time"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              step={300}
              className="tabular-nums"
            />
            {endTime <= startTime && (
              <FieldError>End time must be after start time.</FieldError>
            )}
          </Field>
        </FieldSet>

        <FieldSeparator />

        <FieldSet>
          <FieldLegend variant="label">Order</FieldLegend>
          <FieldDescription>Pick items from one or more sections below.</FieldDescription>
          <div className="space-y-2">
            <ServiceSection
              serviceType="catering"
              title="Catering"
              description="Food & drinks"
              open={cateringOpen}
              onOpenChange={setCateringOpen}
              deliverySpaceId={deliverySpaceId || null}
              onDate={date}
              attendeeCount={1}
              selections={cateringSelections}
              onChangeSelections={setCateringSelections}
            />
            <ServiceSection
              serviceType="av_equipment"
              title="AV / equipment"
              description="Projectors, mics, screens"
              open={avOpen}
              onOpenChange={setAvOpen}
              deliverySpaceId={deliverySpaceId || null}
              onDate={date}
              attendeeCount={1}
              selections={avSelections}
              onChangeSelections={setAvSelections}
            />
            <ServiceSection
              serviceType="facilities_services"
              title="Setup / services"
              description="Layout, signage, on-site help"
              open={setupOpen}
              onOpenChange={setSetupOpen}
              deliverySpaceId={deliverySpaceId || null}
              onDate={date}
              attendeeCount={1}
              selections={setupSelections}
              onChangeSelections={setSetupSelections}
            />
          </div>
          {allSelections.length > 0 && (
            <div className="mt-3 flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2 text-sm">
              <span className="text-muted-foreground">
                {allSelections.length} item{allSelections.length === 1 ? '' : 's'}
              </span>
              <span className="font-medium tabular-nums">{formatCurrency(total)}</span>
            </div>
          )}
        </FieldSet>

        {(costCenters?.length ?? 0) > 0 && (
          <>
            <FieldSeparator />
            <FieldSet>
              <FieldLegend variant="label">Cost center</FieldLegend>
              <FieldDescription>
                Optional GL chargeback. Approval routing for cost-center-driven rules uses the
                cost center's default approver.
              </FieldDescription>
              <Field>
                <FieldLabel htmlFor="order-cost-center">Cost center</FieldLabel>
                <Select
                  value={costCenterId || '__none__'}
                  onValueChange={(v) => setCostCenterId(!v || v === '__none__' ? '' : v)}
                >
                  <SelectTrigger id="order-cost-center">
                    <SelectValue placeholder="No cost center" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">No cost center</SelectItem>
                    {(costCenters ?? []).map((cc) => (
                      <SelectItem key={cc.id} value={cc.id}>
                        <span className="font-mono text-xs tabular-nums">{cc.code}</span>
                        <span className="ml-2 text-muted-foreground">{cc.name}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </FieldSet>
          </>
        )}

        <FieldSeparator />

        <FieldSet>
          <FieldLegend variant="label">Recurrence</FieldLegend>
          <FieldDescription>
            Recurring standalone orders are coming soon. For repeating orders, attach them to a
            recurring room booking instead.
          </FieldDescription>
          <Field orientation="horizontal">
            <Switch id="order-recurring" checked={false} disabled />
            <FieldLabel htmlFor="order-recurring" className="font-normal text-muted-foreground">
              Repeat this order
            </FieldLabel>
          </Field>
        </FieldSet>
      </FieldGroup>

      <div className="flex justify-end gap-2 border-t pt-4">
        <Button variant="outline" onClick={() => navigate('/portal')} disabled={createStandalone.isPending}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={!canSubmit || createStandalone.isPending}>
          {createStandalone.isPending ? 'Placing…' : 'Place order'}
        </Button>
      </div>
    </div>
  );
}

function combineIso(date: string, time: string): string {
  if (!date || !time) return '';
  // Naive local-tz combine — the API treats it as the user's tz. The
  // browser's Intl-aware Date object handles ISO conversion on the wire.
  const d = new Date(`${date}T${time}:00`);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toISOString();
}

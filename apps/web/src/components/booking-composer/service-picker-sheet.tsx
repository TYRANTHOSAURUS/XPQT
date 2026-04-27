import { useEffect, useMemo, useState } from 'react';
import { Coffee, Speaker, Boxes, ShoppingBag, Loader2, Minus, Plus } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useAvailableServiceItems } from '@/api/service-catalog';
import type { AvailableServiceItem, ServiceType } from '@/api/service-catalog';
import { useIsMobile } from '@/hooks/use-mobile';
import { formatCurrency } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface PickerSelection {
  catalog_item_id: string;
  menu_id: string;
  quantity: number;
  unit_price: number | null;
  unit: 'per_item' | 'per_person' | 'flat_rate' | null;
  name: string;
  service_type: ServiceType;
}

const TAB_DEFS: Array<{
  value: ServiceType;
  label: string;
  Icon: typeof Coffee;
  description: string;
}> = [
  { value: 'catering', label: 'Catering', Icon: Coffee, description: 'Coffee, lunch, snacks' },
  { value: 'av_equipment', label: 'AV', Icon: Speaker, description: 'Mics, screens, recording' },
  { value: 'supplies', label: 'Supplies', Icon: Boxes, description: 'Whiteboards, markers' },
  { value: 'other', label: 'Other', Icon: ShoppingBag, description: 'Anything else' },
];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Driving inputs from the booking the user is amending. */
  deliverySpaceId: string | null;
  onDate: string | null;
  attendeeCount: number;
  /** Default tab to focus when opened (e.g. "catering" if invoked from a "+ Add catering" button). */
  initialServiceType?: ServiceType;
  /** Confirm — the parent fires the mutation. */
  onConfirm: (selections: PickerSelection[]) => Promise<void> | void;
  submitting?: boolean;
  /** Title shown at the top — e.g. "Add services" or "Choose for your booking". */
  title?: string;
  /** Sub-title — caller may pass the booking's date/room for context. */
  subtitle?: string;
}

/**
 * Bottom-sheet on mobile, right-sheet on desktop. Tabbed catalog browser
 * — each tab lazy-fetches `GET /service-catalog/available-items` for its
 * service-type. Selections accumulate in local state across tabs; one
 * Submit button at the bottom commits everything via `onConfirm`.
 *
 * Used by:
 *   - Post-booking `+ Add service` on `BundleServicesSection`
 *   - Future composer flows (initial booking, scheduler create, desk list)
 *
 * Smart defaults: a per_item / flat_rate first-add seeds quantity = 1; a
 * per_person first-add seeds quantity = max(1, attendeeCount). Tab labels
 * carry a count badge per service-type so cross-tab selections stay
 * visible. Phase B will extend with personal-template chips above the tabs.
 */
export function ServicePickerSheet({
  open,
  onOpenChange,
  deliverySpaceId,
  onDate,
  attendeeCount,
  initialServiceType = 'catering',
  onConfirm,
  submitting,
  title = 'Add services',
  subtitle,
}: Props) {
  const isMobile = useIsMobile();
  const [activeTab, setActiveTab] = useState<ServiceType>(initialServiceType);
  const [selections, setSelections] = useState<PickerSelection[]>([]);

  // Reset state on open so a previously cancelled session doesn't bleed in.
  useEffect(() => {
    if (open) {
      setActiveTab(initialServiceType);
      setSelections([]);
    }
  }, [open, initialServiceType]);

  const total = useMemo(
    () =>
      selections.reduce(
        (sum, s) => sum + estimateLine(s, attendeeCount),
        0,
      ),
    [selections, attendeeCount],
  );
  const hasSelections = selections.length > 0;

  const countByType = useMemo(() => {
    const m = new Map<ServiceType, number>();
    for (const s of selections) m.set(s.service_type, (m.get(s.service_type) ?? 0) + 1);
    return m;
  }, [selections]);

  const handleSubmit = async () => {
    if (!hasSelections) return;
    await onConfirm(selections);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isMobile ? 'bottom' : 'right'}
        className={cn(
          'flex flex-col gap-0 p-0 sm:max-w-lg',
          // On mobile bottom-sheet: cap at 90dvh so the system UI stays
          // visible and the user can dismiss with a swipe-down on the handle.
          isMobile && 'h-[90dvh] rounded-t-xl',
        )}
      >
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle>{title}</SheetTitle>
          {subtitle && <SheetDescription>{subtitle}</SheetDescription>}
        </SheetHeader>

        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as ServiceType)}
          className="flex flex-1 min-h-0 flex-col"
        >
          <TabsList className="mx-5 mt-3 grid w-auto grid-cols-4 shrink-0 max-[360px]:grid-cols-2 max-[360px]:auto-rows-fr">
            {TAB_DEFS.map((t) => {
              const count = countByType.get(t.value) ?? 0;
              return (
                <TabsTrigger
                  key={t.value}
                  value={t.value}
                  aria-label={t.label}
                  className="relative text-xs"
                >
                  <t.Icon className="size-3.5" />
                  <span className="hidden sm:inline">{t.label}</span>
                  {count > 0 && (
                    <span className="ml-1 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium tabular-nums text-primary-foreground">
                      {count}
                    </span>
                  )}
                </TabsTrigger>
              );
            })}
          </TabsList>

          <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-4 pt-3">
            {TAB_DEFS.map((t) => (
              <TabsContent key={t.value} value={t.value} className="m-0">
                <CatalogPanel
                  serviceType={t.value}
                  description={t.description}
                  deliverySpaceId={deliverySpaceId}
                  onDate={onDate}
                  attendeeCount={attendeeCount}
                  selections={selections}
                  onChange={setSelections}
                  active={activeTab === t.value}
                />
              </TabsContent>
            ))}
          </div>
        </Tabs>

        <SheetFooter className="border-t bg-card px-5 py-3 sm:flex-col sm:items-stretch sm:gap-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {hasSelections
                ? `${selections.length} item${selections.length !== 1 ? 's' : ''}`
                : 'Pick at least one item'}
            </span>
            <span className="font-semibold tabular-nums">{formatCurrency(total)}</span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
              className="flex-1 h-11 sm:h-9"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={!hasSelections || submitting}
              className="flex-1 h-11 sm:h-9"
            >
              {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
              {submitting ? 'Adding…' : 'Add to booking'}
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function CatalogPanel({
  serviceType,
  description,
  deliverySpaceId,
  onDate,
  attendeeCount,
  selections,
  onChange,
  active,
}: {
  serviceType: ServiceType;
  description: string;
  deliverySpaceId: string | null;
  onDate: string | null;
  attendeeCount: number;
  selections: PickerSelection[];
  onChange: (next: PickerSelection[]) => void;
  active: boolean;
}) {
  const query = useAvailableServiceItems({
    delivery_space_id: deliverySpaceId,
    on_date: onDate,
    service_type: serviceType,
    enabled: active && Boolean(deliverySpaceId) && Boolean(onDate),
  });

  const items = query.data?.items ?? [];
  const byId = useMemo(() => {
    const m = new Map<string, PickerSelection>();
    for (const s of selections) m.set(s.catalog_item_id, s);
    return m;
  }, [selections]);

  const setQuantity = (item: AvailableServiceItem, next: number) => {
    const clamped = Math.max(0, Math.floor(next));
    const exists = byId.get(item.catalog_item_id);
    if (clamped === 0) {
      if (!exists) return;
      onChange(selections.filter((s) => s.catalog_item_id !== item.catalog_item_id));
      return;
    }
    if (exists) {
      onChange(
        selections.map((s) =>
          s.catalog_item_id === item.catalog_item_id ? { ...s, quantity: clamped } : s,
        ),
      );
      return;
    }
    // First add: smart-default quantity by unit kind. `per_person` lines
    // multiply by attendees on the backend, so a quantity of 1 is the right
    // seed (1 unit × N attendees = N persons served). `per_item` and
    // `flat_rate` do NOT multiply, so the user typically wants either 1 or
    // attendeeCount worth — seed with the explicit `next` value (the +
    // button passes 1; a "Add for everyone" template path could pass N).
    onChange([
      ...selections,
      {
        catalog_item_id: item.catalog_item_id,
        menu_id: item.menu_id,
        quantity: clamped,
        unit_price: item.price,
        unit: item.unit,
        name: item.name,
        service_type: serviceType,
      },
    ]);
  };

  // For `per_item` lines on first add, default to attendeeCount so a typical
  // "8 sandwiches for 8 attendees" flow is one tap, not eight.
  const initialQuantityFor = (item: AvailableServiceItem): number => {
    if (item.unit === 'per_item') return Math.max(1, attendeeCount);
    return 1;
  };

  if (!deliverySpaceId || !onDate) {
    return (
      <p className="py-8 text-center text-xs text-muted-foreground">
        Pick a date and room first.
      </p>
    );
  }

  if (query.isLoading) {
    return (
      <div className="space-y-2 py-2">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-2/3" />
      </div>
    );
  }
  if (query.error) {
    return (
      <p className="py-8 text-center text-xs text-destructive">
        Couldn't load options. {(query.error as Error).message}
      </p>
    );
  }
  if (items.length === 0) {
    return (
      <div className="py-8 text-center">
        <p className="text-sm font-medium text-muted-foreground">No {description.toLowerCase()}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Nothing available for this room and date.
        </p>
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {items.map((item) => {
        const sel = byId.get(item.catalog_item_id);
        const linePreview = sel
          ? estimateLine(
              { unit_price: item.price, unit: item.unit, quantity: sel.quantity },
              attendeeCount,
            )
          : null;
        return (
          <li
            key={item.catalog_item_id}
            className={cn(
              'flex items-stretch gap-3 rounded-lg border bg-card p-3',
              sel && 'border-primary/30 bg-primary/5',
            )}
          >
            {item.image_url && (
              <div
                className="size-16 shrink-0 rounded-md bg-muted bg-cover bg-center"
                style={{ backgroundImage: `url(${item.image_url})` }}
                aria-hidden
              />
            )}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium leading-tight">{item.name}</div>
              {item.description && (
                <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1">
                  {item.description}
                </p>
              )}
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
                <span className="tabular-nums">{formatCurrency(item.price)}</span>
                {item.unit && <span className="normal-case">/ {prettyUnit(item.unit)}</span>}
                {item.lead_time_hours != null && (
                  <span className="normal-case">· {item.lead_time_hours}h lead</span>
                )}
                {item.dietary_tags.length > 0 && (
                  <span className="normal-case">
                    · {item.dietary_tags.slice(0, 2).join(', ')}
                  </span>
                )}
              </div>
            </div>
            <div className="flex shrink-0 flex-col items-end justify-between gap-2">
              <QuantityStepper
                value={sel?.quantity ?? 0}
                addInitial={initialQuantityFor(item)}
                onChange={(n) => setQuantity(item, n)}
              />
              {linePreview != null && linePreview > 0 && (
                <span className="text-xs tabular-nums text-muted-foreground">
                  {formatCurrency(linePreview)}
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function QuantityStepper({
  value,
  addInitial = 1,
  onChange,
}: {
  value: number;
  /** Seed quantity used when the user taps Add for the first time. Lets
   *  per_item lines default to attendeeCount so "8 sandwiches for 8" is
   *  one tap. */
  addInitial?: number;
  onChange: (next: number) => void;
}) {
  if (value === 0) {
    return (
      <Button
        size="sm"
        variant="outline"
        className="h-11 px-3 sm:h-9"
        onClick={() => onChange(addInitial)}
      >
        Add
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-0.5 rounded-md border bg-background">
      <Button
        size="icon"
        variant="ghost"
        className="size-11 sm:size-9"
        aria-label={`Decrease quantity, currently ${value}`}
        onClick={() => onChange(value - 1)}
      >
        <Minus className="size-3.5" />
      </Button>
      <span
        className="min-w-[2ch] text-center text-sm font-medium tabular-nums"
        aria-live="polite"
      >
        {value}
      </span>
      <Button
        size="icon"
        variant="ghost"
        className="size-11 sm:size-9"
        aria-label={`Increase quantity, currently ${value}`}
        onClick={() => onChange(value + 1)}
      >
        <Plus className="size-3.5" />
      </Button>
    </div>
  );
}

function estimateLine(
  line: { unit_price: number | null; unit: 'per_item' | 'per_person' | 'flat_rate' | null; quantity: number },
  attendeeCount: number,
): number {
  if (line.unit_price == null || !Number.isFinite(line.unit_price)) return 0;
  switch (line.unit) {
    case 'per_person':
      return line.unit_price * line.quantity * Math.max(1, attendeeCount);
    case 'flat_rate':
      return line.unit_price;
    case 'per_item':
    default:
      return line.unit_price * line.quantity;
  }
}

function prettyUnit(unit: 'per_item' | 'per_person' | 'flat_rate'): string {
  switch (unit) {
    case 'per_item':
      return 'item';
    case 'per_person':
      return 'person';
    case 'flat_rate':
      return 'flat';
  }
}

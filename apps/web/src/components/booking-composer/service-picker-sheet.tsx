import { useEffect, useMemo, useState } from 'react';
import { Coffee, Speaker, LayoutPanelLeft, ShoppingBag, Loader2 } from 'lucide-react';
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
import {
  useRecentMyBundles,
  type RecentBundleSummary,
} from '@/api/booking-bundles';
import { useIsMobile } from '@/hooks/use-mobile';
import { NumberStepper } from '@/components/ui/number-stepper';
import { formatCurrency, formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface PickerSelection {
  catalog_item_id: string;
  menu_id: string;
  quantity: number;
  unit_price: number | null;
  unit: 'per_item' | 'per_person' | 'flat_rate' | null;
  name: string;
  service_type: ServiceType;
  /** Carried through from the catalog item so consumers (e.g. the composer)
   *  can pre-flight lead-time vs booking start without a re-fetch. */
  lead_time_hours?: number | null;
  /** ISO timestamps. Null = use the booking window. Set per-line when the
   *  user expands "Different time?" on a catalog row (e.g. coffee at 8:45
   *  for a 9:00 meeting). */
  service_window_start_at?: string | null;
  service_window_end_at?: string | null;
}

const TAB_DEFS: Array<{
  value: ServiceType;
  label: string;
  Icon: typeof Coffee;
  description: string;
}> = [
  { value: 'catering', label: 'Catering', Icon: Coffee, description: 'Coffee, lunch, snacks' },
  { value: 'av_equipment', label: 'AV', Icon: Speaker, description: 'Mics, screens, recording' },
  { value: 'facilities_services', label: 'Setup', Icon: LayoutPanelLeft, description: 'Layout, signage, flipcharts' },
  { value: 'other', label: 'Other', Icon: ShoppingBag, description: 'Anything else' },
];

interface BodyProps {
  /** Driving inputs from the booking the user is amending. */
  deliverySpaceId: string | null;
  onDate: string | null;
  attendeeCount: number;
  /** Booking start/end ISO. Used as the default service window when the
   *  user expands "Different time?" on a catalog row. */
  bookingStartAt?: string | null;
  bookingEndAt?: string | null;
  /** Controlled selections — body is headless. Caller owns the array; body
   *  emits a new array on every quantity / window change. */
  selections: PickerSelection[];
  onSelectionsChange: (next: PickerSelection[]) => void;
  /** Default tab to focus when this body mounts. Subsequent caller changes
   *  re-sync (e.g. swapping from "+ Add catering" to "+ Add AV"). */
  initialServiceType?: ServiceType;
  /** Outer container styling — caller controls horizontal padding so this
   *  body lays out the same inside a Sheet, a Dialog, or a drill-down
   *  pane. */
  className?: string;
}

/**
 * Headless catalog browser for booking services. Renders the recent-bundles
 * chip row and the four-tab catalog grid; the caller wraps with whatever
 * surface chrome is appropriate (Sheet for post-booking add-ons, drill-down
 * pane for in-composer, etc.) and supplies its own commit affordance.
 *
 * Controlled — the body never owns selections, so a single primary CTA at
 * the surface level is the only thing that ever "saves." This is the fix
 * for the modal-on-modal anti-pattern that used to live here.
 */
export function ServicePickerBody({
  deliverySpaceId,
  onDate,
  attendeeCount,
  bookingStartAt = null,
  bookingEndAt = null,
  selections,
  onSelectionsChange,
  initialServiceType = 'catering',
  className,
}: BodyProps) {
  const [activeTab, setActiveTab] = useState<ServiceType>(initialServiceType);

  // Re-seed activeTab when the caller swaps the focused tab — e.g. opening
  // the body from a "+ Add catering" chip vs an "+ Add AV" chip — so the
  // user lands on the relevant grid without an extra click.
  useEffect(() => {
    setActiveTab(initialServiceType);
  }, [initialServiceType]);

  const countByType = useMemo(() => {
    const m = new Map<ServiceType, number>();
    for (const s of selections) m.set(s.service_type, (m.get(s.service_type) ?? 0) + 1);
    return m;
  }, [selections]);

  return (
    <div className={cn('flex flex-1 min-h-0 flex-col', className)}>
      <RecentBundlesChips
        onApply={(bundle) => onSelectionsChange(seedSelectionsFromBundle(bundle))}
      />

      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as ServiceType)}
        className="flex flex-1 min-h-0 flex-col"
      >
        <TabsList className="mt-3 grid w-full grid-cols-4 shrink-0 max-[360px]:grid-cols-2 max-[360px]:auto-rows-fr">
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

        <div className="flex-1 min-h-0 overflow-y-auto pb-4 pt-3">
          {TAB_DEFS.map((t) => (
            <TabsContent key={t.value} value={t.value} className="m-0">
              <CatalogPanel
                serviceType={t.value}
                description={t.description}
                deliverySpaceId={deliverySpaceId}
                onDate={onDate}
                attendeeCount={attendeeCount}
                bookingStartAt={bookingStartAt}
                bookingEndAt={bookingEndAt}
                selections={selections}
                onChange={onSelectionsChange}
                active={activeTab === t.value}
              />
            </TabsContent>
          ))}
        </div>
      </Tabs>
    </div>
  );
}

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Driving inputs from the booking the user is amending. */
  deliverySpaceId: string | null;
  onDate: string | null;
  attendeeCount: number;
  bookingStartAt?: string | null;
  bookingEndAt?: string | null;
  /** Existing selections to hydrate when re-opening the picker for edit.
   *  Without this, "Edit" reopens with an empty cart and the user's
   *  prior picks vanish on the next confirm — codex flagged on the
   *  holistic review. */
  initialSelections?: PickerSelection[];
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
 * Bottom-sheet on mobile, right-sheet on desktop. Used by the post-booking
 * detail surface (`BundleServicesSection`) where the picker IS the only
 * overlay and "Add to booking" is the real commit. The booking composer
 * does NOT use this Sheet anymore — it embeds `ServicePickerBody` directly
 * in a drill-down pane to avoid the modal-on-modal stack.
 */
export function ServicePickerSheet({
  open,
  onOpenChange,
  deliverySpaceId,
  onDate,
  attendeeCount,
  bookingStartAt = null,
  bookingEndAt = null,
  initialSelections,
  initialServiceType = 'catering',
  onConfirm,
  submitting,
  title = 'Add services',
  subtitle,
}: SheetProps) {
  const isMobile = useIsMobile();
  const [selections, setSelections] = useState<PickerSelection[]>(
    initialSelections ?? [],
  );
  // Bumped each time the sheet opens so the embedded body remounts with
  // a fresh `activeTab = initialServiceType`. Without this, re-opening
  // the sheet leaves the user on whichever tab they last visited, which
  // is wrong for the "+ Add catering" chip flow on the detail page.
  const [openVersion, setOpenVersion] = useState(0);

  useEffect(() => {
    if (open) {
      setSelections(initialSelections ?? []);
      setOpenVersion((v) => v + 1);
    }
  }, [open, initialSelections]);

  const total = useMemo(
    () =>
      selections.reduce(
        (sum, s) => sum + estimateLine(s, attendeeCount),
        0,
      ),
    [selections, attendeeCount],
  );
  const hasSelections = selections.length > 0;

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

        <ServicePickerBody
          key={openVersion}
          deliverySpaceId={deliverySpaceId}
          onDate={onDate}
          attendeeCount={attendeeCount}
          bookingStartAt={bookingStartAt}
          bookingEndAt={bookingEndAt}
          selections={selections}
          onSelectionsChange={setSelections}
          initialServiceType={initialServiceType}
          className="px-5"
        />

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
  bookingStartAt,
  bookingEndAt,
  selections,
  onChange,
  active,
}: {
  serviceType: ServiceType;
  description: string;
  deliverySpaceId: string | null;
  onDate: string | null;
  attendeeCount: number;
  bookingStartAt: string | null;
  bookingEndAt: string | null;
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
        lead_time_hours: item.lead_time_hours ?? null,
      },
    ]);
  };

  // For `per_item` lines on first add, default to attendeeCount so a typical
  // "8 sandwiches for 8 attendees" flow is one tap, not eight.
  const initialQuantityFor = (item: AvailableServiceItem): number => {
    if (item.unit === 'per_item') return Math.max(1, attendeeCount);
    return 1;
  };

  const setSelectionWindow = (
    catalogItemId: string,
    window: { start_at: string | null; end_at: string | null } | null,
  ) => {
    onChange(
      selections.map((s) =>
        s.catalog_item_id === catalogItemId
          ? {
              ...s,
              service_window_start_at: window?.start_at ?? null,
              service_window_end_at: window?.end_at ?? null,
            }
          : s,
      ),
    );
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
              'flex flex-col gap-2 rounded-lg border bg-card p-3',
              sel && 'border-primary/30 bg-primary/5',
            )}
          >
            <div className="flex items-stretch gap-3">
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
            </div>
            {sel && (
              <ItemWindowOverride
                sel={sel}
                bookingStartAt={bookingStartAt}
                bookingEndAt={bookingEndAt}
                onChange={(w) => setSelectionWindow(item.catalog_item_id, w)}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Per-line "different time?" disclosure shown below a selected catalog row.
 * Collapsed: a small inline link saying "At meeting time · Set different time".
 * Expanded: two `<input type="time">` fields anchored to the booking date,
 * plus "Use meeting time" reset.
 *
 * Times are stored as full ISO timestamps in PickerSelection; the date
 * component is taken from `bookingStartAt`. If no booking window is known
 * (rare — composer flows pass it), the override is hidden so the user
 * doesn't end up with a half-functional control.
 */
function ItemWindowOverride({
  sel,
  bookingStartAt,
  bookingEndAt,
  onChange,
}: {
  sel: PickerSelection;
  bookingStartAt: string | null;
  bookingEndAt: string | null;
  onChange: (window: { start_at: string | null; end_at: string | null } | null) => void;
}) {
  const [expanded, setExpanded] = useState(
    Boolean(sel.service_window_start_at || sel.service_window_end_at),
  );

  if (!bookingStartAt || !bookingEndAt) return null;

  const hasOverride = Boolean(sel.service_window_start_at || sel.service_window_end_at);
  const effectiveStart = sel.service_window_start_at ?? bookingStartAt;
  const effectiveEnd = sel.service_window_end_at ?? bookingEndAt;
  const startTime = isoToLocalTime(effectiveStart);
  const endTime = isoToLocalTime(effectiveEnd);
  const dateStamp = bookingStartAt.slice(0, 10);

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      >
        {hasOverride
          ? `At ${formatWindowSummary(effectiveStart, effectiveEnd)} · adjust`
          : 'At meeting time · set different time'}
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-dashed pt-2">
      <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
        Service window
      </span>
      <input
        type="time"
        value={startTime}
        onChange={(e) =>
          onChange({
            start_at: combineDateTime(dateStamp, e.target.value),
            end_at: sel.service_window_end_at ?? bookingEndAt,
          })
        }
        className="h-8 rounded-md border bg-background px-2 text-sm tabular-nums focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        aria-label="Service window start"
      />
      <span aria-hidden className="text-xs text-muted-foreground">
        to
      </span>
      <input
        type="time"
        value={endTime}
        onChange={(e) =>
          onChange({
            start_at: sel.service_window_start_at ?? bookingStartAt,
            end_at: combineDateTime(dateStamp, e.target.value),
          })
        }
        className="h-8 rounded-md border bg-background px-2 text-sm tabular-nums focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        aria-label="Service window end"
      />
      {hasOverride && (
        <button
          type="button"
          onClick={() => {
            onChange(null);
            setExpanded(false);
          }}
          className="text-[11px] text-muted-foreground hover:text-foreground"
        >
          Use meeting time
        </button>
      )}
    </div>
  );
}

function isoToLocalTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Combine YYYY-MM-DD + HH:MM (browser local) → ISO timestamp. */
function combineDateTime(date: string, time: string): string {
  if (!time) return new Date(`${date}T00:00`).toISOString();
  return new Date(`${date}T${time}`).toISOString();
}

const TIME_FMT = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});
function formatWindowSummary(startIso: string, endIso: string): string {
  const start = TIME_FMT.format(new Date(startIso));
  const end = TIME_FMT.format(new Date(endIso));
  return `${start}–${end}`;
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
        className="h-10 px-3"
        onClick={() => onChange(addInitial)}
      >
        Add
      </Button>
    );
  }
  return (
    <NumberStepper
      value={value}
      onChange={onChange}
      min={0}
      max={999}
      size="md"
      aria-label="Quantity"
    />
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

/**
 * "Your usual" chip row above the picker tabs. Shows the caller's most-recent
 * service-bearing bundles; tapping a chip seeds the picker with that
 * bundle's items + quantities so a regular Friday-lunch flow is one tap.
 *
 * The chips deliberately don't replace the per-tab catalog browser — they
 * complement it. Tap a chip → selections seeded → user can still tweak a
 * quantity, swap an item, or add an extra in any tab before submitting.
 *
 * Hidden when the user has no recent bundles or the request is in flight,
 * so the picker doesn't show a flicker of empty chips.
 */
function RecentBundlesChips({
  onApply,
}: {
  onApply: (bundle: RecentBundleSummary) => void;
}) {
  const { data, isPending } = useRecentMyBundles();
  const bundles = data?.bundles ?? [];

  if (isPending) return null;
  if (bundles.length === 0) return null;

  return (
    <div className="border-b py-3">
      <div className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        Your usual
      </div>
      <div className="flex flex-wrap gap-1.5">
        {bundles.map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => onApply(b)}
            className={cn(
              'group/chip flex max-w-full items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs transition-colors',
              'hover:border-primary/40 hover:bg-primary/5',
              'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
            )}
            title={summarizeBundle(b)}
            style={{ transitionDuration: '120ms', transitionTimingFunction: 'var(--ease-snap)' }}
          >
            <span className="truncate font-medium">{chipLabel(b)}</span>
            <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
              {formatRelativeTime(b.start_at)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Render a one-line label for the chip — e.g. "Coffee + sandwich · Atlas". */
function chipLabel(b: RecentBundleSummary): string {
  const items = b.line_summary.slice(0, 2).map((l) => l.name).join(' + ');
  const more = b.line_summary.length > 2 ? ` +${b.line_summary.length - 2}` : '';
  const where = b.space_name ? ` · ${b.space_name}` : '';
  return `${items}${more}${where}`;
}

/** Hover-tooltip summary listing every line in the chip's bundle. */
function summarizeBundle(b: RecentBundleSummary): string {
  return b.line_summary.map((l) => `${l.quantity} × ${l.name}`).join(', ');
}

/** Materialize a chip's bundle summary back into PickerSelections. The
 *  picker fetches current menu offers separately — historical menu_id is
 *  preserved as a hint, but if the menu is archived the picker's resolver
 *  silently surfaces the new active offer so prices stay current. */
function seedSelectionsFromBundle(b: RecentBundleSummary): PickerSelection[] {
  return b.line_summary.map((l) => ({
    catalog_item_id: l.catalog_item_id,
    menu_id: l.menu_id ?? '',
    quantity: l.quantity,
    unit_price: l.unit_price,
    unit: l.unit,
    name: l.name,
    service_type: (l.service_type as ServiceType | null) ?? 'other',
  }));
}

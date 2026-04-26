import { useMemo } from 'react';
import { ChevronRight } from 'lucide-react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useAvailableServiceItems } from '@/api/service-catalog';
import type { AvailableServiceItem, ServiceType } from '@/api/service-catalog';
import { formatCurrency } from '@/lib/format';

export interface ServiceSelection {
  catalog_item_id: string;
  menu_id: string;
  quantity: number;
  /** Snapshotted at selection time so the running total stays stable. */
  unit_price: number | null;
  unit: 'per_item' | 'per_person' | 'flat_rate' | null;
  name: string;
  /** When set, overrides the meeting window; null = use the meeting window. */
  service_window_start_at?: string | null;
  service_window_end_at?: string | null;
}

interface ServiceSectionProps {
  serviceType: ServiceType;
  /** Section label in the dialog ("Catering", "AV / equipment", etc.). */
  title: string;
  /** "Cold lunches, hot meals, snacks" copy under the title. */
  description: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Driving inputs from the parent dialog. */
  deliverySpaceId: string | null;
  onDate: string | null;
  attendeeCount: number;
  /** Currently-selected lines, uplifted by the dialog. */
  selections: ServiceSelection[];
  onChangeSelections: (next: ServiceSelection[]) => void;
}

/**
 * Collapsible Catering / AV / Setup section in the booking-confirm dialog.
 *
 * Rendered ONLY when the section is opened — no fetch happens until the
 * trigger flips `open` true. React Query caches the response per
 * (delivery_space, on_date, service_type) tuple at 30s staletime, so
 * collapse/re-expand reads from cache.
 *
 * Each row is a (catalog_item × resolved_menu_offer) pair from
 * `GET /service-catalog/available-items`. Quantity input clamps ≥ 0; setting
 * quantity to 0 removes the line. Per-line preview uses `attendeeCount`
 * for `per_person` items.
 */
export function ServiceSection(props: ServiceSectionProps) {
  const query = useAvailableServiceItems({
    delivery_space_id: props.deliverySpaceId,
    on_date: props.onDate,
    service_type: props.serviceType,
    enabled: props.open && Boolean(props.deliverySpaceId) && Boolean(props.onDate),
  });

  const items = query.data?.items ?? [];
  const selectionsByItem = useMemo(() => {
    const map = new Map<string, ServiceSelection>();
    for (const s of props.selections) map.set(s.catalog_item_id, s);
    return map;
  }, [props.selections]);

  const sectionTotal = useMemo(() => {
    return props.selections.reduce((sum, s) => sum + estimateLineTotal(s, props.attendeeCount), 0);
  }, [props.selections, props.attendeeCount]);

  const handleQuantityChange = (item: AvailableServiceItem, nextQuantity: number) => {
    const clamped = Math.max(0, Math.floor(Number.isFinite(nextQuantity) ? nextQuantity : 0));
    const existing = selectionsByItem.get(item.catalog_item_id);

    if (clamped === 0) {
      if (!existing) return;
      props.onChangeSelections(
        props.selections.filter((s) => s.catalog_item_id !== item.catalog_item_id),
      );
      return;
    }

    if (existing) {
      props.onChangeSelections(
        props.selections.map((s) =>
          s.catalog_item_id === item.catalog_item_id ? { ...s, quantity: clamped } : s,
        ),
      );
      return;
    }

    props.onChangeSelections([
      ...props.selections,
      {
        catalog_item_id: item.catalog_item_id,
        menu_id: item.menu_id,
        quantity: clamped,
        unit_price: item.price,
        unit: item.unit,
        name: item.name,
      },
    ]);
  };

  return (
    <Collapsible open={props.open} onOpenChange={props.onOpenChange}>
      <CollapsibleTrigger
        className="group flex w-full items-center justify-between rounded-md border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent/40"
        data-section={props.serviceType}
      >
        <div className="flex flex-col">
          <span className="text-sm font-medium">{props.title}</span>
          <span className="text-xs text-muted-foreground">{props.description}</span>
        </div>
        <div className="flex items-center gap-3">
          {props.selections.length > 0 ? (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
              {props.selections.length} ·{' '}
              <span className="tabular-nums">{formatCurrency(sectionTotal)}</span>
            </span>
          ) : null}
          <ChevronRight className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 space-y-2 rounded-md border bg-muted/30 p-3">
          {query.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-2/3" />
            </div>
          ) : query.error ? (
            <p className="text-xs text-destructive">
              Couldn’t load options. {(query.error as Error).message}
            </p>
          ) : items.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Nothing available for this location and date. An admin can configure menus in
              <span className="ml-1 font-mono">/admin/booking-services</span>.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {items.map((item) => {
                const sel = selectionsByItem.get(item.catalog_item_id);
                const linePreview = sel
                  ? estimateLineTotal(
                      { unit_price: item.price, unit: item.unit, quantity: sel.quantity },
                      props.attendeeCount,
                    )
                  : null;
                return (
                  <li
                    key={item.catalog_item_id}
                    className="flex items-center gap-3 rounded-md bg-background px-2.5 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium leading-tight">{item.name}</div>
                      {item.description ? (
                        <div className="text-xs text-muted-foreground line-clamp-1">
                          {item.description}
                        </div>
                      ) : null}
                      <div className="mt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
                        <span className="tabular-nums">{formatCurrency(item.price)}</span>
                        {item.unit ? <span className="ml-1 normal-case">/ {prettyUnit(item.unit)}</span> : null}
                        {item.lead_time_hours != null ? (
                          <span className="ml-2 normal-case">· {item.lead_time_hours}h lead</span>
                        ) : null}
                      </div>
                    </div>
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      placeholder="0"
                      className="h-8 w-16 text-center tabular-nums"
                      value={sel?.quantity ?? ''}
                      onChange={(e) => handleQuantityChange(item, Number(e.target.value || 0))}
                      aria-label={`Quantity for ${item.name}`}
                    />
                    <div className="w-16 text-right text-xs tabular-nums text-muted-foreground">
                      {linePreview != null && linePreview > 0 ? formatCurrency(linePreview) : '—'}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Mirrors `CostService.computeLineTotal` on the backend. Pure helper. */
function estimateLineTotal(
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

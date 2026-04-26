import { CheckCircle2, Clock, Truck, X } from 'lucide-react';
import { useBundle } from '@/api/booking-bundles';
import type { BundleLine } from '@/api/booking-bundles';
import { formatCurrency } from '@/lib/format';

interface Props {
  bundleId: string;
}

/**
 * Services section in the /portal/me-bookings drawer. Lazy: fires once when
 * the drawer opens for a reservation that has a `booking_bundle_id`.
 *
 * Shows each line with its current `fulfillment_status` (ordered →
 * confirmed → preparing → delivered → cancelled), service window if it
 * differs from the reservation, and per-line cost. Sub-project 4 will
 * append vendor / team owner once the drawer drills into a work-order
 * ticket.
 */
export function BundleServicesSection({ bundleId }: Props) {
  const { data, isLoading, error } = useBundle(bundleId);

  if (isLoading) {
    return (
      <div className="px-5 py-3 text-xs text-muted-foreground">Loading services…</div>
    );
  }

  if (error) {
    return (
      <div className="px-5 py-3 text-xs text-destructive">
        Couldn’t load services: {(error as Error).message}
      </div>
    );
  }

  if (!data) return null;

  const lines = data.lines ?? [];
  if (lines.length === 0) return null;

  const total = lines.reduce(
    (sum, l) => sum + (l.line_total != null && Number.isFinite(l.line_total) ? Number(l.line_total) : 0),
    0,
  );

  return (
    <div className="border-t">
      <div className="px-5 pt-3 pb-1 text-[11px] uppercase tracking-wider text-muted-foreground">
        Services ({lines.length})
      </div>
      <ul className="px-5 pb-2">
        {lines.map((line) => (
          <li
            key={line.id}
            className="flex items-start gap-3 border-b py-2 last:border-b-0"
          >
            <FulfillmentIcon status={line.fulfillment_status} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate text-sm font-medium">
                  {line.catalog_item_name ?? 'Service item'} × {line.quantity}
                </span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {formatCurrency(line.line_total)}
                </span>
              </div>
              <div className="text-[11px] text-muted-foreground">
                {prettyStatus(line.fulfillment_status)}
                {line.service_window_start_at && (
                  <span className="ml-2 tabular-nums">
                    · {formatTimeShort(line.service_window_start_at)}
                  </span>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between px-5 py-2 text-xs text-muted-foreground">
        <span>Status: {prettyBundleStatus(data.status_rollup)}</span>
        <span className="tabular-nums">{formatCurrency(total)}</span>
      </div>
    </div>
  );
}

function FulfillmentIcon({ status }: { status: BundleLine['fulfillment_status'] }) {
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

function prettyStatus(status: BundleLine['fulfillment_status']): string {
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

function formatTimeShort(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const formatter = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  return formatter.format(d);
}

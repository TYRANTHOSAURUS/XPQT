import { useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { FloorPlanCanvas } from '@/components/floor-plan/floor-plan-canvas';
import {
  useFloorPlanPublished,
  useFloorAvailability,
} from '@/api/floor-plans/hooks';
import { useSpaceDetail } from '@/api/spaces';
import type { OperatorReservationItem } from '@/api/room-booking';
import type { AvailabilityState } from '@/api/floor-plans/types';
import { formatFullTimestamp } from '@/lib/format';

type Props = {
  booking: OperatorReservationItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const TIME_FMT = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function mapAvailability(
  spaces: Array<{ id: string; state: AvailabilityState; free_at?: string | null }>,
) {
  return spaces.map((s) => ({
    spaceId: s.id,
    state: s.state,
    freeAt: s.free_at ?? null,
  }));
}

/**
 * Shows a booking's space highlighted on its floor plan.
 *
 * Resolution path:
 *   booking.space_id → space.parent_id (floor) → useFloorPlanPublished
 *
 * If the space has no floor plan → empty state.
 */
export function BookingFloorDialog({ booking, open, onOpenChange }: Props) {
  // Fetch the room's parent space to find the floor id.
  const spaceDetail = useSpaceDetail(booking?.space_id ?? null);
  const floorSpaceId =
    spaceDetail.data?.type === 'floor'
      ? spaceDetail.data.id
      : (spaceDetail.data?.parent_id ?? null);

  // Fetch the floor's plan.
  const floorPlan = useFloorPlanPublished(floorSpaceId ?? '');

  // Availability for the booking's time window so we can highlight the polygon.
  const availability = useFloorAvailability(
    floorSpaceId ?? '',
    booking?.start_at ?? '',
    booking?.end_at ?? '',
  );

  const states = useMemo(() => {
    if (!availability.data?.spaces) return [];
    return mapAvailability(availability.data.spaces);
  }, [availability.data?.spaces]);

  const isLoading =
    spaceDetail.isLoading ||
    (floorSpaceId ? floorPlan.isLoading : false);

  const requesterName = booking
    ? [booking.requester_first_name, booking.requester_last_name]
        .filter(Boolean)
        .join(' ') || 'Unknown'
    : '';

  const timeLabel = booking
    ? `${TIME_FMT.format(new Date(booking.start_at))} – ${new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(booking.end_at))}`
    : '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-3 border-b">
          <DialogTitle className="text-base">
            {booking?.space_name ?? 'Booking'} — floor view
          </DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0" style={{ height: '520px' }}>
          {/* Floor plan */}
          <div className="relative flex-1 min-w-0 bg-muted/20">
            {isLoading ? (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                Loading…
              </div>
            ) : !floorSpaceId || !floorPlan.data ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center p-6">
                <p className="text-sm font-medium">No floor plan available</p>
                <p className="max-w-xs text-xs text-muted-foreground">
                  This space doesn't appear on any floor plan yet. Publish a
                  floor plan in Admin → Floor Plans to enable this view.
                </p>
              </div>
            ) : (
              <FloorPlanCanvas
                plan={floorPlan.data}
                states={states}
                selectedSpaceId={booking?.space_id ?? null}
              />
            )}
          </div>

          {/* Booking metadata sidebar */}
          {booking && (
            <div className="w-56 shrink-0 border-l flex flex-col gap-4 px-4 py-4 overflow-y-auto">
              <div>
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
                  Room
                </p>
                <p className="text-sm font-medium">{booking.space_name ?? 'Unknown'}</p>
              </div>

              <div>
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
                  Time
                </p>
                <p className="text-sm">{timeLabel}</p>
              </div>

              <div>
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
                  Requester
                </p>
                <p className="text-sm">{requesterName}</p>
              </div>

              <div>
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
                  Status
                </p>
                <StatusBadge status={booking.status} />
              </div>

              {booking.attendee_count != null && booking.attendee_count > 0 && (
                <div>
                  <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
                    Attendees
                  </p>
                  <p className="text-sm">{booking.attendee_count}</p>
                </div>
              )}

              <div className="mt-auto">
                <p className="text-[11px] text-muted-foreground" title={formatFullTimestamp(booking.created_at)}>
                  Created {formatFullTimestamp(booking.created_at)}
                </p>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

type StatusBadgeProps = { status: OperatorReservationItem['status'] };

function StatusBadge({ status }: StatusBadgeProps) {
  const map: Record<string, { label: string; className: string }> = {
    confirmed: { label: 'Confirmed', className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' },
    pending_approval: { label: 'Pending', className: 'bg-amber-500/15 text-amber-700 dark:text-amber-400' },
    checked_in: { label: 'Checked in', className: 'bg-emerald-600/15 text-emerald-800 dark:text-emerald-300' },
    cancelled: { label: 'Cancelled', className: 'bg-muted text-muted-foreground' },
    released: { label: 'Auto-released', className: 'bg-amber-500/10 text-amber-700 dark:text-amber-400' },
    completed: { label: 'Completed', className: 'bg-muted text-muted-foreground' },
    draft: { label: 'Draft', className: 'bg-muted text-muted-foreground' },
  };
  const c = map[status] ?? { label: status, className: 'bg-muted text-muted-foreground' };
  return (
    <Badge
      variant="outline"
      className={`h-5 border-transparent px-2 text-[10px] font-medium ${c.className}`}
    >
      {c.label}
    </Badge>
  );
}

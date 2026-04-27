import { useNavigate } from 'react-router-dom';
import { Maximize2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useReservationDetail } from '@/api/room-booking';
import { formatRelativeTime } from '@/lib/format';
import { formatRef } from '@/lib/format-ref';
import { BookingDetailContent } from './booking-detail-content';

interface Props {
  reservationId: string | null;
  /** Pass-through display name from the list — keeps the title legible while the detail is loading. */
  spaceName?: string | null;
  onClose: () => void;
}

/**
 * Right-side panel for the desk split-pane bookings view. Mirrors the
 * tickets pattern at `/desk/tickets`: list on the left, detail mounted
 * inline on the right when a row is selected. Renders an inline header
 * (ref + title + close + expand) and the shared content body underneath.
 *
 * Designed to fill its parent `<Panel className="relative">`. The expand
 * button routes to the full-page route at `/desk/bookings/:id`.
 */
export function BookingDetailPanel({ reservationId, spaceName, onClose }: Props) {
  const navigate = useNavigate();
  const { data: reservation } = useReservationDetail(reservationId ?? '');

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden border-l bg-background">
      <div className="flex items-start justify-between gap-3 border-b px-5 py-4 shrink-0">
        <div className="min-w-0">
          {reservation && (
            <code
              data-chip
              className="font-mono text-xs text-muted-foreground tabular-nums mb-1 inline-block"
            >
              {formatRef('reservation', reservation.module_number)}
            </code>
          )}
          <h2 className="truncate text-lg font-semibold tracking-tight">
            {spaceName ?? 'Booking'}
          </h2>
          <p className="text-xs text-muted-foreground">
            {reservation
              ? `Booked ${formatRelativeTime(reservation.created_at)}`
              : 'Loading…'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {reservationId && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Open full page"
              onClick={() => navigate(`/desk/bookings/${reservationId}`)}
            >
              <Maximize2 className="size-3.5" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Close"
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <BookingDetailContent reservationId={reservationId} onDismiss={onClose} />
      </div>
    </div>
  );
}

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useReservationDetail } from '@/api/room-booking';
import { formatRelativeTime } from '@/lib/format';
import { formatRef } from '@/lib/format-ref';
import { BookingDetailContent } from './booking-detail-content';

interface Props {
  reservationId: string | null;
  /** Called when the drawer should close (URL is what controls open state). */
  onClose: () => void;
  /** Optional joined display data — useful when the list passes through space names. */
  spaceName?: string | null;
}

/**
 * Right-side drawer per spec §4.2 — wraps the shared BookingDetailContent
 * with a Sheet. Used by the portal `/me-bookings` page where requesters open
 * one booking at a time. Operators on `/desk/bookings` use the split-pane
 * panel instead (see BookingDetailPanel).
 */
export function BookingDetailDrawer({ reservationId, onClose, spaceName }: Props) {
  const open = Boolean(reservationId);
  const { data: reservation } = useReservationDetail(reservationId ?? '');

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-md p-0">
        <SheetHeader className="border-b px-5 py-4">
          {reservation && (
            <code
              data-chip
              className="font-mono text-xs text-muted-foreground tabular-nums mb-1 inline-block"
            >
              {formatRef('reservation', reservation.module_number)}
            </code>
          )}
          <SheetTitle className="text-lg">{spaceName ?? 'Booking'}</SheetTitle>
          <SheetDescription>
            {reservation
              ? `Booked ${formatRelativeTime(reservation.created_at)}`
              : 'Loading…'}
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto">
          <BookingDetailContent reservationId={reservationId} onDismiss={onClose} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

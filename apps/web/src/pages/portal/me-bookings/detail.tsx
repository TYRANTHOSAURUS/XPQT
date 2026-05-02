import { useMemo } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { PortalPage } from '@/components/portal/portal-page';
import { useReservationDetail } from '@/api/room-booking';
import { useSpaces } from '@/api/spaces';
import { formatRelativeTime } from '@/lib/format';
import { BookingDetailContent } from '@/components/booking-detail/booking-detail-content';

/**
 * Portal "my bookings" detail at `/portal/me/bookings/:id`. Mirrors the
 * shape of `/portal/requests/:id` — full route, narrow column, back-link
 * to the list. Operators get the wider split-pane / full-page surface
 * under `/desk/bookings/:id` (see `BookingDetailPanel` and
 * `BookingDetailPage`).
 */
export function MyBookingDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: reservation, isPending } = useReservationDetail(id);
  const { data: spaces } = useSpaces();

  const spaceName = useMemo(() => {
    if (!reservation || !spaces) return null;
    return spaces.find((s) => s.id === reservation.space_id)?.name ?? null;
  }, [reservation, spaces]);

  return (
    <PortalPage width="compact">
      <Link
        to="/portal/me/bookings"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden /> All bookings
      </Link>

      {isPending && !reservation ? (
        <div
          className="mt-6 text-sm text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          Loading…
        </div>
      ) : !reservation ? (
        <div className="mt-3 mb-6 space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-balance">
            Booking not found
          </h1>
          <p className="text-sm text-muted-foreground text-pretty">
            This booking either doesn't exist or you don't have access to it.
          </p>
        </div>
      ) : (
        <>
          <div className="mt-3 mb-6 space-y-1">
            {/* Reference chip retired post-canonicalisation (2026-05-02) —
                `bookings` table has no per-booking monotonic counter. Title
                + booked-relative line below already identify the booking. */}
            <h1 className="text-2xl font-semibold tracking-tight text-balance">
              {spaceName ?? 'Booking'}
            </h1>
            <p className="text-sm text-muted-foreground">
              Booked {formatRelativeTime(reservation.created_at)}
            </p>
          </div>

          <div className="overflow-hidden rounded-md border bg-card">
            <BookingDetailContent
              reservationId={id}
              surface="portal"
              onDismiss={() => navigate('/portal/me/bookings')}
            />
          </div>
        </>
      )}
    </PortalPage>
  );
}

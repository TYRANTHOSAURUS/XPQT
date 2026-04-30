import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CalendarPlus } from 'lucide-react';
import { PortalPage } from '@/components/portal/portal-page';
import { buttonVariants } from '@/components/ui/button';
import { useReservationDetail } from '@/api/room-booking';
import { useSpaces } from '@/api/spaces';
import { BookingsList } from './components/bookings-list';
import { BookingDetailDrawer } from '@/components/booking-detail/booking-detail-drawer';

type TabValue = 'upcoming' | 'past' | 'cancelled';

/**
 * Portal "my bookings" entry point. URL drives drawer state — `:id` opens
 * the right-side detail drawer; closing it `navigate(-1)` or back to the
 * tab base. Tabs are local component state today; if we add per-tab
 * permalinking later, lift to URL.
 *
 * The page is intentionally narrow (max-w-3xl) — bookings are a list of
 * decisions the user reads top-to-bottom, not a data dashboard. The wider
 * portal canvas would just space everything out unnecessarily.
 */
export function MyBookingsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabValue>('upcoming');

  // When the drawer opens via :id we still want a useful header; pre-fetch
  // detail + spaces so the drawer flashes nothing.
  const reservation = useReservationDetail(id ?? '');
  const { data: spaces } = useSpaces();
  const spaceName = useMemo(() => {
    const sid = reservation.data?.space_id;
    if (!sid) return null;
    return spaces?.find((s) => s.id === sid)?.name ?? null;
  }, [reservation.data?.space_id, spaces]);

  return (
    <PortalPage width="narrow">
      <Link
        to="/portal"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden /> Portal home
      </Link>

      <div className="mt-3 mb-6 flex items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-balance">My bookings</h1>
          <p className="mt-1 text-sm text-muted-foreground text-pretty">
            Upcoming, past, and cancelled. Check in near the start; restore
            inside the cancellation grace window.
          </p>
        </div>
        <Link
          to="/portal/rooms"
          className={buttonVariants({ size: 'sm', className: 'gap-1.5 shrink-0' })}
        >
          <CalendarPlus className="size-3.5" aria-hidden />
          Book a room
        </Link>
      </div>

      <BookingsList
        tab={tab}
        onTabChange={setTab}
        buildHref={(rid) => `/portal/me/bookings/${rid}`}
      />

      <BookingDetailDrawer
        reservationId={id ?? null}
        spaceName={spaceName}
        onClose={() => navigate('/portal/me/bookings')}
      />
    </PortalPage>
  );
}

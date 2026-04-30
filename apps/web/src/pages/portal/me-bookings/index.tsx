import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, CalendarPlus } from 'lucide-react';
import { PortalPage } from '@/components/portal/portal-page';
import { buttonVariants } from '@/components/ui/button';
import { BookingsList } from './components/bookings-list';

type TabValue = 'upcoming' | 'past' | 'cancelled';

/**
 * Portal "my bookings" list. Each row links to `/portal/me/bookings/:id`,
 * which mounts `MyBookingDetailPage` as a full route — same shape as
 * `/portal/requests/:id`. Tabs are local component state today; if we
 * add per-tab permalinking later, lift to URL.
 *
 * The page is intentionally compact (max-w-2xl) — bookings are a list of
 * decisions the user reads top-to-bottom, not a data dashboard. The wider
 * portal canvas would just space everything out unnecessarily.
 */
export function MyBookingsPage() {
  const [tab, setTab] = useState<TabValue>('upcoming');

  return (
    <PortalPage width="compact">
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
    </PortalPage>
  );
}

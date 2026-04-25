import { useMemo } from 'react';
import { CalendarPlus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { buttonVariants } from '@/components/ui/button';
import { useReservationList, useCheckInBooking, useRestoreBooking } from '@/api/room-booking';
import type { Reservation } from '@/api/room-booking';
import { useSpaces } from '@/api/spaces';
import { toast } from 'sonner';
import { BookingRow } from './booking-row';

type TabValue = 'upcoming' | 'past' | 'cancelled';

interface Props {
  /** When set, the row link points to the drawer route — drives `:id`-based routing. */
  buildHref: (reservationId: string) => string;
  /** Drives which tab is active; when omitted the component is uncontrolled. */
  tab: TabValue;
  onTabChange: (tab: TabValue) => void;
}

/**
 * "My bookings" list per spec §4.2. Tabs: Upcoming / Past / Cancelled.
 * Powered by `GET /reservations?scope=` which is wired through
 * `ReservationService.listMine` today.
 */
export function BookingsList({ buildHref, tab, onTabChange }: Props) {
  const { data, isPending, isFetching } = useReservationList({ scope: tab, limit: 50 });
  const { data: spaces } = useSpaces();
  const items = data?.items ?? [];

  const spaceNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of spaces ?? []) map.set(s.id, s.name);
    return map;
  }, [spaces]);

  const checkIn = useCheckInBooking();
  const restore = useRestoreBooking();

  const handleCheckIn = async (r: Reservation) => {
    try {
      await checkIn.mutateAsync(r.id);
      toast.success('Checked in');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Check-in failed');
    }
  };

  const handleRestore = async (r: Reservation) => {
    try {
      await restore.mutateAsync(r.id);
      toast.success('Booking restored');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Restore failed');
    }
  };

  return (
    <>
      <Tabs value={tab} onValueChange={(v) => onTabChange(v as TabValue)} className="mb-4">
        <TabsList>
          {(['upcoming', 'past', 'cancelled'] as const).map((t) => (
            <TabsTrigger key={t} value={t} className="capitalize">
              {t}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {isPending && items.length === 0 && (
        <div className="text-sm text-muted-foreground">Loading…</div>
      )}

      {!isPending && items.length > 0 && (
        <div
          className="rounded-xl border bg-card overflow-hidden"
          data-fetching={isFetching ? 'true' : 'false'}
        >
          {items.map((r) => (
            <BookingRow
              key={r.id}
              reservation={r}
              spaceName={spaceNameById.get(r.space_id) ?? null}
              partOfSeries={Boolean(r.recurrence_series_id)}
              href={buildHref(r.id)}
              onCheckIn={() => handleCheckIn(r)}
              onRestore={() => handleRestore(r)}
              isActing={checkIn.isPending || restore.isPending}
            />
          ))}
        </div>
      )}

      {!isPending && items.length === 0 && (
        <div className="rounded-xl border bg-card px-6 py-16 flex flex-col items-center gap-3 text-center">
          <div className="flex size-10 items-center justify-center rounded-full bg-muted">
            <CalendarPlus className="size-5 text-muted-foreground" />
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-medium">No bookings here yet</h3>
            <p className="text-xs text-muted-foreground">
              {tab === 'upcoming'
                ? 'You have nothing on the calendar.'
                : tab === 'past'
                  ? 'Past bookings will appear here once meetings wrap up.'
                  : 'Cancelled bookings show here for the grace window so you can restore them.'}
            </p>
          </div>
          {tab === 'upcoming' && (
            <Link to="/portal/rooms" className={buttonVariants({ size: 'sm' })}>
              Book a room
            </Link>
          )}
        </div>
      )}
    </>
  );
}

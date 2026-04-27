import { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import {
  SettingsPageShell,
  SettingsPageHeader,
} from '@/components/ui/settings-page';
import { useReservationDetail } from '@/api/room-booking';
import { useSpaces } from '@/api/spaces';
import { formatRelativeTime } from '@/lib/format';
import { formatRef } from '@/lib/format-ref';
import { BookingDetailContent } from './booking-detail-content';

/**
 * Full-route booking detail at `/desk/bookings/:id`. Reachable from the
 * split-pane's expand button, from the global command palette, or as a
 * direct deep-link. Reuses the shared `BookingDetailContent` body — only
 * the chrome (page header + back-link) differs from the panel/drawer.
 */
export function BookingDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const { data: reservation, isPending } = useReservationDetail(id);
  const { data: spaces } = useSpaces();

  const spaceName = useMemo(() => {
    if (!reservation || !spaces) return null;
    return spaces.find((s) => s.id === reservation.space_id)?.name ?? null;
  }, [reservation, spaces]);

  if (isPending) {
    return (
      <SettingsPageShell width="default">
        <SettingsPageHeader title="Loading…" backTo="/desk/bookings" />
      </SettingsPageShell>
    );
  }

  if (!reservation) {
    return (
      <SettingsPageShell width="default">
        <SettingsPageHeader
          title="Booking not found"
          description="This booking either doesn't exist or you don't have access to it."
          backTo="/desk/bookings"
        />
      </SettingsPageShell>
    );
  }

  const description =
    `${formatRef('reservation', reservation.module_number)} · Booked ${formatRelativeTime(reservation.created_at)}`;

  return (
    <SettingsPageShell width="default">
      <SettingsPageHeader
        title={spaceName ?? 'Booking'}
        description={description}
        backTo="/desk/bookings"
      />
      <div className="rounded-md border bg-card overflow-hidden">
        <BookingDetailContent reservationId={id} />
      </div>
    </SettingsPageShell>
  );
}

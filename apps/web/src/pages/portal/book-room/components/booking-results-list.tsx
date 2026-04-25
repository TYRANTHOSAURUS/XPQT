import { CalendarSearch } from 'lucide-react';
import type { RankedRoom } from '@/api/room-booking';
import { BookingResultRow } from './booking-result-row';

interface Props {
  rooms: RankedRoom[];
  isPending: boolean;
  isFetching: boolean;
  requestedStartIso: string;
  requestedEndIso: string;
  showRestricted?: boolean;
  onBook: (room: RankedRoom) => void;
}

/**
 * The ranked-results stack rendered below the criteria bar. Loading + empty
 * states match the rest of the portal (Linear-style minimal cards).
 */
export function BookingResultsList({
  rooms,
  isPending,
  isFetching,
  requestedStartIso,
  requestedEndIso,
  showRestricted,
  onBook,
}: Props) {
  if (isPending) {
    return (
      <div className="mt-3 space-y-2">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-[112px] animate-pulse rounded-lg border bg-card/40"
            aria-hidden
          />
        ))}
      </div>
    );
  }

  if (rooms.length === 0) {
    return (
      <div className="mt-3 flex flex-col items-center gap-3 rounded-lg border bg-card/40 px-6 py-16 text-center">
        <div className="flex size-10 items-center justify-center rounded-full bg-muted/60">
          <CalendarSearch className="size-5 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <h3 className="text-sm font-medium">No rooms match those criteria</h3>
          <p className="max-w-sm text-xs text-muted-foreground text-pretty">
            Try widening your time window, lowering attendees, or removing a must-have.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-2" data-fetching={isFetching ? 'true' : 'false'}>
      {rooms.map((room, idx) => (
        <BookingResultRow
          key={room.space_id}
          room={room}
          rank={idx}
          requestedStartIso={requestedStartIso}
          requestedEndIso={requestedEndIso}
          showRestricted={showRestricted}
          onBook={onBook}
        />
      ))}
    </div>
  );
}

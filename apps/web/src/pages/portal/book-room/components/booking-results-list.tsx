import { CalendarSearch, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
  /** Optional reset hook — clears must-haves / lifts attendees if user wants. */
  onWidenSearch?: () => void;
}

export function BookingResultsList({
  rooms,
  isPending,
  isFetching,
  requestedStartIso,
  requestedEndIso,
  showRestricted,
  onBook,
  onWidenSearch,
}: Props) {
  if (isPending) {
    return (
      <div className="mt-4 space-y-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-[148px] overflow-hidden rounded-2xl border bg-card"
            aria-hidden
          >
            <div className="flex h-full animate-pulse gap-4 p-5">
              <div className="size-14 rounded-xl bg-muted/60" />
              <div className="flex-1 space-y-3">
                <div className="h-4 w-1/3 rounded-md bg-muted/60" />
                <div className="flex gap-2">
                  <div className="h-5 w-16 rounded-full bg-muted/40" />
                  <div className="h-5 w-20 rounded-full bg-muted/40" />
                  <div className="h-5 w-12 rounded-full bg-muted/40" />
                </div>
                <div className="h-3 w-2/3 rounded-md bg-muted/40" />
                <div className="h-4 w-full rounded-md bg-muted/30" />
              </div>
              <div className="h-9 w-32 self-center rounded-md bg-muted/60" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (rooms.length === 0) {
    return (
      <div className="mt-6 flex flex-col items-center gap-4 rounded-2xl border bg-card/40 px-6 py-20 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-muted/60">
          <CalendarSearch className="size-5 text-muted-foreground" />
        </div>
        <div className="space-y-1.5">
          <h3 className="text-base font-semibold">No rooms match those criteria</h3>
          <p className="max-w-sm text-sm text-muted-foreground text-pretty">
            Try a different time, lower your attendee count, or remove a must-have requirement.
          </p>
        </div>
        {onWidenSearch && (
          <Button variant="outline" size="sm" className="gap-1.5" onClick={onWidenSearch}>
            <RotateCcw className="size-3.5" />
            Reset filters
          </Button>
        )}
      </div>
    );
  }

  return (
    <div
      className="mt-4 flex flex-col gap-3"
      data-fetching={isFetching ? 'true' : 'false'}
    >
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

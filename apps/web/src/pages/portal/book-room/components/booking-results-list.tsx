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
      <div className="mt-4 space-y-2">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="flex items-stretch overflow-hidden rounded-xl border bg-card"
            aria-hidden
          >
            {/* Skeleton tile mirrors the real row's edge-to-edge image area. */}
            <div className="w-20 sm:w-24 shrink-0 self-stretch animate-pulse bg-muted/40" />
            <div className="flex-1 px-4 py-3.5">
              <div className="animate-pulse space-y-3">
                <div className="flex items-center gap-3">
                  <div className="h-4 w-32 rounded bg-muted/70" />
                  <div className="h-4 w-24 rounded bg-muted/40" />
                  <div className="ml-auto h-7 w-20 rounded-md bg-muted/60" />
                </div>
                <div className="h-3 rounded bg-muted/30" />
              </div>
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

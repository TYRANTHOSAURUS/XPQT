import { CalendarRange, Plus, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Props {
  attendeeCount: number;
  multiRoomCount: number;
  recurring: boolean;
  /** Name of the room these actions would auto-select. Drives the inline
   *  hint so the user can see *which* room they're escalating (instead of
   *  the dialog quietly opening on the top-ranked result). */
  topRoomName?: string | null;
  /** Disable the buttons until the picker has at least one result. */
  disabled?: boolean;
  onAddAttendees: () => void;
  onAddRoom: () => void;
  onMakeRecurring: () => void;
}

/**
 * Spec §4.1 progressive disclosure footer. Three pill buttons that escalate
 * the booking from the simple-default flow into find-time / multi-room /
 * recurring. Selecting any one of them opens the unified BookingComposer.
 * (Auto-scroll-to-section was deferred when the legacy BookingConfirmDialog
 * was retired — composer doesn't yet honor an `initialFocus` prop.)
 *
 * The actions auto-select the top-ranked room from the picker. We surface
 * which room that is in the trailing hint so the user isn't surprised when
 * the dialog opens on a room they didn't explicitly click. When the picker
 * has no results we disable the buttons rather than silently doing nothing.
 */
export function BookingProgressiveActions({
  attendeeCount,
  multiRoomCount,
  recurring,
  topRoomName,
  disabled,
  onAddAttendees,
  onAddRoom,
  onMakeRecurring,
}: Props) {
  return (
    <div
      className="mt-5 flex flex-wrap items-center gap-2 border-t pt-5 text-xs text-muted-foreground"
      aria-label="More booking options"
    >
      <Button
        variant="outline" size="sm"
        onClick={onAddAttendees}
        disabled={disabled}
        className="h-8"
      >
        <UserPlus className="mr-1.5 size-3.5" />
        {attendeeCount > 0
          ? `${attendeeCount} internal attendee${attendeeCount === 1 ? '' : 's'}`
          : 'Add internal attendees'}
      </Button>
      <Button
        variant="outline" size="sm"
        onClick={onAddRoom}
        disabled={disabled}
        className="h-8"
      >
        <Plus className="mr-1.5 size-3.5" />
        {multiRoomCount > 0 ? `${multiRoomCount + 1} rooms in this booking` : 'Add another room'}
      </Button>
      <Button
        variant="outline" size="sm"
        onClick={onMakeRecurring}
        disabled={disabled}
        className="h-8"
      >
        <CalendarRange className="mr-1.5 size-3.5" />
        {recurring ? 'Recurring booking' : 'Make this recurring'}
      </Button>
      {topRoomName && !disabled && (
        <span className="ml-auto truncate text-[11px] text-muted-foreground">
          Will use top match: <span className="text-foreground">{topRoomName}</span>
        </span>
      )}
    </div>
  );
}

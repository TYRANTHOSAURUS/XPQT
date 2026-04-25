import { CalendarRange, Plus, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Props {
  attendeeCount: number;
  multiRoomCount: number;
  recurring: boolean;
  onAddAttendees: () => void;
  onAddRoom: () => void;
  onMakeRecurring: () => void;
}

/**
 * Spec §4.1 progressive disclosure footer. Three pill buttons that escalate
 * the booking from the simple-default flow into find-time / multi-room /
 * recurring. Selecting any one of them opens the same confirm dialog with
 * the relevant section expanded — see <BookingConfirmDialog />.
 */
export function BookingProgressiveActions({
  attendeeCount,
  multiRoomCount,
  recurring,
  onAddAttendees,
  onAddRoom,
  onMakeRecurring,
}: Props) {
  return (
    <div
      className="mt-5 flex flex-wrap gap-2 border-t pt-5 text-xs text-muted-foreground"
      aria-label="More booking options"
    >
      <Button variant="outline" size="sm" onClick={onAddAttendees} className="h-8">
        <UserPlus className="mr-1.5 size-3.5" />
        {attendeeCount > 0
          ? `${attendeeCount} internal attendee${attendeeCount === 1 ? '' : 's'}`
          : 'Add internal attendees'}
      </Button>
      <Button variant="outline" size="sm" onClick={onAddRoom} className="h-8">
        <Plus className="mr-1.5 size-3.5" />
        {multiRoomCount > 0 ? `${multiRoomCount + 1} rooms in this booking` : 'Add another room'}
      </Button>
      <Button variant="outline" size="sm" onClick={onMakeRecurring} className="h-8">
        <CalendarRange className="mr-1.5 size-3.5" />
        {recurring ? 'Recurring booking' : 'Make this recurring'}
      </Button>
    </div>
  );
}

import { useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { BookingComposer } from '@/components/booking-composer/booking-composer';
import type { SchedulerRoom } from '@/api/room-booking';
import { formatFullTimestamp } from '@/lib/format';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  room: SchedulerRoom | null;
  startAtIso: string;
  endAtIso: string;
  /** Operator's own person id — used as the implicit fallback when the
   *  composer's "Booking for" picker is left empty. */
  currentUserPersonId: string;
  /** Toolbar-scoped requester. Pre-seeds the composer's "Booking for"
   *  picker so a desk operator processing a queue on someone's behalf
   *  doesn't have to re-pick on every cell. */
  toolbarBookForPersonId: string | null;
  onCreated?: () => void;
}

/**
 * Drag-create dialog on the desk scheduler. Replaces the old bare
 * quick-create form (attendees + person only) with the unified
 * `<BookingComposer mode="operator" entrySource="desk-scheduler" />`,
 * giving operators access to services + recurrence + cost-center +
 * smart-default templates without leaving the calendar grid.
 *
 * Rendered as a Dialog (centered) instead of a true positioned popover
 * because the gesture's release point is unstable during a drag — a
 * centered modal avoids "popover lands off-screen on a fast release".
 */
export function SchedulerCreatePopover({
  open,
  onOpenChange,
  room,
  startAtIso,
  endAtIso,
  currentUserPersonId,
  toolbarBookForPersonId,
  onCreated,
}: Props) {
  const initial = useMemo(
    () => ({
      startAt: startAtIso,
      endAt: endAtIso,
      requesterPersonId: toolbarBookForPersonId ?? currentUserPersonId,
      // Use the room's min_attendees as the seed if set, else 2 (typical
      // desk handoff baseline).
      attendeeCount:
        room?.min_attendees && room.min_attendees > 0 ? room.min_attendees : 2,
    }),
    [
      startAtIso,
      endAtIso,
      toolbarBookForPersonId,
      currentUserPersonId,
      room?.min_attendees,
    ],
  );

  if (!room) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Book {room.name}</DialogTitle>
          <DialogDescription>
            {formatFullTimestamp(startAtIso)} – {formatFullTimestamp(endAtIso)}
          </DialogDescription>
        </DialogHeader>
        <BookingComposer
          open={open}
          onOpenChange={onOpenChange}
          mode="operator"
          entrySource="desk-scheduler"
          callerPersonId={currentUserPersonId}
          fixedRoom={room}
          initial={initial}
          onBooked={() => onCreated?.()}
        />
      </DialogContent>
    </Dialog>
  );
}

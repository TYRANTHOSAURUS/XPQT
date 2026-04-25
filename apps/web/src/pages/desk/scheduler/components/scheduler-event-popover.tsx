import { toast } from 'sonner';
import { Trash2 } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useCancelBooking, type Reservation } from '@/api/room-booking';
import { ApiError } from '@/lib/api';
import { formatFullTimestamp } from '@/lib/format';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reservation: Reservation | null;
  roomName?: string | null;
}

const STATUS_LABEL: Record<Reservation['status'], string> = {
  confirmed: 'Confirmed',
  checked_in: 'Checked in',
  pending_approval: 'Pending approval',
  draft: 'Draft',
  released: 'Released',
  cancelled: 'Cancelled',
  completed: 'Completed',
};

/**
 * Detail dialog fired when the operator clicks an event block. v1 shows
 * the booking details + a Cancel action. Edit (drag-resize / drag-move)
 * happens directly on the grid; recurrence-scope cancellation, restore,
 * approval, and audit deep-links land in Phase G+.
 */
export function SchedulerEventPopover({
  open,
  onOpenChange,
  reservation,
  roomName,
}: Props) {
  const cancel = useCancelBooking();
  if (!reservation) return null;

  const submitCancel = async () => {
    try {
      await cancel.mutateAsync({ id: reservation.id });
      toast.success('Booking cancelled');
      onOpenChange(false);
    } catch (e) {
      const message =
        e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Cancel failed';
      toast.error(message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {roomName ?? 'Reservation'}
            <Badge variant="outline" className="ml-auto">
              {STATUS_LABEL[reservation.status]}
            </Badge>
          </DialogTitle>
          <DialogDescription>
            {formatFullTimestamp(reservation.start_at)} – {formatFullTimestamp(reservation.end_at)}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <Detail label="Attendees" value={reservation.attendee_count ?? '—'} />
          <Detail label="Source" value={reservation.source} />
          {reservation.setup_buffer_minutes > 0 && (
            <Detail label="Setup buffer" value={`${reservation.setup_buffer_minutes} min`} />
          )}
          {reservation.teardown_buffer_minutes > 0 && (
            <Detail label="Teardown buffer" value={`${reservation.teardown_buffer_minutes} min`} />
          )}
          {reservation.check_in_required && (
            <Detail
              label="Check-in"
              value={
                reservation.checked_in_at
                  ? `Done ${formatFullTimestamp(reservation.checked_in_at)}`
                  : 'Required'
              }
            />
          )}
          {reservation.applied_rule_ids.length > 0 && (
            <Detail label="Applied rules" value={reservation.applied_rule_ids.length} />
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            variant="destructive"
            onClick={submitCancel}
            disabled={cancel.isPending || reservation.status === 'cancelled'}
          >
            <Trash2 className="size-4" />
            {cancel.isPending ? 'Cancelling…' : 'Cancel booking'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

import { cn } from '@/lib/utils';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { formatFullTimestamp, formatRelativeTime } from '@/lib/format';
import type { Reservation, ReservationStatus } from '@/api/room-booking';

interface Props {
  reservation: Pick<
    Reservation,
    'status' | 'released_at' | 'checked_in_at' | 'check_in_required' | 'check_in_grace_minutes' | 'cancellation_grace_until' | 'policy_snapshot'
  >;
}

const STATUS_LABELS: Record<ReservationStatus, string> = {
  draft: 'Draft',
  pending_approval: 'Pending approval',
  confirmed: 'Confirmed',
  checked_in: 'Checked in',
  released: 'Auto-released',
  cancelled: 'Cancelled',
  completed: 'Completed',
};

const STATUS_TONES: Record<ReservationStatus, string> = {
  draft: 'bg-muted text-muted-foreground',
  pending_approval: 'bg-purple-500/15 text-purple-700 dark:text-purple-400',
  confirmed: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  checked_in: 'bg-emerald-600/15 text-emerald-800 dark:text-emerald-300',
  released: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  cancelled: 'bg-muted text-muted-foreground',
  completed: 'bg-muted text-muted-foreground',
};

/**
 * Status pill with a hover popover that explains the reason — most
 * importantly for `released` (auto-released because no one checked in)
 * and `cancelled` (cancelled at … with grace until …).
 *
 * Per §4.2 self-explaining release notice / cancellation grace. The hover
 * is the user-facing "why this status" surface; identical semantics power
 * the email + Outlook decline.
 */
export function BookingStatusPill({ reservation }: Props) {
  const label = STATUS_LABELS[reservation.status];
  const tone = STATUS_TONES[reservation.status];

  const explanation = explainStatus(reservation);

  if (!explanation) {
    return (
      <span className={cn('rounded-md px-2 py-0.5 text-[11px] font-medium', tone)}>
        {label}
      </span>
    );
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={cn(
              'rounded-md px-2 py-0.5 text-[11px] font-medium hover:underline-offset-2',
              tone,
            )}
          >
            {label}
          </button>
        }
      />
      <PopoverContent className="w-72 text-xs">
        <p className="font-medium">{label}</p>
        <p className="mt-1 text-muted-foreground">{explanation}</p>
      </PopoverContent>
    </Popover>
  );
}

function explainStatus(reservation: Props['reservation']): string | null {
  if (reservation.status === 'released' && reservation.released_at) {
    return `Auto-released ${formatRelativeTime(reservation.released_at)} because no one checked in within ${reservation.check_in_grace_minutes} minutes. The room is back in the picker for everyone.`;
  }
  if (reservation.status === 'cancelled' && reservation.cancellation_grace_until) {
    const past = new Date(reservation.cancellation_grace_until).getTime() < Date.now();
    if (past) {
      return `Cancelled. Restore window expired ${formatFullTimestamp(reservation.cancellation_grace_until)}.`;
    }
    return `Cancelled. You can restore until ${formatFullTimestamp(reservation.cancellation_grace_until)}.`;
  }
  if (reservation.status === 'pending_approval') {
    const evals = reservation.policy_snapshot?.rule_evaluations ?? [];
    const hit = evals.find((e) => e.matched && e.effect === 'require_approval');
    return hit?.denial_message ?? 'Awaiting approval from the booking owner.';
  }
  if (reservation.status === 'checked_in' && reservation.checked_in_at) {
    return `Checked in ${formatRelativeTime(reservation.checked_in_at)}.`;
  }
  return null;
}

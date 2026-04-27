export type StatusTone = 'inprog' | 'waiting' | 'scheduled' | 'done' | 'breached';

export interface PortalStatus {
  label: string;
  tone: StatusTone;
}

/**
 * Tone → tailwind classes for the small status pill rendered in
 * activity feed rows, request rows, and request detail. Lifted out so a
 * tone added in one place lands consistently in the others.
 */
export const STATUS_TONE_CLASSES: Record<StatusTone, string> = {
  inprog:    'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  waiting:   'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  scheduled: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
  done:      'bg-muted text-muted-foreground',
  breached:  'bg-red-500/15 text-red-600 dark:text-red-400',
};

export type RequestKind = 'ticket' | 'booking' | 'visitor' | 'order';

/**
 * Per-kind icon tile colors. Same map used by the My Requests row and
 * the home Activity panel — when a new kind is added, both surfaces pick
 * it up automatically.
 */
export const REQUEST_KIND_TILE: Record<RequestKind, string> = {
  ticket:  'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  booking: 'bg-purple-500/15 text-purple-600 dark:text-purple-400',
  visitor: 'bg-pink-500/15 text-pink-600 dark:text-pink-400',
  order:   'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
};

/**
 * Maps a ticket's status_category (+ optional SLA breach flag) to the
 * label + tone shown in the portal. Shared between My Requests rows
 * and the request detail sidebar so labels are consistent across views.
 */
export function derivePortalStatus(
  statusCategory: string | null | undefined,
  slaBreachedAt?: string | null,
): PortalStatus {
  if (slaBreachedAt) return { label: 'Delayed', tone: 'breached' };
  switch (statusCategory) {
    case 'new':         return { label: 'Submitted', tone: 'scheduled' };
    case 'assigned':    return { label: 'Assigned',  tone: 'inprog' };
    case 'in_progress': return { label: 'In progress', tone: 'inprog' };
    case 'waiting':     return { label: 'Waiting',   tone: 'waiting' };
    case 'resolved':    return { label: 'Resolved',  tone: 'done' };
    case 'closed':      return { label: 'Closed',    tone: 'done' };
    default:            return { label: 'Submitted', tone: 'scheduled' };
  }
}

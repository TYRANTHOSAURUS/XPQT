export type StatusTone = 'inprog' | 'waiting' | 'scheduled' | 'done' | 'breached';

export interface PortalStatus {
  label: string;
  tone: StatusTone;
}

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

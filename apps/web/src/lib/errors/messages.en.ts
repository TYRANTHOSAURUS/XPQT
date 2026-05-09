/**
 * Client-side English error messages — Phase 7.B-2.
 *
 * Subset of the canonical server table (`apps/api/src/common/errors/messages.en.ts`),
 * trimmed to codes that actually surface to a user. Internal-only codes
 * (`outbox.*`, `setup_wo.*`, raw db codes, Vendor portal admin codes never
 * shown in this app) fall through `resolveMessage` to `unknown.server_error`
 * per fail-closed (spec §3.4).
 *
 * Voice rules — copied from server:
 *   - Title: outcome the user reads first.
 *   - Detail: optional one-line clarification.
 *   - NEVER vendor names. NEVER SQL fragments.
 *
 * Surface variants (toast / banner / dialog) are reserved for future entries
 * that need different copy on different surfaces; v1 keeps a single
 * (title, detail) pair per code and `resolveMessage` ignores the surface
 * argument when no override is registered.
 *
 * Spec: docs/superpowers/specs/2026-05-02-error-handling-system-design.md §5
 */

export type Surface = 'toast' | 'banner' | 'dialog';

export interface ErrorMessage {
  title: string;
  detail?: string;
  /** Optional surface-specific overrides. */
  surface?: { toast?: string; banner?: string; dialog?: string };
}

export const ERROR_MESSAGES_EN: Record<string, ErrorMessage> = {
  // ─── auth / permission ──────────────────────────────────────────────────
  'auth.unauthorized': {
    title: 'Sign in to continue',
    detail: 'Your session needs a fresh sign-in.',
  },
  'auth.expired': {
    title: 'Your session expired',
    detail: 'Sign in again to continue where you left off.',
  },
  'auth.invalid': {
    title: 'Sign-in failed',
    detail: "Those credentials didn't work. Try again.",
  },
  'permission.denied': {
    title: "You don't have access to this",
    detail: 'Ask an admin if you need access.',
  },
  'permission.missing_role': {
    title: "You don't have access to this",
    detail: 'Your role is missing the permission for this action.',
  },

  // ─── generic legacy buckets ──────────────────────────────────────────────
  'generic.bad_request': {
    title: "Couldn't complete that",
    detail: 'The request was rejected.',
  },
  'generic.unauthorized': { title: 'Sign in to continue' },
  'generic.forbidden': { title: "You don't have access to this" },
  'generic.not_found': { title: "We can't find that" },
  'generic.conflict': {
    title: 'Something else changed',
    detail: 'This was updated by someone else. Reload and try again.',
  },

  // ─── validation ──────────────────────────────────────────────────────────
  'validation.failed': { title: 'Some fields need attention' },

  // ─── rate limit / quota / request ────────────────────────────────────────
  'rate_limit.exceeded': {
    title: 'Too many requests',
    detail: 'Slow down for a moment, then try again.',
  },
  'quota.exceeded': {
    title: 'Quota exceeded',
    detail: "You've hit a usage limit on this workspace.",
  },
  'request.too_large': {
    title: 'That request is too large',
    detail: 'Try a smaller payload or fewer items.',
  },
  'request.cancelled': { title: 'Request cancelled' },

  // ─── network ─────────────────────────────────────────────────────────────
  'network.offline': {
    title: "You're offline",
    detail: 'Changes will sync when you reconnect.',
  },
  'network.timeout': {
    title: "Couldn't reach the server",
    detail: 'The request timed out. Try again.',
  },

  // ─── render / unknown ────────────────────────────────────────────────────
  'render.failed': {
    title: 'Something went wrong on this page',
    detail: 'Reload the page to recover.',
  },
  'unknown.server_error': {
    title: 'Something went wrong on our end',
    detail: 'Try again. If it keeps happening, contact support with the trace ID.',
  },

  // ─── ticket / booking — common user-visible codes ────────────────────────
  'ticket.not_found': { title: "We can't find that ticket" },
  'ticket.title_required': { title: "Couldn't save — title required" },
  'ticket.assignment_invalid': {
    title: "Couldn't assign — pick someone else",
    detail: "That assignee can't take this ticket.",
  },
  'ticket.routing_no_match': { title: "Couldn't route — no team matches" },
  'ticket.write_forbidden': { title: "You can't edit this ticket" },
  'ticket.read_forbidden': { title: "You don't have access to this ticket" },
  'ticket.children_open_cannot_close': {
    title: "Couldn't close — child tickets still open",
    detail: 'Resolve or close the child tickets first.',
  },

  'booking.slot_conflict': {
    title: "Couldn't book — time conflict",
    detail: 'The selected room is already booked for that time.',
  },
  'booking.conflict': { title: "Couldn't book — conflict" },
  'booking.window_closed': { title: 'Booking window is closed' },
  'booking.capacity_exceeded': {
    title: 'Capacity exceeded',
    detail: 'Pick a larger room or remove attendees.',
  },
  'booking.permission_denied': { title: "You can't book this room" },
  'booking.edit_forbidden': { title: "You can't edit this booking" },
  'booking.not_found': { title: "We can't find that booking" },
  'booking.not_editable': { title: "This booking can't be edited" },
  'booking.completed_cannot_edit': {
    title: "Couldn't edit — booking already completed",
  },
  'booking.cancellation_grace_expired': {
    title: "Couldn't cancel — too late to cancel",
  },
  'booking.slot_taken': {
    title: "Couldn't book — slot taken",
    detail: 'Someone else booked that time. Pick another.',
  },
  'reservation.version_conflict': {
    title: 'This was changed by someone else',
    detail: 'Reload to see the latest version.',
  },

  // ─── approval ────────────────────────────────────────────────────────────
  'approval.not_found': { title: "Couldn't find that approval" },
  'approval.already_responded': {
    title: 'Already responded',
    detail: 'This approval was already decided.',
  },
  'approval.not_an_approver': { title: "You can't respond to this approval" },

  // ─── visitor ─────────────────────────────────────────────────────────────
  'visitor.not_found': { title: "Couldn't find that visitor" },
  'visitor.forbidden': { title: "You don't have access to this" },
  'visitor.invalid_state': {
    title: "Couldn't update that visitor",
    detail: "That state transition isn't allowed.",
  },
  'visitor.host_required': {
    title: "You don't have access to this",
    detail: 'You are not a host on this visit.',
  },
  'visitor.invalid_token': {
    title: 'Invitation link is invalid',
    detail: 'This link has expired or is no longer valid.',
  },
  'visitor.pass_unavailable': { title: 'Pass unavailable' },
  'visitor.duplicate': {
    title: "Couldn't save",
    detail: 'A duplicate already exists.',
  },

  // ─── tenant / portal ─────────────────────────────────────────────────────
  'tenant.not_found': { title: "We can't find that workspace" },
  'portal.location_not_authorized': {
    title: "You don't have access to that location",
  },
  'portal.request_type_not_found': { title: "We can't find that request type" },

  // ─── space ──────────────────────────────────────────────────────────────
  'space.not_found': { title: "We can't find that space" },
  'space_not_found': { title: "We can't find that space" },
  'space_not_reservable': { title: "That space can't be booked" },
  'space_inactive': { title: 'That space is inactive' },

  // ─── routing ─────────────────────────────────────────────────────────────
  'routing.no_match': { title: "Couldn't route — no team matches" },
  'routing.cycle_detected': { title: 'Routing loop detected' },
  'routing.not_found': { title: "We can't find that routing rule" },
  'routing.duplicate': {
    title: "Couldn't save — a routing rule with that key already exists",
  },

  // ─── webhook ─────────────────────────────────────────────────────────────
  'webhook.not_found': { title: "We can't find that webhook" },
  'webhook.inactive': { title: 'That webhook is inactive' },

  // ─── workflow ────────────────────────────────────────────────────────────
  'workflow.not_found': { title: "We can't find that workflow" },
  'workflow.invalid': { title: "Couldn't save — workflow is invalid" },
  'workflow_instance.not_found': { title: "We can't find that workflow run" },

  // ─── cost-centers ────────────────────────────────────────────────────────
  'cost_center_not_found': { title: "We can't find that cost center" },
  'cost_center_code_taken': {
    title: "Couldn't save — that code is taken",
    detail: 'Pick a different cost center code.',
  },

  // ─── reference / fk ──────────────────────────────────────────────────────
  'reference.not_in_tenant': {
    title: "Couldn't save — referenced item not available",
    detail: "One of the references doesn't exist in this workspace.",
  },
  'reference.invalid_uuid': {
    title: "Couldn't save — invalid reference",
    detail: 'A required identifier is malformed.',
  },
};

/**
 * Resolve an English message for a code. Falls back to `unknown.server_error`
 * for unregistered codes (fail-closed per spec §3.4 / decision #9).
 *
 * The optional `surface` arg picks a per-surface override when one's been
 * registered; otherwise it returns the canonical (title, detail) pair.
 */
export function resolveMessage(
  code: string,
  surface?: Surface,
): { title: string; detail?: string } {
  const entry = ERROR_MESSAGES_EN[code];
  if (!entry) {
    return ERROR_MESSAGES_EN['unknown.server_error'];
  }
  if (surface && entry.surface?.[surface]) {
    return { title: entry.surface[surface] as string, detail: entry.detail };
  }
  return { title: entry.title, detail: entry.detail };
}

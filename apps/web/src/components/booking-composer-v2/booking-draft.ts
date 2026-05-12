import type { RecurrenceRule } from '@/api/room-booking';
import type { PickerSelection } from '../booking-composer/service-picker-sheet';
import type { PendingVisitor } from '../booking-composer/state';
import type { ComposerMode } from '../booking-composer/state';

/**
 * The unified draft state for the redesigned booking flow. Replaces
 * `ComposerState` from the old `booking-composer/state.ts`. Single root
 * object keeps the popover ↔ modal escalation lossless: the popover
 * holds a small subset, the modal extends it.
 *
 * Field naming intentionally matches the old `ComposerState` so the
 * existing `submit.ts` payload builders work without changes — only the
 * shell (popover + modal + cards) is rewritten.
 *
 * NEW vs ComposerState:
 *  - `title` (the spec-required title field, becomes the placeholder
 *    `"{Host first}'s {Room} booking"` if blank).
 *  - `description` (free-text textarea on the left pane).
 *
 * REMOVED vs ComposerState:
 *  - `errors` (handled by RHF + setFormError per error-handling spec).
 *  - `additionalSpaceIds` (multi-room is not in this redesign).
 */
export interface BookingDraft {
  title: string;
  description: string;
  spaceId: string | null;
  startAt: string | null;
  endAt: string | null;
  hostPersonId: string | null;
  requesterPersonId: string | null;
  attendeeCount: number;
  attendeePersonIds: string[];
  recurrence: RecurrenceRule | null;
  services: PickerSelection[];
  visitors: PendingVisitor[];
  costCenterId: string | null;
  templateId: string | null;
}

/**
 * Round a time UP to the next 15-minute boundary. If we're already on
 * a boundary, advance to the next slot — otherwise a freshly-opened
 * modal at exactly :00 / :15 / :30 / :45 would seed a "now" start that
 * scrolls into the past as the user types.
 */
export function nextQuarterHour(now = new Date()): Date {
  const d = new Date(now);
  d.setSeconds(0, 0);
  const remainder = d.getMinutes() % 15;
  if (remainder !== 0) {
    d.setMinutes(d.getMinutes() + (15 - remainder));
  } else {
    // already on a 15-min boundary; bump to next slot to avoid past times
    d.setMinutes(d.getMinutes() + 15);
  }
  return d;
}

export function emptyDraft(): BookingDraft {
  // Seed a sensible default time so TimesSummaryCard opens filled. The
  // prior null/null seed forced every fresh draft into the empty-state
  // branch, which was a discoverability dead-end on the redesign.
  const start = nextQuarterHour();
  const end = new Date(start.getTime() + 60 * 60_000);
  return {
    title: '',
    description: '',
    spaceId: null,
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    hostPersonId: null,
    requesterPersonId: null,
    attendeeCount: 1,
    attendeePersonIds: [],
    recurrence: null,
    services: [],
    visitors: [],
    costCenterId: null,
    templateId: null,
  };
}

export interface BookingDraftSeed {
  title?: string;
  description?: string;
  spaceId?: string | null;
  startAt?: string | null;
  endAt?: string | null;
  hostPersonId?: string | null;
  requesterPersonId?: string | null;
  attendeeCount?: number;
  attendeePersonIds?: string[];
  recurrence?: RecurrenceRule | null;
  services?: PickerSelection[];
  visitors?: PendingVisitor[];
  costCenterId?: string | null;
  templateId?: string | null;
}

/**
 * Build a `BookingDraft` from the same seed shape callers used to pass
 * to `BookingComposer`'s `initial` prop. Used by the popover→modal
 * escalation and by the modal's "open with these defaults" entry.
 */
export function draftFromComposerSeed(seed: BookingDraftSeed = {}): BookingDraft {
  const base = emptyDraft();
  return {
    ...base,
    ...seed,
    attendeeCount: Math.max(1, seed.attendeeCount ?? base.attendeeCount),
    attendeePersonIds: seed.attendeePersonIds ?? base.attendeePersonIds,
    services: seed.services ?? base.services,
    visitors: seed.visitors ?? base.visitors,
  };
}

/**
 * Field discriminator for routing inline errors back to the right row.
 *
 *  - `'room'` — RoomSummaryCard / RoomPickerInline.
 *  - `'time'` — TimeRow.
 *  - `'attendees'` — count input (no dedicated row yet; surfaced in
 *    the footer banner until one exists).
 *  - `'requester'` — operator-mode header chip.
 *  - `null` — error doesn't bind to a single field; footer banner only.
 */
export type DraftValidationField =
  | 'room'
  | 'time'
  | 'attendees'
  | 'requester'
  | null;

export interface DraftValidationError {
  field: DraftValidationField;
  message: string;
}

/**
 * Validate a draft for submission readiness. Returns the FIRST blocking
 * error (caller-walked, not aggregated — Submit is binary). Each error
 * carries a `field` discriminator so the modal can route it to an
 * inline `<FieldError>` near the offending row per CLAUDE.md form
 * mandate; the footer status line is the catch-all surface for fields
 * that don't have a dedicated row yet (attendees, requester).
 *
 * Rules — in evaluation order:
 *  1. **room** — `spaceId` is required.
 *  2. **time** — both `startAt` and `endAt` must be present.
 *  3. **time** — `endAt` must be strictly after `startAt`. /full-review
 *     v4 I1 closure: the prior validator didn't block end ≤ start, so
 *     the client could submit a negative-duration window and rely on
 *     the server's 422 to surface it. Backend already validates (see
 *     reservation.service.ts:699-712); this just stops the user from
 *     burning a round-trip on a clearly-broken window.
 *  4. **time** — `startAt` must not be in the past (60-second grace
 *     for clock skew + first-frame seeded "now"). Same /full-review v4
 *     I1 motivation as (3): backend will reject; surface it client-side
 *     to short-circuit the round-trip and give a precise field-level
 *     error instead of a generic toast.
 *  5. **attendees** — count must be >= 1.
 *  6. **requester** — operator mode only.
 *
 * NOTE on rules not enforced here:
 *  - Visitor email is OPTIONAL in CreateInvitationPayload (apps/web/
 *    src/api/visitors/index.ts:99-119), so a missing email is not a
 *    draft-validity gate. The bulk-invite hook will surface per-row
 *    server-side rejection.
 *  - Attendee count vs room capacity is a soft warning, not a hard
 *    block (some teams overbook intentionally; the server doesn't
 *    enforce). Surface as a Suggested chip / inline hint in a follow-up
 *    when the capacity-warning UX is designed.
 */
export function validateDraft(
  draft: BookingDraft,
  mode: ComposerMode,
): DraftValidationError | null {
  if (!draft.spaceId) {
    return { field: 'room', message: 'Pick a room.' };
  }
  if (!draft.startAt || !draft.endAt) {
    return { field: 'time', message: 'Pick a date and time.' };
  }
  const s = new Date(draft.startAt).getTime();
  const e = new Date(draft.endAt).getTime();
  // Codex remediation — reject malformed ISO. Pre-fix the next block
  // was wrapped in `Number.isFinite(s) && Number.isFinite(e)`, so NaN
  // timestamps fell through to the attendee check and could submit.
  // The TimeRow controls produce well-formed ISO today, but a future
  // CSV-import / URL-prefill path could feed in junk strings; reject
  // explicitly rather than rely on the server's 422.
  if (!Number.isFinite(s) || !Number.isFinite(e)) {
    return { field: 'time', message: 'Pick a valid date and time.' };
  }
  if (e <= s) {
    return { field: 'time', message: 'End time must be after start.' };
  }
  // 60-second grace handles clock skew between client and server plus
  // the fresh-modal case where `nextQuarterHour()` may seed a start
  // that's a few hundred ms behind the wall clock by the time the
  // user clicks Submit.
  if (s < Date.now() - 60_000) {
    return { field: 'time', message: 'Pick a time in the future.' };
  }
  if (draft.attendeeCount < 1) {
    return { field: 'attendees', message: 'At least one attendee.' };
  }
  if (mode === 'operator' && !draft.requesterPersonId) {
    return { field: 'requester', message: 'Pick who the booking is for.' };
  }
  return null;
}

/**
 * The placeholder title for the title input — the spec calls this
 * "what-you-see-is-what-you-get". When the user submits with a blank
 * title, this string IS the title that gets persisted.
 */
export function defaultTitle(args: {
  hostFirstName: string | null;
  roomName: string | null;
}): string {
  const host = args.hostFirstName?.trim();
  const room = args.roomName?.trim();
  if (!host && !room) return 'Booking';
  if (!host) return `${room} booking`;
  if (!room) return `${host}'s booking`;
  return `${host}'s ${room} booking`;
}

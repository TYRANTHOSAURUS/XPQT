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
 * Validation parity with the legacy `validateForSubmit`. Returns the
 * first user-facing reason the draft cannot submit, or null. The modal
 * uses this to disable Submit; field-level errors paint inline via
 * `setFormError` per the error-handling spec.
 */
export function validateDraft(draft: BookingDraft, mode: ComposerMode): string | null {
  if (!draft.spaceId) return 'Pick a room.';
  if (!draft.startAt || !draft.endAt) return 'Pick a date and time.';
  if (draft.attendeeCount < 1) return 'At least one attendee.';
  if (mode === 'operator' && !draft.requesterPersonId) {
    return 'Pick who the booking is for.';
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

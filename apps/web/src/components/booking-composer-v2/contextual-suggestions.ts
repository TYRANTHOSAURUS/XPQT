import type { BookingDraft } from './booking-draft';
import type { MealWindow } from '@/api/meal-windows';

/**
 * Slim shape the suggestion engine needs from a room. Decoupled from
 * `Space` / `RankedRoom` / `SchedulerRoom` so the function stays pure
 * and testable. Callers pass the relevant boolean signals derived from
 * whatever room shape they have.
 *
 * `has_av_equipment`, `has_catering_vendor`,
 * `needs_visitor_pre_registration` are runtime hints — when the
 * scheduler / portal don't have them yet, pass `false` and the
 * suggestion just doesn't fire. They're additive over time.
 */
export interface SuggestionRoomFacts {
  space_id: string;
  name: string;
  has_av_equipment: boolean;
  has_catering_vendor: boolean;
  needs_visitor_pre_registration: boolean;
}

/** Which add-in card the suggestion targets. */
export type SuggestionTarget = 'catering' | 'av_equipment' | 'visitors';

export interface Suggestion {
  target: SuggestionTarget;
  /** Human-readable reason. Used as the chip's hover tooltip. Always
   *  English in v1 — translation comes when the rest of the modal is
   *  translated. */
  reason: string;
}

/** Convert ISO timestamp → minutes since local midnight. */
function localMinutes(iso: string): number | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.getHours() * 60 + d.getMinutes();
}

/** "HH:MM:SS" or "HH:MM" → minutes since midnight. */
function timeStringToMinutes(t: string): number {
  const [hh, mm] = t.split(':').map((s) => Number.parseInt(s, 10));
  return (hh || 0) * 60 + (mm || 0);
}

function durationMinutes(startAt: string, endAt: string): number {
  const s = new Date(startAt).getTime();
  const e = new Date(endAt).getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return 0;
  return Math.round((e - s) / 60_000);
}

/**
 * Pure function. The single brain for the right-pane "Suggested" chips.
 * Computes signals from already-loaded data — no network, no side
 * effects. The redesign spec calls this out as the discoverability fix
 * for the catering-attachment problem.
 *
 * Inputs:
 *  - `draft`: the user's in-progress booking (start/end/visitors).
 *  - `room`: the picked room's runtime facts. Null when the user
 *    hasn't picked yet (which is rare — the popover usually pre-selects
 *    via the tile click).
 *  - `mealWindows`: tenant-configured local-time windows from
 *    `useMealWindows()`.
 *
 * Output:
 *  - `Suggestion[]`: zero or more chip recommendations. The right-pane
 *    `<AddinCard>` matches its `target` and renders the "Suggested"
 *    chip + tooltip when present.
 */
export function getSuggestions(
  draft: BookingDraft,
  room: SuggestionRoomFacts | null,
  mealWindows: MealWindow[],
): Suggestion[] {
  if (!room) return [];
  const { startAt, endAt } = draft;
  if (!startAt || !endAt) return [];

  const out: Suggestion[] = [];

  // Catering — meal window overlap (compares local-clock minutes both
  // sides; the booking's local hour and the window's local time are
  // already in the same timezone since both come from the same browser
  // / tenant).
  const startMin = localMinutes(startAt);
  const endMin = localMinutes(endAt);
  if (startMin != null && endMin != null) {
    for (const w of mealWindows) {
      if (!w.active) continue;
      const wStart = timeStringToMinutes(w.start_time);
      const wEnd = timeStringToMinutes(w.end_time);
      // Standard interval overlap: [a,b] vs [c,d] iff a<d AND c<b.
      if (startMin < wEnd && wStart < endMin) {
        out.push({
          target: 'catering',
          reason: `Booking spans ${w.label.toLowerCase()} — many teams add catering here.`,
        });
        break; // one catering suggestion is enough
      }
    }
  }

  // Catering — vendor signal (room has a catering vendor in routing).
  // De-duped against meal-window suggestion above.
  if (
    room.has_catering_vendor &&
    !out.some((s) => s.target === 'catering')
  ) {
    out.push({
      target: 'catering',
      reason: `${room.name} has a linked catering vendor.`,
    });
  }

  // AV — equipment + duration > 30 min.
  if (room.has_av_equipment && durationMinutes(startAt, endAt) > 30) {
    out.push({
      target: 'av_equipment',
      reason: `${room.name} has AV equipment configured.`,
    });
  }

  // Visitors — pre-reg wing AND no visitors added yet.
  if (room.needs_visitor_pre_registration && draft.visitors.length === 0) {
    out.push({
      target: 'visitors',
      reason: 'Visitors are typically pre-registered for this room.',
    });
  }

  return out;
}

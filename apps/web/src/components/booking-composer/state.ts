import type { RecurrenceRule } from '@/api/room-booking';
import type { PickerSelection } from './service-picker-sheet';

/**
 * Surfaces the composer can render in. The wrapper component picks the
 * variant; the composer itself renders the same sections regardless.
 *
 *   - `dialog`: centered modal. Drag-create on the desk scheduler, the
 *     existing portal booking-confirm flow.
 *   - `sheet`:  side / bottom sheet. The new "+ New booking" button on
 *     /desk/bookings (bottom-sheet on mobile, right-sheet on desktop).
 */
export type ComposerSurface = 'dialog' | 'sheet';

/**
 * Mode shapes the composer's UX:
 *   - `self`:     the caller is booking for themselves. On-behalf picker is
 *                 hidden; cost-center stays implicit (template-driven).
 *   - `operator`: a desk operator is booking on behalf of someone. Surfaces
 *                 the requester (book-for) picker, optional cost-center
 *                 override when services are present, and threads the
 *                 picked person into PickerInput.requester_id so room
 *                 ranking + rule preview reflect their universe.
 */
export type ComposerMode = 'self' | 'operator';

/**
 * Where the composer was launched from. Threads through to the booking
 * payload's `source` field so analytics + audit can distinguish a desk
 * operator booking from a portal self-booking.
 */
export type ComposerEntrySource = 'portal' | 'desk-list' | 'desk-scheduler';

export interface ComposerState {
  // ── Cart ──────────────────────────────────────────────────────────────
  /** Single-room only in v1; multi-room intentionally deferred per codex. */
  spaceId: string | null;
  startAt: string | null;
  endAt: string | null;
  attendeeCount: number;
  attendeePersonIds: string[];
  /** The person the booking is FOR (operator mode only). Resolves to the
   *  reservation's requester_person_id on submit. Distinct from the
   *  reservation's host_person_id which models the meeting host (a real
   *  attendee with calendar visibility) — they're often the same person
   *  but not always. */
  requesterPersonId: string | null;
  hostPersonId: string | null;
  /** Resolved cost_center_id. The picker accepts a person.cost_center
   *  code and looks up the id via /admin/cost-centers; the reducer never
   *  stores the code. */
  costCenterId: string | null;
  /** Recurrence rule. Disabled when the composer is in multi-room mode
   *  (which doesn't ship in δ-light at all — single-room only). */
  recurrence: RecurrenceRule | null;
  /** Service selections — same shape the ServicePickerSheet returns. */
  services: PickerSelection[];
  /** Optional bundle metadata (template id, etc). */
  templateId: string | null;
  notes: string;

  // ── UI ────────────────────────────────────────────────────────────────
  errors: Record<string, string>;
}

export type ComposerAction =
  | { type: 'SET_SPACE'; spaceId: string | null }
  | { type: 'SET_TIME'; startAt: string | null; endAt: string | null }
  | { type: 'SET_ATTENDEES'; count: number; personIds?: string[] }
  | { type: 'SET_REQUESTER'; personId: string | null }
  | { type: 'SET_HOST'; personId: string | null }
  | { type: 'SET_COST_CENTER'; costCenterId: string | null }
  | { type: 'SET_RECURRENCE'; rule: RecurrenceRule | null }
  | { type: 'SET_SERVICES'; services: PickerSelection[] }
  | { type: 'SET_TEMPLATE_ID'; templateId: string | null }
  | { type: 'SET_NOTES'; notes: string }
  | { type: 'SET_ERROR'; key: string; message: string | null }
  | { type: 'RESET'; partial?: Partial<ComposerState> };

export interface InitialComposerState {
  /** Defaults applied on construction. The reducer derives a fresh state
   *  on `RESET`. Useful for surface-specific seeds (e.g. drag-create
   *  pre-selects spaceId + startAt + endAt). */
  spaceId?: string | null;
  startAt?: string | null;
  endAt?: string | null;
  attendeeCount?: number;
  attendeePersonIds?: string[];
  requesterPersonId?: string | null;
  hostPersonId?: string | null;
  costCenterId?: string | null;
  templateId?: string | null;
  services?: PickerSelection[];
  recurrence?: import('@/api/room-booking').RecurrenceRule | null;
}

export function initialState(seed: InitialComposerState = {}): ComposerState {
  return {
    spaceId: seed.spaceId ?? null,
    startAt: seed.startAt ?? null,
    endAt: seed.endAt ?? null,
    attendeeCount: seed.attendeeCount ?? 1,
    attendeePersonIds: seed.attendeePersonIds ?? [],
    requesterPersonId: seed.requesterPersonId ?? null,
    hostPersonId: seed.hostPersonId ?? null,
    costCenterId: seed.costCenterId ?? null,
    recurrence: seed.recurrence ?? null,
    services: seed.services ?? [],
    templateId: seed.templateId ?? null,
    notes: '',
    errors: {},
  };
}

/**
 * Adapter for the bundle-template payload's `services` shape →
 * composer's `PickerSelection[]`. Used by the portal book-room flow to
 * pass `activeTemplate.payload.services` into `initial.services`.
 *
 * Quantity semantics — codex caught a real bug here on 2026-04-28:
 *
 * Template items can carry `quantity` (a fixed total) or
 * `quantity_per_attendee` (a per-head ratio). The picker's
 * `estimateLine` already multiplies `per_person` units by
 * `attendeeCount` server-side; pre-multiplying templates by attendees
 * over-orders by attendees² for any `per_person` line. Since unit is
 * not on the template payload (only on the resolved menu offer), the
 * safest seed is to PRESERVE the per-attendee value as the raw line
 * quantity. The picker shows "1 × Lunch Bowl · €N" for `per_person`
 * (correct: backend multiplies by attendees) and "1 × Sandwich" for
 * `per_item` (under-seeded; user bumps in the picker).
 *
 * Trade-off: under-seeded `per_item` requires one extra tap. But
 * over-charge (the prior bug) trains finance to distrust the system
 * and is the worse failure mode.
 */
export function templateServicesToPickerSelections(
  templateServices: Array<{
    catalog_item_id: string;
    menu_id?: string | null;
    quantity?: number;
    quantity_per_attendee?: number;
  }>,
  // attendeeCount kept in the signature for API stability — older callers
  // passed it for the old (buggy) multiplication. Currently unused.
  _attendeeCount: number,
): PickerSelection[] {
  return templateServices.map((s) => ({
    catalog_item_id: s.catalog_item_id,
    menu_id: s.menu_id ?? '',
    quantity: s.quantity_per_attendee ?? s.quantity ?? 1,
    unit_price: null, // resolved when the picker fetches current menus
    unit: null,
    name: 'Template item',
    service_type: 'other',
  }));
}

export function composerReducer(state: ComposerState, action: ComposerAction): ComposerState {
  switch (action.type) {
    case 'SET_SPACE':
      return { ...state, spaceId: action.spaceId };
    case 'SET_TIME':
      return { ...state, startAt: action.startAt, endAt: action.endAt };
    case 'SET_ATTENDEES':
      return {
        ...state,
        attendeeCount: Math.max(1, action.count),
        attendeePersonIds: action.personIds ?? state.attendeePersonIds,
      };
    case 'SET_REQUESTER':
      return { ...state, requesterPersonId: action.personId };
    case 'SET_HOST':
      return { ...state, hostPersonId: action.personId };
    case 'SET_COST_CENTER':
      return { ...state, costCenterId: action.costCenterId };
    case 'SET_RECURRENCE': {
      // XOR the end modes — a rule with BOTH count and until is
      // semantically ambiguous (which bound wins?). When both are set,
      // prefer `until` (the explicit calendar bound) and drop `count`.
      // Codex flagged the duplicate end-mode possibility on 2026-04-28.
      const r = action.rule;
      if (r && r.until && r.count != null) {
        return { ...state, recurrence: { ...r, count: undefined } };
      }
      return { ...state, recurrence: r };
    }
    case 'SET_SERVICES':
      return { ...state, services: action.services };
    case 'SET_TEMPLATE_ID':
      return { ...state, templateId: action.templateId };
    case 'SET_NOTES':
      return { ...state, notes: action.notes };
    case 'SET_ERROR': {
      const next = { ...state.errors };
      if (action.message == null) delete next[action.key];
      else next[action.key] = action.message;
      return { ...state, errors: next };
    }
    case 'RESET':
      return { ...initialState(), ...(action.partial ?? {}) };
    default:
      return state;
  }
}

/** Validation: returns the first user-facing error, or null when ready
 *  to submit. Doesn't mutate state — surfaces inline so the wrapper can
 *  disable Submit + render `errors` accordingly. */
export function validateForSubmit(
  state: ComposerState,
  mode: ComposerMode,
): string | null {
  if (!state.spaceId) return 'Pick a room.';
  if (!state.startAt || !state.endAt) return 'Pick a date and time.';
  if (state.attendeeCount < 1) return 'At least one attendee.';
  if (mode === 'operator' && !state.requesterPersonId) {
    return 'Pick who the booking is for.';
  }
  return null;
}

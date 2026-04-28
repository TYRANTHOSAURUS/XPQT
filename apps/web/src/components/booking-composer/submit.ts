import type { BookingPayload, ServiceLinePayload } from '@/api/room-booking';
import type { ComposerEntrySource, ComposerMode, ComposerState } from './state';

/**
 * Map a composer state + caller context into the `POST /reservations`
 * payload. Single-room only — multi-room is intentionally out of scope
 * for δ-light. Recurrence is supported and threads through.
 *
 * Source attribution: portal flows pass 'portal'; desk flows pass
 * 'desk'. The `entrySource` discriminator on the wrapper feeds this.
 *
 * Cost-center: only set when services are present AND a value was
 * picked (or seeded from a template). Empty string is normalised to
 * null so the bundle insert doesn't fail an FK lookup.
 *
 * Returns null if the state isn't submittable — the caller validated
 * upstream and should never hit this path, but the null guard is here
 * as defense.
 */
export function buildBookingPayload(args: {
  state: ComposerState;
  mode: ComposerMode;
  entrySource: ComposerEntrySource;
  /** Caller's own person id, used as the implicit requester in self mode. */
  callerPersonId: string;
}): BookingPayload | null {
  const { state, mode, entrySource, callerPersonId } = args;

  if (!state.spaceId || !state.startAt || !state.endAt) return null;

  // Operator mode: the picked "book for" person is the requester.
  // Self mode: the caller is the requester (degenerate self-booking).
  const requesterPersonId =
    mode === 'operator' ? state.requesterPersonId ?? callerPersonId : callerPersonId;

  const services: ServiceLinePayload[] = state.services.map((s) => ({
    catalog_item_id: s.catalog_item_id,
    menu_id: s.menu_id || undefined,
    quantity: s.quantity,
    service_window_start_at: s.service_window_start_at ?? null,
    service_window_end_at: s.service_window_end_at ?? null,
  }));

  const hasServices = services.length > 0;
  const costCenterId = state.costCenterId && state.costCenterId.length > 0
    ? state.costCenterId
    : null;

  return {
    space_id: state.spaceId,
    requester_person_id: requesterPersonId,
    host_person_id: state.hostPersonId ?? null,
    start_at: state.startAt,
    end_at: state.endAt,
    attendee_count: state.attendeeCount,
    attendee_person_ids:
      state.attendeePersonIds.length > 0 ? state.attendeePersonIds : undefined,
    recurrence_rule: state.recurrence ?? undefined,
    source: entrySourceToReservationSource(entrySource),
    services: hasServices ? services : undefined,
    bundle: hasServices
      ? {
          bundle_type: 'meeting',
          template_id: state.templateId ?? undefined,
          cost_center_id: costCenterId,
        }
      : undefined,
  };
}

function entrySourceToReservationSource(
  entry: ComposerEntrySource,
): BookingPayload['source'] {
  switch (entry) {
    case 'portal':
      return 'portal';
    case 'desk-list':
    case 'desk-scheduler':
      return 'desk';
    default:
      return 'portal';
  }
}

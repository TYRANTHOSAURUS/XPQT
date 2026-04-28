import { ForbiddenException } from '@nestjs/common';
import type { ActorContext } from './dto/types';

/**
 * Gate the `requester_person_id` field on reservation create / dry-run /
 * multi-room. The reservations API has historically accepted this field
 * from the request body to support the desk scheduler's PersonPicker —
 * but without enforcement, ANY authenticated portal user can pass an
 * arbitrary person id and impersonate a different requester. This gate
 * resolves the mismatch:
 *
 *   - missing / null  → fall back to the actor's own person_id.
 *   - equal to actor   → allow (degenerate self-booking; no escalation).
 *   - different person → require `rooms.book_on_behalf` permission, surfaced
 *                        as `actor.is_service_desk = true` per
 *                        ReservationController.actorFromRequest. Anyone else
 *                        gets a 403 with `book_on_behalf_forbidden`.
 *
 * Pure function so the four branches can be unit-tested without spinning
 * up a Nest test module.
 */
export function resolveRequesterForActor(
  requested: string | null | undefined,
  actor: ActorContext,
): string {
  if (!requested || requested === actor.person_id) {
    return actor.person_id ?? '';
  }
  if (!actor.is_service_desk) {
    throw new ForbiddenException({
      code: 'book_on_behalf_forbidden',
      message: 'You do not have permission to book on behalf of another person.',
    });
  }
  return requested;
}

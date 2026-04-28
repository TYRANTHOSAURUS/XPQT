import { ForbiddenException } from '@nestjs/common';
import { resolveRequesterForActor } from './book-on-behalf.gate';
import type { ActorContext } from './dto/types';

describe('resolveRequesterForActor', () => {
  const SELF = '11111111-1111-1111-1111-111111111111';
  const OTHER = '22222222-2222-2222-2222-222222222222';

  const actor = (overrides: Partial<ActorContext> = {}): ActorContext => ({
    user_id: 'u-self',
    person_id: SELF,
    is_service_desk: false,
    has_override_rules: false,
    ...overrides,
  });

  it('returns the actor person_id when the dto field is missing', () => {
    expect(resolveRequesterForActor(undefined, actor())).toBe(SELF);
    expect(resolveRequesterForActor(null, actor())).toBe(SELF);
    expect(resolveRequesterForActor('', actor())).toBe(SELF);
  });

  it('allows degenerate self-booking when dto matches actor person_id', () => {
    expect(resolveRequesterForActor(SELF, actor())).toBe(SELF);
  });

  it('throws book_on_behalf_forbidden when a non-service-desk caller requests for someone else', () => {
    expect(() => resolveRequesterForActor(OTHER, actor({ is_service_desk: false }))).toThrow(
      ForbiddenException,
    );
    try {
      resolveRequesterForActor(OTHER, actor({ is_service_desk: false }));
      fail('expected ForbiddenException');
    } catch (e) {
      expect((e as ForbiddenException).getResponse()).toMatchObject({
        code: 'book_on_behalf_forbidden',
      });
    }
  });

  it('allows a service-desk caller to request on behalf of someone else', () => {
    expect(
      resolveRequesterForActor(OTHER, actor({ is_service_desk: true })),
    ).toBe(OTHER);
  });

  it('still falls through to actor person_id when dto is missing — even for a service desk', () => {
    expect(resolveRequesterForActor(undefined, actor({ is_service_desk: true }))).toBe(SELF);
  });

  it('returns empty string when actor has no person_id and dto is missing', () => {
    // Edge case: synthetic actors (system imports) sometimes carry person_id=null.
    // The downstream booking-flow validates the empty-string requester at the
    // service layer (NotFoundException for the persons FK), so the gate
    // should let it through here rather than masking the failure.
    expect(
      resolveRequesterForActor(undefined, actor({ person_id: null })),
    ).toBe('');
  });
});

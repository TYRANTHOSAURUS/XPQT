import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { BookingFlowService } from './booking-flow.service';
import { TenantContext } from '../../common/tenant-context';
import type { ActorContext, CreateReservationInput } from './dto/types';
import type { AttachPlan, BookingInput } from '../booking-bundles/attach-plan.types';
import { planUuid } from '../booking-bundles/plan-uuid';

/**
 * B.0.C.4 — `BookingFlowService.buildAttachPlan` is the pure plan-builder
 * for the combined-RPC path. These tests verify it returns deterministic
 * `{ bookingInput, attachPlan }` for the same input + idempotency key, and
 * delegates correctly to `BundleService.buildAttachPlan` when services are
 * present.
 */

describe('BookingFlowService.buildAttachPlan (B.0.C.4)', () => {
  const TENANT = { id: 'tenant-1', slug: 'acme', tier: 'standard' as const };
  const REQUESTER_PERSON = '11111111-1111-1111-1111-111111111111';
  const SPACE = '22222222-2222-2222-2222-222222222222';

  function makeSupabase() {
    const admin = {
      rpc: jest.fn(),
      from: (table: string) => {
        if (table === 'spaces') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () =>
                    Promise.resolve({
                      data: {
                        id: SPACE,
                        type: 'room',
                        reservable: true,
                        active: true,
                        capacity: 8,
                        setup_buffer_minutes: 0,
                        teardown_buffer_minutes: 0,
                        check_in_required: false,
                        check_in_grace_minutes: 15,
                        cost_per_hour: null,
                      },
                      error: null,
                    }),
                }),
              }),
            }),
          };
        }
        return {};
      },
    };
    return { admin };
  }

  function makeConflict() {
    return {
      snapshotBuffersForBooking: jest.fn(async () => ({
        setup_buffer_minutes: 0,
        teardown_buffer_minutes: 0,
      })),
      isExclusionViolation: jest.fn(() => false),
      preCheck: jest.fn(async () => []),
    };
  }

  function makeRules(final: 'allow' | 'deny' | 'require_approval' = 'allow') {
    return {
      resolve: jest.fn(async () => ({
        effects: [],
        matchedRules: [],
        warnings: [],
        denialMessages: final === 'deny' ? ['Denied by rule.'] : [],
        overridable: false,
        approvalConfig: null,
        final,
      })),
    };
  }

  function makeActor(overrides: Partial<ActorContext> = {}): ActorContext {
    return {
      user_id: 'user-1',
      person_id: REQUESTER_PERSON,
      is_service_desk: false,
      has_override_rules: false,
      ...overrides,
    };
  }

  function baseInput(overrides: Partial<CreateReservationInput> = {}): CreateReservationInput {
    return {
      space_id: SPACE,
      requester_person_id: REQUESTER_PERSON,
      start_at: '2026-05-04T09:00:00Z',
      end_at: '2026-05-04T10:00:00Z',
      attendee_count: 4,
      ...overrides,
    } as CreateReservationInput;
  }

  function makeBundle(plan: AttachPlan) {
    return {
      buildAttachPlan: jest.fn(async () => plan),
      attachServicesToBooking: jest.fn(),
    };
  }

  function emptyPlan(bookingId: string): AttachPlan {
    return {
      version: 1,
      any_pending_approval: false,
      any_deny: false,
      deny_messages: [],
      orders: [],
      asset_reservations: [],
      order_line_items: [],
      approvals: [],
      bundle_audit_payload: {
        bundle_id: bookingId,
        booking_id: bookingId,
        order_ids: [],
        order_line_item_ids: [],
        asset_reservation_ids: [],
        approval_ids: [],
        any_pending_approval: false,
      },
    };
  }

  it('rejects an empty idempotencyKey', async () => {
    const svc = new BookingFlowService(
      makeSupabase() as never,
      makeConflict() as never,
      makeRules() as never,
    );
    await TenantContext.run(TENANT, async () => {
      await expect(svc.buildAttachPlan(baseInput(), makeActor(), '')).rejects.toThrow(
        /idempotencyKey required/,
      );
    });
  });

  it('builds a deterministic BookingInput with pre-generated UUIDs', async () => {
    const svc = new BookingFlowService(
      makeSupabase() as never,
      makeConflict() as never,
      makeRules() as never,
    );

    const result = await TenantContext.run(TENANT, () =>
      svc.buildAttachPlan(baseInput(), makeActor(), 'idem-stable-1'),
    );

    expect(result.bookingInput.booking_id).toBe(planUuid('idem-stable-1', 'booking', '0'));
    expect(result.bookingInput.slot_ids).toEqual([planUuid('idem-stable-1', 'slot', '0')]);
    expect(result.bookingInput.location_id).toBe(SPACE);
    expect(result.bookingInput.status).toBe('confirmed');
    expect(result.bookingInput.source).toBe('portal');
    expect(result.bookingInput.slots).toHaveLength(1);
    expect(result.bookingInput.slots[0].id).toBe(result.bookingInput.slot_ids[0]);
    expect(result.bookingInput.slots[0].slot_type).toBe('room');
  });

  it('produces byte-identical output for the same input + key (full determinism)', async () => {
    const svc = new BookingFlowService(
      makeSupabase() as never,
      makeConflict() as never,
      makeRules() as never,
    );

    const a = await TenantContext.run(TENANT, () =>
      svc.buildAttachPlan(baseInput(), makeActor(), 'idem-1'),
    );
    const b = await TenantContext.run(TENANT, () =>
      svc.buildAttachPlan(baseInput(), makeActor(), 'idem-1'),
    );
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('produces an empty AttachPlan when no services are present', async () => {
    const svc = new BookingFlowService(
      makeSupabase() as never,
      makeConflict() as never,
      makeRules() as never,
    );
    const result = await TenantContext.run(TENANT, () =>
      svc.buildAttachPlan(baseInput(), makeActor(), 'idem-no-svc'),
    );
    expect(result.attachPlan.version).toBe(1);
    expect(result.attachPlan.orders).toEqual([]);
    expect(result.attachPlan.order_line_items).toEqual([]);
    expect(result.attachPlan.approvals).toEqual([]);
    expect(result.attachPlan.any_pending_approval).toBe(false);
    expect(result.attachPlan.any_deny).toBe(false);
  });

  it('delegates to BundleService.buildAttachPlan when services are present', async () => {
    const bookingId = planUuid('idem-with-svc', 'booking', '0');
    const bundle = makeBundle(emptyPlan(bookingId));
    const svc = new BookingFlowService(
      makeSupabase() as never,
      makeConflict() as never,
      makeRules() as never,
      undefined,
      undefined,
      bundle as never,
    );

    await TenantContext.run(TENANT, () =>
      svc.buildAttachPlan(
        baseInput({
          services: [
            { catalog_item_id: 'cat-1', quantity: 1, client_line_id: 'line-a' },
          ],
        }),
        makeActor(),
        'idem-with-svc',
      ),
    );

    expect(bundle.buildAttachPlan).toHaveBeenCalledTimes(1);
    const callArgs = bundle.buildAttachPlan.mock.calls[0][0];
    expect(callArgs.idempotency_key).toBe('idem-with-svc');
    expect(callArgs.booking_id).toBe(bookingId);
    expect(callArgs.tenant_id).toBe(TENANT.id);
    expect(callArgs.services).toHaveLength(1);
    expect(callArgs.services[0].client_line_id).toBe('line-a');
  });

  it('throws when services are present but BundleService is not injected', async () => {
    const svc = new BookingFlowService(
      makeSupabase() as never,
      makeConflict() as never,
      makeRules() as never,
      // No bundle.
    );
    await TenantContext.run(TENANT, async () => {
      await expect(
        svc.buildAttachPlan(
          baseInput({
            services: [{ catalog_item_id: 'c-1', quantity: 1, client_line_id: 'line-a' }],
          }),
          makeActor(),
          'idem-1',
        ),
      ).rejects.toThrow(/BundleService not injected/);
    });
  });

  it('honours rule deny: throws ForbiddenException when actor cannot override', async () => {
    const svc = new BookingFlowService(
      makeSupabase() as never,
      makeConflict() as never,
      makeRules('deny') as never,
    );
    await TenantContext.run(TENANT, async () => {
      await expect(svc.buildAttachPlan(baseInput(), makeActor(), 'idem-1')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  it('honours rule deny override: requires override_reason', async () => {
    const svc = new BookingFlowService(
      makeSupabase() as never,
      makeConflict() as never,
      makeRules('deny') as never,
    );
    await TenantContext.run(TENANT, async () => {
      // has_override_rules but no overridable flag — same as can't override.
      await expect(
        svc.buildAttachPlan(
          baseInput(),
          makeActor({ has_override_rules: true }),
          'idem-1',
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it('honours require_approval status on the BookingInput', async () => {
    const svc = new BookingFlowService(
      makeSupabase() as never,
      makeConflict() as never,
      makeRules('require_approval') as never,
    );
    const result = await TenantContext.run(TENANT, () =>
      svc.buildAttachPlan(baseInput(), makeActor(), 'idem-1'),
    );
    expect(result.bookingInput.status).toBe('pending_approval');
  });

  it('coerces source="auto" to "calendar_sync" by default', async () => {
    const svc = new BookingFlowService(
      makeSupabase() as never,
      makeConflict() as never,
      makeRules() as never,
    );
    const result = await TenantContext.run(TENANT, () =>
      svc.buildAttachPlan(baseInput({ source: 'auto' }), makeActor(), 'idem-1'),
    );
    expect(result.bookingInput.source).toBe('calendar_sync');
  });

  it('coerces source="auto" to "recurrence" when actor is system:recurrence:*', async () => {
    const svc = new BookingFlowService(
      makeSupabase() as never,
      makeConflict() as never,
      makeRules() as never,
    );
    const result = await TenantContext.run(TENANT, () =>
      svc.buildAttachPlan(
        baseInput({ source: 'auto' }),
        makeActor({ user_id: 'system:recurrence:abc' }),
        'idem-1',
      ),
    );
    expect(result.bookingInput.source).toBe('recurrence');
  });

  it('returned BookingInput round-trips through JSON.stringify (jsonb wire shape)', async () => {
    const svc = new BookingFlowService(
      makeSupabase() as never,
      makeConflict() as never,
      makeRules() as never,
    );
    const result = await TenantContext.run(TENANT, () =>
      svc.buildAttachPlan(baseInput(), makeActor(), 'idem-1'),
    );
    const json = JSON.stringify(result.bookingInput);
    const parsed = JSON.parse(json) as BookingInput;
    expect(parsed).toEqual(result.bookingInput);
  });

  it('rejects basic input validation failures (mirrors create)', async () => {
    const svc = new BookingFlowService(
      makeSupabase() as never,
      makeConflict() as never,
      makeRules() as never,
    );
    await TenantContext.run(TENANT, async () => {
      await expect(
        svc.buildAttachPlan(
          baseInput({ end_at: '2026-05-04T08:00:00Z' /* before start */ }),
          makeActor(),
          'idem-1',
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });
});

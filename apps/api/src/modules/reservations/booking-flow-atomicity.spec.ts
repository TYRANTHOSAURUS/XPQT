import { BadRequestException, ConflictException, InternalServerErrorException } from '@nestjs/common';
import { BookingFlowService } from './booking-flow.service';
import { InProcessBookingTransactionBoundary } from './booking-transaction-boundary';
import { TenantContext } from '../../common/tenant-context';
import type { ActorContext, CreateReservationInput } from './dto/types';

// B.0.D.2 — atomicity tests for `BookingFlowService.create`.
//
// Pre-B.0.D this file tested the post-create attach + compensation
// pattern: attach fails → txBoundary invokes deleteBooking → original
// error or partial_failure surfaces. Under B.0.D.2 the with-services
// path goes through `create_booking_with_attach_plan` which is atomic
// (one Postgres transaction commits the booking + slots + orders +
// asset_reservations + OLIs + approvals + outbox emissions). No
// compensation is needed; the test surface shifts to RPC-error
// mapping.
//
// What stays:
//   - Empty / undefined services arrays still bypass the combined RPC
//     and use the existing `create_booking` path. Tests at the bottom
//     verify those don't accidentally pull in the new collaborators.
//
// What's new:
//   - With-services + RPC error paths exercise `mapAttachPlanRpcError`
//     and ensure each error surface (payload_mismatch, fk_invalid,
//     internal_ref_invalid, snapshot_uuid_invalid, service_rule_deny,
//     unexpected) maps to the expected exception with structured code.

describe('BookingFlowService.create atomicity (B.0.D.2)', () => {
  const TENANT = { id: 'T', slug: 't', tier: 'standard' as const };
  const BOOKING_ID_NO_SVC = 'B-1';
  const SLOT_ID_NO_SVC = 'S-1';

  // Realistic uuids — buildAttachPlan synthesises them deterministically
  // from the idempotency key, so the spec doesn't need to predict them;
  // we just round-trip whatever the RPC mock returns.
  const RPC_BOOKING_ID = '88888888-8888-4888-8888-888888888888';
  const RPC_SLOT_ID = '99999999-9999-4999-8999-999999999999';

  function bookingRowFor(bookingId: string) {
    return {
      id: bookingId,
      tenant_id: TENANT.id,
      title: null,
      description: null,
      requester_person_id: 'P',
      host_person_id: null,
      booked_by_user_id: 'U',
      location_id: 'space-1',
      start_at: '2026-05-01T09:00:00Z',
      end_at: '2026-05-01T10:00:00Z',
      timezone: 'UTC',
      status: 'confirmed',
      source: 'portal',
      cost_center_id: null,
      cost_amount_snapshot: null,
      policy_snapshot: { matched_rule_ids: [], effects_seen: [] },
      applied_rule_ids: [],
      config_release_id: null,
      calendar_event_id: null,
      calendar_provider: null,
      calendar_etag: null,
      calendar_last_synced_at: null,
      recurrence_series_id: null,
      recurrence_index: null,
      recurrence_overridden: false,
      recurrence_skipped: false,
      template_id: null,
      created_at: '2026-05-01T08:00:00Z',
      updated_at: '2026-05-01T08:00:00Z',
    };
  }

  type RpcStub = (
    fn: string,
    args: unknown,
  ) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;

  function makeSupabase(rpcStub?: RpcStub, bookingId: string = BOOKING_ID_NO_SVC) {
    const calls = {
      rpc: [] as Array<{ fn: string; args: unknown }>,
      bookingsReads: 0,
      auditInserts: [] as unknown[],
      approvalInserts: [] as unknown[],
    };
    const admin = {
      rpc: (fn: string, args: unknown) => {
        calls.rpc.push({ fn, args });
        if (rpcStub) return rpcStub(fn, args);
        if (fn === 'create_booking') {
          return Promise.resolve({
            data: { booking_id: BOOKING_ID_NO_SVC, slot_ids: [SLOT_ID_NO_SVC] },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      },
      from: (table: string) => {
        if (table === 'spaces') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () =>
                    Promise.resolve({
                      data: {
                        id: 'space-1',
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
        if (table === 'bookings') {
          calls.bookingsReads++;
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () =>
                    Promise.resolve({
                      data: bookingRowFor(bookingId),
                      error: null,
                    }),
                }),
              }),
            }),
          };
        }
        if (table === 'audit_events') {
          return {
            insert: (row: unknown) => {
              calls.auditInserts.push(row);
              return Promise.resolve({ data: null, error: null });
            },
          };
        }
        if (table === 'approvals') {
          return {
            insert: (rows: unknown) => {
              calls.approvalInserts.push(rows);
              return Promise.resolve({ data: null, error: null });
            },
          };
        }
        return {};
      },
    };
    return { admin, calls };
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

  function makeRules() {
    return {
      resolve: jest.fn(async () => ({
        effects: [],
        matchedRules: [],
        warnings: [],
        denialMessages: [],
        overridable: false,
        approvalConfig: null,
        final: 'allow' as const,
      })),
    };
  }

  function makeBundle() {
    // Provide a buildAttachPlan stub so the with-services path can run.
    return {
      buildAttachPlan: jest.fn(async () => ({
        version: 1,
        any_pending_approval: false,
        any_deny: false,
        deny_messages: [],
        orders: [],
        asset_reservations: [],
        order_line_items: [],
        approvals: [],
        bundle_audit_payload: {
          bundle_id: RPC_BOOKING_ID,
          booking_id: RPC_BOOKING_ID,
          order_ids: [],
          order_line_item_ids: [],
          asset_reservation_ids: [],
          approval_ids: [],
          any_pending_approval: false,
        },
      })),
      attachServicesToBooking: jest.fn(),
    };
  }

  function makeActor(overrides: Partial<ActorContext> = {}): ActorContext {
    return {
      user_id: 'U',
      person_id: 'P',
      is_service_desk: false,
      has_override_rules: false,
      ...overrides,
    };
  }

  function baseInput(overrides: Partial<CreateReservationInput> = {}): CreateReservationInput {
    return {
      space_id: 'space-1',
      requester_person_id: 'P',
      start_at: '2026-05-01T09:00:00Z',
      end_at: '2026-05-01T10:00:00Z',
      attendee_count: 4,
      ...overrides,
    } as CreateReservationInput;
  }

  // ─── No-services path: existing create_booking RPC ───────────────────

  it('uses create_booking RPC when services array is empty', async () => {
    const supabase = makeSupabase();
    const conflict = makeConflict();
    const rules = makeRules();
    const bundle = makeBundle();

    const boundary = new InProcessBookingTransactionBoundary();
    const svc = new BookingFlowService(
      supabase as never,
      conflict as never,
      rules as never,
      undefined,
      undefined,
      bundle as never,
      undefined,
      boundary,
      { deleteBooking: jest.fn() } as never,
    );

    const result = await TenantContext.run(TENANT, () => svc.create(baseInput(), makeActor()));

    expect(result.id).toBe(BOOKING_ID_NO_SVC);
    expect(supabase.calls.rpc.some((c) => c.fn === 'create_booking')).toBe(true);
    expect(supabase.calls.rpc.some((c) => c.fn === 'create_booking_with_attach_plan')).toBe(false);
    expect(bundle.attachServicesToBooking).not.toHaveBeenCalled();
    expect(bundle.buildAttachPlan).not.toHaveBeenCalled();
  });

  it('uses create_booking RPC when services is undefined', async () => {
    const supabase = makeSupabase();
    const conflict = makeConflict();
    const rules = makeRules();
    const bundle = makeBundle();

    const boundary = new InProcessBookingTransactionBoundary();
    const svc = new BookingFlowService(
      supabase as never,
      conflict as never,
      rules as never,
      undefined,
      undefined,
      bundle as never,
      undefined,
      boundary,
      { deleteBooking: jest.fn() } as never,
    );

    const input = baseInput();
    delete (input as Partial<CreateReservationInput>).services;
    await TenantContext.run(TENANT, () => svc.create(input, makeActor()));

    expect(supabase.calls.rpc.some((c) => c.fn === 'create_booking')).toBe(true);
    expect(supabase.calls.rpc.some((c) => c.fn === 'create_booking_with_attach_plan')).toBe(false);
  });

  // ─── With-services path: combined RPC ───────────────────────────────

  it('uses create_booking_with_attach_plan RPC when services are present', async () => {
    const rpcStub: RpcStub = (fn) => {
      if (fn === 'create_booking_with_attach_plan') {
        return Promise.resolve({
          data: {
            booking_id: RPC_BOOKING_ID,
            slot_ids: [RPC_SLOT_ID],
            order_ids: [],
            order_line_item_ids: [],
            asset_reservation_ids: [],
            approval_ids: [],
            any_pending_approval: false,
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    };
    const supabase = makeSupabase(rpcStub, RPC_BOOKING_ID);
    const conflict = makeConflict();
    const rules = makeRules();
    const bundle = makeBundle();

    const svc = new BookingFlowService(
      supabase as never,
      conflict as never,
      rules as never,
      undefined,
      undefined,
      bundle as never,
    );

    const result = await TenantContext.run(TENANT, () =>
      svc.create(
        baseInput({
          services: [{ catalog_item_id: 'C1', quantity: 1, client_line_id: 'line-a' }],
        }),
        makeActor({ client_request_id: '11111111-1111-4111-8111-111111111111' }),
      ),
    );

    expect(result.id).toBe(RPC_BOOKING_ID);
    expect(supabase.calls.rpc.some((c) => c.fn === 'create_booking_with_attach_plan')).toBe(true);
    expect(supabase.calls.rpc.some((c) => c.fn === 'create_booking')).toBe(false);
    expect(bundle.buildAttachPlan).toHaveBeenCalledTimes(1);
    expect(bundle.attachServicesToBooking).not.toHaveBeenCalled();
  });

  it('threads idempotency_key constructed from actor.client_request_id', async () => {
    let capturedIdempKey = '';
    const rpcStub: RpcStub = (fn, args) => {
      if (fn === 'create_booking_with_attach_plan') {
        capturedIdempKey = (args as { p_idempotency_key: string }).p_idempotency_key;
        return Promise.resolve({
          data: {
            booking_id: RPC_BOOKING_ID,
            slot_ids: [RPC_SLOT_ID],
            order_ids: [],
            order_line_item_ids: [],
            asset_reservation_ids: [],
            approval_ids: [],
            any_pending_approval: false,
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    };
    const supabase = makeSupabase(rpcStub, RPC_BOOKING_ID);
    const svc = new BookingFlowService(
      supabase as never,
      makeConflict() as never,
      makeRules() as never,
      undefined,
      undefined,
      makeBundle() as never,
    );

    await TenantContext.run(TENANT, () =>
      svc.create(
        baseInput({ services: [{ catalog_item_id: 'C1', quantity: 1, client_line_id: 'l' }] }),
        makeActor({ client_request_id: '22222222-2222-4222-8222-222222222222' }),
      ),
    );

    expect(capturedIdempKey).toBe(
      'booking.create:U:22222222-2222-4222-8222-222222222222',
    );
  });

  it('returns the cached_result on retry (idempotent — RPC handles dedup)', async () => {
    let callCount = 0;
    const cachedResult = {
      booking_id: RPC_BOOKING_ID,
      slot_ids: [RPC_SLOT_ID],
      order_ids: [],
      order_line_item_ids: [],
      asset_reservation_ids: [],
      approval_ids: [],
      any_pending_approval: false,
    };
    const rpcStub: RpcStub = (fn) => {
      if (fn === 'create_booking_with_attach_plan') {
        callCount++;
        return Promise.resolve({ data: cachedResult, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    };
    const supabase = makeSupabase(rpcStub, RPC_BOOKING_ID);
    const svc = new BookingFlowService(
      supabase as never,
      makeConflict() as never,
      makeRules() as never,
      undefined,
      undefined,
      makeBundle() as never,
    );

    const actor = makeActor({ client_request_id: '33333333-3333-4333-8333-333333333333' });
    const input = baseInput({ services: [{ catalog_item_id: 'C1', quantity: 1, client_line_id: 'l' }] });

    const r1 = await TenantContext.run(TENANT, () => svc.create(input, actor));
    const r2 = await TenantContext.run(TENANT, () => svc.create(input, actor));

    // Both calls return the same booking id — the second one would be
    // served by attach_operations.cached_result on a real DB; the test
    // mock just returns the same payload twice.
    expect(r1.id).toBe(r2.id);
    expect(callCount).toBe(2);
  });

  // ─── Error mapping ──────────────────────────────────────────────────

  it('maps attach_operations.payload_mismatch to ConflictException', async () => {
    const rpcStub: RpcStub = (fn) => {
      if (fn === 'create_booking_with_attach_plan') {
        return Promise.resolve({
          data: null,
          error: {
            code: 'P0001',
            message: 'attach_operations.payload_mismatch',
          },
        });
      }
      return Promise.resolve({ data: null, error: null });
    };
    const svc = new BookingFlowService(
      makeSupabase(rpcStub) as never,
      makeConflict() as never,
      makeRules() as never,
      undefined,
      undefined,
      makeBundle() as never,
    );

    let caught: unknown = null;
    try {
      await TenantContext.run(TENANT, () =>
        svc.create(
          baseInput({ services: [{ catalog_item_id: 'C1', quantity: 1, client_line_id: 'l' }] }),
          makeActor({ client_request_id: '44444444-4444-4444-8444-444444444444' }),
        ),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConflictException);
    expect((caught as ConflictException).getResponse()).toMatchObject({
      code: 'booking.idempotency_payload_mismatch',
    });
  });

  it('maps attach_plan.fk_invalid to BadRequestException(booking.fk_invalid)', async () => {
    const rpcStub: RpcStub = (fn) => {
      if (fn === 'create_booking_with_attach_plan') {
        return Promise.resolve({
          data: null,
          error: {
            code: '42501',
            message: 'attach_plan.fk_invalid: requester_person_id',
          },
        });
      }
      return Promise.resolve({ data: null, error: null });
    };
    const svc = new BookingFlowService(
      makeSupabase(rpcStub) as never,
      makeConflict() as never,
      makeRules() as never,
      undefined,
      undefined,
      makeBundle() as never,
    );

    let caught: unknown = null;
    try {
      await TenantContext.run(TENANT, () =>
        svc.create(
          baseInput({ services: [{ catalog_item_id: 'C1', quantity: 1, client_line_id: 'l' }] }),
          makeActor({ client_request_id: '55555555-5555-4555-8555-555555555555' }),
        ),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as BadRequestException).getResponse()).toMatchObject({
      code: 'booking.fk_invalid',
    });
  });

  it('maps attach_plan.internal_refs (without 42501) to booking.internal_ref_invalid', async () => {
    const rpcStub: RpcStub = (fn) => {
      if (fn === 'create_booking_with_attach_plan') {
        return Promise.resolve({
          data: null,
          error: {
            code: '22023',
            message: 'attach_plan.internal_refs: order_line_items[].order_id 0xdeadbeef not in plan.orders[]',
          },
        });
      }
      return Promise.resolve({ data: null, error: null });
    };
    const svc = new BookingFlowService(
      makeSupabase(rpcStub) as never,
      makeConflict() as never,
      makeRules() as never,
      undefined,
      undefined,
      makeBundle() as never,
    );

    let caught: unknown = null;
    try {
      await TenantContext.run(TENANT, () =>
        svc.create(
          baseInput({ services: [{ catalog_item_id: 'C1', quantity: 1, client_line_id: 'l' }] }),
          makeActor({ client_request_id: '66666666-6666-4666-8666-666666666666' }),
        ),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as BadRequestException).getResponse()).toMatchObject({
      code: 'booking.internal_ref_invalid',
    });
  });

  it('maps attach_plan.internal_refs with 42501 (snapshot uuid) to booking.snapshot_uuid_invalid', async () => {
    const rpcStub: RpcStub = (fn) => {
      if (fn === 'create_booking_with_attach_plan') {
        return Promise.resolve({
          data: null,
          error: {
            code: '42501',
            message:
              'attach_plan.internal_refs: applied_rule_ids[] 0xdeadbeef not in tenant service_rules',
          },
        });
      }
      return Promise.resolve({ data: null, error: null });
    };
    const svc = new BookingFlowService(
      makeSupabase(rpcStub) as never,
      makeConflict() as never,
      makeRules() as never,
      undefined,
      undefined,
      makeBundle() as never,
    );

    let caught: unknown = null;
    try {
      await TenantContext.run(TENANT, () =>
        svc.create(
          baseInput({ services: [{ catalog_item_id: 'C1', quantity: 1, client_line_id: 'l' }] }),
          makeActor({ client_request_id: '77777777-7777-4777-8777-777777777777' }),
        ),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as BadRequestException).getResponse()).toMatchObject({
      code: 'booking.snapshot_uuid_invalid',
    });
  });

  it('maps service_rule_deny to BadRequestException(service_rule_deny)', async () => {
    const rpcStub: RpcStub = (fn) => {
      if (fn === 'create_booking_with_attach_plan') {
        return Promise.resolve({
          data: null,
          error: {
            code: 'P0001',
            message: 'service_rule_deny: This catering vendor is not bookable on weekends.',
          },
        });
      }
      return Promise.resolve({ data: null, error: null });
    };
    const svc = new BookingFlowService(
      makeSupabase(rpcStub) as never,
      makeConflict() as never,
      makeRules() as never,
      undefined,
      undefined,
      makeBundle() as never,
    );

    let caught: unknown = null;
    try {
      await TenantContext.run(TENANT, () =>
        svc.create(
          baseInput({ services: [{ catalog_item_id: 'C1', quantity: 1, client_line_id: 'l' }] }),
          makeActor({ client_request_id: '88888888-8888-4888-8888-888888888888' }),
        ),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as BadRequestException).getResponse()).toMatchObject({
      code: 'service_rule_deny',
      message: 'This catering vendor is not bookable on weekends.',
    });
  });

  it('maps GiST exclusion (23P01) to ConflictException(booking.slot_conflict)', async () => {
    const rpcStub: RpcStub = (fn) => {
      if (fn === 'create_booking_with_attach_plan') {
        return Promise.resolve({
          data: null,
          error: {
            code: '23P01',
            message: 'conflicting key value violates exclusion constraint "booking_slots_no_overlap"',
          },
        });
      }
      return Promise.resolve({ data: null, error: null });
    };
    const supabase = makeSupabase(rpcStub);
    const conflict = {
      ...makeConflict(),
      isExclusionViolation: jest.fn(() => true),
    };
    const svc = new BookingFlowService(
      supabase as never,
      conflict as never,
      makeRules() as never,
      undefined,
      undefined,
      makeBundle() as never,
    );

    let caught: unknown = null;
    try {
      await TenantContext.run(TENANT, () =>
        svc.create(
          baseInput({ services: [{ catalog_item_id: 'C1', quantity: 1, client_line_id: 'l' }] }),
          makeActor({ client_request_id: '99999999-9999-4999-8999-999999999999' }),
        ),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConflictException);
    expect((caught as ConflictException).getResponse()).toMatchObject({
      code: 'booking.slot_conflict',
    });
  });

  it('maps an unrecognised error to InternalServerErrorException(booking.unexpected_error)', async () => {
    const rpcStub: RpcStub = (fn) => {
      if (fn === 'create_booking_with_attach_plan') {
        return Promise.resolve({
          data: null,
          error: { code: 'XX000', message: 'Internal mishap.' },
        });
      }
      return Promise.resolve({ data: null, error: null });
    };
    const svc = new BookingFlowService(
      makeSupabase(rpcStub) as never,
      makeConflict() as never,
      makeRules() as never,
      undefined,
      undefined,
      makeBundle() as never,
    );

    let caught: unknown = null;
    try {
      await TenantContext.run(TENANT, () =>
        svc.create(
          baseInput({ services: [{ catalog_item_id: 'C1', quantity: 1, client_line_id: 'l' }] }),
          makeActor({ client_request_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
        ),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InternalServerErrorException);
    expect((caught as InternalServerErrorException).getResponse()).toMatchObject({
      code: 'booking.unexpected_error',
    });
  });
});

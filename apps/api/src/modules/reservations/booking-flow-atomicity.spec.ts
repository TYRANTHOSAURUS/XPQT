import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { BookingFlowService } from './booking-flow.service';
import {
  InProcessBookingTransactionBoundary,
  type CompensationOutcome,
} from './booking-transaction-boundary';
import { TenantContext } from '../../common/tenant-context';
import type { ActorContext, CreateReservationInput } from './dto/types';

// Phase 1.3 — Bug #1 (atomic booking + service via RPC + boundary).
//
// Spec for the integration of BookingFlowService.create with the new
// BookingTransactionBoundary + BookingCompensationService. Three scenarios per
// docs/superpowers/plans/2026-05-04-architecture-phase-1-correctness-bugs.md
// Phase 1.3 — Tests (TDD) #2:
//
//   1. attachServicesToBooking fails, compensation returns 'rolled_back'  →
//      original error is re-thrown unchanged (e.g. catalog_item_not_found).
//   2. attachServicesToBooking fails, compensation returns 'partial_failure'
//      → BadRequestException(booking.partial_failure) with booking_id +
//      blocked_by[].
//   3. Empty services array → neither attachServicesToBooking nor
//      compensation is invoked at all.
//
// We build a real InProcessBookingTransactionBoundary and a stub
// compensation service that returns whatever outcome the test wants. The
// supabase client is mocked just enough to round-trip the create_booking RPC
// + booking re-read.

describe('BookingFlowService.create atomicity (Phase 1.3)', () => {
  const TENANT = { id: 'T', slug: 't', tier: 'standard' as const };
  const BOOKING_ID = 'B-1';
  const SLOT_ID = 'S-1';

  function makeSupabase() {
    const calls = {
      rpc: [] as Array<{ fn: string; args: unknown }>,
      bookingsReads: 0,
      auditInserts: [] as unknown[],
      approvalInserts: [] as unknown[],
    };
    const admin = {
      rpc: (fn: string, args: unknown) => {
        calls.rpc.push({ fn, args });
        if (fn === 'create_booking') {
          return Promise.resolve({
            data: { booking_id: BOOKING_ID, slot_ids: [SLOT_ID] },
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
                      data: {
                        id: BOOKING_ID,
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
                      },
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

  it('rolls back the booking and re-throws original error when service-attach fails (rolled_back)', async () => {
    const supabase = makeSupabase();
    const conflict = makeConflict();
    const rules = makeRules();

    const attachErr = new Error('catalog_item_not_found');
    const bundle = {
      attachServicesToBooking: jest.fn(async () => {
        throw attachErr;
      }),
    };

    const compensation = {
      deleteBooking: jest.fn(
        async (id: string): Promise<CompensationOutcome> => ({ kind: 'rolled_back', bookingId: id }),
      ),
    };

    const boundary = new InProcessBookingTransactionBoundary();
    const svc = new BookingFlowService(
      supabase as never,
      conflict as never,
      rules as never,
      undefined,           // recurrence
      undefined,           // notifications
      bundle as never,     // bundle
      undefined,           // picker
      boundary,
      compensation as never,
    );

    let caught: unknown = null;
    try {
      await TenantContext.run(TENANT, () =>
        svc.create(baseInput({ services: [{ catalog_item_id: 'C1', quantity: 1 }] }), makeActor()),
      );
    } catch (err) {
      caught = err;
    }

    // Original error re-thrown unchanged — caller sees the same exception
    // they would have without compensation.
    expect(caught).toBe(attachErr);
    expect(bundle.attachServicesToBooking).toHaveBeenCalledTimes(1);
    expect(compensation.deleteBooking).toHaveBeenCalledTimes(1);
    expect(compensation.deleteBooking).toHaveBeenCalledWith(BOOKING_ID);
  });

  it('throws BadRequestException(booking.partial_failure) when compensation reports a blocker', async () => {
    const supabase = makeSupabase();
    const conflict = makeConflict();
    const rules = makeRules();

    const attachErr = new Error('catalog_item_not_found');
    const bundle = {
      attachServicesToBooking: jest.fn(async () => {
        throw attachErr;
      }),
    };

    const compensation = {
      deleteBooking: jest.fn(
        async (id: string): Promise<CompensationOutcome> => ({
          kind: 'partial_failure',
          bookingId: id,
          blockedBy: ['recurrence_series'],
        }),
      ),
    };

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
      compensation as never,
    );

    let caught: unknown = null;
    try {
      await TenantContext.run(TENANT, () =>
        svc.create(baseInput({ services: [{ catalog_item_id: 'C1', quantity: 1 }] }), makeActor()),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as BadRequestException).getResponse()).toMatchObject({
      code: 'booking.partial_failure',
      booking_id: BOOKING_ID,
      blocked_by: ['recurrence_series'],
      original_error: 'catalog_item_not_found',
    });
    expect(compensation.deleteBooking).toHaveBeenCalledTimes(1);
  });

  it('skips compensation entirely when input.services is empty', async () => {
    const supabase = makeSupabase();
    const conflict = makeConflict();
    const rules = makeRules();

    const bundle = { attachServicesToBooking: jest.fn() };
    const compensation = { deleteBooking: jest.fn() };

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
      compensation as never,
    );

    const result = await TenantContext.run(TENANT, () => svc.create(baseInput(), makeActor()));

    expect(result.id).toBe(BOOKING_ID);
    expect(bundle.attachServicesToBooking).not.toHaveBeenCalled();
    expect(compensation.deleteBooking).not.toHaveBeenCalled();
  });

  // Sanity: with services missing entirely (undefined), same behavior as
  // empty array. The plan only requires the empty-array case but undefined
  // is the more common shape from the picker pipeline.
  it('skips compensation when input.services is undefined', async () => {
    const supabase = makeSupabase();
    const conflict = makeConflict();
    const rules = makeRules();

    const bundle = { attachServicesToBooking: jest.fn() };
    const compensation = { deleteBooking: jest.fn() };

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
      compensation as never,
    );

    const input = baseInput();
    delete (input as Partial<CreateReservationInput>).services;
    await TenantContext.run(TENANT, () => svc.create(input, makeActor()));

    expect(bundle.attachServicesToBooking).not.toHaveBeenCalled();
    expect(compensation.deleteBooking).not.toHaveBeenCalled();
  });
});

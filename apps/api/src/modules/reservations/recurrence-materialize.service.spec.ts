import { RecurrenceService } from './recurrence.service';
import type { Booking, BookingSlot } from './dto/types';

describe('RecurrenceService.materialize', () => {
  // Booking-canonicalisation rewrite (2026-05-02): the master is now read as
  // a `booking_slots` row joined with its parent `bookings` row (see
  // recurrence.service.ts:327-339 + reservation-projection.ts:55-65). The
  // legacy single-row `reservations` read no longer exists.

  function makeMasterBooking(): Booking {
    return {
      id: 'MASTER',
      tenant_id: 'T',
      title: null,
      description: null,
      requester_person_id: 'P',
      host_person_id: null,
      booked_by_user_id: 'U',
      location_id: 'S',
      start_at: '2026-05-01T09:00:00Z',
      end_at: '2026-05-01T10:00:00Z',
      timezone: 'UTC',
      status: 'confirmed',
      source: 'portal',
      cost_center_id: null,
      cost_amount_snapshot: null,
      policy_snapshot: {},
      applied_rule_ids: [],
      config_release_id: null,
      calendar_event_id: null,
      calendar_provider: null,
      calendar_etag: null,
      calendar_last_synced_at: null,
      // recurrence_series_id mirrors the series being materialised so
      // recurrence.service.ts:390 finds the row when scanning existing indices.
      recurrence_series_id: 'SER',
      recurrence_index: 0,
      recurrence_overridden: false,
      recurrence_skipped: false,
      template_id: null,
      created_at: '2026-05-01T09:00:00Z',
      updated_at: '2026-05-01T09:00:00Z',
    };
  }

  function makeMasterSlotEmbed(booking: Booking): BookingSlot & {
    bookings: Booking;
  } {
    // The shape returned by the SLOT_WITH_BOOKING_SELECT embed
    // (reservation-projection.ts:131-143). Slot fields live at the top level;
    // the parent booking is nested under `bookings`.
    return {
      id: 'MASTER-SLOT',
      tenant_id: 'T',
      booking_id: booking.id,
      slot_type: 'room',
      space_id: 'S',
      start_at: booking.start_at,
      end_at: booking.end_at,
      setup_buffer_minutes: 0,
      teardown_buffer_minutes: 0,
      effective_start_at: booking.start_at,
      effective_end_at: booking.end_at,
      attendee_count: 2,
      attendee_person_ids: [],
      status: booking.status,
      check_in_required: false,
      check_in_grace_minutes: 15,
      checked_in_at: null,
      released_at: null,
      cancellation_grace_until: null,
      display_order: 0,
      created_at: booking.created_at,
      updated_at: booking.updated_at,
      bookings: booking,
    };
  }

  function makeSupabase(opts: {
    series: Record<string, unknown>;
    masterBooking: Booking;
    existing: Array<{ recurrence_index: number | null }>;
  }) {
    const masterSlotEmbed = makeMasterSlotEmbed(opts.masterBooking);
    return {
      admin: {
        from: (table: string) => {
          if (table === 'recurrence_series') {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: () =>
                    Promise.resolve({ data: opts.series, error: null }),
                }),
              }),
              update: () => ({
                eq: () => Promise.resolve({ data: null, error: null }),
              }),
            };
          }
          // Master booking projection — recurrence.service.ts:328-333.
          // Chain shape: .from('booking_slots').select(...).eq('booking_id', X)
          //   .order(...).limit(1).maybeSingle()
          if (table === 'booking_slots') {
            return {
              select: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () => ({
                      maybeSingle: () =>
                        Promise.resolve({ data: masterSlotEmbed, error: null }),
                    }),
                  }),
                }),
              }),
            };
          }
          // Existing-indices scan — recurrence.service.ts:386-390.
          // Chain shape: .from('bookings').select('recurrence_index')
          //   .eq('tenant_id', T).eq('recurrence_series_id', SER)
          if (table === 'bookings') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () =>
                    Promise.resolve({ data: opts.existing, error: null }),
                }),
              }),
            };
          }
          if (table === 'business_hours_calendars') {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({ data: null, error: null }),
                }),
              }),
            };
          }
          return {};
        },
      },
    };
  }

  it('creates occurrences via bookingFlow + skips conflicts on 23P01', async () => {
    const masterBooking = makeMasterBooking();
    // Series row shape — recurrence.service.ts:302-314.
    // `parent_booking_id` replaced legacy `parent_reservation_id` (00278:179-181).
    const series = {
      id: 'SER',
      tenant_id: 'T',
      recurrence_rule: { frequency: 'daily', interval: 1, count: 5 },
      series_start_at: '2026-05-01T09:00:00Z',
      series_end_at: null,
      max_occurrences: 365,
      holiday_calendar_id: null,
      materialized_through: '2026-05-01T00:00:00Z',
      parent_booking_id: 'MASTER',
    };

    const supabase = makeSupabase({
      series,
      masterBooking,
      existing: [{ recurrence_index: 0 }], // master is already on disk at index 0
    });

    let createCalls = 0;
    const bookingFlow = {
      create: jest.fn(async (input: { start_at: string; end_at: string }) => {
        createCalls += 1;
        // Simulate conflict on the 3rd materialised occurrence.
        if (createCalls === 3) {
          throw Object.assign(new Error('reservations_no_overlap exclusion'), {
            code: '23P01',
            message: 'reservations_no_overlap',
          });
        }
        // BookingFlowService.create returns a `Reservation` (legacy projection)
        // — see booking-flow.service.ts:90. recurrence.service.ts:435,464 only
        // reads `id`, `start_at`, `end_at` off the result.
        return {
          id: `OCC-${createCalls}`,
          start_at: input.start_at,
          end_at: input.end_at,
        };
      }),
    };
    const conflict = {
      isExclusionViolation: (err: unknown) => {
        const e = err as { code?: string };
        return e?.code === '23P01';
      },
    };

    const svc = new RecurrenceService(supabase as never, conflict as never);
    svc.setBookingFlow(bookingFlow as never);

    const result = await svc.materialize('SER', new Date('2026-05-10T00:00:00Z'));

    // Indices 1..4 attempted (index 0 is the master, already on disk).
    expect(result.skipped_conflicts).toBeGreaterThanOrEqual(1);
    expect(result.created.length).toBeGreaterThan(0);
    expect(result.created.length + result.skipped_conflicts).toBeLessThanOrEqual(4);
  });
});

// /full-review v3 closure I4 — wrap clone in compensation boundary.
//
// Pre-fix: bookingFlow.create(...) was called with services=[] (skipping
// the BookingFlowService-internal compensation), then a separate
// cloneBundleOrdersToOccurrence call ran AFTER the booking committed.
// If the clone threw, the orphan occurrence booking persisted and the
// catch block silently bumped `skipped += 1`.
//
// Post-fix: the clone step is wrapped in
// BookingTransactionBoundary.runWithCompensation. On a throw, the
// boundary calls compensation.deleteBooking(occurrence.id) which invokes
// delete_booking_with_guard (00292) to atomically delete the orphan.
describe('RecurrenceService.materialize — clone wraps in compensation boundary (I4)', () => {
  function buildSupabase(opts: {
    series: Record<string, unknown>;
    masterBooking: ReturnType<typeof masterBooking>;
    existing: Array<{ recurrence_index: number | null }>;
    masterOrders: Array<{ id: string }>;
  }) {
    const masterSlotEmbed = {
      id: 'MASTER-SLOT',
      tenant_id: 'T',
      booking_id: opts.masterBooking.id,
      slot_type: 'room',
      space_id: 'S',
      start_at: opts.masterBooking.start_at,
      end_at: opts.masterBooking.end_at,
      setup_buffer_minutes: 0,
      teardown_buffer_minutes: 0,
      effective_start_at: opts.masterBooking.start_at,
      effective_end_at: opts.masterBooking.end_at,
      attendee_count: 2,
      attendee_person_ids: [],
      status: opts.masterBooking.status,
      check_in_required: false,
      check_in_grace_minutes: 15,
      checked_in_at: null,
      released_at: null,
      cancellation_grace_until: null,
      display_order: 0,
      created_at: opts.masterBooking.created_at,
      updated_at: opts.masterBooking.updated_at,
      bookings: opts.masterBooking,
    };
    return {
      admin: {
        from: (table: string) => {
          if (table === 'recurrence_series') {
            return {
              select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: opts.series, error: null }) }) }),
              update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
            };
          }
          if (table === 'booking_slots') {
            return {
              select: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () => ({
                      maybeSingle: () => Promise.resolve({ data: masterSlotEmbed, error: null }),
                    }),
                  }),
                }),
              }),
            };
          }
          if (table === 'bookings') {
            return {
              select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: opts.existing, error: null }) }) }),
            };
          }
          if (table === 'business_hours_calendars') {
            return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
          }
          if (table === 'orders') {
            // Master orders for cloneBundleOrdersToOccurrence.
            return {
              select: () => ({
                eq: () => Promise.resolve({ data: opts.masterOrders, error: null }),
              }),
            };
          }
          return {};
        },
      },
    };
  }

  // Local helper — mirrors makeMasterBooking from the outer describe.
  function masterBooking() {
    return {
      id: 'MASTER',
      tenant_id: 'T',
      title: null,
      description: null,
      requester_person_id: 'P',
      host_person_id: null,
      booked_by_user_id: 'U',
      location_id: 'S',
      start_at: '2026-05-01T09:00:00Z',
      end_at: '2026-05-01T10:00:00Z',
      timezone: 'UTC',
      status: 'confirmed' as const,
      source: 'portal',
      cost_center_id: null,
      cost_amount_snapshot: null,
      policy_snapshot: {},
      applied_rule_ids: [],
      config_release_id: null,
      calendar_event_id: null,
      calendar_provider: null,
      calendar_etag: null,
      calendar_last_synced_at: null,
      recurrence_series_id: 'SER',
      recurrence_index: 0,
      recurrence_overridden: false,
      recurrence_skipped: false,
      template_id: null,
      created_at: '2026-05-01T09:00:00Z',
      updated_at: '2026-05-01T09:00:00Z',
    };
  }

  it('clone failure on occurrence triggers compensation.deleteBooking AND skips the occurrence', async () => {
    const supabase = buildSupabase({
      series: {
        id: 'SER',
        tenant_id: 'T',
        recurrence_rule: { frequency: 'daily', interval: 1, count: 3 },
        series_start_at: '2026-05-01T09:00:00Z',
        series_end_at: null,
        max_occurrences: 365,
        holiday_calendar_id: null,
        materialized_through: '2026-05-01T00:00:00Z',
        parent_booking_id: 'MASTER',
      },
      masterBooking: masterBooking(),
      existing: [{ recurrence_index: 0 }],
      // Master has 1 order — clone will be attempted for each new occurrence.
      masterOrders: [{ id: 'ORDER-1' }],
    });

    let createCalls = 0;
    const bookingFlow = {
      create: jest.fn(async (input: { start_at: string; end_at: string }) => {
        createCalls += 1;
        return {
          id: `OCC-${createCalls}`,
          start_at: input.start_at,
          end_at: input.end_at,
        };
      }),
    };
    const conflict = { isExclusionViolation: () => false };

    // Orders fan-out — every clone throws to simulate a hard failure
    // (asset GiST conflict, FK violation, etc.). The compensation
    // boundary should catch this and delete the orphan booking.
    const ordersFanOut = {
      cloneOrderForOccurrence: jest.fn(async () => {
        throw new Error('clone failed: asset GiST conflict');
      }),
    };

    // Mock the compensation boundary + service. The boundary's contract
    // is: catch the operation throw, call compensate(bookingId), then
    // re-throw the original error if outcome.kind === 'rolled_back'.
    const deleteBooking = jest.fn(async (bookingId: string) => {
      return { kind: 'rolled_back' as const, bookingId };
    });
    const compensation = { deleteBooking } as unknown as Parameters<RecurrenceService['constructor']>[4];
    const txBoundary = {
      runWithCompensation: jest.fn(async <T>(
        bookingId: string,
        operation: () => Promise<T>,
        compensate: (bookingId: string) => Promise<{ kind: 'rolled_back' | 'partial_failure'; bookingId: string; blockedBy?: string[] }>,
      ): Promise<T> => {
        try {
          return await operation();
        } catch (err) {
          const outcome = await compensate(bookingId);
          if (outcome.kind === 'rolled_back') throw err;
          // Match boundary's BadRequest('booking.partial_failure') re-throw.
          throw Object.assign(new Error('booking.partial_failure'), {
            response: { code: 'booking.partial_failure', booking_id: outcome.bookingId },
          });
        }
      }),
    };

    const svc = new RecurrenceService(
      supabase as never,
      conflict as never,
      undefined,
      txBoundary as never,
      compensation as never,
    );
    svc.setBookingFlow(bookingFlow as never);
    svc.setOrdersFanOut(ordersFanOut as never);

    const result = await svc.materialize('SER', new Date('2026-05-05T00:00:00Z'));

    // The clone threw on every occurrence → compensation deleteBooking
    // fired for each created booking. None survived → created length is 0.
    expect(result.created).toHaveLength(0);
    // Skipped > 0 (each clone failure → skipped += 1 in the catch).
    expect(result.skipped_conflicts).toBeGreaterThan(0);
    // deleteBooking was called with EACH occurrence's booking id, NOT
    // the master id.
    expect(deleteBooking).toHaveBeenCalled();
    for (const call of deleteBooking.mock.calls) {
      const id = call[0];
      expect(id).not.toBe('MASTER');
      expect(id).toMatch(/^OCC-/);
    }
    // The runWithCompensation boundary fired once per occurrence
    // (= once per created booking).
    expect(txBoundary.runWithCompensation).toHaveBeenCalled();
  });

  it('partial_failure (recurrence_series blocker) is logged + skipped', async () => {
    const supabase = buildSupabase({
      series: {
        id: 'SER',
        tenant_id: 'T',
        recurrence_rule: { frequency: 'daily', interval: 1, count: 2 },
        series_start_at: '2026-05-01T09:00:00Z',
        series_end_at: null,
        max_occurrences: 365,
        holiday_calendar_id: null,
        materialized_through: '2026-05-01T00:00:00Z',
        parent_booking_id: 'MASTER',
      },
      masterBooking: masterBooking(),
      existing: [{ recurrence_index: 0 }],
      masterOrders: [{ id: 'ORDER-1' }],
    });

    const bookingFlow = {
      create: jest.fn(async (input: { start_at: string; end_at: string }) => ({
        id: 'OCC-1', start_at: input.start_at, end_at: input.end_at,
      })),
    };
    const conflict = { isExclusionViolation: () => false };
    const ordersFanOut = {
      cloneOrderForOccurrence: jest.fn(async () => {
        throw new Error('clone failed');
      }),
    };

    // Compensation returns partial_failure (a child sub-series blocks).
    const compensation = {
      deleteBooking: jest.fn(async (bookingId: string) => ({
        kind: 'partial_failure' as const,
        bookingId,
        blockedBy: ['recurrence_series'],
      })),
    };
    const txBoundary = {
      runWithCompensation: jest.fn(async <T>(
        bookingId: string,
        operation: () => Promise<T>,
        compensate: (bookingId: string) => Promise<{ kind: 'rolled_back' | 'partial_failure'; bookingId: string; blockedBy?: string[] }>,
      ): Promise<T> => {
        try { return await operation(); } catch {
          const outcome = await compensate(bookingId);
          if (outcome.kind === 'rolled_back') throw new Error('rolled_back path');
          throw Object.assign(new Error('booking.partial_failure'), {
            response: {
              code: 'booking.partial_failure',
              booking_id: outcome.bookingId,
              blocked_by: outcome.blockedBy,
            },
          });
        }
      }),
    };

    const svc = new RecurrenceService(
      supabase as never,
      conflict as never,
      undefined,
      txBoundary as never,
      compensation as never,
    );
    svc.setBookingFlow(bookingFlow as never);
    svc.setOrdersFanOut(ordersFanOut as never);

    const result = await svc.materialize('SER', new Date('2026-05-03T00:00:00Z'));

    // partial_failure → skipped (orphan booking persists; ops triages
    // via the audit_events row written by BookingCompensationService).
    expect(result.skipped_conflicts).toBeGreaterThan(0);
    expect(compensation.deleteBooking).toHaveBeenCalled();
  });
});

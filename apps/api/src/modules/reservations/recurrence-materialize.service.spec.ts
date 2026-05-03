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

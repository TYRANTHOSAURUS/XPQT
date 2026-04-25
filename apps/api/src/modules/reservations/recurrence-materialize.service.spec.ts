import { RecurrenceService } from './recurrence.service';
import type { Reservation } from './dto/types';

describe('RecurrenceService.materialize', () => {
  function makeMaster(): Reservation {
    return {
      id: 'MASTER',
      tenant_id: 'T',
      space_id: 'S',
      reservation_type: 'room',
      requester_person_id: 'P',
      host_person_id: null,
      start_at: '2026-05-01T09:00:00Z',
      end_at: '2026-05-01T10:00:00Z',
      attendee_count: 2,
      attendee_person_ids: [],
      status: 'confirmed',
      recurrence_rule: null,
      recurrence_series_id: 'SER',
      recurrence_master_id: 'MASTER',
      recurrence_index: 0,
      recurrence_overridden: false,
      recurrence_skipped: false,
      linked_order_id: null,
      approval_id: null,
      setup_buffer_minutes: 0,
      teardown_buffer_minutes: 0,
      effective_start_at: '2026-05-01T09:00:00Z',
      effective_end_at: '2026-05-01T10:00:00Z',
      check_in_required: false,
      check_in_grace_minutes: 15,
      checked_in_at: null,
      released_at: null,
      cancellation_grace_until: null,
      policy_snapshot: {},
      applied_rule_ids: [],
      source: 'portal',
      booked_by_user_id: 'U',
      cost_amount_snapshot: null,
      multi_room_group_id: null,
      calendar_event_id: null,
      calendar_provider: null,
      calendar_etag: null,
      calendar_last_synced_at: null,
      booking_bundle_id: null,
      created_at: '2026-05-01T09:00:00Z',
      updated_at: '2026-05-01T09:00:00Z',
    };
  }

  function makeSupabase(opts: {
    series: Record<string, unknown>;
    master: Reservation;
    existing: Array<{ recurrence_index: number | null }>;
  }) {
    return {
      admin: {
        from: (table: string) => {
          if (table === 'recurrence_series') {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({ data: opts.series, error: null }),
                }),
              }),
              update: () => ({
                eq: () => Promise.resolve({ data: null, error: null }),
              }),
            };
          }
          if (table === 'reservations') {
            return {
              select: () => ({
                eq: (_k: string, v: string) => {
                  if (v === 'MASTER') {
                    return {
                      maybeSingle: () => Promise.resolve({ data: opts.master, error: null }),
                    };
                  }
                  return {
                    eq: () => Promise.resolve({ data: opts.existing, error: null }),
                  };
                },
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
    const master = makeMaster();
    const series = {
      id: 'SER',
      tenant_id: 'T',
      recurrence_rule: { frequency: 'daily', interval: 1, count: 5 },
      series_start_at: '2026-05-01T09:00:00Z',
      series_end_at: null,
      max_occurrences: 365,
      holiday_calendar_id: null,
      materialized_through: '2026-05-01T00:00:00Z',
      parent_reservation_id: 'MASTER',
    };

    const supabase = makeSupabase({
      series,
      master,
      existing: [{ recurrence_index: 0 }],   // master is already on disk at index 0
    });

    let createCalls = 0;
    const bookingFlow = {
      create: jest.fn(async (input: any) => {
        createCalls += 1;
        // Simulate conflict on the 3rd materialised occurrence.
        if (createCalls === 3) {
          throw Object.assign(new Error('reservations_no_overlap exclusion'), {
            code: '23P01',
            message: 'reservations_no_overlap',
          });
        }
        return { ...master, id: `OCC-${createCalls}`, start_at: input.start_at };
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

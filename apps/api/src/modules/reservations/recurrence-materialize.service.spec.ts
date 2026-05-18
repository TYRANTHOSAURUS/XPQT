import { Logger } from '@nestjs/common';
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
            // I3 added an optional second .eq('tenant_id') on the
            // lookup chain when TenantContext is set. The materialize()
            // call site uses currentOrNull() so the test can run with
            // or without TenantContext.run(). Idempotent .eq() supports
            // both shapes.
            const lookupChain: any = {
              eq: () => lookupChain,
              maybeSingle: () =>
                Promise.resolve({ data: opts.series, error: null }),
            };
            const updateChain: any = {
              eq: () => updateChain,
              then: (r: (v: { error: unknown }) => unknown) =>
                Promise.resolve({ error: null }).then(r),
            };
            return {
              select: () => ({ eq: () => lookupChain }),
              update: () => updateChain,
            };
          }
          // Master booking projection — recurrence.service.ts:328-333.
          // Chain shape: .from('booking_slots').select(...).eq('booking_id', X)
          //   .order(...).limit(1).maybeSingle()
          if (table === 'booking_slots') {
            // I3 added a tenant_id eq before the booking_id eq.
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    order: () => ({
                      limit: () => ({
                        maybeSingle: () =>
                          Promise.resolve({ data: masterSlotEmbed, error: null }),
                      }),
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
            // I3: optional .eq('tenant_id') after .eq('id').
            const calChain: any = {
              eq: () => calChain,
              maybeSingle: () => Promise.resolve({ data: null, error: null }),
            };
            return { select: () => ({ eq: () => calChain }) };
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

// Booking-audit Slice 7 (audit 03 P2-1) — the clone step is no longer
// wrapped in BookingTransactionBoundary.runWithCompensation. Both
// BookingTransactionBoundary + BookingCompensationService are RETIRED.
// On a clone throw, materialize() calls the new focused private helper
// `RecurrenceService.deleteOrphanOccurrence` which:
//   - calls `delete_booking_with_guard` (00292/00373) DIRECTLY with
//     `{ p_booking_id: <occurrence booking id>, p_tenant_id }`
//   - emits the `booking.compensation_failed` /
//     `booking.compensation_partial_failure` audit_events rows VERBATIM
//     from the retired BookingCompensationService
//   - returns an outcome the clone-catch maps to the SAME throws the
//     boundary raised, so the existing materialize() catch behaves
//     byte-identically (unexpected/partial → sawUnexpectedFailure →
//     materialized_through NOT advanced; an original 23P01 on the
//     rolled_back path → conflict skip + advance).
//
// These tests assert the REAL reproduced behaviour against the direct
// `delete_booking_with_guard` RPC + the audit_events emission — NOT a
// boundary mock.

// Shared mock supabase with: series/master/existing reads, a controllable
// `delete_booking_with_guard` rpc, an audit_events insert capture, and a
// materialized_through-update capture.
function buildDirectDeleteSupabase(opts: {
  series: Record<string, unknown>;
  masterOrders: Array<{ id: string }>;
  // What delete_booking_with_guard returns, per call. If a function,
  // called with the rpc args; else returned verbatim.
  guardResult:
    | { data: unknown; error: unknown }
    | ((args: Record<string, unknown>) => { data: unknown; error: unknown });
}) {
  const master = {
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
  const masterSlotEmbed = {
    id: 'MASTER-SLOT',
    tenant_id: 'T',
    booking_id: 'MASTER',
    slot_type: 'room',
    space_id: 'S',
    start_at: master.start_at,
    end_at: master.end_at,
    setup_buffer_minutes: 0,
    teardown_buffer_minutes: 0,
    effective_start_at: master.start_at,
    effective_end_at: master.end_at,
    attendee_count: 2,
    attendee_person_ids: [],
    status: master.status,
    check_in_required: false,
    check_in_grace_minutes: 15,
    checked_in_at: null,
    released_at: null,
    cancellation_grace_until: null,
    display_order: 0,
    created_at: master.created_at,
    updated_at: master.updated_at,
    bookings: master,
  };

  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const auditInserts: Array<Record<string, unknown>> = [];
  const seriesUpdates: Array<unknown> = [];

  const supabase = {
    admin: {
      rpc: (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push({ fn, args });
        if (fn === 'delete_booking_with_guard') {
          const r =
            typeof opts.guardResult === 'function'
              ? opts.guardResult(args)
              : opts.guardResult;
          return Promise.resolve(r);
        }
        return Promise.resolve({ data: null, error: null });
      },
      from: (table: string) => {
        if (table === 'recurrence_series') {
          const lookupChain: any = {
            eq: () => lookupChain,
            maybeSingle: () =>
              Promise.resolve({ data: opts.series, error: null }),
          };
          const buildUpdateChain = (patch: unknown) => {
            seriesUpdates.push(patch);
            const c: any = {
              eq: () => c,
              then: (r: (v: { error: unknown }) => unknown) =>
                Promise.resolve({ error: null }).then(r),
            };
            return c;
          };
          return {
            select: () => ({ eq: () => lookupChain }),
            update: (patch: unknown) => buildUpdateChain(patch),
          };
        }
        if (table === 'booking_slots') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () => ({
                      maybeSingle: () =>
                        Promise.resolve({ data: masterSlotEmbed, error: null }),
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'bookings') {
          return {
            select: () => ({
              eq: () => ({
                eq: () =>
                  Promise.resolve({
                    data: [{ recurrence_index: 0 }],
                    error: null,
                  }),
              }),
            }),
          };
        }
        if (table === 'business_hours_calendars') {
          const c: any = {
            eq: () => c,
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
          };
          return { select: () => ({ eq: () => c }) };
        }
        if (table === 'orders') {
          const c: any = {
            eq: () => c,
            then: (r: (v: { data: unknown; error: unknown }) => unknown) =>
              Promise.resolve({ data: opts.masterOrders, error: null }).then(r),
          };
          return { select: () => c };
        }
        if (table === 'audit_events') {
          return {
            insert: (row: Record<string, unknown>) => {
              auditInserts.push(row);
              return Promise.resolve({ error: null });
            },
          };
        }
        return {};
      },
    },
  };

  return { supabase, rpcCalls, auditInserts, seriesUpdates };
}

describe('RecurrenceService.materialize — Slice 7 direct delete_booking_with_guard compensation', () => {
  const series = {
    id: 'SER',
    tenant_id: 'T',
    recurrence_rule: { frequency: 'daily', interval: 1, count: 3 },
    series_start_at: '2026-05-01T09:00:00Z',
    series_end_at: null,
    max_occurrences: 365,
    holiday_calendar_id: null,
    materialized_through: '2026-05-01T00:00:00Z',
    parent_booking_id: 'MASTER',
  };

  function makeBookingFlow() {
    let n = 0;
    return {
      create: jest.fn(async (input: { start_at: string; end_at: string }) => {
        n += 1;
        return { id: `OCC-${n}`, start_at: input.start_at, end_at: input.end_at };
      }),
    };
  }

  it('clone failure → delete_booking_with_guard called DIRECTLY with the occurrence booking id (not master), rolled_back → no audit, occurrence not in created', async () => {
    const { supabase, rpcCalls, auditInserts } = buildDirectDeleteSupabase({
      series,
      masterOrders: [{ id: 'ORDER-1' }],
      // Clean rollback for every compensation call.
      guardResult: { data: { kind: 'rolled_back' }, error: null },
    });
    const conflict = { isExclusionViolation: () => false };
    const ordersFanOut = {
      cloneOrderForOccurrence: jest.fn(async () => {
        throw new Error('clone failed: asset GiST conflict');
      }),
    };

    const svc = new RecurrenceService(supabase as never, conflict as never);
    svc.setBookingFlow(makeBookingFlow() as never);
    svc.setOrdersFanOut(ordersFanOut as never);

    const result = await svc.materialize('SER', new Date('2026-05-05T00:00:00Z'));

    // Every clone threw → every occurrence compensated → none survived.
    expect(result.created).toHaveLength(0);
    expect(result.skipped_conflicts).toBeGreaterThan(0);

    // delete_booking_with_guard fired directly with the OCCURRENCE booking
    // id + the tenant — NOT the master id, NOT via any boundary.
    const guardCalls = rpcCalls.filter(
      (c) => c.fn === 'delete_booking_with_guard',
    );
    expect(guardCalls.length).toBeGreaterThan(0);
    for (const c of guardCalls) {
      expect(c.args.p_booking_id).not.toBe('MASTER');
      expect(String(c.args.p_booking_id)).toMatch(/^OCC-/);
      expect(c.args.p_tenant_id).toBe('T');
    }
    // rolled_back path emits NO audit (booking-compensation.service.ts:
    // 108-112 — clean rollback, no audit). Reproduced verbatim.
    expect(auditInserts).toHaveLength(0);
  });

  it('rolled_back path re-throws the ORIGINAL clone error → an original 23P01 takes the conflict skip + ADVANCE path (boundary parity)', async () => {
    const { supabase, seriesUpdates } = buildDirectDeleteSupabase({
      series,
      masterOrders: [{ id: 'ORDER-1' }],
      guardResult: { data: { kind: 'rolled_back' }, error: null },
    });
    // The clone throws a 23P01-shaped error; deleteOrphanOccurrence rolls
    // back cleanly, materialize() re-throws the ORIGINAL error, and the
    // existing catch's `conflict.isExclusionViolation` matches it →
    // EXPECTED failure → materialized_through SHOULD advance (this is the
    // exact behaviour the boundary produced: it re-threw the original on
    // rolled_back).
    const conflict = {
      isExclusionViolation: (err: unknown) =>
        (err as { code?: string })?.code === '23P01',
    };
    const ordersFanOut = {
      cloneOrderForOccurrence: jest.fn(async () => {
        throw Object.assign(new Error('asset exclusion'), { code: '23P01' });
      }),
    };

    const svc = new RecurrenceService(supabase as never, conflict as never);
    svc.setBookingFlow(makeBookingFlow() as never);
    svc.setOrdersFanOut(ordersFanOut as never);

    const result = await svc.materialize('SER', new Date('2026-05-05T00:00:00Z'));

    expect(result.skipped_conflicts).toBeGreaterThan(0);
    // Expected-failure-only run → materialized_through advances exactly
    // as it did with the boundary's rolled_back→re-throw-original path.
    const advanced = seriesUpdates.filter(
      (u) => u && typeof u === 'object' && 'materialized_through' in (u as object),
    );
    expect(advanced.length).toBeGreaterThan(0);
  });
});

describe('RecurrenceService.materialize — Slice 7 audit emission + materialized_through gating', () => {
  const series = {
    id: 'SER',
    tenant_id: 'T',
    recurrence_rule: { frequency: 'daily', interval: 1, count: 3 },
    series_start_at: '2026-05-01T09:00:00Z',
    series_end_at: null,
    max_occurrences: 365,
    holiday_calendar_id: null,
    materialized_through: '2026-05-01T00:00:00Z',
    parent_booking_id: 'MASTER',
  };

  function makeBookingFlow() {
    let n = 0;
    return {
      create: jest.fn(async (input: { start_at: string; end_at: string }) => {
        n += 1;
        return { id: `OCC-${n}`, start_at: input.start_at, end_at: input.end_at };
      }),
    };
  }

  function makeFailingClone() {
    return {
      cloneOrderForOccurrence: jest.fn(async () => {
        throw new Error('clone failed');
      }),
    };
  }

  it('partial_failure → emits booking.compensation_partial_failure audit (verbatim payload) AND does NOT advance materialized_through', async () => {
    const { supabase, auditInserts, seriesUpdates } = buildDirectDeleteSupabase({
      series,
      masterOrders: [{ id: 'ORDER-1' }],
      guardResult: {
        data: { kind: 'partial_failure', blocked_by: ['recurrence_series'] },
        error: null,
      },
    });
    const conflict = { isExclusionViolation: () => false };

    // audit-03 slice1 (D-9): the dedicated `booking.partial_failure`
    // ops-triage branch was DEAD pre-fix (catch read e.response?.code,
    // always undefined → catch-all). Spy the Logger and assert the
    // dedicated triage line ("clone failed AND compensation blocked —
    // manual recovery required") now fires.
    const errSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    const svc = new RecurrenceService(supabase as never, conflict as never);
    svc.setBookingFlow(makeBookingFlow() as never);
    svc.setOrdersFanOut(makeFailingClone() as never);

    const result = await svc.materialize('SER', new Date('2026-05-03T00:00:00Z'));
    expect(result.skipped_conflicts).toBeGreaterThan(0);

    // Dedicated booking.partial_failure triage branch is now LIVE.
    const triageCalls = errSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) =>
        m.includes('clone failed AND compensation blocked — manual recovery required'),
      );
    expect(triageCalls.length).toBeGreaterThan(0);
    errSpy.mockRestore();

    // Audit row reproduced verbatim from BookingCompensationService:
    // event_type 'booking.compensation_partial_failure', entity_type
    // 'booking', entity_id = occurrence id, details { blocked_by:[...] },
    // tenant_id 'T' (booking-compensation.service.ts:118-120,142-148).
    const partial = auditInserts.filter(
      (r) => r.event_type === 'booking.compensation_partial_failure',
    );
    expect(partial.length).toBeGreaterThan(0);
    for (const row of partial) {
      expect(row.tenant_id).toBe('T');
      expect(row.entity_type).toBe('booking');
      expect(String(row.entity_id)).toMatch(/^OCC-/);
      expect((row.details as { blocked_by?: unknown }).blocked_by).toEqual([
        'recurrence_series',
      ]);
    }

    // Retry signal: NO materialized_through advance (the partial_failure
    // outcome maps to booking.partial_failure → sawUnexpectedFailure).
    const advanced = seriesUpdates.filter(
      (u) => u && typeof u === 'object' && 'materialized_through' in (u as object),
    );
    expect(advanced).toHaveLength(0);
  });

  it('RPC error → emits booking.compensation_failed audit (verbatim payload) AND does NOT advance materialized_through', async () => {
    const { supabase, auditInserts, seriesUpdates } = buildDirectDeleteSupabase({
      series,
      masterOrders: [{ id: 'ORDER-1' }],
      // delete_booking_with_guard itself blew up (network/5xx).
      guardResult: { data: null, error: { message: 'connection lost' } },
    });
    const conflict = { isExclusionViolation: () => false };

    // audit-03 slice1 (D-9): the dedicated `booking.compensation_failed`
    // ops-triage branch was DEAD pre-fix. Spy the Logger and assert the
    // dedicated triage line ("compensation RPC failed — booking may
    // persist in unknown state") now fires.
    const errSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    const svc = new RecurrenceService(supabase as never, conflict as never);
    svc.setBookingFlow(makeBookingFlow() as never);
    svc.setOrdersFanOut(makeFailingClone() as never);

    const result = await svc.materialize('SER', new Date('2026-05-03T00:00:00Z'));
    expect(result.skipped_conflicts).toBeGreaterThan(0);

    // Dedicated booking.compensation_failed triage branch is now LIVE.
    const triageCalls = errSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) =>
        m.includes('compensation RPC failed — booking may persist in unknown state'),
      );
    expect(triageCalls.length).toBeGreaterThan(0);
    errSpy.mockRestore();

    // Audit row reproduced verbatim: 'booking.compensation_failed',
    // details { rpc_error: 'connection lost' }
    // (booking-compensation.service.ts:73-75,142-148).
    const failed = auditInserts.filter(
      (r) => r.event_type === 'booking.compensation_failed',
    );
    expect(failed.length).toBeGreaterThan(0);
    for (const row of failed) {
      expect(row.tenant_id).toBe('T');
      expect(row.entity_type).toBe('booking');
      expect(String(row.entity_id)).toMatch(/^OCC-/);
      expect((row.details as { rpc_error?: unknown }).rpc_error).toBe(
        'connection lost',
      );
    }

    // compensation_failed maps to booking.compensation_failed →
    // sawUnexpectedFailure → NO advance.
    const advanced = seriesUpdates.filter(
      (u) => u && typeof u === 'object' && 'materialized_through' in (u as object),
    );
    expect(advanced).toHaveLength(0);
  });

  it('malformed RPC payload → emits booking.compensation_failed audit (rpc_error=malformed_payload) AND does NOT advance materialized_through', async () => {
    const { supabase, auditInserts, seriesUpdates } = buildDirectDeleteSupabase({
      series,
      masterOrders: [{ id: 'ORDER-1' }],
      // RPC returned no/garbage payload (booking-compensation.service.ts:
      // 93-106 malformed-payload branch).
      guardResult: { data: null, error: null },
    });
    const conflict = { isExclusionViolation: () => false };

    const svc = new RecurrenceService(supabase as never, conflict as never);
    svc.setBookingFlow(makeBookingFlow() as never);
    svc.setOrdersFanOut(makeFailingClone() as never);

    const result = await svc.materialize('SER', new Date('2026-05-03T00:00:00Z'));
    expect(result.skipped_conflicts).toBeGreaterThan(0);

    const failed = auditInserts.filter(
      (r) => r.event_type === 'booking.compensation_failed',
    );
    expect(failed.length).toBeGreaterThan(0);
    for (const row of failed) {
      expect((row.details as { rpc_error?: unknown }).rpc_error).toBe(
        'malformed_payload',
      );
    }
    const advanced = seriesUpdates.filter(
      (u) => u && typeof u === 'object' && 'materialized_through' in (u as object),
    );
    expect(advanced).toHaveLength(0);
  });

  it('expected failure (23P01 at create) DOES advance materialized_through — Slice 7 does not gate off the expected-skip path', async () => {
    const { supabase, seriesUpdates } = buildDirectDeleteSupabase({
      series,
      masterOrders: [],
      guardResult: { data: { kind: 'rolled_back' }, error: null },
    });
    const conflict = {
      isExclusionViolation: (err: unknown) =>
        (err as { code?: string })?.code === '23P01',
    };
    const bookingFlow = {
      // Every create throws a GiST conflict — expected skip → advance.
      create: jest.fn(async () => {
        throw Object.assign(new Error('exclusion'), { code: '23P01' });
      }),
    };

    const svc = new RecurrenceService(supabase as never, conflict as never);
    svc.setBookingFlow(bookingFlow as never);

    await svc.materialize('SER', new Date('2026-05-03T00:00:00Z'));

    const advanced = seriesUpdates.filter(
      (u) => u && typeof u === 'object' && 'materialized_through' in (u as object),
    );
    expect(advanced.length).toBeGreaterThan(0);
  });
});

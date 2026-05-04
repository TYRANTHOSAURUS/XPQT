/**
 * Slice 4 — verify ReservationService.editOne fans out per-visitor
 * BundleEvents when a booking-attached slot moves time / changes room.
 *
 * Booking-canonicalisation rewrite (2026-05-02):
 *   - `reservations` was dropped; reads/writes go through `booking_slots`
 *     joined to `bookings` (reservation.service.ts:163-175).
 *   - `visitors.booking_bundle_id` was renamed to `visitors.booking_id`
 *     (00278:41 retarget). The cascade lookup now keys on `booking_id`
 *     (reservation.service.ts:732-736).
 *   - Under canonicalisation the booking IS the bundle, so the legacy
 *     `Reservation.booking_bundle_id` field equals `bookings.id`
 *     (reservation-projection.ts:34, 121). The `bundle_id` carried on
 *     emitted events therefore equals the booking id.
 *
 * The visitor cascade adapter (in VisitorsModule) consumes these events and
 * translates them into the right per-visitor action (cancel / email / host
 * alert) per spec §10.2. Here we only assert the emitter side.
 *
 * What we verify:
 *   - editOne with start_at change AND a bundle attachment + visitors emits
 *     one bundle.line.moved per visitor with line_kind='visitor', old/new
 *     expected_at, and the right tenant.
 *   - editOne with space_id change emits one bundle.line.room_changed per
 *     visitor.
 *   - editOne with both fields changed emits BOTH events per visitor.
 *   - editOne on a booking with zero visitors emits nothing.
 *   - cross-tenant: events carry the current TenantContext id, not the row's.
 *   - A no-op edit (same value) doesn't emit.
 */

import { ReservationService } from './reservation.service';
import { BundleEventBus, type BundleEvent } from '../booking-bundles/bundle-event-bus';
import { TenantContext } from '../../common/tenant-context';

const TENANT = '11111111-1111-4111-8111-111111111111';
// Under canonicalisation BOOKING_ID is the id editOne receives; the
// returned Reservation projection has booking_bundle_id === booking.id
// (reservation-projection.ts:121), so emitted events carry this same id
// as `bundle_id`.
const BOOKING_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
// Plan A.2 / Commit 6: editOne adds a TS-layer space pre-flight using
// assertTenantOwned, which strictly validates uuid format. Replaced
// non-hex placeholder strings (`s`, `v`, `u`, `p`) with valid hex
// surrogates so the regex accepts them.
const PRIMARY_SLOT_ID = 'aaaaaaa1-1111-4111-8111-aaaaaaaaaaaa';
const SPACE_OLD = 'aaaaaa11-1111-4111-8111-aaaaaaaaaaaa';
const SPACE_NEW = 'aaaaaa22-2222-4222-8222-aaaaaaaaaaaa';
const V1 = 'b1111111-1111-4111-8111-bbbbbbbbbbbb';
const V2 = 'b2222222-2222-4222-8222-bbbbbbbbbbbb';
const USER_ID = 'cccccccc-1111-4111-8111-cccccccccccc';
const PERSON_ID = 'dddddddd-1111-4111-8111-dddddddddddd';

// Base data is split into a "slot" half and a "booking" half so the mock
// can return the PostgREST embed shape that `slotWithBookingToReservation`
// (reservation-projection.ts:55) consumes.
const baseSlot = {
  id: PRIMARY_SLOT_ID,
  tenant_id: TENANT,
  booking_id: BOOKING_ID,
  slot_type: 'room',
  space_id: SPACE_OLD,
  start_at: '2026-05-01T10:00:00.000Z',
  end_at: '2026-05-01T11:00:00.000Z',
  attendee_count: 5,
  attendee_person_ids: [],
  status: 'confirmed',
  setup_buffer_minutes: 0,
  teardown_buffer_minutes: 0,
  effective_start_at: '2026-05-01T10:00:00.000Z',
  effective_end_at: '2026-05-01T11:00:00.000Z',
  check_in_required: false,
  check_in_grace_minutes: null,
  checked_in_at: null,
  released_at: null,
  cancellation_grace_until: null,
  display_order: 0,
};

const baseBooking = {
  id: BOOKING_ID,
  tenant_id: TENANT,
  title: 'Test booking',
  description: null,
  requester_person_id: PERSON_ID,
  host_person_id: null,
  booked_by_user_id: USER_ID,
  location_id: SPACE_OLD,
  start_at: '2026-05-01T10:00:00.000Z',
  end_at: '2026-05-01T11:00:00.000Z',
  timezone: 'UTC',
  status: 'confirmed',
  source: 'portal',
  cost_center_id: null,
  cost_amount_snapshot: null,
  policy_snapshot: null,
  applied_rule_ids: null,
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
  created_at: '2026-05-01T09:00:00.000Z',
  updated_at: '2026-05-01T09:00:00.000Z',
};

function makeService(opts: {
  visitorIds?: string[];
  visitorLookupError?: { message: string };
  updateError?: { message: string } | null;
  // Patch applied to the slot half of the embed AFTER the update returns.
  updatedSlot?: Partial<typeof baseSlot>;
  // Patch applied to the booking half of the embed AFTER the update returns.
  updatedBooking?: Partial<typeof baseBooking>;
}) {
  const visitorIds = opts.visitorIds ?? [V1, V2];

  // Mutable state — `findByIdOrThrow` is called twice (once before update,
  // once after). The post-update read should reflect the patch.
  let postUpdate = false;

  const buildSlotEmbed = () => ({
    ...baseSlot,
    ...(postUpdate ? (opts.updatedSlot ?? {}) : {}),
    bookings: {
      ...baseBooking,
      ...(postUpdate ? (opts.updatedBooking ?? {}) : {}),
    },
  });

  const supabase = {
    admin: {
      // C2 closure: editOne now delegates geometry to editSlot, which
      // calls the edit_booking_slot RPC instead of writing the slot row
      // directly. The RPC is the atomicity primitive (00291 + 00293
      // lock); on success we mark postUpdate=true so the post-RPC
      // findByIdOrThrowAtSlot read returns the new geometry.
      rpc: jest.fn((fn: string, _args: unknown) => {
        if (fn === 'edit_booking_slot') {
          if (opts.updateError) {
            return Promise.resolve({ data: null, error: opts.updateError });
          }
          postUpdate = true;
          return Promise.resolve({
            data: { slot: buildSlotEmbed(), booking: null },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      }),
      from: jest.fn((table: string) => {
        if (table === 'booking_slots') {
          return {
            // Three select shapes are used:
            //  - SLOT_WITH_BOOKING_SELECT (full embed) → findByIdOrThrow
            //    (booking-id-keyed) and findByIdOrThrowAtSlot (slot-id-keyed).
            //  - select('id') → primary-slot lookup in editOne / editSlot pre-resolution.
            //  - select('booking_id') → editSlot's pre-flight (URL-mismatch + not-found gate).
            select: (cols?: string) => {
              const isPrimarySlotLookup = cols === 'id';
              const isBookingIdLookup = cols === 'booking_id';
              if (isBookingIdLookup) {
                // editSlot pre-flight: .eq('tenant_id').eq('id').maybeSingle()
                return {
                  eq: () => ({
                    eq: () => ({
                      maybeSingle: () =>
                        Promise.resolve({
                          data: { booking_id: BOOKING_ID },
                          error: null,
                        }),
                    }),
                  }),
                };
              }
              return {
                eq: () => ({
                  eq: () => ({
                    order: () => {
                      if (isPrimarySlotLookup) {
                        // editOne: .order().order().limit().maybeSingle() — primary-slot lookup.
                        return {
                          order: () => ({
                            limit: () => ({
                              maybeSingle: () =>
                                Promise.resolve({
                                  data: { id: PRIMARY_SLOT_ID },
                                  error: null,
                                }),
                            }),
                          }),
                          // Backward-compat: the legacy .order().limit() (no second order)
                          // shape is still used by the cancel/restore paths.
                          limit: () => ({
                            maybeSingle: () =>
                              Promise.resolve({
                                data: { id: PRIMARY_SLOT_ID },
                                error: null,
                              }),
                          }),
                        };
                      }
                      // findByIdOrThrow / findByIdOrThrowAtSlot chain:
                      // .order().order().limit().maybeSingle()
                      return {
                        order: () => ({
                          limit: () => ({
                            maybeSingle: () =>
                              Promise.resolve({
                                data: buildSlotEmbed(),
                                error: null,
                              }),
                          }),
                        }),
                      };
                    },
                  }),
                }),
              };
            },
            update: () => {
              // Slot meta-only update path (attendee_count/attendee_person_ids).
              // Geometry no longer flows through here under C2 — those go via RPC.
              const buildChain = () => {
                const chain: {
                  eq: (...args: unknown[]) => typeof chain;
                  then: (resolve: (v: { error: unknown }) => unknown) => Promise<unknown>;
                } = {
                  eq: () => chain,
                  then: (resolve) => {
                    if (opts.updateError) {
                      return Promise.resolve({ error: opts.updateError }).then(resolve);
                    }
                    postUpdate = true;
                    return Promise.resolve({ error: null }).then(resolve);
                  },
                };
                return chain;
              };
              return buildChain();
            },
          };
        }
        if (table === 'bookings') {
          return {
            update: () => {
              const buildChain = () => {
                const chain: {
                  eq: (...args: unknown[]) => typeof chain;
                  then: (resolve: (v: { error: unknown }) => unknown) => Promise<unknown>;
                } = {
                  eq: () => chain,
                  then: (resolve) => {
                    postUpdate = true;
                    return Promise.resolve({ error: null }).then(resolve);
                  },
                };
                return chain;
              };
              return buildChain();
            },
          };
        }
        if (table === 'visitors') {
          // reservation.service.ts:732-736 — `.from('visitors').select('id')
          //   .eq('tenant_id', X).eq('booking_id', Y)` (no further chaining).
          return {
            select: () => ({
              eq: () => ({
                eq: () => {
                  if (opts.visitorLookupError) {
                    return Promise.resolve({ data: null, error: opts.visitorLookupError });
                  }
                  return Promise.resolve({
                    data: visitorIds.map((id) => ({ id })),
                    error: null,
                  });
                },
              }),
            }),
          };
        }
        if (table === 'spaces') {
          // Plan A.2 / Commit 6: editOne pre-flight calls
          // assertTenantOwned('spaces', patch.space_id, ..., {activeOnly, reservableOnly}).
          // Return a positive match for SPACE_NEW under TENANT — the only
          // space_id this spec ever passes into editOne.
          const filters: Record<string, unknown> = {};
          const chain: Record<string, unknown> = {
            eq: (col: string, val: unknown) => {
              filters[col] = val;
              return chain;
            },
            maybeSingle: () => {
              if (
                filters.tenant_id === TENANT &&
                filters.active === true &&
                filters.reservable === true
              ) {
                return Promise.resolve({
                  data: { id: filters.id as string },
                  error: null,
                });
              }
              return Promise.resolve({ data: null, error: null });
            },
          };
          return { select: () => chain };
        }
        if (table === 'audit_events') {
          return { insert: () => Promise.resolve({ data: null, error: null }) };
        }
        // Defensive — never reached in this spec.
        return {
          select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }),
          insert: () => Promise.resolve({ data: null, error: null }),
        };
      }),
    },
  };

  const conflict = { isExclusionViolation: () => false };
  const visibility = {
    loadContextByUserId: jest.fn(async () => ({})),
    assertVisible: () => {},
    canEdit: () => true,
  };

  const eventBus = new BundleEventBus();
  const captured: BundleEvent[] = [];
  const sub = eventBus.events$.subscribe((e) => captured.push(e));

  const svc = new ReservationService(
    supabase as never,
    conflict as never,
    visibility as never,
    undefined,
    undefined,
    undefined,
    eventBus,
  );

  return { svc, captured, unsubscribe: () => sub.unsubscribe() };
}

const ACTOR = {
  user_id: USER_ID,
  person_id: PERSON_ID,
  is_service_desk: false,
  has_override_rules: false,
};

describe('ReservationService.editOne — slice 4 visitor cascade emission', () => {
  it('emits bundle.line.moved per visitor when start_at changes', async () => {
    const newStart = '2026-05-01T14:00:00.000Z';
    const { svc, captured, unsubscribe } = makeService({
      updatedSlot: { start_at: newStart },
      updatedBooking: { start_at: newStart },
    });
    try {
      await TenantContext.run(
        { id: TENANT, slug: 'test', tier: 'standard' },
        () => svc.editOne(BOOKING_ID, ACTOR, { start_at: newStart }),
      );

      // One per visitor.
      const moved = captured.filter((e) => e.kind === 'bundle.line.moved');
      expect(moved).toHaveLength(2);
      const ids = new Set(moved.map((e) => e.kind === 'bundle.line.moved' ? e.line_id : ''));
      expect(ids).toEqual(new Set([V1, V2]));
      for (const evt of moved) {
        expect(evt.tenant_id).toBe(TENANT);
        // Under canonicalisation the booking IS the bundle
        // (reservation-projection.ts:121), so `bundle_id` on the event
        // equals the booking id passed to editOne.
        expect(evt.bundle_id).toBe(BOOKING_ID);
        if (evt.kind === 'bundle.line.moved') {
          expect(evt.line_kind).toBe('visitor');
          expect(evt.old_expected_at).toBe(baseSlot.start_at);
          expect(evt.new_expected_at).toBe(newStart);
        }
      }
      // No room_changed when only time moved.
      expect(captured.filter((e) => e.kind === 'bundle.line.room_changed')).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });

  it('emits bundle.line.room_changed per visitor when space_id changes', async () => {
    const { svc, captured, unsubscribe } = makeService({
      updatedSlot: { space_id: SPACE_NEW },
      updatedBooking: { location_id: SPACE_NEW },
    });
    try {
      await TenantContext.run(
        { id: TENANT, slug: 'test', tier: 'standard' },
        () => svc.editOne(BOOKING_ID, ACTOR, { space_id: SPACE_NEW }),
      );
      const roomChanges = captured.filter((e) => e.kind === 'bundle.line.room_changed');
      expect(roomChanges).toHaveLength(2);
      for (const evt of roomChanges) {
        expect(evt.bundle_id).toBe(BOOKING_ID);
        if (evt.kind === 'bundle.line.room_changed') {
          expect(evt.line_kind).toBe('visitor');
          expect(evt.old_room_id).toBe(SPACE_OLD);
          expect(evt.new_room_id).toBe(SPACE_NEW);
        }
      }
      expect(captured.filter((e) => e.kind === 'bundle.line.moved')).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });

  it('emits BOTH moved + room_changed when start_at AND space_id change', async () => {
    const newStart = '2026-05-01T14:00:00.000Z';
    const { svc, captured, unsubscribe } = makeService({
      updatedSlot: { start_at: newStart, space_id: SPACE_NEW },
      updatedBooking: { start_at: newStart, location_id: SPACE_NEW },
    });
    try {
      await TenantContext.run(
        { id: TENANT, slug: 'test', tier: 'standard' },
        () => svc.editOne(BOOKING_ID, ACTOR, { start_at: newStart, space_id: SPACE_NEW }),
      );
      // 2 visitors × 2 events each = 4 emissions.
      expect(captured).toHaveLength(4);
      expect(captured.filter((e) => e.kind === 'bundle.line.moved')).toHaveLength(2);
      expect(captured.filter((e) => e.kind === 'bundle.line.room_changed')).toHaveLength(2);
    } finally {
      unsubscribe();
    }
  });

  it('does not emit when bundle has zero visitors', async () => {
    const newStart = '2026-05-01T14:00:00.000Z';
    const { svc, captured, unsubscribe } = makeService({
      visitorIds: [],
      updatedSlot: { start_at: newStart },
      updatedBooking: { start_at: newStart },
    });
    try {
      await TenantContext.run(
        { id: TENANT, slug: 'test', tier: 'standard' },
        () => svc.editOne(BOOKING_ID, ACTOR, { start_at: newStart }),
      );
      expect(captured).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });

  it('event payload tenant_id matches current TenantContext (cross-tenant defence)', async () => {
    const newStart = '2026-05-01T14:00:00.000Z';
    const OTHER_TENANT = '99999999-9999-4999-8999-999999999999';
    const { svc, captured, unsubscribe } = makeService({
      updatedSlot: { start_at: newStart },
      updatedBooking: { start_at: newStart },
    });
    try {
      await TenantContext.run(
        { id: OTHER_TENANT, slug: 'other', tier: 'standard' },
        () => svc.editOne(BOOKING_ID, ACTOR, { start_at: newStart }),
      );
      expect(captured.length).toBeGreaterThan(0);
      for (const evt of captured) {
        expect(evt.tenant_id).toBe(OTHER_TENANT);
      }
    } finally {
      unsubscribe();
    }
  });

  it('does not emit when no field actually changed', async () => {
    const { svc, captured, unsubscribe } = makeService({});
    try {
      // Patch the same value back — the editOne early-returns at
      // reservation.service.ts:653-655 because no patch keys are populated.
      await TenantContext.run(
        { id: TENANT, slug: 'test', tier: 'standard' },
        () => svc.editOne(BOOKING_ID, ACTOR, { start_at: baseSlot.start_at }),
      );
      expect(captured).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });
});

// /full-review v3 closure I3 — editSlot itself emits the visitor cascade.
//
// Before I3 / C2: editOne emitted; editSlot was silent. Operators editing
// a non-primary slot via the slot endpoint moved visitors without firing
// the bundle.line.moved / room_changed events. With C2 routing editOne
// through editSlot, the cascade emission now lives in editSlot — and
// crucially, fires EXACTLY ONCE per geometry edit, not twice via the
// editOne → editSlot delegation chain.
describe('ReservationService.editSlot — visitor cascade emission (I3)', () => {
  it('emits bundle.line.moved exactly once per visitor when start_at changes', async () => {
    const newStart = '2026-05-01T14:00:00.000Z';
    const { svc, captured, unsubscribe } = makeService({
      updatedSlot: { start_at: newStart },
      updatedBooking: { start_at: newStart },
    });
    try {
      await TenantContext.run(
        { id: TENANT, slug: 'test', tier: 'standard' },
        () => svc.editSlot(BOOKING_ID, PRIMARY_SLOT_ID, ACTOR, { start_at: newStart }),
      );
      const moved = captured.filter((e) => e.kind === 'bundle.line.moved');
      // Exactly one per visitor — guards against the double-fire that
      // would happen if both editOne AND editSlot emitted.
      expect(moved).toHaveLength(2);
      const lineIds = new Set(
        moved.map((e) => (e.kind === 'bundle.line.moved' ? e.line_id : '')),
      );
      expect(lineIds).toEqual(new Set([V1, V2]));
      for (const evt of moved) {
        if (evt.kind === 'bundle.line.moved') {
          expect(evt.bundle_id).toBe(BOOKING_ID);
          expect(evt.line_kind).toBe('visitor');
          expect(evt.old_expected_at).toBe(baseSlot.start_at);
          expect(evt.new_expected_at).toBe(newStart);
        }
      }
    } finally {
      unsubscribe();
    }
  });

  it('emits bundle.line.room_changed when space_id changes (primary slot path)', async () => {
    const { svc, captured, unsubscribe } = makeService({
      updatedSlot: { space_id: SPACE_NEW },
      updatedBooking: { location_id: SPACE_NEW },
    });
    try {
      await TenantContext.run(
        { id: TENANT, slug: 'test', tier: 'standard' },
        () => svc.editSlot(BOOKING_ID, PRIMARY_SLOT_ID, ACTOR, { space_id: SPACE_NEW }),
      );
      const roomChanges = captured.filter((e) => e.kind === 'bundle.line.room_changed');
      expect(roomChanges).toHaveLength(2);
    } finally {
      unsubscribe();
    }
  });

  it('does not double-fire — editOne → editSlot path emits exactly once per visitor', async () => {
    // C2 + I3 interaction guard: editOne now delegates geometry to
    // editSlot. If both ever emitted independently, this would 2x.
    const newStart = '2026-05-01T14:00:00.000Z';
    const { svc, captured, unsubscribe } = makeService({
      updatedSlot: { start_at: newStart },
      updatedBooking: { start_at: newStart },
    });
    try {
      await TenantContext.run(
        { id: TENANT, slug: 'test', tier: 'standard' },
        () => svc.editOne(BOOKING_ID, ACTOR, { start_at: newStart }),
      );
      const moved = captured.filter((e) => e.kind === 'bundle.line.moved');
      // 2 visitors × 1 event = 2. NOT 4 (which would be 2 visitors × 2
      // emit calls — once from editOne, once from editSlot).
      expect(moved).toHaveLength(2);
    } finally {
      unsubscribe();
    }
  });
});

// /full-review v3 closure I1 — cascade compares TARGET slot's pre/post
// state, NOT the primary slot's pre vs the target slot's post.
//
// Pre-fix: editSlot loaded `reservation = findByIdOrThrow(bookingId)`
// for auth — that projection picks the booking's PRIMARY slot. Then
// the post-RPC `updated = findByIdOrThrowAtSlot(slotId)` projection
// is the TARGET slot. The cascade diffed `updated` vs `reservation`,
// i.e. target-new vs PRIMARY-old. For non-primary edits, the "old"
// fields came from the wrong slot.
//
// Multi-room booking with 3 slots:
//   slot A (primary, display_order=0) — 09:00-10:00 in room R_A
//   slot B (display_order=1)          — 11:00-12:00 in room R_B
//   slot C (display_order=2)          — 13:00-14:00 in room R_C
// Operator edits slot B from 11:00 → 15:00. Pre-fix the cascade
// would emit `old_expected_at = 09:00` (slot A's start, the primary),
// not `11:00` (slot B's actual prior start).
//
// Post-fix: the cascade reads `targetSlotPre.start_at = 11:00` (slot B)
// → emits old_expected_at=11:00, new=15:00. Slot A's primary status is
// irrelevant.
describe('ReservationService.editSlot — I1 target-slot cascade', () => {
  // Distinct slot ids + per-slot baseline state so the mock can return
  // different "pre" rows depending on which slot id is being projected.
  const PRIMARY = 'sssssss1-1111-4111-8111-ssssssssssss'; // = PRIMARY_SLOT_ID
  const SLOT_B = 'sssssss2-2222-4222-8222-ssssssssssss'; // non-primary
  const ROOM_A = 'aaaaaa11-1111-4111-8111-aaaaaaaaaaaa';
  const ROOM_B = 'bbbbbb22-2222-4222-8222-bbbbbbbbbbbb';
  const ROOM_NEW = 'cccccc33-3333-4333-8333-cccccccccccc';

  // Distinct primary + non-primary slot embeds so we can prove the
  // cascade reads from TARGET, not PRIMARY.
  const slotA = {
    ...baseSlot,
    id: PRIMARY,
    space_id: ROOM_A,
    start_at: '2026-05-01T09:00:00.000Z',
    end_at: '2026-05-01T10:00:00.000Z',
    effective_start_at: '2026-05-01T09:00:00.000Z',
    effective_end_at: '2026-05-01T10:00:00.000Z',
    display_order: 0,
  };
  const slotBPre = {
    ...baseSlot,
    id: SLOT_B,
    space_id: ROOM_B,
    start_at: '2026-05-01T11:00:00.000Z',
    end_at: '2026-05-01T12:00:00.000Z',
    effective_start_at: '2026-05-01T11:00:00.000Z',
    effective_end_at: '2026-05-01T12:00:00.000Z',
    display_order: 1,
  };

  /**
   * Mock that returns slot A as the primary lookup, slot A's embed for
   * findByIdOrThrow(bookingId), and slot B's embed for
   * findByIdOrThrowAtSlot(slotId). After the RPC, the slot B post-state
   * is mutated (start_at + space_id) and returned by subsequent
   * findByIdOrThrowAtSlot reads.
   *
   * The two findByIdOrThrowAtSlot reads (one before RPC for I1 pre-state,
   * one after for the projection) need to return different shapes —
   * `pre` returns slot B's prior state, `post` returns slot B with the
   * patch applied.
   */
  function makeNonPrimaryService(opts: {
    visitorIds?: string[];
    targetPatch: { start_at?: string; space_id?: string };
  }) {
    const visitorIds = opts.visitorIds ?? [V1, V2];
    let projectionsServed = 0;

    const buildSlotEmbed = (slot: typeof baseSlot, patch?: typeof opts.targetPatch) => ({
      ...slot,
      ...(patch ?? {}),
      bookings: {
        ...baseBooking,
        // booking-level mirror: in real life MIN/MAX over slots would
        // shift; for the test only the slot-level fields drive the
        // cascade after I1.
      },
    });

    const supabase = {
      admin: {
        rpc: jest.fn((fn: string) => {
          if (fn === 'edit_booking_slot') {
            return Promise.resolve({
              data: {
                slot: buildSlotEmbed(slotBPre, opts.targetPatch),
                booking: null,
              },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        }),
        from: jest.fn((table: string) => {
          if (table === 'booking_slots') {
            return {
              select: (cols?: string) => {
                if (cols === 'booking_id') {
                  // editSlot's pre-flight: returns the slot's parent
                  // booking_id under tenant filter.
                  return {
                    eq: () => ({
                      eq: () => ({
                        maybeSingle: () =>
                          Promise.resolve({
                            data: { booking_id: BOOKING_ID },
                            error: null,
                          }),
                      }),
                    }),
                  };
                }
                if (cols === 'id') {
                  // Primary-slot lookup (used by editOne's delegation
                  // path). Returns slot A's id since that's primary.
                  return {
                    eq: () => ({
                      eq: () => ({
                        order: () => ({
                          order: () => ({
                            limit: () => ({
                              maybeSingle: () =>
                                Promise.resolve({
                                  data: { id: PRIMARY },
                                  error: null,
                                }),
                            }),
                          }),
                        }),
                      }),
                    }),
                  };
                }
                // SLOT_WITH_BOOKING_SELECT projection.
                //
                // Two callers in editSlot:
                //   1. findByIdOrThrow(bookingId) — keys on tenant_id +
                //      booking_id, picks PRIMARY (slot A) via .order().
                //   2. findByIdOrThrowAtSlot(slotId) — keys on tenant_id +
                //      id (the slot id). Pre-fix used once after RPC; I1
                //      now also calls it BEFORE the RPC for pre-state.
                //
                // Both chains end in .order().order().limit().maybeSingle().
                // We disambiguate by the eq column passed.
                let lastEq: string | undefined;
                const chain: any = {
                  eq: (col: string) => {
                    lastEq = col;
                    return {
                      eq: (col2: string) => {
                        // Two paths converge here. Track the second eq
                        // to pick the right embed:
                        //   booking_id keying  → return primary (slot A)
                        //   id keying          → return target (slot B)
                        const slotKeyCol = col2 === 'id' ? 'id' : col;
                        const isPrimaryLookup = slotKeyCol === 'booking_id';
                        const isSlotIdLookup = slotKeyCol === 'id' || lastEq === 'id';
                        return {
                          order: () => ({
                            order: () => ({
                              limit: () => ({
                                maybeSingle: () => {
                                  projectionsServed += 1;
                                  if (isPrimaryLookup) {
                                    return Promise.resolve({
                                      data: buildSlotEmbed(slotA),
                                      error: null,
                                    });
                                  }
                                  if (isSlotIdLookup) {
                                    // First slot-id projection = pre-RPC
                                    // (I1 pre-state). Subsequent ones =
                                    // post-RPC. Track via projectionsServed.
                                    // Pre-state: slotBPre untouched.
                                    // Post-state: slotBPre + targetPatch.
                                    const isPostRpc = projectionsServed > 2;
                                    return Promise.resolve({
                                      data: isPostRpc
                                        ? buildSlotEmbed(slotBPre, opts.targetPatch)
                                        : buildSlotEmbed(slotBPre),
                                      error: null,
                                    });
                                  }
                                  return Promise.resolve({
                                    data: buildSlotEmbed(slotA),
                                    error: null,
                                  });
                                },
                              }),
                            }),
                          }),
                        };
                      },
                    };
                  },
                };
                return chain;
              },
              update: () => ({
                eq: () => ({
                  eq: () => Promise.resolve({ error: null }),
                  then: (r: (v: { error: unknown }) => unknown) =>
                    Promise.resolve({ error: null }).then(r),
                }),
              }),
            };
          }
          if (table === 'visitors') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () =>
                    Promise.resolve({
                      data: visitorIds.map((id) => ({ id })),
                      error: null,
                    }),
                }),
              }),
            };
          }
          if (table === 'audit_events') {
            return { insert: () => Promise.resolve({ data: null, error: null }) };
          }
          if (table === 'bookings') {
            return {
              update: () => ({
                eq: () => Promise.resolve({ error: null }),
                then: (r: (v: { error: unknown }) => unknown) =>
                  Promise.resolve({ error: null }).then(r),
              }),
            };
          }
          return {};
        }),
      },
    };

    const conflict = { isExclusionViolation: () => false };
    const visibility = {
      loadContextByUserId: jest.fn(async () => ({})),
      assertVisible: () => {},
      canEdit: () => true,
    };

    const eventBus = new BundleEventBus();
    const captured: BundleEvent[] = [];
    const sub = eventBus.events$.subscribe((e) => captured.push(e));

    const svc = new ReservationService(
      supabase as never,
      conflict as never,
      visibility as never,
      undefined,
      undefined,
      undefined,
      eventBus,
    );

    return { svc, captured, unsubscribe: () => sub.unsubscribe() };
  }

  it('non-primary slot edit reports TARGET slot pre-state (not primary slot pre-state) in cascade', async () => {
    const newStart = '2026-05-01T15:00:00.000Z';
    const { svc, captured, unsubscribe } = makeNonPrimaryService({
      targetPatch: { start_at: newStart },
    });
    try {
      await TenantContext.run(
        { id: TENANT, slug: 'test', tier: 'standard' },
        () => svc.editSlot(BOOKING_ID, SLOT_B, ACTOR, { start_at: newStart }),
      );

      const moved = captured.filter((e) => e.kind === 'bundle.line.moved');
      expect(moved.length).toBeGreaterThan(0);
      for (const evt of moved) {
        if (evt.kind === 'bundle.line.moved') {
          // The fix: old_expected_at MUST equal slot B's prior start
          // (11:00), NOT slot A's (09:00). Pre-fix this would have been
          // 09:00 because the cascade compared against the PRIMARY's
          // pre-state.
          expect(evt.old_expected_at).toBe(slotBPre.start_at);
          expect(evt.old_expected_at).not.toBe(slotA.start_at);
          expect(evt.new_expected_at).toBe(newStart);
        }
      }
    } finally {
      unsubscribe();
    }
  });

  it('non-primary slot space change reports TARGET slot prior room (not primary slot room)', async () => {
    const { svc, captured, unsubscribe } = makeNonPrimaryService({
      targetPatch: { space_id: ROOM_NEW },
    });
    try {
      await TenantContext.run(
        { id: TENANT, slug: 'test', tier: 'standard' },
        () => svc.editSlot(BOOKING_ID, SLOT_B, ACTOR, { space_id: ROOM_NEW }),
      );
      const roomChanges = captured.filter((e) => e.kind === 'bundle.line.room_changed');
      expect(roomChanges.length).toBeGreaterThan(0);
      for (const evt of roomChanges) {
        if (evt.kind === 'bundle.line.room_changed') {
          // old_room_id MUST be slot B's pre-RPC space (ROOM_B), not
          // slot A's (ROOM_A).
          expect(evt.old_room_id).toBe(ROOM_B);
          expect(evt.old_room_id).not.toBe(ROOM_A);
          expect(evt.new_room_id).toBe(ROOM_NEW);
        }
      }
    } finally {
      unsubscribe();
    }
  });
});

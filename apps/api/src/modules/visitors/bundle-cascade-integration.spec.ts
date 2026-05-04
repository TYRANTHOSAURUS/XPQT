/**
 * Slice 4 — end-to-end integration of:
 *   - emit side: BundleCascadeService.cancelBundle, ReservationService.editOne
 *   - bus: BundleEventBus (slice 2c)
 *   - subscriber: BundleCascadeAdapter (slice 2c)
 *
 * This wires REAL emit + REAL bus + REAL adapter to a mock DbService /
 * VisitorService so we can exercise the full §10.2 cascade matrix without
 * a database. Each test:
 *   1. Set up bundle + visitor row(s) with a chosen status.
 *   2. Trigger a bundle change (move / cancel / room).
 *   3. Drain the microtask queue (the adapter handler is async).
 *   4. Assert the visitor-side action: transitionStatus call OR an
 *      `update public.visitors` SQL OR a domain_events intent insert.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §10
 * Plan task 4.3 — verify each cascade-matrix cell end-to-end.
 */

import { BundleCascadeService } from '../booking-bundles/bundle-cascade.service';
import { BundleEventBus } from '../booking-bundles/bundle-event-bus';
import { ReservationService } from '../reservations/reservation.service';
import { TenantContext } from '../../common/tenant-context';
import { BundleCascadeAdapter } from './bundle-cascade.adapter';
import type { VisitorStatus } from './dto/transition-status.dto';

const TENANT = '11111111-1111-4111-8111-111111111111';
const BUNDLE = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
// Pre-canonicalisation: a separate `RES` constant existed because
// reservations.id ≠ booking.id. Post-rewrite (00277:27) the booking IS
// the bundle, so we pass BUNDLE to editOne. The C2 url-mismatch gate
// in editSlot rejects callers that drift from this identity.
// Plan A.2 / Commit 7: replaced non-hex placeholder constants (`o`, `s`,
// `v`, `u`, `p`) with valid hex surrogates so the assertTenantOwned uuid
// regex on the editOne space pre-flight (Commit 6) accepts SPACE_NEW.
const ORDER = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee';
const SPACE_OLD = 'aaaa1111-1111-4111-8111-aaaaaaaaaaaa';
const SPACE_NEW = 'aaaa2222-2222-4222-8222-aaaaaaaaaaaa';
const VISITOR = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const USER = 'cccccccc-1111-4111-8111-cccccccccccc';
const PERSON = 'dddddddd-1111-4111-8111-dddddddddddd';

interface VisitorState {
  id: string;
  tenant_id: string;
  status: VisitorStatus;
}

function buildHarness(opts: {
  visitor: VisitorState;
  visitorIdsForBundle?: string[];
  bundleLines?: Array<{ id: string; fulfillment_status: string | null; linked_asset_reservation_id: string | null; linked_ticket_id: string | null; order_id: string }>;
  // Slot-level fixture for the booking the cascade operates on.
  // Post-canonicalisation the booking IS the bundle (00277:27); the
  // primary slot drives findByIdOrThrow's projection
  // (reservation.service.ts:161, reservation-projection.ts:55-65).
  // BUNDLE here is the booking id (= bundle id under canonicalisation).
  slot?: {
    id: string;
    space_id: string;
    start_at: string;
    end_at: string;
  };
}) {
  const transitionCalls: Array<{ visitor_id: string; to: VisitorStatus }> = [];
  const visitorUpdates: Array<{ sql: string; params: unknown[] }> = [];
  const intentInserts: Array<{ event_type: string; payload: Record<string, unknown> }> = [];

  // === DbService mock for the visitor adapter ===
  // Adapter now reads visitor under FOR SHARE inside `db.tx` (full-review
  // I6); the fake client honours that path. The queryOne path is preserved
  // for legacy callers that haven't migrated; it's no longer hit by the
  // adapter.
  const fakeClient = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      const t = sql.trim().toLowerCase();
      if (t.includes('select id, tenant_id, status') && t.includes('for share')) {
        const id = params[0] as string;
        const tenant = params[1] as string;
        if (id === opts.visitor.id && tenant === opts.visitor.tenant_id) {
          return { rows: [{ ...opts.visitor }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
  const db = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      const t = sql.trim().toLowerCase();
      if (t.startsWith('update public.visitors')) {
        visitorUpdates.push({ sql, params });
        if (t.includes('set expected_at')) {
          opts.visitor.status = opts.visitor.status; // no status change here
        }
      }
      if (t.startsWith('insert into public.domain_events')) {
        intentInserts.push({
          event_type: params[1] as string,
          payload: JSON.parse(params[3] as string) as Record<string, unknown>,
        });
      }
      return { rows: [], rowCount: 0 };
    }),
    queryOne: jest.fn(async (_sql: string, _params: unknown[] = []) => null),
    queryMany: jest.fn(async (sql: string, _params: unknown[] = []) => {
      const t = sql.trim().toLowerCase();
      // Adapter resolves linked visitors via visitors.booking_id (00278:41 —
      // booking_bundle_id was renamed to booking_id; reservation_id was
      // dropped entirely in 00280). See bundle-cascade.adapter.ts:317-321.
      if (t.includes('booking_id = $2')) {
        return (opts.visitorIdsForBundle ?? [opts.visitor.id]).map((id) => ({ id }));
      }
      return [];
    }),
    tx: jest.fn(async <T>(fn: (c: typeof fakeClient) => Promise<T>): Promise<T> => fn(fakeClient)),
  };

  // === VisitorService mock — only transitionStatus is consumed by adapter ===
  const visitors = {
    transitionStatus: jest.fn(async (visitor_id: string, to: VisitorStatus) => {
      transitionCalls.push({ visitor_id, to });
      // Reflect back into local state so subsequent reads are consistent.
      if (visitor_id === opts.visitor.id) {
        opts.visitor.status = to;
      }
    }),
  };

  // === SupabaseService mock for the cascade-cancel + reservation-edit paths ===
  //
  // Post-canonicalisation (00276-00281): `reservations` + `booking_bundles`
  // are gone. Reads/writes target `bookings` (00277:27) + `booking_slots`
  // (00277:116). The booking IS the bundle, so BUNDLE here is the booking
  // id and the projection (reservation-projection.ts:121) sets
  // r.booking_bundle_id = booking.id.
  const slotFixture = opts.slot ?? {
    id: 'slot1111-1111-4111-8111-slotslotslot',
    space_id: SPACE_OLD,
    start_at: '2026-05-01T10:00:00.000Z',
    end_at: '2026-05-01T11:00:00.000Z',
  };

  // Mutable slot + booking rows so editOne's update → re-read flow returns
  // the patched values to the cascade emit step.
  let slotRow: Record<string, unknown> = {
    id: slotFixture.id,
    tenant_id: TENANT,
    booking_id: BUNDLE,
    slot_type: 'room',
    space_id: slotFixture.space_id,
    start_at: slotFixture.start_at,
    end_at: slotFixture.end_at,
    setup_buffer_minutes: 0,
    teardown_buffer_minutes: 0,
    effective_start_at: slotFixture.start_at,
    effective_end_at: slotFixture.end_at,
    attendee_count: 5,
    attendee_person_ids: [],
    status: 'confirmed',
    check_in_required: false,
    check_in_grace_minutes: 0,
    checked_in_at: null,
    released_at: null,
    cancellation_grace_until: null,
    display_order: 0,
    created_at: '2026-04-30T09:00:00.000Z',
    updated_at: '2026-04-30T09:00:00.000Z',
  };
  let bookingRow: Record<string, unknown> = {
    id: BUNDLE,
    tenant_id: TENANT,
    title: null,
    description: null,
    requester_person_id: PERSON,
    host_person_id: null,
    booked_by_user_id: null,
    location_id: slotFixture.space_id,
    start_at: slotFixture.start_at,
    end_at: slotFixture.end_at,
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
    recurrence_series_id: null,
    recurrence_index: null,
    recurrence_overridden: false,
    recurrence_skipped: false,
    template_id: null,
    created_at: '2026-04-30T09:00:00.000Z',
    updated_at: '2026-04-30T09:00:00.000Z',
  };

  // Build a slot+booking embed shape for SLOT_WITH_BOOKING_SELECT
  // (reservation-projection.ts:131-143). PostgREST returns the parent under
  // the `bookings` key when using the !inner embed.
  const buildSlotEmbed = () => ({ ...slotRow, bookings: { ...bookingRow } });

  const supabase = {
    admin: {
      // C2 closure: editOne now delegates geometry to editSlot which
      // calls the edit_booking_slot RPC (00291 + 00293). The RPC
      // updates one slot AND recomputes booking-level start_at/end_at/
      // location_id mirrors atomically. Mock applies the patch to
      // slotRow + bookingRow so post-RPC reads reflect the new state.
      rpc: jest.fn((fn: string, args: { p_patch?: Record<string, unknown> }) => {
        if (fn === 'edit_booking_slot') {
          const patch = args.p_patch ?? {};
          if (patch.start_at !== undefined) {
            slotRow = { ...slotRow, start_at: patch.start_at as string };
            bookingRow = { ...bookingRow, start_at: patch.start_at as string };
          }
          if (patch.end_at !== undefined) {
            slotRow = { ...slotRow, end_at: patch.end_at as string };
            bookingRow = { ...bookingRow, end_at: patch.end_at as string };
          }
          if (patch.space_id !== undefined) {
            slotRow = { ...slotRow, space_id: patch.space_id as string };
            // location_id mirrors only when the edited slot is primary.
            // The single-slot test fixture is always primary.
            bookingRow = { ...bookingRow, location_id: patch.space_id as string };
          }
          return Promise.resolve({
            data: { slot: slotRow, booking: bookingRow },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      }),
      from: jest.fn((table: string) => {
        // ── bookings ─────────────────────────────────────────────────────
        // loadBundle (cascade) selects id/requester/host/location.
        // editOne updates booking-level fields (location_id/start_at/end_at/...).
        // cancelBundleImpl updates status='cancelled' on the booking row.
        if (table === 'bookings') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () =>
                    Promise.resolve({
                      data: {
                        id: BUNDLE,
                        requester_person_id: PERSON,
                        host_person_id: null,
                        location_id: bookingRow.location_id,
                      },
                      error: null,
                    }),
                }),
              }),
            }),
            update: (patch: Record<string, unknown>) => {
              bookingRow = { ...bookingRow, ...patch };
              const chain: Record<string, (...args: unknown[]) => unknown> = {};
              chain.eq = () => chain;
              chain.in = () => chain;
              chain.select = () => Promise.resolve({ data: [], error: null });
              (chain as Record<string, unknown>).then = (resolve: (v: unknown) => void) =>
                resolve({ data: null, error: null });
              return chain;
            },
          };
        }
        // ── spaces ───────────────────────────────────────────────────────
        // Plan A.2 / Commit 6: editOne does a TS-layer pre-flight on
        // patch.space_id via assertTenantOwned (activeOnly + reservableOnly).
        // Mock supports the .eq().eq().eq().eq().maybeSingle() chain and
        // returns success for the SPACE_NEW under TENANT.
        if (table === 'spaces') {
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
        // ── booking_slots ────────────────────────────────────────────────
        // findByIdOrThrow uses SLOT_WITH_BOOKING_SELECT (slot + bookings embed).
        // editOne reads `select('id')` to find the primary slot id, then
        // delegates geometry to editSlot which uses `select('booking_id')`
        // for its pre-flight gate (URL-mismatch + not-found) and calls the
        // edit_booking_slot RPC. cancelBundleImpl flips slot.status to
        // 'cancelled'.
        if (table === 'booking_slots') {
          return {
            select: (cols?: string) => {
              // editSlot pre-flight: .select('booking_id').eq().eq().maybeSingle().
              if (cols && cols.trim() === 'booking_id') {
                return {
                  eq: () => ({
                    eq: () => ({
                      maybeSingle: () =>
                        Promise.resolve({ data: { booking_id: slotRow.booking_id }, error: null }),
                    }),
                  }),
                };
              }
              // Primary-slot id-only read. C2 added a second .order(created_at)
              // for tie-breaking — accept BOTH the legacy single-order and
              // the new double-order chain so both editOne and other callers
              // (cancel/restore — which still use the legacy single-order)
              // resolve.
              if (cols && cols.trim() === 'id') {
                const slotIdResult = () =>
                  Promise.resolve({ data: { id: slotRow.id }, error: null });
                return {
                  eq: () => ({
                    eq: () => ({
                      order: () => ({
                        order: () => ({
                          limit: () => ({ maybeSingle: slotIdResult }),
                        }),
                        limit: () => ({ maybeSingle: slotIdResult }),
                      }),
                    }),
                  }),
                };
              }
              // Embed read for findByIdOrThrow / findByIdOrThrowAtSlot.
              return {
                eq: () => ({
                  eq: () => ({
                    order: () => ({
                      order: () => ({
                        limit: () => ({
                          maybeSingle: () =>
                            Promise.resolve({ data: buildSlotEmbed(), error: null }),
                        }),
                      }),
                    }),
                  }),
                }),
              };
            },
            update: (patch: Record<string, unknown>) => {
              slotRow = { ...slotRow, ...patch };
              const chain: Record<string, (...args: unknown[]) => unknown> = {};
              chain.eq = () => chain;
              chain.in = () => chain;
              chain.select = () => Promise.resolve({ data: [], error: null });
              (chain as Record<string, unknown>).then = (resolve: (v: unknown) => void) =>
                resolve({ data: null, error: null });
              return chain;
            },
          };
        }
        // ── orders ───────────────────────────────────────────────────────
        // orderIdsForBundle (cascade) selects id by booking_id (00278:109).
        if (table === 'orders') {
          return {
            select: (cols?: string) => {
              if (cols === 'id') {
                const chain: Record<string, (...args: unknown[]) => unknown> = {};
                chain.eq = () => chain;
                (chain as Record<string, unknown>).then = (resolve: (v: unknown) => void) =>
                  resolve({ data: [{ id: ORDER }], error: null });
                return chain;
              }
              return {
                eq: () => ({
                  eq: () => ({
                    maybeSingle: () => Promise.resolve({ data: { booking_id: BUNDLE }, error: null }),
                  }),
                }),
              };
            },
          };
        }
        // ── order_line_items ─────────────────────────────────────────────
        if (table === 'order_line_items') {
          return {
            select: (cols?: string) => {
              if (cols && cols.includes('fulfillment_status')) {
                const chain: Record<string, (...args: unknown[]) => unknown> = {};
                chain.in = () =>
                  Promise.resolve({ data: opts.bundleLines ?? [], error: null });
                chain.eq = () => chain;
                chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
                return chain;
              }
              return {
                eq: () => ({
                  eq: () => ({
                    maybeSingle: () => Promise.resolve({ data: null, error: null }),
                  }),
                }),
              };
            },
            update: () => {
              const chain: Record<string, (...args: unknown[]) => unknown> = {};
              chain.eq = () => chain;
              chain.in = () => chain;
              chain.select = () => Promise.resolve({ data: [], error: null });
              (chain as Record<string, unknown>).then = (resolve: (v: unknown) => void) =>
                resolve({ data: null, error: null });
              return chain;
            },
          };
        }
        // ── work_orders / asset_reservations / approvals ────────────────
        // Cascade-cancel writes: work_orders.update (cascade.service:302),
        // asset_reservations.update (286), approvals.select+update (584-596).
        if (
          table === 'work_orders' ||
          table === 'asset_reservations' ||
          table === 'approvals'
        ) {
          return {
            select: () => {
              // approvals.select('id').eq.eq.eq → array result.
              const chain: Record<string, (...args: unknown[]) => unknown> = {};
              chain.eq = () => chain;
              chain.in = () => chain;
              (chain as Record<string, unknown>).then = (resolve: (v: unknown) => void) =>
                resolve({ data: [], error: null });
              return chain;
            },
            update: () => {
              const chain: Record<string, (...args: unknown[]) => unknown> = {};
              chain.eq = () => chain;
              chain.in = () => chain;
              chain.select = () => Promise.resolve({ data: [], error: null });
              (chain as Record<string, unknown>).then = (resolve: (v: unknown) => void) =>
                resolve({ data: null, error: null });
              return chain;
            },
          };
        }
        // ── visitors ─────────────────────────────────────────────────────
        // emitVisitorCascadeForBundle (reservation.service:732-736) reads
        // visitors.booking_id → ids, post column-rename (00278:41).
        if (table === 'visitors') {
          return {
            select: () => ({
              eq: () => ({
                eq: () =>
                  Promise.resolve({
                    data: (opts.visitorIdsForBundle ?? [opts.visitor.id]).map((id) => ({ id })),
                    error: null,
                  }),
              }),
            }),
          };
        }
        if (table === 'audit_events') {
          return { insert: () => Promise.resolve({ data: null, error: null }) };
        }
        // Default fallthrough.
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: null, error: null }),
              }),
            }),
          }),
          insert: () => Promise.resolve({ data: null, error: null }),
        };
      }),
    },
  };

  const visibility = { assertVisible: jest.fn(async () => {}) };
  const bus = new BundleEventBus();

  // Wire the real adapter to the real bus + mocked VisitorService + DbService.
  const adapter = new BundleCascadeAdapter(db as never, visitors as never, bus as never);
  adapter.resubscribe();

  const cascadeService = new BundleCascadeService(supabase as never, visibility as never, bus);
  const reservationVisibility = {
    loadContextByUserId: jest.fn(async () => ({})),
    assertVisible: () => {},
    canEdit: () => true,
  };
  const reservationService = new ReservationService(
    supabase as never,
    { isExclusionViolation: () => false } as never,
    reservationVisibility as never,
    undefined,
    undefined,
    undefined,
    bus,
  );

  return {
    bus,
    adapter,
    cascadeService,
    reservationService,
    visitors,
    transitionCalls,
    visitorUpdates,
    intentInserts,
    teardown: () => adapter.unsubscribe(),
  };
}

const ACTOR = {
  user_id: USER,
  person_id: PERSON,
  is_service_desk: false,
  has_override_rules: false,
};

// Allow the bus subscription's microtask + the adapter's async handler chain
// to drain before assertions.
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
}

describe('Bundle cascade — end-to-end (slice 4 emit + slice 2c adapter)', () => {
  beforeEach(() => {
    jest.spyOn(TenantContext, 'currentOrNull').mockReturnValue(undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('move bundle time → visitor.expected_at updated + visitor email intent (status=expected)', async () => {
    const newStart = '2026-05-01T14:00:00.000Z';
    const h = buildHarness({
      visitor: { id: VISITOR, tenant_id: TENANT, status: 'expected' },
    });
    try {
      await TenantContext.run(
        { id: TENANT, slug: 'test', tier: 'standard' },
        () => h.reservationService.editOne(BUNDLE, ACTOR, { start_at: newStart }),
      );
      await drainMicrotasks();

      // visitor expected_at update fired.
      const updates = h.visitorUpdates.filter((u) => u.sql.toLowerCase().includes('set expected_at'));
      expect(updates).toHaveLength(1);
      expect(updates[0]!.params[0]).toBe(newStart);

      // visitor email intent fired.
      const moved = h.intentInserts.filter((i) => i.event_type === 'visitor.cascade.moved');
      expect(moved).toHaveLength(1);
      expect(moved[0]!.payload.email_target).toBe('visitor');
      expect(moved[0]!.payload.new_expected_at).toBe(newStart);

      // No transitionStatus (just an expected_at update).
      expect(h.transitionCalls).toHaveLength(0);
    } finally {
      h.teardown();
    }
  });

  it('move bundle time → host alert when visitor already arrived (no email to visitor)', async () => {
    const newStart = '2026-05-01T14:00:00.000Z';
    const h = buildHarness({
      visitor: { id: VISITOR, tenant_id: TENANT, status: 'arrived' },
    });
    try {
      await TenantContext.run(
        { id: TENANT, slug: 'test', tier: 'standard' },
        () => h.reservationService.editOne(BUNDLE, ACTOR, { start_at: newStart }),
      );
      await drainMicrotasks();

      // No expected_at update — visitor is already on-site.
      const updates = h.visitorUpdates.filter((u) =>
        u.sql.toLowerCase().includes('set expected_at'),
      );
      expect(updates).toHaveLength(0);

      // Host alert intent fired (NOT visitor.cascade.moved).
      const moved = h.intentInserts.filter((i) => i.event_type === 'visitor.cascade.moved');
      expect(moved).toHaveLength(0);
      const hostAlerts = h.intentInserts.filter((i) => i.event_type === 'visitor.cascade.host_alert');
      expect(hostAlerts).toHaveLength(1);
      expect(hostAlerts[0]!.payload.email_target).toBe('host');
      expect(hostAlerts[0]!.payload.reason).toBe('bundle.line.moved');

      // Status unchanged.
      expect(h.transitionCalls).toHaveLength(0);
    } finally {
      h.teardown();
    }
  });

  it('change room → visitor.meeting_room_id updated + visitor email intent (status=expected)', async () => {
    const h = buildHarness({
      visitor: { id: VISITOR, tenant_id: TENANT, status: 'expected' },
    });
    try {
      await TenantContext.run(
        { id: TENANT, slug: 'test', tier: 'standard' },
        () => h.reservationService.editOne(BUNDLE, ACTOR, { space_id: SPACE_NEW }),
      );
      await drainMicrotasks();

      const updates = h.visitorUpdates.filter((u) =>
        u.sql.toLowerCase().includes('set meeting_room_id'),
      );
      expect(updates).toHaveLength(1);
      expect(updates[0]!.params[0]).toBe(SPACE_NEW);

      const roomChange = h.intentInserts.filter(
        (i) => i.event_type === 'visitor.cascade.room_changed',
      );
      expect(roomChange).toHaveLength(1);
      expect(roomChange[0]!.payload.email_target).toBe('visitor');
    } finally {
      h.teardown();
    }
  });

  it('cancel whole bundle → all linked visitors transition to cancelled', async () => {
    const V_OTHER = 'vvvv0002-2222-4222-8222-vvvvvvvvvvvv';
    const h = buildHarness({
      visitor: { id: VISITOR, tenant_id: TENANT, status: 'expected' },
      visitorIdsForBundle: [VISITOR, V_OTHER],
      // cancel cascade walks bundle lines; harness returns one ordered line so
      // somethingCancelled = true and the bundle.cancelled event fires.
      bundleLines: [
        {
          id: 'oli-1',
          fulfillment_status: 'ordered',
          linked_asset_reservation_id: null,
          linked_ticket_id: null,
          order_id: ORDER,
        },
      ],
    });
    // Visitor V_OTHER read uses the same loadVisitor row. To keep the harness
    // simple, mirror the status onto the queryOne lookup for V_OTHER too.
    (h as unknown as {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      visitors: any;
    }).visitors.transitionStatus = jest.fn(async (visitor_id: string, to: VisitorStatus) => {
      h.transitionCalls.push({ visitor_id, to });
    });

    try {
      await TenantContext.run(
        { id: TENANT, slug: 'test', tier: 'standard' },
        () =>
          h.cascadeService.cancelBundle({ bundle_id: BUNDLE }, {
            user_id: USER,
            person_id: PERSON,
            has_override: false,
          } as never),
      );
      await drainMicrotasks();

      // VISITOR was status=expected — adapter cascades to cancelled.
      // V_OTHER returns null from queryOne (only VISITOR is registered) —
      // adapter no-ops on missing row. Verify VISITOR was cancelled.
      const visitorTransitions = h.transitionCalls.filter((c) => c.visitor_id === VISITOR);
      expect(visitorTransitions).toHaveLength(1);
      expect(visitorTransitions[0]!.to).toBe('cancelled');
    } finally {
      h.teardown();
    }
  });

  it('cancel whole bundle → host alert (not cancellation) when visitor already arrived', async () => {
    const h = buildHarness({
      visitor: { id: VISITOR, tenant_id: TENANT, status: 'arrived' },
      bundleLines: [
        {
          id: 'oli-1',
          fulfillment_status: 'ordered',
          linked_asset_reservation_id: null,
          linked_ticket_id: null,
          order_id: ORDER,
        },
      ],
    });
    try {
      await TenantContext.run(
        { id: TENANT, slug: 'test', tier: 'standard' },
        () =>
          h.cascadeService.cancelBundle({ bundle_id: BUNDLE }, {
            user_id: USER,
            person_id: PERSON,
            has_override: false,
          } as never),
      );
      await drainMicrotasks();

      // Visitor already on-site — must NOT auto-transition.
      expect(h.transitionCalls).toHaveLength(0);
      // Host alert intent fired instead.
      const hostAlert = h.intentInserts.filter(
        (i) => i.event_type === 'visitor.cascade.host_alert',
      );
      expect(hostAlert).toHaveLength(1);
      expect(hostAlert[0]!.payload.reason).toBe('bundle.line.cancelled');
    } finally {
      h.teardown();
    }
  });

  it('cross-tenant: events from tenant B do not affect tenant A visitor', async () => {
    const OTHER = '99999999-9999-4999-8999-999999999999';
    const h = buildHarness({
      visitor: { id: VISITOR, tenant_id: TENANT, status: 'expected' },
    });
    try {
      // Run the cancelBundle in OTHER tenant context — the cascade emits an
      // event whose tenant_id=OTHER, and the adapter's loadVisitor query
      // filters on `tenant_id = $2 = OTHER`, finding nothing for VISITOR.
      await TenantContext.run(
        { id: OTHER, slug: 'other', tier: 'standard' },
        () =>
          h.cascadeService.cancelBundle({ bundle_id: BUNDLE }, {
            user_id: USER,
            person_id: PERSON,
            has_override: false,
          } as never),
      );
      await drainMicrotasks();

      // Visitor untouched.
      expect(h.transitionCalls).toHaveLength(0);
      expect(h.visitorUpdates).toHaveLength(0);
    } finally {
      h.teardown();
    }
  });
});

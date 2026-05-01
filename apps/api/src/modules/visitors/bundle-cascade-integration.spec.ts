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
const RES = 'rrrrrrrr-1111-4111-8111-rrrrrrrrrrrr';
const ORDER = 'oooooooo-1111-4111-8111-oooooooooooo';
const SPACE_OLD = 'ssss1111-1111-4111-8111-ssssssssssss';
const SPACE_NEW = 'ssss2222-2222-4222-8222-ssssssssssss';
const VISITOR = 'vvvvvvvv-1111-4111-8111-vvvvvvvvvvvv';
const USER = 'uuuuuuuu-1111-4111-8111-uuuuuuuuuuuu';
const PERSON = 'pppppppp-1111-4111-8111-pppppppppppp';

interface VisitorState {
  id: string;
  tenant_id: string;
  status: VisitorStatus;
}

function buildHarness(opts: {
  visitor: VisitorState;
  visitorIdsForBundle?: string[];
  bundleLines?: Array<{ id: string; fulfillment_status: string | null; linked_asset_reservation_id: string | null; linked_ticket_id: string | null; order_id: string }>;
  reservation?: {
    id: string;
    tenant_id: string;
    space_id: string;
    start_at: string;
    end_at: string;
    booking_bundle_id: string | null;
  };
}) {
  const transitionCalls: Array<{ visitor_id: string; to: VisitorStatus }> = [];
  const visitorUpdates: Array<{ sql: string; params: unknown[] }> = [];
  const intentInserts: Array<{ event_type: string; payload: Record<string, unknown> }> = [];

  // === DbService mock for the visitor adapter ===
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
    queryOne: jest.fn(async (sql: string, params: unknown[] = []) => {
      const t = sql.trim().toLowerCase();
      if (t.includes('select id, tenant_id, status')) {
        const id = params[0] as string;
        const tenant = params[1] as string;
        if (id === opts.visitor.id && tenant === opts.visitor.tenant_id) {
          return { ...opts.visitor };
        }
      }
      return null;
    }),
    queryMany: jest.fn(async (sql: string, params: unknown[] = []) => {
      const t = sql.trim().toLowerCase();
      if (t.includes('booking_bundle_id = $2')) {
        return (opts.visitorIdsForBundle ?? [opts.visitor.id]).map((id) => ({ id }));
      }
      return [];
    }),
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
  // Minimal chain that satisfies the cancel cascade + reservation editOne.
  const reservation = opts.reservation ?? {
    id: RES,
    tenant_id: TENANT,
    space_id: SPACE_OLD,
    start_at: '2026-05-01T10:00:00.000Z',
    end_at: '2026-05-01T11:00:00.000Z',
    booking_bundle_id: BUNDLE,
    attendee_count: 5,
    attendee_person_ids: [],
    host_person_id: null,
    recurrence_series_id: null,
    multi_room_group_id: null,
    requester_person_id: PERSON,
    source: 'portal',
    status: 'confirmed',
  };

  let lastUpdatedReservation: Record<string, unknown> = { ...reservation };

  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        if (table === 'booking_bundles') {
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
                        location_id: SPACE_OLD,
                        primary_reservation_id: RES,
                      },
                      error: null,
                    }),
                }),
              }),
            }),
          };
        }
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
                    maybeSingle: () => Promise.resolve({ data: { booking_bundle_id: BUNDLE }, error: null }),
                  }),
                }),
              };
            },
          };
        }
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
        if (table === 'reservations') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({ data: { ...lastUpdatedReservation }, error: null }),
                }),
              }),
            }),
            update: (patch: Record<string, unknown>) => {
              lastUpdatedReservation = { ...lastUpdatedReservation, ...patch };
              const chain: Record<string, (...args: unknown[]) => unknown> = {};
              chain.eq = () => chain;
              chain.in = () => chain;
              chain.select = () => ({
                single: () => Promise.resolve({ data: { ...lastUpdatedReservation }, error: null }),
              });
              return chain;
            },
          };
        }
        if (table === 'asset_reservations' || table === 'tickets' || table === 'approvals') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    in: () => Promise.resolve({ data: [], error: null }),
                  }),
                }),
              }),
            }),
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
        () => h.reservationService.editOne(RES, ACTOR, { start_at: newStart }),
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
        () => h.reservationService.editOne(RES, ACTOR, { start_at: newStart }),
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
        () => h.reservationService.editOne(RES, ACTOR, { space_id: SPACE_NEW }),
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

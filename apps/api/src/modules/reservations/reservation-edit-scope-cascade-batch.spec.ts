/**
 * Tier B followup #6 — `ReservationService.emitVisitorCascadesForBundles`
 * spec (b4-followups.md).
 *
 * Batched sibling of `emitVisitorCascadeForBundle`. Replaces the N
 * sequential `.eq('booking_id', _)` reads the editScope cascade loop
 * fired previously with one `.in('booking_id', [...])`. Wire-shape
 * identical to the singular: per-visitor `bundle.line.moved` /
 * `bundle.line.room_changed` events with the same payload contract
 * (reservation.service.ts emitVisitorCascadeEvents helper, shared
 * between the two methods).
 *
 * Scenarios covered (mirrors Tier B #6 brief):
 *   1. Empty input → no .in() query, no emits.
 *   2. Single item → one .in() query with 1 id, emits per visitor found.
 *   3. Multiple items, all moved → one .in() query with N ids; emits
 *      grouped per booking_id.
 *   4. Multiple items, partial moved → caller pre-filters in editScope;
 *      verified there. Within the plural, items passed are assumed moved
 *      (covered by scenarios 2-3 above).
 *   5. Visitor row returns for a bundle whose item-axis is unchanged
 *      (defensive — shouldn't happen post-filter, but the null-axis
 *      contract in the emit helper still suppresses emits).
 *   6. .in() returns error → logs warning, returns, no emits.
 *
 * Plus:
 *   - Cross-tenant items → throws (per the single-tenant invariant).
 *   - bundleEventBus undefined → no-op.
 *   - .in() throws (network-class) → caught, logged, no emits.
 *   - Per-bundle emit isolation: one bundle's subscriber throwing does
 *     not block emits for the rest.
 */

import { ReservationService } from './reservation.service';
import { BundleEventBus, type BundleEvent } from '../booking-bundles/bundle-event-bus';

const TENANT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const BUNDLE_1 = 'cccccccc-1111-4111-8111-cccccccccccc';
const BUNDLE_2 = 'dddddddd-1111-4111-8111-dddddddddddd';
const BUNDLE_3 = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee';
const VISITOR_1A = 'ffffffff-aaaa-4111-8111-111111111111';
const VISITOR_1B = 'ffffffff-aaaa-4111-8111-222222222222';
const VISITOR_2A = 'ffffffff-bbbb-4111-8111-111111111111';
const SPACE_OLD = 'ffffffff-cccc-4111-8111-111111111111';
const SPACE_NEW = 'ffffffff-cccc-4111-8111-222222222222';
const T_OLD = '2026-06-01T09:00:00Z';
const T_NEW = '2026-06-01T10:00:00Z';

/**
 * Minimal supabase mock — the plural method only reads `visitors` via
 * `.in('booking_id', [...])`. Captures the .in() arg + records call count
 * so we can assert "one round-trip total".
 */
function makeSupabase(opts: {
  /** Visitor rows returned by .in(). */
  visitorRows: Array<{ id: string; booking_id: string }>;
  /** Optional simulated supabase-js {error} response. */
  selectError?: { message: string };
  /** Optional thrown error from the .in() call (network-class). */
  thrown?: Error;
}) {
  const calls = {
    selectIn: [] as Array<{ tenantId: string; bookingIds: string[] }>,
  };
  let lastTenantId: string | null = null;
  const admin = {
    from: (table: string) => {
      if (table !== 'visitors') {
        throw new Error(
          `unexpected supabase.from('${table}') call — batch cascade spec only stubs visitors`,
        );
      }
      const builder = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          if (col === 'tenant_id') lastTenantId = val as string;
          return builder;
        },
        in: (col: string, vals: unknown[]) => {
          calls.selectIn.push({
            tenantId: lastTenantId ?? '<unset>',
            bookingIds: vals as string[],
          });
          if (opts.thrown) return Promise.reject(opts.thrown);
          return Promise.resolve({
            data: opts.visitorRows,
            error: opts.selectError ?? null,
          });
        },
      };
      return builder as unknown;
    },
  };
  return { admin, calls } as never as {
    admin: typeof admin;
    calls: typeof calls;
  };
}

/**
 * Construct a `ReservationService` with only the deps the plural method
 * touches: supabase.admin + bundleEventBus + the internal logger. Other
 * positional ctor params can be `undefined` because the plural method
 * doesn't reach them.
 */
function buildService(opts: {
  supabase: ReturnType<typeof makeSupabase>;
  bundleEventBus?: BundleEventBus;
}) {
  return new ReservationService(
    opts.supabase as never,
    undefined as never, // conflict
    undefined as never, // visibility
    undefined as never, // recurrence
    undefined, // notifications
    undefined, // bundleCascade
    opts.bundleEventBus,
    undefined as never, // assembleEditPlan
  );
}

function captureEvents(bus: BundleEventBus) {
  const events: BundleEvent[] = [];
  const sub = bus.events$.subscribe((e) => events.push(e));
  return { events, unsubscribe: () => sub.unsubscribe() };
}

describe('ReservationService.emitVisitorCascadesForBundles (Tier B followup #6)', () => {
  it('no-op when items[] is empty (no .in() query, no emits)', async () => {
    const supabase = makeSupabase({ visitorRows: [] });
    const bus = new BundleEventBus();
    const { events } = captureEvents(bus);
    const svc = buildService({ supabase, bundleEventBus: bus });

    await svc.emitVisitorCascadesForBundles([]);

    expect(supabase.calls.selectIn).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it('no-op when bundleEventBus is undefined (even with items)', async () => {
    const supabase = makeSupabase({ visitorRows: [] });
    const svc = buildService({ supabase, bundleEventBus: undefined });

    await svc.emitVisitorCascadesForBundles([
      {
        tenantId: TENANT_A,
        bundleId: BUNDLE_1,
        oldStartAt: T_OLD,
        newStartAt: T_NEW,
        oldSpaceId: null,
        newSpaceId: null,
      },
    ]);

    // No bus = no point in even reading visitors — the singular short-circuits
    // BEFORE the supabase query, the plural mirrors the same posture.
    expect(supabase.calls.selectIn).toHaveLength(0);
  });

  it('single item: fires ONE .in() with 1 booking_id; emits per visitor', async () => {
    const supabase = makeSupabase({
      visitorRows: [
        { id: VISITOR_1A, booking_id: BUNDLE_1 },
        { id: VISITOR_1B, booking_id: BUNDLE_1 },
      ],
    });
    const bus = new BundleEventBus();
    const { events } = captureEvents(bus);
    const svc = buildService({ supabase, bundleEventBus: bus });

    await svc.emitVisitorCascadesForBundles([
      {
        tenantId: TENANT_A,
        bundleId: BUNDLE_1,
        oldStartAt: T_OLD,
        newStartAt: T_NEW,
        oldSpaceId: SPACE_OLD,
        newSpaceId: SPACE_NEW,
      },
    ]);

    // ONE round-trip.
    expect(supabase.calls.selectIn).toHaveLength(1);
    expect(supabase.calls.selectIn[0].tenantId).toBe(TENANT_A);
    expect(supabase.calls.selectIn[0].bookingIds).toEqual([BUNDLE_1]);

    // Two visitors × two axes (time + room) = 4 events. Same payload shape
    // as the singular method (verified by reservation.service.events.spec.ts
    // for the singular path).
    expect(events).toHaveLength(4);
    const moved = events.filter((e) => e.kind === 'bundle.line.moved');
    const roomed = events.filter((e) => e.kind === 'bundle.line.room_changed');
    expect(moved).toHaveLength(2);
    expect(roomed).toHaveLength(2);
    expect(moved[0]).toMatchObject({
      kind: 'bundle.line.moved',
      tenant_id: TENANT_A,
      bundle_id: BUNDLE_1,
      line_kind: 'visitor',
      old_expected_at: T_OLD,
      new_expected_at: T_NEW,
    });
    expect(roomed[0]).toMatchObject({
      kind: 'bundle.line.room_changed',
      tenant_id: TENANT_A,
      bundle_id: BUNDLE_1,
      line_kind: 'visitor',
      old_room_id: SPACE_OLD,
      new_room_id: SPACE_NEW,
    });
    // line_ids cover both visitors (order not guaranteed, hence Set).
    expect(new Set(moved.map((e) => (e as { line_id: string }).line_id))).toEqual(
      new Set([VISITOR_1A, VISITOR_1B]),
    );
  });

  it('multiple items: ONE .in() with all booking_ids; events grouped by booking_id', async () => {
    const supabase = makeSupabase({
      visitorRows: [
        { id: VISITOR_1A, booking_id: BUNDLE_1 },
        { id: VISITOR_1B, booking_id: BUNDLE_1 },
        { id: VISITOR_2A, booking_id: BUNDLE_2 },
        // BUNDLE_3 has no visitors.
      ],
    });
    const bus = new BundleEventBus();
    const { events } = captureEvents(bus);
    const svc = buildService({ supabase, bundleEventBus: bus });

    await svc.emitVisitorCascadesForBundles([
      // BUNDLE_1: time + room change.
      {
        tenantId: TENANT_A,
        bundleId: BUNDLE_1,
        oldStartAt: T_OLD,
        newStartAt: T_NEW,
        oldSpaceId: SPACE_OLD,
        newSpaceId: SPACE_NEW,
      },
      // BUNDLE_2: room only.
      {
        tenantId: TENANT_A,
        bundleId: BUNDLE_2,
        oldStartAt: null,
        newStartAt: null,
        oldSpaceId: SPACE_OLD,
        newSpaceId: SPACE_NEW,
      },
      // BUNDLE_3: time only (but visitors[] empty → 0 emits).
      {
        tenantId: TENANT_A,
        bundleId: BUNDLE_3,
        oldStartAt: T_OLD,
        newStartAt: T_NEW,
        oldSpaceId: null,
        newSpaceId: null,
      },
    ]);

    // ONE round-trip with all three booking_ids.
    expect(supabase.calls.selectIn).toHaveLength(1);
    expect(supabase.calls.selectIn[0].bookingIds).toEqual([
      BUNDLE_1,
      BUNDLE_2,
      BUNDLE_3,
    ]);

    // BUNDLE_1: 2 visitors × (moved + room_changed) = 4 events.
    // BUNDLE_2: 1 visitor × room_changed = 1 event.
    // BUNDLE_3: 0 visitors = 0 events.
    expect(events).toHaveLength(5);
    expect(events.filter((e) => e.bundle_id === BUNDLE_1)).toHaveLength(4);
    expect(events.filter((e) => e.bundle_id === BUNDLE_2)).toHaveLength(1);
    expect(events.filter((e) => e.bundle_id === BUNDLE_3)).toHaveLength(0);

    // BUNDLE_2: room-only, so no moved events.
    const bundle2Events = events.filter((e) => e.bundle_id === BUNDLE_2);
    expect(bundle2Events.every((e) => e.kind === 'bundle.line.room_changed')).toBe(
      true,
    );
  });

  it('defensive: visitor row for a bundle with null/equal axes emits nothing', async () => {
    // The plural is called by editScope only with items where at least one
    // axis moved (the filter in reservation.service.ts:~1916-1923 ensures
    // it). But the per-axis null-or-equal guards in emitVisitorCascadeEvents
    // are belt-and-suspenders: if a caller mistakenly passes an item with
    // both axes unchanged, no events fire even though .in() returned rows.
    const supabase = makeSupabase({
      visitorRows: [{ id: VISITOR_1A, booking_id: BUNDLE_1 }],
    });
    const bus = new BundleEventBus();
    const { events } = captureEvents(bus);
    const svc = buildService({ supabase, bundleEventBus: bus });

    await svc.emitVisitorCascadesForBundles([
      {
        tenantId: TENANT_A,
        bundleId: BUNDLE_1,
        oldStartAt: T_OLD,
        newStartAt: T_OLD, // equal → no moved emit
        oldSpaceId: SPACE_OLD,
        newSpaceId: SPACE_OLD, // equal → no room_changed emit
      },
    ]);

    // The .in() query still fired (defensive call hit the network), but
    // the emit suppression kicked in. Logically: editScope's pre-filter
    // shouldn't let this happen — this test pins the defensive guard.
    expect(supabase.calls.selectIn).toHaveLength(1);
    expect(events).toHaveLength(0);
  });

  it('.in() error: logs warning + returns; no emits', async () => {
    const supabase = makeSupabase({
      visitorRows: [],
      selectError: { message: 'connection terminated' },
    });
    const bus = new BundleEventBus();
    const { events } = captureEvents(bus);
    const svc = buildService({ supabase, bundleEventBus: bus });

    // Should not throw — mirrors the singular's posture of "cascade is
    // best-effort; an emit failure must not roll back the committed RPC
    // mutation".
    await expect(
      svc.emitVisitorCascadesForBundles([
        {
          tenantId: TENANT_A,
          bundleId: BUNDLE_1,
          oldStartAt: T_OLD,
          newStartAt: T_NEW,
          oldSpaceId: null,
          newSpaceId: null,
        },
      ]),
    ).resolves.toBeUndefined();

    expect(events).toHaveLength(0);
  });

  it('.in() thrown (network-class): caught, no emits, no throw', async () => {
    const supabase = makeSupabase({
      visitorRows: [],
      thrown: new Error('ECONNRESET'),
    });
    const bus = new BundleEventBus();
    const { events } = captureEvents(bus);
    const svc = buildService({ supabase, bundleEventBus: bus });

    await expect(
      svc.emitVisitorCascadesForBundles([
        {
          tenantId: TENANT_A,
          bundleId: BUNDLE_1,
          oldStartAt: T_OLD,
          newStartAt: T_NEW,
          oldSpaceId: null,
          newSpaceId: null,
        },
      ]),
    ).resolves.toBeUndefined();

    expect(events).toHaveLength(0);
  });

  it('cross-tenant items throw (single-tenant invariant)', async () => {
    const supabase = makeSupabase({ visitorRows: [] });
    const bus = new BundleEventBus();
    const svc = buildService({ supabase, bundleEventBus: bus });

    await expect(
      svc.emitVisitorCascadesForBundles([
        {
          tenantId: TENANT_A,
          bundleId: BUNDLE_1,
          oldStartAt: T_OLD,
          newStartAt: T_NEW,
          oldSpaceId: null,
          newSpaceId: null,
        },
        {
          tenantId: TENANT_B, // cross-tenant!
          bundleId: BUNDLE_2,
          oldStartAt: T_OLD,
          newStartAt: T_NEW,
          oldSpaceId: null,
          newSpaceId: null,
        },
      ]),
    ).rejects.toThrow(/2 tenants/);

    // .in() must NOT fire — we threw before reaching the read.
    expect(supabase.calls.selectIn).toHaveLength(0);
  });

  it('per-bundle emit isolation: bus.emit throwing on one bundle does not block other bundles', async () => {
    // RxJS 7 Subject.next swallows synchronous subscriber errors via the
    // unhandled-error channel — so a subscriber-throw won't propagate out
    // of Subject.next(). To pin the plural method's per-bundle try/catch
    // contract independently, use a fake bus whose `emit` itself throws
    // for one bundle but succeeds for the rest. Mirrors the singular's
    // outer try/catch wrapping the emit loop (reservation.service.ts).
    const supabase = makeSupabase({
      visitorRows: [
        { id: VISITOR_1A, booking_id: BUNDLE_1 },
        { id: VISITOR_2A, booking_id: BUNDLE_2 },
      ],
    });
    const captured: BundleEvent[] = [];
    const fakeBus = {
      emit: (e: BundleEvent) => {
        if (e.bundle_id === BUNDLE_1) {
          throw new Error('emit failed on bundle 1');
        }
        captured.push(e);
      },
    } as unknown as BundleEventBus;
    const svc = buildService({ supabase, bundleEventBus: fakeBus });

    await expect(
      svc.emitVisitorCascadesForBundles([
        {
          tenantId: TENANT_A,
          bundleId: BUNDLE_1,
          oldStartAt: T_OLD,
          newStartAt: T_NEW,
          oldSpaceId: null,
          newSpaceId: null,
        },
        {
          tenantId: TENANT_A,
          bundleId: BUNDLE_2,
          oldStartAt: T_OLD,
          newStartAt: T_NEW,
          oldSpaceId: null,
          newSpaceId: null,
        },
      ]),
    ).resolves.toBeUndefined();

    // BUNDLE_2's event landed despite BUNDLE_1's emit throwing.
    expect(captured.some((e) => e.bundle_id === BUNDLE_2)).toBe(true);
  });
});

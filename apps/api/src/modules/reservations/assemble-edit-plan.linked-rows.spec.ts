// Booking-audit remediation P0-2/P0-3 — unit coverage for
// AssembleEditPlanService.buildLinkedRowPatches.
//
// Before this fix, buildSingleSlotPlan hard-coded
// asset_reservation_patches/order_patches/work_order_sla_patches to []
// (assemble-edit-plan.service.ts pre-fix :839-852) so an editOne /
// editSlot time/room move left the booking's linked orders /
// asset_reservations / setup work_orders at the OLD time (the caterer
// daglijst diverged). The `edit_booking` v5 RPC (00394) already applies
// these arrays atomically; the fix is purely the TS producer.
//
// These tests exercise the LOCKED classify rules (booking-audit codex
// plan review) directly against the private helper, isolating the P0-2
// logic from the full assembleEditPlan pipeline (resolver / approval /
// conflict) and from the unrelated pre-existing `edit_booking.
// actor_not_found` RPC-actor blocker (reservation.service.ts:1015/1332
// pass app users.id where 00394:294-295 matches on auth_uid) that
// blocks the live smoke gate on origin/main.
//
// Citation discipline: every column / status literal / migration line
// referenced below was Read in this session.
//   - asset_reservations.status terminal = cancelled|released
//     (00142_asset_reservations.sql:14-15); booking_id rename
//     (00278_retarget_sibling_tables.sql:135-136).
//   - orders.status terminal = cancelled|fulfilled
//     (00013_orders_catalog.sql:55); requested_for_* + booking_id
//     (00144_orders_bundle_columns.sql:6-7 + 00278:108-118).
//   - work_orders.status_category terminal = resolved|closed
//     (00213_step1c1_work_orders_new_table.sql:53); sla_id
//     (00213:76); booking_id (00278:86-95).
//   - RPC apply sites: §10.c 00394:736-745 / §10.d :748-770 /
//     §10.f :856-870 / sla emit gate :1011-1031.

import { AssembleEditPlanService } from './assemble-edit-plan.service';

const TENANT = 't1';
const BOOKING = 'B-1';
const OLD_START = '2026-09-26T13:00:00.000Z';
const OLD_END = '2026-09-26T14:00:00.000Z'; // 1h booking
const SPACE_OLD = 'space-old';
const SPACE_NEW = 'space-new';

type Row = Record<string, unknown>;

/**
 * Hand-rolled supabase.admin mock supporting exactly the query shapes
 * buildLinkedRowPatches issues:
 *   - .from('booking_slots').select('id',{count:'exact',head:true})
 *       .eq().eq()                            → { count }
 *   - .from(T).select(cols).eq().eq()
 *       .not('status'|'status_category','in', '(...)')  (terminal await)
 *                                             → { data: Row[] }
 */
/**
 * Which one read the mock should make fail (truthy `.error`). Used by
 * the I-3 fail-closed suite. `'slotCount'` targets the head/count read
 * on `booking_slots`; the other three target the corresponding child
 * table read. Undefined = every read succeeds (the default).
 */
type ErrorOn = 'slotCount' | 'asset_reservations' | 'orders' | 'work_orders';

const DB_ERR = { message: 'connection reset by peer', code: 'XX000' };

function makeSupabase(opts: {
  slotCount: number;
  assetReservations: Row[];
  orders: Row[];
  workOrders: Row[];
  /** I-3: simulate a truthy Supabase `.error` on exactly this read. */
  errorOn?: ErrorOn;
}) {
  function selectChain(table: string, head: boolean) {
    const tableErrors =
      (table === 'asset_reservations' && opts.errorOn === 'asset_reservations') ||
      (table === 'orders' && opts.errorOn === 'orders') ||
      (table === 'work_orders' && opts.errorOn === 'work_orders');
    const chain: Record<string, unknown> = {
      eq: () => chain,
      not: (_col: string, _op: string, _val: string) =>
        // `.not(...)` is the terminal — return the rows. The status
        // exclusion is asserted by the fixtures (we only seed live
        // rows; terminal-status rows are added in dedicated tests and
        // expected to be filtered by the real query — here the mock
        // returns ALL seeded rows so the test must seed only what the
        // real `.not(...in...)` would keep, OR assert the helper's
        // own behavior given the kept set). To keep the unit honest we
        // seed only live rows + verify the helper maps them; a
        // separate test seeds a terminal row and asserts the QUERY was
        // built with the right exclusion list (captured below).
        Promise.resolve(
          tableErrors
            ? // I-3: a truthy `.error` — the helper must fail CLOSED
              // (throw) and NEVER fall back to `data ?? []`. The `data`
              // here is intentionally null to prove the helper does NOT
              // proceed on it.
              { data: null, error: DB_ERR }
            : {
                data:
                  table === 'asset_reservations'
                    ? opts.assetReservations
                    : table === 'orders'
                      ? opts.orders
                      : opts.workOrders,
                error: null,
              },
        ),
    };
    if (head) {
      // count path: select('id',{count:'exact',head:true}).eq().eq()
      // is awaited directly (no .not()). Make the chain thenable.
      (chain as { then?: unknown }).then = (
        onF: (v: {
          count: number | null;
          error: typeof DB_ERR | null;
        }) => unknown,
      ) =>
        Promise.resolve(
          opts.errorOn === 'slotCount'
            ? // I-3 slot-count fail-closed: count null + truthy error.
              // The helper must throw, NOT treat `count ?? 0` as
              // single-slot and propagate.
              { count: null, error: DB_ERR }
            : { count: opts.slotCount, error: null },
        ).then(onF);
    }
    return chain;
  }

  const captured: Array<{ table: string; notArgs: string[] }> = [];
  const supabase = {
    admin: {
      from: (table: string) => ({
        select: (_cols: string, o?: { count?: string; head?: boolean }) => {
          const head = !!o?.head;
          const base = selectChain(table, head);
          // wrap .not to capture the exclusion list for assertion
          const origNot = base.not as (...a: string[]) => unknown;
          base.not = (col: string, op: string, val: string) => {
            captured.push({ table, notArgs: [col, op, val] });
            return origNot(col, op, val);
          };
          return base;
        },
      }),
    },
  };
  return { supabase, captured };
}

function makeService(supabase: { admin: unknown }) {
  // The other constructor deps (bookingFlow / ruleResolver / conflict)
  // are never touched by buildLinkedRowPatches — pass undefined casts.
  return new AssembleEditPlanService(
    supabase as never,
    undefined as never,
    undefined as never,
    undefined as never,
  );
}

/** Reach the private helper — repo specs already construct the real
 *  service and exercise internals (cf. reservation-edit-tenant-
 *  validation.spec.ts). */
function callHelper(
  svc: AssembleEditPlanService,
  args: {
    oldStart?: string;
    oldEnd?: string;
    newStart: string;
    newEnd: string;
    oldSpace?: string;
    newSpace?: string;
  },
) {
  return (
    svc as unknown as {
      buildLinkedRowPatches: (
        bookingId: string,
        tenantId: string,
        oldStart: string,
        oldEnd: string,
        newStart: string,
        newEnd: string,
        oldSpaceId: string,
        newSpaceId: string,
      ) => Promise<{
        asset_reservation_patches: Array<{
          id: string;
          start_at: string;
          end_at: string;
        }>;
        order_patches: Array<{
          id: string;
          delivery_location_id?: string | null;
          requested_for_start_at?: string | null;
          requested_for_end_at?: string | null;
        }>;
        work_order_sla_patches: Array<{
          id: string;
          planned_start_at: string;
          needs_repoint?: boolean;
          sla_policy_id?: string | null;
          sla_due_at?: string | null;
        }>;
        skippedMultiSlot: boolean;
      }>;
    }
  ).buildLinkedRowPatches(
    BOOKING,
    TENANT,
    args.oldStart ?? OLD_START,
    args.oldEnd ?? OLD_END,
    args.newStart,
    args.newEnd,
    args.oldSpace ?? SPACE_OLD,
    args.newSpace ?? SPACE_OLD,
  );
}

// +2h pure move (duration unchanged → startDelta == endDelta == +2h).
const NEW_START = '2026-09-26T15:00:00.000Z';
const NEW_END = '2026-09-26T16:00:00.000Z';
const TWO_H = 2 * 60 * 60_000;

describe('AssembleEditPlanService.buildLinkedRowPatches (P0-2)', () => {
  it('boundary-aligned child windows follow the booking window (newStart,newEnd)', async () => {
    const { supabase } = makeSupabase({
      slotCount: 1,
      assetReservations: [
        { id: 'ar-bnd', start_at: OLD_START, end_at: OLD_END, status: 'confirmed' },
      ],
      orders: [
        {
          id: 'o-bnd',
          requested_for_start_at: OLD_START,
          requested_for_end_at: OLD_END,
          delivery_location_id: SPACE_OLD,
          status: 'confirmed',
        },
      ],
      workOrders: [],
    });
    const out = await callHelper(makeService(supabase), {
      newStart: NEW_START,
      newEnd: NEW_END,
    });
    expect(out.skippedMultiSlot).toBe(false);
    expect(out.asset_reservation_patches).toEqual([
      { id: 'ar-bnd', start_at: NEW_START, end_at: NEW_END },
    ]);
    expect(out.order_patches).toEqual([
      {
        id: 'o-bnd',
        requested_for_start_at: NEW_START,
        requested_for_end_at: NEW_END,
      },
    ]);
  });

  it('custom-window child shifts by startDelta only — duration preserved', async () => {
    // 30-min window offset +15min from old start; must end up +2h with
    // its 30-min span intact (NOT restretched to the 1h booking).
    const cStart = '2026-09-26T13:15:00.000Z';
    const cEnd = '2026-09-26T13:45:00.000Z';
    const { supabase } = makeSupabase({
      slotCount: 1,
      assetReservations: [
        { id: 'ar-cust', start_at: cStart, end_at: cEnd, status: 'confirmed' },
      ],
      orders: [],
      workOrders: [],
    });
    const out = await callHelper(makeService(supabase), {
      newStart: NEW_START,
      newEnd: NEW_END,
    });
    const p = out.asset_reservation_patches[0];
    expect(p.id).toBe('ar-cust');
    expect(Date.parse(p.start_at)).toBe(Date.parse(cStart) + TWO_H);
    expect(Date.parse(p.end_at)).toBe(Date.parse(cEnd) + TWO_H);
    // duration still 30 min — NOT (newEnd-newStart)=60min.
    expect(Date.parse(p.end_at) - Date.parse(p.start_at)).toBe(30 * 60_000);
  });

  it('work_orders: planned_start_at + startDelta, needs_repoint + sla_policy_id, no raw sla_due_at', async () => {
    const woPlanned = '2026-09-26T12:30:00.000Z'; // 30min setup lead
    const { supabase } = makeSupabase({
      slotCount: 1,
      assetReservations: [],
      orders: [],
      workOrders: [
        {
          id: 'wo-1',
          planned_start_at: woPlanned,
          sla_id: 'sla-pol-1',
          status_category: 'assigned',
        },
      ],
    });
    const out = await callHelper(makeService(supabase), {
      newStart: NEW_START,
      newEnd: NEW_END,
    });
    expect(out.work_order_sla_patches).toHaveLength(1);
    const w = out.work_order_sla_patches[0];
    expect(w.id).toBe('wo-1');
    expect(Date.parse(w.planned_start_at)).toBe(Date.parse(woPlanned) + TWO_H);
    expect(w.needs_repoint).toBe(true);
    expect(w.sla_policy_id).toBe('sla-pol-1');
    // The producer must NOT hand-shift sla_due_at (the SLA repoint
    // handler recomputes from the policy — emitting it double-applies).
    expect(w.sla_due_at).toBeUndefined();
  });

  it('work_orders: a null planned_start_at WO is skipped (RPC requires the key, no ? guard at 00394:858)', async () => {
    const { supabase } = makeSupabase({
      slotCount: 1,
      assetReservations: [],
      orders: [],
      workOrders: [
        { id: 'wo-null', planned_start_at: null, sla_id: 's', status_category: 'new' },
      ],
    });
    const out = await callHelper(makeService(supabase), {
      newStart: NEW_START,
      newEnd: NEW_END,
    });
    expect(out.work_order_sla_patches).toEqual([]);
  });

  it('orders: delivery_location_id re-pointed ONLY when space changed AND order delivered to the old space', async () => {
    const { supabase } = makeSupabase({
      slotCount: 1,
      assetReservations: [],
      orders: [
        // delivered to old space → re-point to new space
        {
          id: 'o-here',
          requested_for_start_at: OLD_START,
          requested_for_end_at: OLD_END,
          delivery_location_id: SPACE_OLD,
          status: 'confirmed',
        },
        // delivered elsewhere → do NOT clobber
        {
          id: 'o-elsewhere',
          requested_for_start_at: OLD_START,
          requested_for_end_at: OLD_END,
          delivery_location_id: 'space-other',
          status: 'confirmed',
        },
      ],
      workOrders: [],
    });
    const out = await callHelper(makeService(supabase), {
      newStart: NEW_START,
      newEnd: NEW_END,
      oldSpace: SPACE_OLD,
      newSpace: SPACE_NEW,
    });
    const here = out.order_patches.find((p) => p.id === 'o-here');
    const elsewhere = out.order_patches.find((p) => p.id === 'o-elsewhere');
    expect(here?.delivery_location_id).toBe(SPACE_NEW);
    expect(elsewhere && 'delivery_location_id' in elsewhere).toBe(false);
  });

  it('orders: a null requested_for_* key is omitted (RPC preserves absent keys, 00394:755-764)', async () => {
    const { supabase } = makeSupabase({
      slotCount: 1,
      assetReservations: [],
      orders: [
        {
          id: 'o-null-window',
          requested_for_start_at: null,
          requested_for_end_at: null,
          delivery_location_id: SPACE_OLD,
          status: 'confirmed',
        },
      ],
      workOrders: [],
    });
    const out = await callHelper(makeService(supabase), {
      newStart: NEW_START,
      newEnd: NEW_END,
    });
    const p = out.order_patches[0];
    expect(p.id).toBe('o-null-window');
    expect('requested_for_start_at' in p).toBe(false);
    expect('requested_for_end_at' in p).toBe(false);
  });

  it('multi-slot booking → returns empty arrays + skippedMultiSlot=true (no slot/space attribution column)', async () => {
    const { supabase } = makeSupabase({
      slotCount: 2,
      assetReservations: [
        { id: 'ar', start_at: OLD_START, end_at: OLD_END, status: 'confirmed' },
      ],
      orders: [
        {
          id: 'o',
          requested_for_start_at: OLD_START,
          requested_for_end_at: OLD_END,
          delivery_location_id: SPACE_OLD,
          status: 'confirmed',
        },
      ],
      workOrders: [
        { id: 'wo', planned_start_at: OLD_START, sla_id: 's', status_category: 'new' },
      ],
    });
    const out = await callHelper(makeService(supabase), {
      newStart: NEW_START,
      newEnd: NEW_END,
    });
    expect(out.skippedMultiSlot).toBe(true);
    expect(out.asset_reservation_patches).toEqual([]);
    expect(out.order_patches).toEqual([]);
    expect(out.work_order_sla_patches).toEqual([]);
  });

  it('queries exclude terminal statuses (asset cancelled|released, order cancelled|fulfilled, WO resolved|closed)', async () => {
    const { supabase, captured } = makeSupabase({
      slotCount: 1,
      assetReservations: [],
      orders: [],
      workOrders: [],
    });
    await callHelper(makeService(supabase), {
      newStart: NEW_START,
      newEnd: NEW_END,
    });
    const ar = captured.find((c) => c.table === 'asset_reservations');
    const ord = captured.find((c) => c.table === 'orders');
    const wo = captured.find((c) => c.table === 'work_orders');
    expect(ar?.notArgs).toEqual(['status', 'in', '("cancelled","released")']);
    expect(ord?.notArgs).toEqual(['status', 'in', '("cancelled","fulfilled")']);
    expect(wo?.notArgs).toEqual([
      'status_category',
      'in',
      '("resolved","closed")',
    ]);
  });

  it('tz/NUMERIC round-trip safe: non-Z offset input re-serializes to a stable UTC instant', async () => {
    // Old window expressed with a +02:00 offset; the helper parses to
    // epoch ms and re-emits ISO-8601 'Z'. The instant must be exact.
    const oldStartTz = '2026-09-26T15:00:00.000+02:00'; // == 13:00Z
    const oldEndTz = '2026-09-26T16:00:00.000+02:00'; // == 14:00Z
    const { supabase } = makeSupabase({
      slotCount: 1,
      assetReservations: [
        {
          id: 'ar-tz',
          start_at: oldStartTz,
          end_at: oldEndTz,
          status: 'confirmed',
        },
      ],
      orders: [],
      workOrders: [],
    });
    const out = await callHelper(makeService(supabase), {
      oldStart: oldStartTz,
      oldEnd: oldEndTz,
      newStart: NEW_START,
      newEnd: NEW_END,
    });
    // boundary-aligned (child == old window) → exactly (newStart,newEnd).
    expect(out.asset_reservation_patches[0]).toEqual({
      id: 'ar-tz',
      start_at: NEW_START,
      end_at: NEW_END,
    });
  });

  // ── I-2 (booking-audit remediation): partial-null order window ───────
  // Before the fix, an order with exactly ONE of requested_for_start_at /
  // requested_for_end_at non-null fell back to oldStart/oldEnd for the
  // missing endpoint then ran the boundary classifier
  // (csMs===oldStartMs && ceMs===oldEndMs), which misclassified a
  // really-boundary-aligned partial order as custom-window (and could
  // spuriously classify a synthetic pair as boundary-aligned). Correct
  // behavior: a partial window is ALWAYS custom-window — shift only the
  // present endpoint by startDelta, emit ONLY the non-null key(s)
  // (absent key = preserve in the RPC, 00394:755-764). Both-null emits
  // no time keys; both-set keeps the existing boundary/custom classify.
  describe('orders: partial-null requested_for_* window (I-2)', () => {
    it('only requested_for_start_at set → shift start by startDelta, omit end key', async () => {
      // Endpoint equals OLD_START — under the old code this + the
      // oldEnd fallback would hit the boundary classifier and snap to
      // (newStart,newEnd). Correct: pure +startDelta on start only.
      const { supabase } = makeSupabase({
        slotCount: 1,
        assetReservations: [],
        orders: [
          {
            id: 'o-start-only',
            requested_for_start_at: OLD_START,
            requested_for_end_at: null,
            delivery_location_id: SPACE_OLD,
            status: 'confirmed',
          },
        ],
        workOrders: [],
      });
      const out = await callHelper(makeService(supabase), {
        newStart: NEW_START,
        newEnd: NEW_END,
      });
      const p = out.order_patches[0];
      expect(p.id).toBe('o-start-only');
      expect('requested_for_start_at' in p).toBe(true);
      expect(Date.parse(p.requested_for_start_at as string)).toBe(
        Date.parse(OLD_START) + TWO_H,
      );
      expect('requested_for_end_at' in p).toBe(false);
    });

    it('only requested_for_end_at set → shift end by startDelta, omit start key', async () => {
      const cEnd = '2026-09-26T13:45:00.000Z'; // arbitrary partial end
      const { supabase } = makeSupabase({
        slotCount: 1,
        assetReservations: [],
        orders: [
          {
            id: 'o-end-only',
            requested_for_start_at: null,
            requested_for_end_at: cEnd,
            delivery_location_id: SPACE_OLD,
            status: 'confirmed',
          },
        ],
        workOrders: [],
      });
      const out = await callHelper(makeService(supabase), {
        newStart: NEW_START,
        newEnd: NEW_END,
      });
      const p = out.order_patches[0];
      expect(p.id).toBe('o-end-only');
      expect('requested_for_end_at' in p).toBe(true);
      expect(Date.parse(p.requested_for_end_at as string)).toBe(
        Date.parse(cEnd) + TWO_H,
      );
      expect('requested_for_start_at' in p).toBe(false);
    });

    it('both null → no time keys emitted (delivery re-point may still apply)', async () => {
      const { supabase } = makeSupabase({
        slotCount: 1,
        assetReservations: [],
        orders: [
          {
            id: 'o-both-null',
            requested_for_start_at: null,
            requested_for_end_at: null,
            delivery_location_id: SPACE_OLD,
            status: 'confirmed',
          },
        ],
        workOrders: [],
      });
      const out = await callHelper(makeService(supabase), {
        newStart: NEW_START,
        newEnd: NEW_END,
        oldSpace: SPACE_OLD,
        newSpace: SPACE_NEW,
      });
      const p = out.order_patches[0];
      expect(p.id).toBe('o-both-null');
      expect('requested_for_start_at' in p).toBe(false);
      expect('requested_for_end_at' in p).toBe(false);
      // space changed + delivered to old space → re-point still applies.
      expect(p.delivery_location_id).toBe(SPACE_NEW);
    });

    it('both set + boundary-aligned → follows booking window (newStart,newEnd)', async () => {
      const { supabase } = makeSupabase({
        slotCount: 1,
        assetReservations: [],
        orders: [
          {
            id: 'o-both-bnd',
            requested_for_start_at: OLD_START,
            requested_for_end_at: OLD_END,
            delivery_location_id: SPACE_OLD,
            status: 'confirmed',
          },
        ],
        workOrders: [],
      });
      const out = await callHelper(makeService(supabase), {
        newStart: NEW_START,
        newEnd: NEW_END,
      });
      expect(out.order_patches[0]).toEqual({
        id: 'o-both-bnd',
        requested_for_start_at: NEW_START,
        requested_for_end_at: NEW_END,
      });
    });

    it('both set + custom-window → both endpoints shift by startDelta, duration preserved', async () => {
      // 30-min order window offset +15min from old start; both endpoints
      // present but != old window → custom-window: +startDelta, span kept.
      const cStart = '2026-09-26T13:15:00.000Z';
      const cEnd = '2026-09-26T13:45:00.000Z';
      const { supabase } = makeSupabase({
        slotCount: 1,
        assetReservations: [],
        orders: [
          {
            id: 'o-both-cust',
            requested_for_start_at: cStart,
            requested_for_end_at: cEnd,
            delivery_location_id: SPACE_OLD,
            status: 'confirmed',
          },
        ],
        workOrders: [],
      });
      const out = await callHelper(makeService(supabase), {
        newStart: NEW_START,
        newEnd: NEW_END,
      });
      const p = out.order_patches[0];
      expect(p.id).toBe('o-both-cust');
      expect(Date.parse(p.requested_for_start_at as string)).toBe(
        Date.parse(cStart) + TWO_H,
      );
      expect(Date.parse(p.requested_for_end_at as string)).toBe(
        Date.parse(cEnd) + TWO_H,
      );
      // span unchanged (30 min) — NOT restretched to the 1h booking.
      expect(
        Date.parse(p.requested_for_end_at as string) -
          Date.parse(p.requested_for_start_at as string),
      ).toBe(30 * 60_000);
    });
  });

  // ── I-3 (booking-audit codex REJECT — blocking Important) ────────────
  // buildLinkedRowPatches was fail-OPEN on Supabase read errors: the
  // slot-count read and the 3 child reads (asset_reservations / orders /
  // work_orders) ignored the response `.error` and fell back to
  // `count ?? 0` / `data ?? []`. A transient DB read error therefore made
  // the code proceed as if the booking were single-slot / had no children
  // → the `edit_booking` RPC committed the booking time move while linked
  // orders / asset_reservations / work_orders stayed at the OLD time
  // (the exact P0-2 divergence this slice exists to prevent — silently).
  //
  // Fix: a truthy `.error` on ANY of the 4 reads throws
  // `AppErrors.server('edit_booking.not_found', { detail, cause })` —
  // the same code/factory the in-file scope-row read at
  // assemble-edit-plan.service.ts:495-499 already uses for a failed
  // Supabase read. The throw fires BEFORE any empty-patch return and
  // before the caller reaches the `edit_booking` RPC.
  //
  // IMPORTANT distinction asserted by the last test in this block: a
  // SUCCESSFUL slot-count read with count > 1 is the deliberate
  // documented multi-slot skip (loud logger.warn + empty arrays), NOT
  // an error — it must stay behaviorally unchanged (no throw).
  describe('I-3 fail-closed on Supabase read errors', () => {
    const seeded = {
      slotCount: 1,
      assetReservations: [
        { id: 'ar', start_at: OLD_START, end_at: OLD_END, status: 'confirmed' },
      ] as Row[],
      orders: [
        {
          id: 'o',
          requested_for_start_at: OLD_START,
          requested_for_end_at: OLD_END,
          delivery_location_id: SPACE_OLD,
          status: 'confirmed',
        },
      ] as Row[],
      workOrders: [
        { id: 'wo', planned_start_at: OLD_START, sla_id: 's', status_category: 'new' },
      ] as Row[],
    };

    it('slot-count read error → REJECTS (no single-slot fallback / no propagation)', async () => {
      const { supabase } = makeSupabase({ ...seeded, errorOn: 'slotCount' });
      await expect(
        callHelper(makeService(supabase), {
          newStart: NEW_START,
          newEnd: NEW_END,
        }),
      ).rejects.toMatchObject({
        name: 'AppError',
        code: 'edit_booking.not_found',
        status: 500,
      });
    });

    it('asset_reservations read error → REJECTS (no [] fallback)', async () => {
      const { supabase } = makeSupabase({
        ...seeded,
        errorOn: 'asset_reservations',
      });
      await expect(
        callHelper(makeService(supabase), {
          newStart: NEW_START,
          newEnd: NEW_END,
        }),
      ).rejects.toMatchObject({
        name: 'AppError',
        code: 'edit_booking.not_found',
        status: 500,
      });
    });

    it('orders read error → REJECTS (no [] fallback)', async () => {
      const { supabase } = makeSupabase({ ...seeded, errorOn: 'orders' });
      await expect(
        callHelper(makeService(supabase), {
          newStart: NEW_START,
          newEnd: NEW_END,
        }),
      ).rejects.toMatchObject({
        name: 'AppError',
        code: 'edit_booking.not_found',
        status: 500,
      });
    });

    it('work_orders read error → REJECTS (no [] fallback)', async () => {
      const { supabase } = makeSupabase({ ...seeded, errorOn: 'work_orders' });
      await expect(
        callHelper(makeService(supabase), {
          newStart: NEW_START,
          newEnd: NEW_END,
        }),
      ).rejects.toMatchObject({
        name: 'AppError',
        code: 'edit_booking.not_found',
        status: 500,
      });
    });

    it('LEGIT multi-slot path unchanged: count read OK + count>1 → empty arrays + warn, NO throw', async () => {
      const { supabase } = makeSupabase({
        slotCount: 2, // successful read, >1 slot — NOT an error
        assetReservations: seeded.assetReservations,
        orders: seeded.orders,
        workOrders: seeded.workOrders,
        // errorOn intentionally absent — every read succeeds.
      });
      const svc = makeService(supabase);
      const warnSpy = jest
        .spyOn(
          (svc as unknown as { log: { warn: (m: string) => void } }).log,
          'warn',
        )
        .mockImplementation(() => undefined);
      const out = await callHelper(svc, {
        newStart: NEW_START,
        newEnd: NEW_END,
      });
      // No throw; deliberate documented skip.
      expect(out.skippedMultiSlot).toBe(true);
      expect(out.asset_reservation_patches).toEqual([]);
      expect(out.order_patches).toEqual([]);
      expect(out.work_order_sla_patches).toEqual([]);
      // The skip is loud (I-1 observability), not silent.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('[I-1]');
      warnSpy.mockRestore();
    });
  });
});

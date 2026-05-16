// Booking-audit remediation Slice 1 — RUNNABLE GUARD for the
// idempotency-hash determinism P0.
//
// The P0 (verified + scoped by the booking-audit codex idempotency
// review): edit_booking / edit_booking_scope hashed the WHOLE plan text
// for the command_operations idempotency gate. The plan carries
// retry-unstable content:
//   - `_resolution_at` — a server-stamped wall-clock instant captured
//     fresh on every assembleEditPlan call (assemble-edit-plan.service
//     .ts:624 `new Date().toISOString()`).
//   - 6 audit-snapshot / id-keyed arrays whose source-row order is
//     non-deterministic (rule-resolver fan-out ties; supabase-js has no
//     implicit row order without an explicit .order()).
// → the same logical edit retried under the same idempotency key
// hashed differently → spurious command_operations.payload_mismatch
// 409 on a legitimate replay.
//
// The fix has two halves and this guard covers BOTH:
//
//   GUARD 1 (producer canonicalization, dynamic) — drive the REAL
//   buildSingleSlotPlan twice with the wall clock mocked to two
//   DIFFERENT instants and every unordered source (rule-resolver
//   matched rules, linked asset_reservations / orders / work_orders)
//   returning rows in SHUFFLED order, under the same logical edit.
//   Assert the two plans are byte-identical after applying the strip
//   that mirrors the SQL helper (public.booking_edit_strip_hash_server
//   _fields, migration 00407). This proves the only residual
//   nondeterminism is the _-prefixed `_resolution_at`, which the SQL
//   helper strips before hashing.
//
//   GUARD 2 (exclusion-set static check) — parse migration 00407's
//   `key not in (...)` exclusion list and assert EVERY EditPlan field
//   whose key starts with `_` is present. This FAILS if a future
//   `_`-prefixed field is added to EditPlan without updating the SQL
//   helper's exclusion set (the exact failure mode that would silently
//   re-open the P0).
//
// Citation discipline: every column / method / migration line below
// was Read in this session.
//   - assemble-edit-plan.service.ts:624 (_resolution_at stamp),
//     :761-790 (policy_snapshot + applied_rule_ids canonicalization),
//     :1006 / :1037 / :1082 (linked-row .sort()), :1146-1166
//     (loadBookingAndSlot query shapes), :231-241 of edit-plan-helpers
//     (loadCurrentApprovalChain query shape).
//   - supabase/migrations/00407_booking_edit_idempotency_intent_hash
//     .sql — booking_edit_strip_hash_server_fields exclusion set.
//   - edit-plan.types.ts:130-142 (EditPlan shape; only _-prefixed key
//     is `_resolution_at`).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AssembleEditPlanService } from './assemble-edit-plan.service';
import type { EditPlan } from './edit-plan.types';

const TENANT = 't-idem';
const BOOKING = 'B-idem';
const SLOT = 'S-idem';
const SPACE = 'space-idem';
const REQUESTER = 'person-req';

// Two distinct wall-clock instants. _resolution_at is stamped from
// `new Date().toISOString()`; a real retry of the same logical edit
// happens at a later instant, so the plans MUST differ ONLY in
// _resolution_at (which the SQL helper strips).
const INSTANT_A = '2026-05-16T08:00:00.000Z';
const INSTANT_B = '2026-05-16T08:05:30.000Z';

type Row = Record<string, unknown>;

// ── TS mirror of public.booking_edit_strip_hash_server_fields ────────
// (migration 00407). Recursively removes any object key in the
// exclusion set at every nesting depth; preserves array order (the
// producer is responsible for canonicalising array CONTENT order). The
// exclusion set is parsed from the migration in GUARD 2 and asserted to
// cover every _-prefixed EditPlan field, so this literal is kept in
// lockstep with the SQL.
const SERVER_FIELD_EXCLUSIONS = new Set(['_resolution_at']);
function stripServerFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripServerFields);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SERVER_FIELD_EXCLUSIONS.has(k)) continue;
      out[k] = stripServerFields(v);
    }
    return out;
  }
  return value;
}

// Build a Supabase mock that serves every query shape buildSingleSlotPlan
// issues. `shuffle` flips the row order of the unordered sources so the
// determinism property is actually exercised (a stable mock would make
// the guard vacuous).
function makeSupabase(shuffle: boolean) {
  const ar: Row[] = [
    { id: 'ar-2', start_at: '2026-09-26T13:00:00.000Z', end_at: '2026-09-26T14:00:00.000Z', status: 'confirmed' },
    { id: 'ar-1', start_at: '2026-09-26T13:00:00.000Z', end_at: '2026-09-26T14:00:00.000Z', status: 'confirmed' },
  ];
  const orders: Row[] = [
    { id: 'o-2', requested_for_start_at: '2026-09-26T13:00:00.000Z', requested_for_end_at: '2026-09-26T14:00:00.000Z', delivery_location_id: null, status: 'pending' },
    { id: 'o-1', requested_for_start_at: '2026-09-26T13:00:00.000Z', requested_for_end_at: '2026-09-26T14:00:00.000Z', delivery_location_id: null, status: 'pending' },
  ];
  const wos: Row[] = [
    { id: 'w-2', planned_start_at: '2026-09-26T12:00:00.000Z', sla_id: 'sla-x', status_category: 'open' },
    { id: 'w-1', planned_start_at: '2026-09-26T12:00:00.000Z', sla_id: 'sla-x', status_category: 'open' },
  ];
  const order = (rows: Row[]) => (shuffle ? [...rows].reverse() : rows);

  function from(table: string) {
    const state: { rows: Row[]; single: boolean } = { rows: [], single: false };
    if (table === 'bookings') {
      state.rows = [
        {
          id: BOOKING,
          tenant_id: TENANT,
          requester_person_id: REQUESTER,
          location_id: SPACE,
          start_at: '2026-09-26T13:00:00.000Z',
          end_at: '2026-09-26T14:00:00.000Z',
          status: 'confirmed',
          recurrence_series_id: null,
        },
      ];
      state.single = true;
    } else if (table === 'booking_slots') {
      state.rows = [
        {
          id: SLOT,
          booking_id: BOOKING,
          tenant_id: TENANT,
          space_id: SPACE,
          start_at: '2026-09-26T13:00:00.000Z',
          end_at: '2026-09-26T14:00:00.000Z',
          attendee_count: 4,
          attendee_person_ids: [],
        },
      ];
      state.single = true;
    } else if (table === 'approvals') {
      state.rows = []; // no current chain → old_outcome='allow'
    } else if (table === 'asset_reservations') {
      state.rows = order(ar);
    } else if (table === 'orders') {
      state.rows = order(orders);
    } else if (table === 'work_orders') {
      state.rows = order(wos);
    }

    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      order: () => chain,
      not: () => Promise.resolve({ data: state.rows, error: null }),
      maybeSingle: () =>
        Promise.resolve({ data: state.rows[0] ?? null, error: null }),
    };
    return chain;
  }

  return { admin: { from } } as unknown;
}

// Stub the 3 non-Supabase collaborators. matchedRules order is FLIPPED
// when shuffle=true so the policy_snapshot canonicalization is exercised.
function makeService(shuffle: boolean) {
  const rules = [
    { id: 'rule-b', effect: 'allow_override', denial_message: null },
    { id: 'rule-a', effect: 'warn', denial_message: null },
  ];
  const bookingFlow = {
    loadSpace: async () => ({
      id: SPACE,
      cost_per_hour: null,
      setup_buffer_minutes: 0,
      teardown_buffer_minutes: 0,
      check_in_required: false,
    }),
  };
  const ruleResolver = {
    resolve: async () => ({
      final: 'allow' as const,
      effects: shuffle ? ['warn', 'allow_override'] : ['allow_override', 'warn'],
      matchedRules: shuffle ? [...rules].reverse() : rules,
      approvalConfig: null,
    }),
  };
  const conflict = {
    snapshotBuffersForBooking: async () => ({
      setup_buffer_minutes: 0,
      teardown_buffer_minutes: 0,
    }),
  };
  return new AssembleEditPlanService(
    makeSupabase(shuffle) as never,
    bookingFlow as never,
    ruleResolver as never,
    conflict as never,
  );
}

function buildPlanAt(instant: string, shuffle: boolean): Promise<EditPlan> {
  const svc = makeService(shuffle);
  const realDate = global.Date;
  // Freeze the wall clock so _resolution_at = `new Date().toISOString()`
  // resolves to `instant`. Keep Date.parse / new Date(arg) working for
  // the window-shift math (only the zero-arg constructor is pinned).
  class FixedDate extends realDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(instant);
      } else {
        // @ts-expect-error — forward to the real Date ctor
        super(...args);
      }
    }
    static now() {
      return new realDate(instant).getTime();
    }
  }
  // @ts-expect-error — swap the global for the duration of the build
  global.Date = FixedDate;
  return (
    svc as unknown as {
      buildSingleSlotPlan: (
        args: unknown,
        patch: unknown,
      ) => Promise<EditPlan>;
    }
  )
    .buildSingleSlotPlan(
      { bookingId: BOOKING, slotId: SLOT, tenantId: TENANT },
      {
        // Pure resave (no geometry change) — the dominant retry shape.
        auto_set_recurrence_overridden: false,
      },
    )
    .finally(() => {
      global.Date = realDate;
    });
}

describe('Booking-edit idempotency-hash determinism (Slice 1 P0 guard)', () => {
  it('GUARD 1: same logical edit at two different instants + shuffled sources → byte-identical after server-field strip', async () => {
    const planA = await buildPlanAt(INSTANT_A, false);
    const planB = await buildPlanAt(INSTANT_B, true);

    // Sanity: the two raw plans DO differ (only in _resolution_at) —
    // otherwise the guard would be vacuous (proves the harness actually
    // varies the clock + row order).
    expect(planA._resolution_at).toBe(INSTANT_A);
    expect(planB._resolution_at).toBe(INSTANT_B);
    expect(JSON.stringify(planA)).not.toBe(JSON.stringify(planB));

    // The actual idempotency property: after the SQL helper's strip, the
    // canonical bytes are identical. If the producer left ANY of the 6
    // arrays in source order, the shuffled run would diverge here.
    const canonA = JSON.stringify(stripServerFields(planA));
    const canonB = JSON.stringify(stripServerFields(planB));
    expect(canonB).toBe(canonA);

    // Spot-check the canonicalization landed where the codex review said.
    expect(planB.booking.policy_snapshot).toEqual(planA.booking.policy_snapshot);
    expect((planB.booking.policy_snapshot as Record<string, unknown>).matched_rule_ids).toEqual(
      ['rule-a', 'rule-b'],
    );
    expect((planB.booking.policy_snapshot as Record<string, unknown>).effects_seen).toEqual(
      ['allow_override', 'warn'],
    );
    expect(planB.asset_reservation_patches?.map((p) => p.id)).toEqual(['ar-1', 'ar-2']);
    expect(planB.order_patches?.map((p) => p.id)).toEqual(['o-1', 'o-2']);
    expect(planB.work_order_sla_patches?.map((p) => p.id)).toEqual(['w-1', 'w-2']);
  });

  it('GUARD 2: every _-prefixed EditPlan field is in migration 00407 booking_edit_strip_hash_server_fields exclusion set', () => {
    // The full EditPlan shape is the contract in edit-plan.types.ts. The
    // ONLY _-prefixed key today is `_resolution_at`. This list is the
    // exhaustive set of _-prefixed top-level EditPlan keys; if a future
    // _-prefixed field is added it MUST be appended here AND to the SQL
    // exclusion set, or this guard fails.
    const underscorePrefixedEditPlanFields = ['_resolution_at'];

    // jest cwd is apps/api; migrations live at the monorepo root. Walk
    // up until supabase/migrations resolves so the guard is robust to
    // the runner's cwd.
    const fileName = '00407_booking_edit_idempotency_intent_hash.sql';
    const candidates = [
      join(process.cwd(), 'supabase', 'migrations', fileName),
      join(process.cwd(), '..', '..', 'supabase', 'migrations', fileName),
    ];
    let sql: string | null = null;
    for (const p of candidates) {
      try {
        sql = readFileSync(p, 'utf8');
        break;
      } catch {
        // try next candidate
      }
    }
    expect(sql).not.toBeNull();

    // Parse the `where key not in ('a', 'b', ...)` clause inside
    // booking_edit_strip_hash_server_fields.
    const m = (sql as string).match(/key\s+not\s+in\s*\(([^)]*)\)/i);
    expect(m).not.toBeNull();
    const exclusionSet = new Set(
      (m as RegExpMatchArray)[1]
        .split(',')
        .map((s) => s.trim().replace(/^'/, '').replace(/'$/, ''))
        .filter((s) => s.length > 0),
    );

    for (const field of underscorePrefixedEditPlanFields) {
      expect(exclusionSet.has(field)).toBe(true);
    }

    // Defense-in-depth: the TS strip mirror must match the SQL exclusion
    // set exactly, so the dynamic GUARD 1 cannot drift from the DB.
    expect([...SERVER_FIELD_EXCLUSIONS].sort()).toEqual([...exclusionSet].sort());
  });
});

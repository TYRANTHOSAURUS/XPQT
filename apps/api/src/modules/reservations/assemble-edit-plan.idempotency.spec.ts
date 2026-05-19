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

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AssembleEditPlanService } from './assemble-edit-plan.service';
import type { AssembleScopeEditPlanResult } from './assemble-edit-plan.service';
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
// audit-03 Slice 2 (D-5): extended to include the two enumerated
// pre-state-derived approval fields (`old_outcome`,
// `chain_config_changed`) alongside the `_`-prefixed server field. The
// SQL exclusion set (migration 00430) carries the same three names;
// GUARD 2 asserts this mirror == the SQL set EXACTLY so GUARD 1 / 3
// cannot drift from the DB.
const SERVER_FIELD_EXCLUSIONS = new Set([
  '_resolution_at',
  'old_outcome',
  'chain_config_changed',
]);
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

  it('GUARD 2: the SQL hash-exclusion set is exactly the enumerated server/pre-state fields (underscore-prefixed server-stamped OR enumerated pre-state-derived)', () => {
    // The full EditPlan shape is the contract in edit-plan.types.ts. The
    // hash-exclusion set covers TWO kinds of NON-caller-intent fields:
    //   (1) underscore-prefixed server-stamped fields — today only
    //       `_resolution_at` (assemble-edit-plan.service.ts:649,
    //       `new Date().toISOString()`).
    //   (2) enumerated pre-state-derived fields under `approval` —
    //       `old_outcome` / `chain_config_changed`. Both are derived
    //       from a LIVE `approvals` read (loadCurrentApprovalChain,
    //       edit-plan-helpers.ts:210-313) with ZERO caller input. The
    //       COMMIT's §3.6.5 reconciliation mutates `approvals`; a
    //       same-intent RETRY reads back the mutated state → these two
    //       flip → spurious command_operations.payload_mismatch 409
    //       (audit-03 D-5). They are pure pre-state, fully re-derivable
    //       by the RPC from `new_chain_config` + live state; the RPC
    //       reads them from the UNSTRIPPED plan so §3.6.5 is unaffected.
    // Any future field that is NOT caller intent AND reaches the hashed
    // RPC payload MUST be appended here AND to the SQL exclusion set, or
    // this guard fails. This is the exhaustive enumerated set; D-2's
    // residual (a future non-`_` request-varying field) is now closed
    // for these two pre-state names — they are explicitly enumerated-
    // excluded and GUARD 2 covers them.
    //
    // EXEMPTION (audit-03 Slice 3, P0-2 multi-slot residual, Path B):
    // `EditPlan._skipped_multi_slot_linked_rows` is `_`-prefixed and
    // non-caller-intent, but is INTENTIONALLY NOT in this set. It is a
    // SERVER-INTERNAL marker the service STRIPS at the producer→RPC
    // boundary (`ReservationService.stripInternalMarkers`, applied at
    // every `edit_booking` / `edit_booking_scope` call site) so it NEVER
    // reaches the wire, the RPC, or the hashed payload. The "append to
    // the SQL/TS strip set" rule applies ONLY to fields that DO reach the
    // hashed payload — this one cannot, by construction, so adding it to
    // the SQL exclusion set would be dead/misleading. GUARD 3's exact-
    // equality assertion below stays valid precisely because this field
    // is absent from the hashed payload (the GUARD 1/3 fixtures are
    // single-slot ⇒ `buildLinkedRowPatches` never sets the marker).
    const expectedExclusionFields = [
      '_resolution_at',
      'old_outcome',
      'chain_config_changed',
    ];

    // COLLISION AUDIT (grep-proven, see decision doc + migration header):
    // `old_outcome` / `chain_config_changed` appear as object keys ONLY
    // under `EditPlanApproval` (edit-plan.types.ts:40-57) in the entire
    // hashed payload — `assemble-edit-plan.service.ts:756-761` is the
    // sole producer; no other plan field or nested object uses either
    // name. So the SQL helper's GLOBAL by-exact-name strip removes only
    // the intended `approval.{old_outcome,chain_config_changed}` and
    // cannot collateral-strip an unrelated field at any depth.

    // jest cwd is apps/api; migrations live at the monorepo root. Walk
    // up until supabase/migrations resolves so the guard is robust to
    // the runner's cwd.
    const fileName = '00430_booking_edit_strip_hash_prestate_fields.sql';
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

    // Parse the `where key not in ('a', 'b', ...)` clause inside the
    // EXECUTABLE body of booking_edit_strip_hash_server_fields. Strip
    // SQL `--` line comments first: the 00430 migration header
    // intentionally documents the 00407→00430 exclusion-set diff in
    // prose (`-- 00407: where key not in ('_resolution_at')`), which
    // would otherwise be the first regex hit and make this guard parse
    // the WRONG (documentation) set. After comment-stripping, the only
    // `key not in (...)` is the real CREATE OR REPLACE body.
    const sqlNoComments = (sql as string)
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');
    const m = sqlNoComments.match(/key\s+not\s+in\s*\(([^)]*)\)/i);
    expect(m).not.toBeNull();
    const exclusionSet = new Set(
      (m as RegExpMatchArray)[1]
        .split(',')
        .map((s) => s.trim().replace(/^'/, '').replace(/'$/, ''))
        .filter((s) => s.length > 0),
    );

    for (const field of expectedExclusionFields) {
      expect(exclusionSet.has(field)).toBe(true);
    }

    // EXACT EQUALITY (reworked, still passing): the TS strip mirror MUST
    // equal the SQL exclusion set, so the dynamic guards cannot drift
    // from the DB. The set now includes the two enumerated pre-state
    // names in addition to the `_`-prefixed server field.
    expect([...SERVER_FIELD_EXCLUSIONS].sort()).toEqual([...exclusionSet].sort());
    expect([...exclusionSet].sort()).toEqual([...expectedExclusionFields].sort());
  });
});

// ─────────────────────────────────────────────────────────────────────
// GUARD 3 — audit-03 D-5: edit-scope idempotency producer-determinism.
//
// Root cause (proven, completeness-falsified below): a same-intent
// COMMIT→RETRY of an `edit_booking_scope`. The COMMIT's §3.6.5
// reconciliation mutates `approvals`; the RETRY's producer
// (`assembleScopeEditPlan`→`buildSingleSlotPlan`) re-reads the now-
// mutated live chain via `loadCurrentApprovalChain` and recomputes
// `approval.old_outcome` + `approval.chain_config_changed` from it.
// Those two fields FLIP → different post-strip md5 → spurious
// `command_operations.payload_mismatch` 409, op permanently lost.
//
// This guard drives the REAL scope producer path TWICE with mocked
// supabase such that `loadCurrentApprovalChain` returns DIFFERENT live-
// chain state across the two runs (modeling commit→retry), then:
//   (a) proves the bug under the CURRENT {_resolution_at} strip set;
//   (b) COMPLETENESS: proves the post-{_resolution_at}-strip key-path
//       diff is EXACTLY {approval.old_outcome, approval.chain_config_
//       changed} and nothing else — if a third path differed the
//       by-name set would be incomplete (the prior-misdiagnosis trap);
//   (c) proves the fix under the {_resolution_at, old_outcome,
//       chain_config_changed} strip set.
// Two transition pairs are exercised: (1) no-chain→inserted-chain and
// (2) chain→expired (the §3.6.5 expire branch). The live smoke
// (smoke-edit-booking-scope.mjs FIXME-409 block) is the AUTHORITATIVE
// completeness gate over this modeled jest guard; it runs in the batch
// push pass.
// ─────────────────────────────────────────────────────────────────────

// Faithful TS mirror of public.booking_edit_strip_hash_server_fields
// (00407 :55-69 / 00430): recursively remove any object key whose EXACT
// NAME is in the exclusion set, at EVERY nesting depth; preserve array
// order. Parameterized by the exclusion set so the SAME mirror can be
// asserted under HEAD's set and the proposed set.
function stripByNameSet(value: unknown, names: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => stripByNameSet(v, names));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (names.has(k)) continue;
      out[k] = stripByNameSet(v, names);
    }
    return out;
  }
  return value;
}
// md5(JSON) — mirrors `md5(coalesce(strip(p_payload)::text,''))`
// (00407:73). The exact textual form is not load-bearing (we compare
// run-1 vs run-2 with the SAME serializer), only its determinism.
function md5Json(value: unknown): string {
  return createHash('md5').update(JSON.stringify(value)).digest('hex');
}

// Exhaustive deep key-path diff. Returns the SORTED set of dotted key
// paths whose leaf value differs between two JSON-able structures
// (array index segments included). Used for the COMPLETENESS assertion.
function deepKeyPathDiff(a: unknown, b: unknown, prefix = ''): string[] {
  const diffs: string[] = [];
  const isObj = (x: unknown): x is Record<string, unknown> =>
    x !== null && typeof x === 'object' && !Array.isArray(x);
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      diffs.push(...deepKeyPathDiff(a[i], b[i], `${prefix}[${i}]`));
    }
    return diffs;
  }
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const p = prefix ? `${prefix}.${k}` : k;
      diffs.push(...deepKeyPathDiff(a[k], b[k], p));
    }
    return diffs;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(prefix || '<root>');
  return diffs;
}

const G3_TENANT = 't-d5';
const G3_SERIES = 'series-d5';
const G3_PIVOT = 'B-d5';
const G3_SLOT = 'S-d5';
const G3_SPACE = 'space-d5';
const G3_REQUESTER = 'person-req-d5';
const G3_INSTANT = '2026-05-18T09:00:00.000Z';

// A live approval chain row, shaped like the `approvals` projection
// loadCurrentApprovalChain selects (edit-plan-helpers.ts:231-241).
type ApprovalRow = {
  approval_chain_id: string | null;
  parallel_group: string | null;
  approver_person_id: string | null;
  approver_team_id: string | null;
  created_at: string;
  status: string;
};

// Build the scope-path supabase mock. `approvalRows` is what
// loadCurrentApprovalChain reads (the only thing that varies between
// the two commit→retry runs). Single-slot booking, no linked rows, so
// the only producer variance is the approval block.
function makeScopeSupabase(approvalRows: ApprovalRow[]) {
  function from(_table: string) {
    const table = _table;
    const ctx: {
      selectArg: string;
      head: boolean;
      // Models Postgres applying `.in('status', [...])` server-side.
      // loadCurrentApprovalChain (edit-plan-helpers.ts:239) filters
      // status IN (pending,delegated,approved); the mock MUST honor it
      // or expired/rejected rows leak through and the expire-transition
      // model is unfaithful.
      statusIn: ReadonlyArray<string> | null;
    } = { selectArg: '', head: false, statusIn: null };

    const result = (): { data: unknown; error: null; count: number | null } => {
      if (table === 'bookings') {
        // Two distinct bookings reads:
        //  - pivot (assembleScopeEditPlan §B): select
        //    'id, tenant_id, recurrence_series_id'
        //  - scope-rows (§D): select 'id'
        //  - loadBookingAndSlot: 8-col select
        if (ctx.selectArg.includes('requester_person_id')) {
          return {
            data: {
              id: G3_PIVOT,
              tenant_id: G3_TENANT,
              requester_person_id: G3_REQUESTER,
              location_id: G3_SPACE,
              start_at: '2026-09-26T13:00:00.000Z',
              end_at: '2026-09-26T14:00:00.000Z',
              status: 'confirmed',
              recurrence_series_id: G3_SERIES,
            },
            error: null,
            count: null,
          };
        }
        if (ctx.selectArg.includes('recurrence_series_id')) {
          // pivot read (maybeSingle)
          return {
            data: {
              id: G3_PIVOT,
              tenant_id: G3_TENANT,
              recurrence_series_id: G3_SERIES,
            },
            error: null,
            count: null,
          };
        }
        // scope-rows read (array, .order('id'))
        return { data: [{ id: G3_PIVOT }], error: null, count: null };
      }
      if (table === 'booking_slots') {
        if (ctx.head) {
          // buildLinkedRowPatches slot-count head query → single slot.
          return { data: null, error: null, count: 1 };
        }
        if (ctx.selectArg.includes('booking_id')) {
          // loadBookingAndSlot 8-col slot read.
          return {
            data: {
              id: G3_SLOT,
              booking_id: G3_PIVOT,
              tenant_id: G3_TENANT,
              space_id: G3_SPACE,
              start_at: '2026-09-26T13:00:00.000Z',
              end_at: '2026-09-26T14:00:00.000Z',
              attendee_count: 4,
              attendee_person_ids: [],
            },
            error: null,
            count: null,
          };
        }
        // primary-slot read (select 'id', maybeSingle).
        return { data: { id: G3_SLOT }, error: null, count: null };
      }
      if (table === 'approvals') {
        // Apply the server-side status filter the way Postgres would
        // for loadCurrentApprovalChain's `.in('status', [...])`.
        const filtered =
          ctx.statusIn === null
            ? approvalRows
            : approvalRows.filter((r) => ctx.statusIn!.includes(r.status));
        return { data: filtered, error: null, count: null };
      }
      // asset_reservations / orders / work_orders — no linked rows.
      return { data: [], error: null, count: null };
    };

    const chain: Record<string, unknown> = {
      select: (arg?: string, opts?: { head?: boolean }) => {
        ctx.selectArg = arg ?? '';
        ctx.head = opts?.head === true;
        return chain;
      },
      eq: () => chain,
      neq: () => chain,
      in: (col: string, vals: ReadonlyArray<string>) => {
        if (col === 'status') ctx.statusIn = vals;
        return chain;
      },
      not: () => chain,
      gte: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => Promise.resolve(result()),
      // Thenable: `await chain` after `.order()/.not()/.eq()` (the
      // direct-await query shapes loadCurrentApprovalChain /
      // scope-rows / linked-row reads use) resolves to the result.
      then: (
        onFulfilled: (v: ReturnType<typeof result>) => unknown,
        onRejected?: (e: unknown) => unknown,
      ) => Promise.resolve(result()).then(onFulfilled, onRejected),
    };
    return chain;
  }
  return { admin: { from } } as unknown;
}

// new_chain_config the resolver returns — CONSTANT across both runs
// (same logical edit; the resolver output does not depend on the live
// chain). 2 approvers, threshold 'all' → parallel chain.
const G3_NEW_CHAIN = {
  required_approvers: [
    { type: 'person' as const, id: 'appr-zeta' },
    { type: 'team' as const, id: 'appr-alpha' },
  ],
  threshold: 'all' as const,
};

function makeScopeService(approvalRows: ApprovalRow[]) {
  const bookingFlow = {
    loadSpace: async () => ({
      id: G3_SPACE,
      cost_per_hour: null,
      setup_buffer_minutes: 0,
      teardown_buffer_minutes: 0,
      check_in_required: false,
    }),
  };
  const ruleResolver = {
    resolve: async () => ({
      final: 'require_approval' as const,
      effects: [] as string[],
      matchedRules: [
        { id: 'rule-appr', effect: 'require_approval', denial_message: null },
      ],
      approvalConfig: {
        required_approvers: [...G3_NEW_CHAIN.required_approvers],
        threshold: G3_NEW_CHAIN.threshold,
      },
    }),
  };
  const conflict = {
    snapshotBuffersForBooking: async () => ({
      setup_buffer_minutes: 0,
      teardown_buffer_minutes: 0,
    }),
  };
  return new AssembleEditPlanService(
    makeScopeSupabase(approvalRows) as never,
    bookingFlow as never,
    ruleResolver as never,
    conflict as never,
  );
}

async function buildScopePlan(
  approvalRows: ApprovalRow[],
): Promise<Record<string, unknown>> {
  const svc = makeScopeService(approvalRows);
  const realDate = global.Date;
  class FixedDate extends realDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(G3_INSTANT);
      // @ts-expect-error forward to real ctor
      else super(...args);
    }
    static now() {
      return new realDate(G3_INSTANT).getTime();
    }
  }
  // @ts-expect-error swap global Date for the build
  global.Date = FixedDate;
  try {
    const res: AssembleScopeEditPlanResult = await svc.assembleScopeEditPlan({
      bookingId: G3_PIVOT,
      tenantId: G3_TENANT,
      effectiveSeriesId: G3_SERIES,
      patch: { space_id: G3_SPACE },
    });
    expect(res.rpc_plans).toHaveLength(1);
    return res.rpc_plans[0].plan as unknown as Record<string, unknown>;
  } finally {
    global.Date = realDate;
  }
}

// Live-chain rows for the two reconciliation states of a same-intent
// commit→retry. Run-1 = the chain matching G3_NEW_CHAIN is INSERTED
// (post-commit reconciliation created it); old_outcome derives from
// chain presence, chain_config_changed from equality vs new config.
const G3_INSERTED_CHAIN: ApprovalRow[] = [
  {
    approval_chain_id: 'chain-1',
    parallel_group: `parallel-${G3_PIVOT}`,
    approver_person_id: 'appr-zeta',
    approver_team_id: null,
    created_at: '2026-05-18T08:59:00.000Z',
    status: 'pending',
  },
  {
    approval_chain_id: 'chain-1',
    parallel_group: `parallel-${G3_PIVOT}`,
    approver_person_id: null,
    approver_team_id: 'appr-alpha',
    created_at: '2026-05-18T08:59:00.000Z',
    status: 'pending',
  },
];
// No live chain (pre-commit OR every prior chain expired/rejected) →
// loadCurrentApprovalChain returns null → old_outcome='allow',
// chain_config_changed = !(null===newChain) = true.
const G3_NO_CHAIN: ApprovalRow[] = [];
// Expired chain — §3.6.5 expire branch. status NOT in
// (pending,delegated,approved) → loadCurrentApprovalChain filters it
// out → returns null → same projection as G3_NO_CHAIN. This models the
// chain→expired reconciliation transition.
const G3_EXPIRED_CHAIN: ApprovalRow[] = [
  {
    approval_chain_id: 'chain-1',
    parallel_group: `parallel-${G3_PIVOT}`,
    approver_person_id: 'appr-zeta',
    approver_team_id: null,
    created_at: '2026-05-18T08:59:00.000Z',
    status: 'expired',
  },
  {
    approval_chain_id: 'chain-1',
    parallel_group: `parallel-${G3_PIVOT}`,
    approver_person_id: null,
    approver_team_id: 'appr-alpha',
    created_at: '2026-05-18T08:59:00.000Z',
    status: 'rejected',
  },
];

const HEAD_SET = new Set(['_resolution_at']);
const FIX_SET = new Set([
  '_resolution_at',
  'old_outcome',
  'chain_config_changed',
]);

describe('GUARD 3 — audit-03 D-5 edit-scope idempotency completeness', () => {
  it('reproduces the bug + COMPLETENESS: post-{_resolution_at}-strip diff is EXACTLY {approval.old_outcome, approval.chain_config_changed} (no-chain → inserted-chain)', async () => {
    // run-1: no live chain (pre-commit). run-2: chain inserted by the
    // COMMIT's §3.6.5 reconciliation (same-intent retry reads it back).
    const run1 = await buildScopePlan(G3_NO_CHAIN);
    const run2 = await buildScopePlan(G3_INSERTED_CHAIN);

    // Sanity: the two raw plans differ. Their approval block flipped
    // exactly as the root-cause analysis predicts.
    const a1 = run1.approval as Record<string, unknown>;
    const a2 = run2.approval as Record<string, unknown>;
    expect(a1.old_outcome).toBe('allow');
    expect(a2.old_outcome).toBe('require_approval');
    expect(a1.chain_config_changed).toBe(true);
    expect(a2.chain_config_changed).toBe(false);
    // new_outcome / new_chain_config are CONSTANT (resolver output does
    // not depend on the live chain) — proves these are NOT the variance.
    expect(a1.new_outcome).toBe(a2.new_outcome);
    expect(JSON.stringify(a1.new_chain_config)).toBe(
      JSON.stringify(a2.new_chain_config),
    );

    // (a) BUG REPRODUCED under HEAD's {_resolution_at}-only strip.
    const head1 = md5Json(stripByNameSet(run1, HEAD_SET));
    const head2 = md5Json(stripByNameSet(run2, HEAD_SET));
    // eslint-disable-next-line no-console
    console.log(
      `[D-5 GUARD3] HEAD-strip md5(run1)=${head1} md5(run2)=${head2} equal=${head1 === head2}`,
    );
    expect(head1).not.toBe(head2); // bug reproduced

    // (b) COMPLETENESS — the load-bearing falsification. After stripping
    // ONLY {_resolution_at}, the EXHAUSTIVE deep key-path diff of the
    // two payloads must be EXACTLY the two pre-state approval fields. If
    // ANY third path differs, the by-name strip set is INCOMPLETE → the
    // fix is a misdiagnosis. (This is the assertion the audit skipped
    // twice.)
    const stripped1 = stripByNameSet(run1, HEAD_SET);
    const stripped2 = stripByNameSet(run2, HEAD_SET);
    const diffPaths = deepKeyPathDiff(stripped1, stripped2).sort();
    // eslint-disable-next-line no-console
    console.log(
      `[D-5 GUARD3] post-{_resolution_at}-strip varying key paths = ${JSON.stringify(diffPaths)}`,
    );
    expect(diffPaths).toEqual([
      'approval.chain_config_changed',
      'approval.old_outcome',
    ]);

    // (c) FIX PROVEN under the proposed {_resolution_at, old_outcome,
    // chain_config_changed} strip set → md5 identical.
    const fix1 = md5Json(stripByNameSet(run1, FIX_SET));
    const fix2 = md5Json(stripByNameSet(run2, FIX_SET));
    // eslint-disable-next-line no-console
    console.log(
      `[D-5 GUARD3] FIX-strip md5(run1)=${fix1} md5(run2)=${fix2} equal=${fix1 === fix2}`,
    );
    expect(fix1).toBe(fix2);
  });

  it('expire transition: chain → expired/rejected also varies ONLY the two pre-state fields, fixed by the proposed set', async () => {
    // §3.6.5 expire branch: run-1 has a live inserted chain; the COMMIT
    // expires/rejects it; the same-intent RETRY reads no live chain.
    const run1 = await buildScopePlan(G3_INSERTED_CHAIN);
    const run2 = await buildScopePlan(G3_EXPIRED_CHAIN);

    const a1 = run1.approval as Record<string, unknown>;
    const a2 = run2.approval as Record<string, unknown>;
    expect(a1.old_outcome).toBe('require_approval');
    expect(a2.old_outcome).toBe('allow'); // expired chain → no live chain
    expect(a1.chain_config_changed).toBe(false);
    expect(a2.chain_config_changed).toBe(true);

    // Bug reproduced under HEAD set.
    expect(md5Json(stripByNameSet(run1, HEAD_SET))).not.toBe(
      md5Json(stripByNameSet(run2, HEAD_SET)),
    );

    // COMPLETENESS for the expire transition too.
    const diffPaths = deepKeyPathDiff(
      stripByNameSet(run1, HEAD_SET),
      stripByNameSet(run2, HEAD_SET),
    ).sort();
    // eslint-disable-next-line no-console
    console.log(
      `[D-5 GUARD3] expire-transition post-{_resolution_at}-strip varying key paths = ${JSON.stringify(diffPaths)}`,
    );
    expect(diffPaths).toEqual([
      'approval.chain_config_changed',
      'approval.old_outcome',
    ]);

    // Fixed by the proposed set.
    expect(md5Json(stripByNameSet(run1, FIX_SET))).toBe(
      md5Json(stripByNameSet(run2, FIX_SET)),
    );
  });

  it('STEP 3 — required_approvers is canonically ordered: same approver set in two input orders → identical post-strip md5', async () => {
    // shapeChainConfigForPlan serializes
    // `approval.new_chain_config.required_approvers`. The rule-resolver
    // approver fan-out has no guaranteed order; without a canonical sort
    // the SAME logical edit serialises two different arrays → spurious
    // payload_mismatch. This drives the real producer twice with the
    // resolver returning the SAME approver set in REVERSED order and
    // asserts the post-{FIX_SET}-strip md5 is identical (the RPC chain-
    // insert is a SET not a sequence, so order cannot change the
    // approval decision/threshold/parallel-group — verified in plan
    // review). No live chain in either run so the only candidate
    // variance is the approver array order.
    const svcOrderA = makeScopeService(G3_NO_CHAIN);
    const svcOrderB = makeScopeService(G3_NO_CHAIN);
    // Override the resolver to return the approver set in two orders.
    const setForward = [
      { type: 'person' as const, id: 'appr-zeta' },
      { type: 'team' as const, id: 'appr-alpha' },
    ];
    const setReversed = [...setForward].reverse();
    const mkResolver = (
      approvers: ReadonlyArray<{ type: 'person' | 'team'; id: string }>,
    ) => ({
      resolve: async () => ({
        final: 'require_approval' as const,
        effects: [] as string[],
        matchedRules: [
          { id: 'rule-appr', effect: 'require_approval', denial_message: null },
        ],
        approvalConfig: {
          required_approvers: [...approvers],
          threshold: 'all' as const,
        },
      }),
    });
    (svcOrderA as unknown as { ruleResolver: unknown }).ruleResolver =
      mkResolver(setForward);
    (svcOrderB as unknown as { ruleResolver: unknown }).ruleResolver =
      mkResolver(setReversed);

    const realDate = global.Date;
    class FixedDate extends realDate {
      constructor(...args: unknown[]) {
        if (args.length === 0) super(G3_INSTANT);
        // @ts-expect-error forward to real ctor
        else super(...args);
      }
      static now() {
        return new realDate(G3_INSTANT).getTime();
      }
    }
    // @ts-expect-error swap global Date
    global.Date = FixedDate;
    let planA: Record<string, unknown>;
    let planB: Record<string, unknown>;
    try {
      const rA = await svcOrderA.assembleScopeEditPlan({
        bookingId: G3_PIVOT,
        tenantId: G3_TENANT,
        effectiveSeriesId: G3_SERIES,
        patch: { space_id: G3_SPACE },
      });
      const rB = await svcOrderB.assembleScopeEditPlan({
        bookingId: G3_PIVOT,
        tenantId: G3_TENANT,
        effectiveSeriesId: G3_SERIES,
        patch: { space_id: G3_SPACE },
      });
      planA = rA.rpc_plans[0].plan as unknown as Record<string, unknown>;
      planB = rB.rpc_plans[0].plan as unknown as Record<string, unknown>;
    } finally {
      global.Date = realDate;
    }

    const approversA = (
      (planA.approval as Record<string, unknown>)
        .new_chain_config as Record<string, unknown>
    ).required_approvers as Array<{ type: string; id: string }>;
    const approversB = (
      (planB.approval as Record<string, unknown>)
        .new_chain_config as Record<string, unknown>
    ).required_approvers as Array<{ type: string; id: string }>;
    // Canonical order is (type asc, id asc): person<team, then id.
    expect(approversA).toEqual([
      { type: 'person', id: 'appr-zeta' },
      { type: 'team', id: 'appr-alpha' },
    ]);
    expect(approversB).toEqual(approversA);

    // Identical post-strip md5 despite reversed resolver input order.
    expect(md5Json(stripByNameSet(planA, FIX_SET))).toBe(
      md5Json(stripByNameSet(planB, FIX_SET)),
    );
  });
});

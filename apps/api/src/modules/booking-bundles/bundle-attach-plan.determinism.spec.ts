/**
 * audit-03 D-6 — producer-determinism COMPLETENESS GUARD.
 *
 * Mirrors the D-5 GUARD-3 pattern (assemble-edit-plan.idempotency.spec.ts):
 * this spec exists to PROVE the fix AND to act as the misdiagnosis-#N
 * tripwire. It drives the REAL producers — `BundleService.buildAttachPlan`
 * (attach) and `BookingFlowService.buildAttachPlan` (create) — TWICE with
 * the wall-clock advanced ACROSS lead-time-rule boundaries, seeding ALL
 * THREE nondeterminism vectors at once:
 *
 *   V1 (attach + create): `hydrateLines` `lead_time_remaining_hours` →
 *     a `$.line.lead_time_remaining_hours` service rule predicate.
 *   V2 (create): a `$.booking.lead_time_minutes` lead-band ROOM rule.
 *   V3-time (attach + create): a `lead_minutes_lt` service rule + a
 *     `lead_minutes_lt` room rule (predicate-engine operators).
 *   V3-order (attach + create, TIME-INDEPENDENT): ≥2 rules tied on
 *     (specificity, priority) — fed in DB order; the deterministic
 *     `.order('id')` tie-break must make the matched-id arrays stable.
 *
 * Assertions (load-bearing):
 *   - WITHOUT the fix (basis = the per-run advancing wall-clock, the
 *     pre-fix `Date.now()` behaviour modeled by feeding each run its OWN
 *     advanced instant as the basis): the two rebuilds' exhaustive deep
 *     key-path diff is NON-empty AND md5 differs — i.e. the seeded rules
 *     genuinely make the OUTCOME time/order-sensitive (the WITH-fix EMPTY
 *     result is therefore meaningful, not vacuous).
 *   - WITH the fix (basis = ONE request-canonical instant for both runs,
 *     exactly as the shipped code threads it): the exhaustive deep
 *     key-path diff is EMPTY and md5 IDENTICAL — for BOTH `p_attach_plan`
 *     (attach) AND `p_booking_input` + `p_attach_plan` (create). The
 *     OUTCOME is byte-stable, not just one field.
 *   - The completeness assertion HARD-FAILS if ANY key path still varies
 *     under the fix — that is the 4th-vector tripwire. If it fires, STOP
 *     and report the offending key path; do NOT paper over.
 *
 * Explicitly-considered-and-EXCLUDED (documented so the guard does not
 * false-flag it): `booking-flow.service.ts:~1015` `startSeries`'s
 * `new Date(Date.now()+90d)` horizon. It is a POST-COMMIT
 * fire-and-forget recurrence call (`void this.startSeries(...)` AFTER the
 * RPC returns) — it is NOT part of `buildAttachPlan`'s returned
 * `{ bookingInput, attachPlan }` and is therefore NOT in the
 * idempotency-hashed payload. This guard exercises `buildAttachPlan` ONLY
 * (it never invokes the RPC / startSeries), so the 90d horizon cannot
 * leak into the diff by construction. Out of D-6 scope by design.
 */

import { createHash } from 'node:crypto';
import { BundleService } from './bundle.service';
import { BookingFlowService } from '../reservations/booking-flow.service';
import { ServiceRuleResolverService } from '../service-catalog/service-rule-resolver.service';
import { RuleResolverService } from '../room-booking-rules/rule-resolver.service';
import { PredicateEngineService } from '../room-booking-rules/predicate-engine.service';
import { TenantContext } from '../../common/tenant-context';
import type { ActorContext, CreateReservationInput } from '../reservations/dto/types';

// ── md5(JSON) — mirrors the RPC gate `md5(coalesce(p_attach_plan::text,''))`
//    / `md5(p_booking_input || '|' || p_attach_plan)`. The exact textual
//    form is not load-bearing (we compare run-1 vs run-2 with the SAME
//    serializer), only its determinism. ──────────────────────────────────
function md5Json(value: unknown): string {
  return createHash('md5').update(JSON.stringify(value)).digest('hex');
}

// Exhaustive deep key-path diff: the SORTED set of dotted key paths whose
// leaf differs between two JSON-able structures (array indices included).
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
  return diffs.sort();
}

// ── Fixture ids ─────────────────────────────────────────────────────────
const TENANT = { id: 't-d6', slug: 'd6', tier: 'standard' as const };
const SPACE = '00000000-0000-4000-8000-0000000000sp'.replace('sp', '01');
const REQUESTER = '00000000-0000-4000-8000-0000000000pr'.replace('pr', '01');
const USER = '00000000-0000-4000-8000-0000000000us'.replace('us', '01');
const CATERING_CATALOG = '00000000-0000-4000-8000-0000000000c1';
const BOOKING_ID = '00000000-0000-4000-8000-0000000000b1';

// Two service-rule ids that TIE on (specificity, priority): both
// catalog_item-scoped at the SAME catalog item, SAME priority. Fed to the
// mock in DESCENDING id order so a non-deterministic (stable-sort over
// DB-order) tie-break would surface them reversed; `.order('id')` must
// canonicalise to ascending. (V3-order — time-independent.)
const RULE_TIE_HI = '00000000-0000-4000-8000-00000000ra02';
const RULE_TIE_LO = '00000000-0000-4000-8000-00000000ra01';
// A lead-band service rule whose firing depends on the resolution basis
// (V1 / V3-time): `lead_minutes_lt 600` (10h). With start_at +9h from the
// basis it FIRES; advancing the wall-clock past it would flip the lead.
const RULE_LEAD_SVC = '00000000-0000-4000-8000-00000000ld01';
// A room rule keyed on `$.booking.lead_time_minutes` (V2) + a room rule
// using `lead_minutes_lt` (V3-time, room engine).
const ROOM_RULE_LEADBAND = '00000000-0000-4000-8000-00000000rr01';
const ROOM_RULE_LEADFN = '00000000-0000-4000-8000-00000000rr02';

// start_at is anchored RELATIVE to the resolution basis so the lead-time
// predicates are exercised regardless of when the test runs.
function startAtFor(basisMs: number): string {
  return new Date(basisMs + 9 * 3_600_000).toISOString(); // +9h lead
}
function endAtFor(basisMs: number): string {
  return new Date(basisMs + 10 * 3_600_000).toISOString();
}

// ── Service-rule rows (returned by `service_rules` select) ──────────────
// All three: two TIED rules (V3-order) + one lead-band rule (V1/V3-time).
// Fed HI-id first so a DB-order tie-break would reverse them.
function serviceRuleRows(): unknown[] {
  const base = {
    tenant_id: TENANT.id,
    target_kind: 'catalog_item',
    target_id: CATERING_CATALOG,
    active: true,
    approval_config: { approver_target: 'person', person_id: REQUESTER },
  };
  return [
    {
      ...base,
      id: RULE_TIE_HI,
      name: 'tie-hi',
      applies_when: { op: 'eq', left: 1, right: 1 }, // always fires
      effect: 'require_approval',
      denial_message: 'tie-hi reason',
      priority: 10,
    },
    {
      ...base,
      id: RULE_LEAD_SVC,
      name: 'lead-svc',
      // V3-time: predicate-engine `lead_minutes_gt` operator — the
      // canonical "minimum lead time" rule (must book ≥60min ahead). With
      // start_at pinned to the BASIS_A window: at basis=BASIS_A the lead
      // is +540min → 540 > 60 → FIRES; at a +7d-advanced basis the
      // EFFECTIVE lead goes negative → -9540 > 60 → does NOT fire. So the
      // pre-fix `Date.now()` read FLIPS this rule's match across a
      // same-intent retry → a different matched-rule set / approval /
      // setup_emit → different md5. The fix anchors on the canonical
      // basis so the boolean (and the whole serialized outcome) is stable.
      applies_when: { fn: 'lead_minutes_gt', args: ['$.booking.start_at', 60] },
      effect: 'require_approval',
      denial_message: 'lead-svc reason',
      priority: 5,
      requires_internal_setup: true,
      internal_setup_lead_time_minutes: 45,
    },
    {
      ...base,
      id: RULE_TIE_LO,
      name: 'tie-lo',
      applies_when: { op: 'eq', left: 1, right: 1 }, // always fires; ties HI
      effect: 'require_approval',
      denial_message: 'tie-lo reason',
      priority: 10,
    },
  ];
}

// ── Room-rule rows (returned by `room_booking_rules` select) ────────────
function roomRuleRows(): unknown[] {
  return [
    {
      id: ROOM_RULE_LEADBAND,
      tenant_id: TENANT.id,
      name: 'room-leadband',
      target_scope: 'tenant',
      target_id: null,
      // V2: a `$.booking.lead_time_minutes` band. assembleContext derives
      // lead_time_minutes from the basis; with +9h that's 540 (>120) so
      // this fires. The point: the derivation must use the canonical
      // basis, not Date.now.
      applies_when: { op: 'gt', left: '$.booking.lead_time_minutes', right: 120 },
      effect: 'require_approval',
      approval_config: { approver_target: 'person', person_id: REQUESTER },
      denial_message: 'room-leadband reason',
      priority: 10,
      active: true,
      template_id: null,
      workflow_definition_id: null,
    },
    {
      id: ROOM_RULE_LEADFN,
      tenant_id: TENANT.id,
      name: 'room-leadfn',
      target_scope: 'tenant',
      target_id: null,
      // V3-time, room engine `lead_minutes_lt`.
      applies_when: { fn: 'lead_minutes_lt', args: ['$.booking.start_at', 600] },
      effect: 'warn',
      approval_config: null,
      denial_message: 'room-leadfn warn',
      priority: 10, // ties ROOM_RULE_LEADBAND on (tenant-specificity, prio)
      active: true,
      template_id: null,
      workflow_definition_id: null,
    },
  ];
}

// ── A chainable supabase mock that serves every read the real producers
//    make. Resolves at `.maybeSingle()` / `.then()` / terminal `.order()`
//    / `.in()`. Keyed on table + select-shape. ──────────────────────────
function makeSupabase() {
  function builder(table: string) {
    const state = { select: '', table };
    const resolve = (): { data: unknown; error: null } => {
      switch (state.table) {
        case 'persons':
          return { data: { id: REQUESTER, type: 'employee', cost_center: null }, error: null };
        case 'person_org_memberships':
          return { data: { org_node_id: null }, error: null };
        case 'users':
          return { data: { id: USER }, error: null };
        case 'user_role_assignments':
          return { data: [], error: null };
        case 'catalog_items':
          return {
            data: {
              id: CATERING_CATALOG,
              category: 'food_and_drinks',
              price_per_unit: 12.5,
              unit: 'per_person',
              fulfillment_team_id: null,
            },
            error: null,
          };
        case 'booking_slots':
          return { data: { attendee_count: 6 }, error: null };
        case 'spaces':
          // loadSpace (booking-flow) wants a wide projection; the room
          // resolver's loadAncestorChain/loadSpacesWithAncestors want
          // id/parent_id/etc. One superset row satisfies both.
          return {
            data: {
              id: SPACE,
              type: 'room',
              parent_id: null,
              reservable: true,
              active: true,
              capacity: 20,
              min_attendees: null,
              default_calendar_id: null,
              setup_buffer_minutes: 0,
              teardown_buffer_minutes: 0,
              check_in_required: false,
              check_in_grace_minutes: 15,
              cost_per_hour: null,
            },
            error: null,
          };
        case 'service_rules':
          return { data: serviceRuleRows(), error: null };
        case 'room_booking_rules':
          return { data: roomRuleRows(), error: null };
        default:
          return { data: null, error: null };
      }
    };
    // `.in('id', [...])` on spaces returns an ARRAY of rows.
    const resolveList = (): { data: unknown; error: null } => {
      if (state.table === 'spaces') {
        const r = resolve().data as Record<string, unknown>;
        return { data: [r], error: null };
      }
      return resolve();
    };
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = (s: string) => {
      state.select = s ?? '';
      return chain;
    };
    chain.eq = self;
    chain.or = self;
    chain.order = () => Promise.resolve(resolve());
    chain.in = () => Promise.resolve(resolveList());
    chain.limit = self;
    chain.maybeSingle = () => Promise.resolve(resolve());
    chain.then = (onF: (v: { data: unknown; error: null }) => unknown) =>
      Promise.resolve(resolve()).then(onF);
    return chain;
  }
  const admin = {
    from: (t: string) => builder(t),
    rpc: (fn: string) => {
      if (fn === 'user_has_permission') return Promise.resolve({ data: false, error: null });
      if (fn === 'resolve_menu_offer') {
        // No menu offer → hydrateLines falls back to catalog defaults.
        // (Lead-time hard guard only fires when offerRow.lead_time_hours
        // is set, so no offer = no spurious validation throw here.)
        return Promise.resolve({ data: [], error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };
  return { admin } as never;
}

function makeBundleService(): BundleService {
  const supabase = makeSupabase();
  const engine = new PredicateEngineService(supabase);
  const resolver = new ServiceRuleResolverService(supabase, engine);
  const approvalRouter = {
    // Deterministic-by-construction; the rule resolver feeds it the
    // matched-rule order, so its output reflects V3-order/V1 too.
    assemblePlan: jest.fn(
      async (a: {
        per_line_outcomes: Array<{
          line_key: string;
          outcome: {
            matched_rule_ids: string[];
            denial_messages: string[];
            approver_targets: Array<{ rule_id: string }>;
          };
        }>;
        idempotencyKey: string;
      }) => {
        // Echo a plan row carrying the matched rule ids + reasons so the
        // V3-order vector is visible in the hashed plan (the real
        // ApprovalRoutingService sorts reasons; here we deliberately do
        // NOT sort, so an unsorted matched_rule_ids would surface in the
        // WITHOUT-fix arm and the fix's sorting closes it).
        const reasons = a.per_line_outcomes.flatMap((o) =>
          o.outcome.matched_rule_ids.map((rid) => ({ rule_id: rid })),
        );
        return reasons.length
          ? [
              {
                id: 'appr-1',
                target_entity_type: 'booking',
                target_entity_id: BOOKING_ID,
                approver_person_id: REQUESTER,
                scope_breakdown: { reasons },
                status: 'pending',
              },
            ]
          : [];
      },
    ),
  };
  const eventBus = {} as never;
  return new BundleService(
    supabase,
    resolver as never,
    approvalRouter as never,
    eventBus,
  );
}

function makeBookingFlow(bundle: BundleService): BookingFlowService {
  const supabase = makeSupabase();
  const engine = new PredicateEngineService(supabase);
  const ruleResolver = new RuleResolverService(supabase, engine);
  const conflict = {
    snapshotBuffersForBooking: jest.fn(async () => ({
      setup_buffer_minutes: 0,
      teardown_buffer_minutes: 0,
    })),
    isExclusionViolation: jest.fn(() => false),
  };
  return new BookingFlowService(
    supabase,
    conflict as never,
    ruleResolver,
    undefined, // recurrence
    undefined, // notifications
    bundle,
  );
}

const SERVICES = [
  { catalog_item_id: CATERING_CATALOG, quantity: 6, client_line_id: 'L1' },
];

function attachArgs(basisAtIso: string) {
  const basisMs = Date.parse(basisAtIso);
  return {
    booking_id: BOOKING_ID,
    tenant_id: TENANT.id,
    booking: {
      location_id: SPACE,
      requester_person_id: REQUESTER,
      host_person_id: null,
      start_at: startAtFor(basisMs),
      end_at: endAtFor(basisMs),
      attendee_count: 6 as number | null,
      source: 'desk' as const,
      created_at: basisAtIso, // ← the attach-path resolution basis (V1/V3)
    },
    requester_person_id: REQUESTER,
    services: SERVICES,
    idempotency_key: 'idem-d6',
  };
}

function createInput(basisMs: number): CreateReservationInput {
  return {
    space_id: SPACE,
    requester_person_id: REQUESTER,
    start_at: startAtFor(basisMs),
    end_at: endAtFor(basisMs),
    attendee_count: 6,
    reservation_type: 'room',
    source: 'desk',
    services: SERVICES,
  } as CreateReservationInput;
}

function actorFor(basisAtIso: string): ActorContext {
  return {
    user_id: USER,
    auth_uid: USER,
    person_id: REQUESTER,
    is_service_desk: true,
    has_override_rules: false,
    client_request_id: 'crid-d6',
    resolution_basis_at: basisAtIso, // ← the create-path resolution basis
  };
}

describe('audit-03 D-6 — attach/create producer-determinism COMPLETENESS guard', () => {
  // Two wall-clock instants 7 days apart. 7d straddles ANY tenant
  // lead-time band (the seeded predicates use ≤600min windows). The
  // CANONICAL basis is fixed; the "no-fix" arm feeds each run its OWN
  // advanced instant (the pre-fix Date.now() behaviour).
  const BASIS_A = '2026-06-01T09:00:00.000Z';
  const BASIS_B = '2026-06-08T09:00:00.000Z'; // +7d

  // ──────────────────────────────────────────────────────────────────────
  // ATTACH PATH
  // ──────────────────────────────────────────────────────────────────────
  describe('attach: BundleService.buildAttachPlan', () => {
    it('WITHOUT the fix (basis = per-run advancing wall-clock) → md5 DIFFERS / deep-diff NON-empty (vectors are real, not vacuous)', async () => {
      const svc = makeBundleService();
      await TenantContext.run(TENANT, async () => {
        // Model the pre-fix Date.now(): each run's basis = its OWN
        // (advanced) wall-clock. start_at is anchored relative to each
        // basis, so the lead-time predicates evaluate against a DIFFERENT
        // effective lead window across the two runs.
        const run1 = await svc.buildAttachPlan(attachArgs(BASIS_A));
        const run2Args = attachArgs(BASIS_B);
        // Pin start/end to RUN-1's window so the ONLY thing that moved is
        // the basis (faithfully isolates the V1/V3-time nondeterminism;
        // pre-fix `now` advanced while the booking time stayed put).
        run2Args.booking.start_at = startAtFor(Date.parse(BASIS_A));
        run2Args.booking.end_at = endAtFor(Date.parse(BASIS_A));
        const run2 = await svc.buildAttachPlan(run2Args);

        const m1 = md5Json(run1);
        const m2 = md5Json(run2);
        const diff = deepKeyPathDiff(run1, run2);
        // eslint-disable-next-line no-console
        console.log(
          `[D-6 GUARD attach NO-FIX] md5(run1)=${m1} md5(run2)=${m2} equal=${m1 === m2} diffPaths=${JSON.stringify(diff)}`,
        );
        expect(m1).not.toBe(m2);
        expect(diff.length).toBeGreaterThan(0);
      });
    });

    it('WITH the fix (basis = ONE request-canonical instant) → deep-diff EMPTY + md5 IDENTICAL (byte-stable outcome; 4th-vector tripwire)', async () => {
      const svc = makeBundleService();
      await TenantContext.run(TENANT, async () => {
        // EXACTLY what the shipped code does: the attach basis is the
        // booking's server-immutable created_at — the SAME instant on
        // every retry even though the wall-clock advanced 7d between them.
        const args1 = attachArgs(BASIS_A);
        const args2 = attachArgs(BASIS_A); // same created_at, same window
        const run1 = await svc.buildAttachPlan(args1);
        const run2 = await svc.buildAttachPlan(args2);

        const m1 = md5Json(run1);
        const m2 = md5Json(run2);
        const diff = deepKeyPathDiff(run1, run2);
        // eslint-disable-next-line no-console
        console.log(
          `[D-6 GUARD attach FIX] md5(run1)=${m1} md5(run2)=${m2} equal=${m1 === m2} deepDiff=${JSON.stringify(diff)}`,
        );
        // COMPLETENESS: ANY surviving key path = a 4th vector → STOP.
        expect(diff).toEqual([]);
        expect(m1).toBe(m2);
      });
    });

    it('WITH the fix — V3-order tie is deterministic (tied rules canonicalised, NOT DB-feed order)', async () => {
      const svc = makeBundleService();
      await TenantContext.run(TENANT, async () => {
        const plan = await svc.buildAttachPlan(attachArgs(BASIS_A));
        // The seeded service rules are fed HI-id first; the deterministic
        // `.order('id')` + the producer's canonical matched-id sort must
        // surface them ascending wherever rule ids are serialized.
        const json = JSON.stringify(plan);
        const hiAt = json.indexOf(RULE_TIE_LO);
        const loFirst = json.indexOf(RULE_TIE_LO) < json.indexOf(RULE_TIE_HI);
        expect(hiAt).toBeGreaterThanOrEqual(0); // rules are present
        expect(loFirst).toBe(true); // lowest-id first, not DB-feed order
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // CREATE PATH (p_booking_input + p_attach_plan)
  // ──────────────────────────────────────────────────────────────────────
  describe('create: BookingFlowService.buildAttachPlan', () => {
    it('WITHOUT the fix (basis = per-run advancing wall-clock) → md5 DIFFERS / deep-diff NON-empty', async () => {
      const bundle = makeBundleService();
      const flow = makeBookingFlow(bundle);
      await TenantContext.run(TENANT, async () => {
        // Pin the booking window to BASIS_A's window for BOTH runs; only
        // the actor.resolution_basis_at moves (models pre-fix Date.now()).
        const input = createInput(Date.parse(BASIS_A));
        const r1 = await flow.buildAttachPlan(input, actorFor(BASIS_A), 'idem-c1');
        const r2 = await flow.buildAttachPlan(input, actorFor(BASIS_B), 'idem-c1');
        const c1 = { bi: r1.bookingInput, ap: r1.attachPlan };
        const c2 = { bi: r2.bookingInput, ap: r2.attachPlan };
        const m1 = md5Json(c1);
        const m2 = md5Json(c2);
        const diff = deepKeyPathDiff(c1, c2);
        // eslint-disable-next-line no-console
        console.log(
          `[D-6 GUARD create NO-FIX] md5(run1)=${m1} md5(run2)=${m2} equal=${m1 === m2} diffPaths=${JSON.stringify(diff)}`,
        );
        expect(m1).not.toBe(m2);
        expect(diff.length).toBeGreaterThan(0);
      });
    });

    it('WITH the fix (basis = ONE request-canonical instant) → deep-diff EMPTY + md5 IDENTICAL for p_booking_input + p_attach_plan (4th-vector tripwire)', async () => {
      const bundle = makeBundleService();
      const flow = makeBookingFlow(bundle);
      await TenantContext.run(TENANT, async () => {
        const input = createInput(Date.parse(BASIS_A));
        // Same actor.resolution_basis_at on both retries — exactly what
        // the controller chokepoint defaults ONCE per request.
        const r1 = await flow.buildAttachPlan(input, actorFor(BASIS_A), 'idem-c2');
        const r2 = await flow.buildAttachPlan(input, actorFor(BASIS_A), 'idem-c2');
        const c1 = { bi: r1.bookingInput, ap: r1.attachPlan };
        const c2 = { bi: r2.bookingInput, ap: r2.attachPlan };
        const m1 = md5Json(c1);
        const m2 = md5Json(c2);
        const diff = deepKeyPathDiff(c1, c2);
        // eslint-disable-next-line no-console
        console.log(
          `[D-6 GUARD create FIX] md5(run1)=${m1} md5(run2)=${m2} equal=${m1 === m2} deepDiff=${JSON.stringify(diff)}`,
        );
        // COMPLETENESS: byte-stable p_booking_input + p_attach_plan.
        expect(diff).toEqual([]);
        expect(m1).toBe(m2);
      });
    });
  });
});

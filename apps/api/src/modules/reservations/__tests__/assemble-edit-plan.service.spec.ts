/**
 * Unit tests for `../assemble-edit-plan.service` (B.4 step 2D-C).
 *
 * Coverage (mocked deps):
 *   1. Geometry-only patch (same room, time tweak) — no rule outcome change,
 *      chain_config_changed=false, single slot patch.
 *   2. Location change with allow→require_approval — new chain inserted,
 *      chain_config_changed=true. Asserts loadSpace called with target room
 *      (N-CODE-2).
 *   3. Location change preserving same chain — chain_config_changed=false.
 *   4. Location change with different chain config — chain_config_changed=true.
 *   5. Deny outcome — helper still builds plan; RPC will reject (the helper
 *      does NOT pre-empt deny — that's the RPC's Row 10).
 *   6. Missing booking → throws AppError (edit_booking.not_found, 404).
 *   7. Slot belongs to a different booking → throws AppError 404 (no leak).
 *   8. Cost recompute when target room has cost_per_hour.
 *   9. Cross-tenant slot path — slot returned for a different tenant id is
 *      filtered to null at the tenant_id eq layer (I-CODE-5).
 *  10. PLAN-C1 fail-fast: require_approval with approvalConfig=null → 422
 *      `edit_booking.rule_missing_approvers`.
 *  11. PLAN-C1 fail-fast: require_approval with required_approvers=[] → 422
 *      `edit_booking.rule_missing_approvers`.
 *  12. I-PLAN-3 dispatch: kind='one' / kind='scope' → 400
 *      `edit_booking.invalid_plan_shape` (not yet implemented).
 *  13. N-CODE-7: applied_rule_ids returned in lexicographic order.
 *  14. I-CODE-4 — supabase mock honours the (table, eq) predicates so a
 *      cross-tenant smuggle returns null at the .eq('tenant_id', ...) layer.
 *  15. N-CODE-5: ruleResolver.resolve called EXACTLY ONCE (the dead OLD
 *      call has been removed).
 */

import { AppError } from '../../../common/errors';
import { TenantContext } from '../../../common/tenant-context';
import {
  AssembleEditPlanService,
  type AssembleEditPlanArgs,
  type AssembleEditPlanScopePatch,
  type AssembleEditPlanSlotPatch,
} from '../assemble-edit-plan.service';
import type { ResolveOutcome } from '../../room-booking-rules/rule-resolver.service';
import type { ApprovalConfig } from '../../room-booking-rules/dto';

const TENANT = 't1';
const OTHER_TENANT = 't2';
const BOOKING = '11111111-1111-4111-8111-111111111111';
const SLOT = '22222222-2222-4222-8222-222222222222';
const SPACE_OLD = '33333333-3333-4333-8333-333333333333';
const SPACE_NEW = '44444444-4444-4444-8444-444444444444';
const REQUESTER = '55555555-5555-4555-8555-555555555555';
const APPROVER_A = '66666666-6666-4666-8666-666666666666';
const APPROVER_B = '77777777-7777-4777-8777-777777777777';

interface BookingRow {
  id: string;
  tenant_id: string;
  requester_person_id: string;
  location_id: string;
  start_at: string;
  end_at: string;
  status: string;
  /** Step 2E — null on standalone bookings; UUID when part of a series.
   * The plan-builder reads this to decide whether to auto-set
   * booking_patch.recurrence_overridden on kind='one' edits. */
  recurrence_series_id: string | null;
}

interface SlotRow {
  id: string;
  booking_id: string;
  tenant_id: string;
  space_id: string;
  start_at: string;
  end_at: string;
  attendee_count: number | null;
  attendee_person_ids: string[];
}

interface ApprovalRow {
  approval_chain_id: string | null;
  parallel_group: string | null;
  approver_person_id: string | null;
  approver_team_id: string | null;
  created_at: string;
  status: string;
}

/**
 * Mock SupabaseService that routes from('<table>') to the right fixture.
 *
 * I-CODE-4 — tightened mocks: each .eq() captures (column, value) and the
 * final .maybeSingle() returns the fixture ONLY if every captured eq passes
 * a structural predicate. This catches "tenant_id mismatch let through"
 * regressions that the previous mock (which ignored eq args) silently
 * masked.
 *
 * Predicates used:
 *   - bookings: id===bookingId AND tenant_id===tenantId.
 *   - booking_slots: id===slotId AND tenant_id===tenantId.
 *   - approvals (list): tenant_id===tenantId AND target_entity_type===
 *     'booking' AND target_entity_id===bookingId AND status IN [live].
 */
function makeSupabase(opts: {
  booking: BookingRow | null;
  slot: SlotRow | null;
  approvals: ApprovalRow[];
  /** Caller's expected tenant for predicate-matching. Defaults to TENANT. */
  expectedTenant?: string;
  /** Caller's expected booking id. Defaults to BOOKING. */
  expectedBookingId?: string;
  /** Caller's expected slot id. Defaults to SLOT. */
  expectedSlotId?: string;
}) {
  const expectedTenant = opts.expectedTenant ?? TENANT;
  const expectedBookingId = opts.expectedBookingId ?? BOOKING;
  const expectedSlotId = opts.expectedSlotId ?? SLOT;

  const fromMock = jest.fn((table: string) => {
    if (table === 'bookings') {
      const filters: Record<string, unknown> = {};
      const eq = jest.fn((col: string, val: unknown) => {
        filters[col] = val;
        return chain;
      });
      const chain = {
        eq,
        maybeSingle: () => {
          // Tenant + id predicates must match the fixture's identity AND
          // the test's expected values.
          const matches =
            opts.booking !== null &&
            filters.tenant_id === expectedTenant &&
            filters.id === expectedBookingId &&
            opts.booking.tenant_id === expectedTenant &&
            opts.booking.id === expectedBookingId;
          return Promise.resolve({
            data: matches ? opts.booking : null,
            error: null,
          });
        },
      };
      return {
        select: jest.fn(() => chain),
        _filters: filters,
        _eq: eq,
      } as unknown as { select: jest.Mock };
    }
    if (table === 'booking_slots') {
      const filters: Record<string, unknown> = {};
      const eq = jest.fn((col: string, val: unknown) => {
        filters[col] = val;
        return chain;
      });
      const chain = {
        eq,
        maybeSingle: () => {
          const matches =
            opts.slot !== null &&
            filters.tenant_id === expectedTenant &&
            filters.id === expectedSlotId &&
            opts.slot.tenant_id === expectedTenant &&
            opts.slot.id === expectedSlotId;
          return Promise.resolve({
            data: matches ? opts.slot : null,
            error: null,
          });
        },
      };
      return {
        select: jest.fn(() => chain),
        _filters: filters,
        _eq: eq,
      } as unknown as { select: jest.Mock };
    }
    if (table === 'approvals') {
      // approvals: select → eq*3 → in → order*2 → await. Mirror the
      // helper's exact builder shape after CODE-C2 + I-CODE-1.
      // Codex 2026-05-12 NIT: tighten predicate honoring to match the
      // bookings + booking_slots mocks (which DO assert tenant_id +
      // identity). Capture eq filters; predicate-fail returns empty
      // array so a tenant_id mismatch correctly surfaces as no live
      // chain (= old_outcome 'allow' downstream).
      const filters: Record<string, unknown> = {};
      const builder: Record<string, jest.Mock> = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn((col: string, val: unknown) => {
          filters[col] = val;
          return builder as unknown;
        }) as unknown as jest.Mock,
        in: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
      };
      (builder as unknown as PromiseLike<unknown>).then = (
        resolve: (v: unknown) => unknown,
      ) => {
        const matches =
          filters.tenant_id === expectedTenant &&
          filters.target_entity_type === 'booking' &&
          filters.target_entity_id === expectedBookingId;
        return Promise.resolve(
          resolve({ data: matches ? opts.approvals : [], error: null }),
        );
      };
      return builder;
    }
    const linked = linkedRowTableMock(table);
    if (linked) return linked;
    throw new Error(`unexpected table: ${table}`);
  });

  return { admin: { from: fromMock } } as never;
}

/**
 * Shared no-op mock for the P0-2 `buildLinkedRowPatches` linked-table
 * reads (booking-audit remediation). Both `makeSupabase` factories
 * delegate here. Pre-fix the assembler hard-coded asset_reservation_
 * patches/order_patches/work_order_sla_patches to []; now it READS
 * those tables. These fixtures carry no linked rows, so returning an
 * empty data set keeps every pre-existing assertion green (the patch
 * arrays are still []) while letting the new code path run.
 *
 * The booking_slots COUNT read (select('id',{count:'exact',head:true})
 * .eq().eq(), awaited directly) is NOT handled here on purpose — the
 * existing booking_slots handler's chain has no `.then`, so awaiting
 * it resolves to the chain object and `.count` is undefined → the
 * helper's `?? 0` yields slotCount=0 (single-slot path), which is the
 * correct default for these single-slot fixtures.
 *
 * Query shape mirrored from assemble-edit-plan.service.ts:
 *   select(cols).eq().eq().not(col,'in',list)  → awaited → { data }
 */
function linkedRowTableMock(table: string) {
  if (
    table !== 'asset_reservations' &&
    table !== 'orders' &&
    table !== 'work_orders'
  ) {
    return null;
  }
  const chain: Record<string, unknown> = {
    eq: () => chain,
    not: () => Promise.resolve({ data: [], error: null }),
  };
  return { select: () => chain } as unknown as { select: jest.Mock };
}

function makeBookingFlow(spaceOverrides: {
  costPerHour?: string | null;
  setupBuffer?: number;
  teardownBuffer?: number;
} = {}) {
  return {
    loadSpace: jest.fn(async (spaceId: string) => ({
      id: spaceId,
      type: 'room',
      reservable: true,
      capacity: 8,
      setup_buffer_minutes: spaceOverrides.setupBuffer ?? 0,
      teardown_buffer_minutes: spaceOverrides.teardownBuffer ?? 0,
      check_in_required: false,
      check_in_grace_minutes: 15,
      cost_per_hour: spaceOverrides.costPerHour ?? null,
    })),
  } as never;
}

/**
 * N-CODE-5 — single resolver call. The OLD-state resolve was dead code
 * (the orchestrator derives `old_outcome` from chain presence, not a
 * fresh resolve). Test mocks now expose a single `resolve` that returns
 * the new outcome. Tests that want to assert call count read the spy.
 */
function makeRuleResolver(newOutcome: ResolveOutcome) {
  return {
    resolve: jest.fn(async () => newOutcome),
  } as never;
}

function makeConflict(buffers: { setup: number; teardown: number } = { setup: 0, teardown: 0 }) {
  return {
    snapshotBuffersForBooking: jest.fn(async () => ({
      setup_buffer_minutes: buffers.setup,
      teardown_buffer_minutes: buffers.teardown,
    })),
  } as never;
}

function outcome(overrides: Partial<ResolveOutcome> = {}): ResolveOutcome {
  return {
    effects: [],
    matchedRules: [],
    warnings: [],
    denialMessages: [],
    overridable: false,
    approvalConfig: null,
    final: 'allow',
    ...overrides,
  };
}

function approvalConfig(...approvers: Array<{ type: 'person' | 'team'; id: string }>): ApprovalConfig {
  return { required_approvers: approvers, threshold: 'all' };
}

/**
 * Codex remediation 2026-05-12: the production AssembleEditPlanService
 * hard-asserts that `TenantContext.current()?.id === args.tenantId` at
 * every plan-builder entry point. In production this is guaranteed by
 * `TenantMiddleware` wrapping every request in `TenantContext.run(...)`;
 * in this unit-test file, callers invoke `svc.assembleEditPlan(args)`
 * directly with no ALS context. Wrap the returned service in a Proxy
 * that auto-routes the public entry points through `TenantContext.run`
 * using the args' tenantId — equivalent to what the middleware would
 * have done in a real request stack.
 *
 * Tests that intentionally want to test the assertion (mismatch
 * between ALS context and args.tenantId) bypass this helper by
 * calling `TenantContext.run(...)` themselves around the raw service
 * instance.
 */
function makeService(deps: {
  supabase: ReturnType<typeof makeSupabase>;
  bookingFlow: ReturnType<typeof makeBookingFlow>;
  ruleResolver: ReturnType<typeof makeRuleResolver>;
  conflict: ReturnType<typeof makeConflict>;
}) {
  const svc = new AssembleEditPlanService(
    deps.supabase,
    deps.bookingFlow,
    deps.ruleResolver,
    deps.conflict,
  );
  return new Proxy(svc, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver) as unknown;
      if (typeof orig !== 'function') return orig;
      // Wrap the public entry points so callers' implicit "I'm in tenant
      // X" intent (encoded as args.tenantId) becomes the ALS-stored
      // tenant for the duration of the call.
      if (prop === 'assembleEditPlan' || prop === 'assembleScopeEditPlan') {
        return function (this: unknown, ...callArgs: unknown[]) {
          const argsArg = callArgs[0] as { tenantId?: string } | undefined;
          const tenantId = argsArg?.tenantId ?? TENANT;
          return TenantContext.run(
            { id: tenantId, slug: tenantId, tier: 'standard' },
            () => (orig as Function).apply(target, callArgs),
          );
        };
      }
      return (orig as Function).bind(target);
    },
  });
}

function baseBooking(overrides: Partial<BookingRow> = {}): BookingRow {
  return {
    id: BOOKING,
    tenant_id: TENANT,
    requester_person_id: REQUESTER,
    location_id: SPACE_OLD,
    start_at: '2026-05-12T09:00:00Z',
    end_at: '2026-05-12T10:00:00Z',
    status: 'confirmed',
    recurrence_series_id: null,
    ...overrides,
  };
}

function baseSlot(overrides: Partial<SlotRow> = {}): SlotRow {
  return {
    id: SLOT,
    booking_id: BOOKING,
    tenant_id: TENANT,
    space_id: SPACE_OLD,
    start_at: '2026-05-12T09:00:00Z',
    end_at: '2026-05-12T10:00:00Z',
    attendee_count: 4,
    attendee_person_ids: [],
    ...overrides,
  };
}

/**
 * Helper that builds a `kind:'slot'` patch — the only kind Step 2D-C
 * implements. I-PLAN-3.
 */
function slotPatch(overrides: Omit<AssembleEditPlanSlotPatch, 'kind'> = {}): AssembleEditPlanSlotPatch {
  return { kind: 'slot', ...overrides };
}

function baseArgs(
  patchOverrides: Omit<AssembleEditPlanSlotPatch, 'kind'> = {},
): AssembleEditPlanArgs {
  return {
    bookingId: BOOKING,
    tenantId: TENANT,
    slotId: SLOT,
    patch: slotPatch(patchOverrides),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe('AssembleEditPlanService.assembleEditPlan', () => {
  // Codex remediation 2026-05-12: tests call svc.assembleEditPlan(args)
  // directly with no ALS context. The makeService Proxy auto-wraps every
  // call in TenantContext.run({ id: args.tenantId, ... }), simulating
  // what TenantMiddleware does in production.

  it('builds a plan for a geometry-only patch (same room, no rule change)', async () => {
    const supabase = makeSupabase({
      booking: baseBooking(),
      slot: baseSlot(),
      approvals: [],
    });
    const ruleResolver = makeRuleResolver(outcome());
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver,
      conflict: makeConflict(),
    });

    const plan = await svc.assembleEditPlan(
      baseArgs({ start_at: '2026-05-12T11:00:00Z', end_at: '2026-05-12T12:00:00Z' }),
    );

    expect(plan.booking.location_id).toBe(SPACE_OLD);
    expect(plan.booking.start_at).toBe('2026-05-12T11:00:00Z');
    expect(plan.booking.end_at).toBe('2026-05-12T12:00:00Z');
    expect(plan.slot_patches).toHaveLength(1);
    expect(plan.slot_patches[0].slot_id).toBe(SLOT);
    expect(plan.slot_patches[0].space_id).toBe(SPACE_OLD);
    expect(plan.approval.old_outcome).toBe('allow');
    expect(plan.approval.new_outcome).toBe('allow');
    expect(plan.approval.chain_config_changed).toBe(false);
    expect(plan.approval.new_chain_config).toBeNull();
    expect(plan.asset_reservation_patches).toEqual([]);
    expect(plan.order_patches).toEqual([]);
    expect(plan.work_order_sla_patches).toEqual([]);
    expect(plan.booking.cost_amount_snapshot).toBeNull(); // no cost_per_hour
    expect(typeof plan._resolution_at).toBe('string');

    // N-CODE-5 — only ONE resolve call (no dead OLD pass).
    expect((ruleResolver as unknown as { resolve: jest.Mock }).resolve).toHaveBeenCalledTimes(1);
  });

  it('flips to require_approval when target room rule resolver returns require_approval (allow → require_approval)', async () => {
    const supabase = makeSupabase({
      booking: baseBooking(),
      slot: baseSlot(),
      approvals: [], // no current chain
    });
    const newChain = approvalConfig({ type: 'person', id: APPROVER_A });
    const bookingFlow = makeBookingFlow();
    const svc = makeService({
      supabase,
      bookingFlow,
      ruleResolver: makeRuleResolver(
        outcome({ final: 'require_approval', approvalConfig: newChain }),
      ),
      conflict: makeConflict(),
    });

    const plan = await svc.assembleEditPlan(baseArgs({ space_id: SPACE_NEW }));

    expect(plan.booking.location_id).toBe(SPACE_NEW);
    expect(plan.approval.old_outcome).toBe('allow');
    expect(plan.approval.new_outcome).toBe('require_approval');
    expect(plan.approval.chain_config_changed).toBe(true); // null → non-null
    expect(plan.approval.new_chain_config).toEqual({
      required_approvers: [{ type: 'person', id: APPROVER_A }],
      threshold: 'all',
    });

    // N-CODE-2 — loadSpace called with the TARGET room id, not the old one.
    // Phase 8: tenantId is now an explicit second argument (was ALS-read).
    expect((bookingFlow as unknown as { loadSpace: jest.Mock }).loadSpace).toHaveBeenCalledWith(
      SPACE_NEW,
      TENANT,
    );
  });

  it('preserves chain when same chain config returned by resolver (chain_config_changed=false)', async () => {
    const sameChain = approvalConfig({ type: 'person', id: APPROVER_A });
    const supabase = makeSupabase({
      booking: baseBooking(),
      slot: baseSlot(),
      approvals: [
        {
          approval_chain_id: 'chain-old',
          parallel_group: `parallel-${BOOKING}`,
          approver_person_id: APPROVER_A,
          approver_team_id: null,
          created_at: '2026-05-10T09:00:00Z',
          status: 'pending',
        },
      ],
    });
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(
        outcome({ final: 'require_approval', approvalConfig: sameChain }),
      ),
      conflict: makeConflict(),
    });

    const plan = await svc.assembleEditPlan(baseArgs({ space_id: SPACE_NEW }));

    expect(plan.approval.old_outcome).toBe('require_approval');
    expect(plan.approval.new_outcome).toBe('require_approval');
    expect(plan.approval.chain_config_changed).toBe(false); // same chain — preserve
  });

  it('flips chain_config_changed=true when chain members differ', async () => {
    const newChain = approvalConfig({ type: 'person', id: APPROVER_B });
    const supabase = makeSupabase({
      booking: baseBooking(),
      slot: baseSlot(),
      approvals: [
        {
          approval_chain_id: 'chain-old',
          parallel_group: `parallel-${BOOKING}`,
          approver_person_id: APPROVER_A,
          approver_team_id: null,
          created_at: '2026-05-10T09:00:00Z',
          status: 'pending',
        },
      ],
    });
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(
        outcome({ final: 'require_approval', approvalConfig: newChain }),
      ),
      conflict: makeConflict(),
    });

    const plan = await svc.assembleEditPlan(baseArgs({ space_id: SPACE_NEW }));

    expect(plan.approval.chain_config_changed).toBe(true);
    expect(plan.approval.new_chain_config?.required_approvers).toEqual([
      { type: 'person', id: APPROVER_B },
    ]);
  });

  it("does not pre-empt deny — emits new_outcome='deny' so the RPC raises Row 10", async () => {
    const supabase = makeSupabase({
      booking: baseBooking(),
      slot: baseSlot(),
      approvals: [],
    });
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(
        outcome({ final: 'deny', denialMessages: ['Forbidden room.'] }),
      ),
      conflict: makeConflict(),
    });

    const plan = await svc.assembleEditPlan(baseArgs({ space_id: SPACE_NEW }));
    expect(plan.approval.new_outcome).toBe('deny');
    // Plan still well-formed so the RPC's invalid_plan_shape gate doesn't
    // trip on the structural check before reaching the deny-raise gate.
    expect(plan.booking).toBeTruthy();
    expect(plan.slot_patches).toHaveLength(1);
  });

  it('throws AppError 404 when the booking does not exist', async () => {
    const supabase = makeSupabase({
      booking: null,
      slot: baseSlot(),
      approvals: [],
    });
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(outcome()),
      conflict: makeConflict(),
    });

    await expect(svc.assembleEditPlan(baseArgs())).rejects.toMatchObject({
      code: 'edit_booking.not_found',
      status: 404,
    });
  });

  it('throws AppError 404 when the slot belongs to a different booking', async () => {
    const otherBookingId = '99999999-9999-4999-8999-999999999999';
    const supabase = makeSupabase({
      booking: baseBooking(),
      slot: baseSlot({ booking_id: otherBookingId }),
      approvals: [],
    });
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(outcome()),
      conflict: makeConflict(),
    });

    await expect(svc.assembleEditPlan(baseArgs())).rejects.toBeInstanceOf(AppError);
  });

  it('computes cost_amount_snapshot from target room cost_per_hour + window', async () => {
    const supabase = makeSupabase({
      booking: baseBooking(),
      slot: baseSlot(),
      approvals: [],
    });
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow({ costPerHour: '100' }),
      ruleResolver: makeRuleResolver(outcome()),
      conflict: makeConflict(),
    });

    const plan = await svc.assembleEditPlan(
      baseArgs({
        space_id: SPACE_NEW,
        start_at: '2026-05-12T11:00:00Z',
        end_at: '2026-05-12T12:30:00Z',
      }),
    );

    // 100 * (90 / 60) = 150.00
    expect(plan.booking.cost_amount_snapshot).toBe('150.00');
  });

  it('preserves slot fields not present in patch (omitted fields fall back to current row)', async () => {
    const supabase = makeSupabase({
      booking: baseBooking(),
      slot: baseSlot({ attendee_count: 12, attendee_person_ids: ['p1', 'p2'] }),
      approvals: [],
    });
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(outcome()),
      conflict: makeConflict(),
    });

    // Patch only changes start_at — attendee_count + attendee_person_ids preserved.
    const plan = await svc.assembleEditPlan(baseArgs({ start_at: '2026-05-12T11:00:00Z' }));

    expect(plan.slot_patches[0].attendee_count).toBe(12);
    expect(plan.slot_patches[0].attendee_person_ids).toEqual(['p1', 'p2']);
  });

  it('passes the editing slot id as exclude_ids to snapshotBuffersForBooking', async () => {
    const supabase = makeSupabase({
      booking: baseBooking(),
      slot: baseSlot(),
      approvals: [],
    });
    const conflict = makeConflict();
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow({ setupBuffer: 15, teardownBuffer: 15 }),
      ruleResolver: makeRuleResolver(outcome()),
      conflict,
    });

    await svc.assembleEditPlan(baseArgs({ space_id: SPACE_NEW }));

    expect(conflict.snapshotBuffersForBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        space_id: SPACE_NEW,
        exclude_ids: [SLOT],
      }),
    );
  });

  // ── I-CODE-5 — cross-tenant slot path ─────────────────────────────────
  it('returns 404 when the slot belongs to a different tenant (no leak)', async () => {
    // Slot fixture is for OTHER_TENANT; the test's tenantId arg is TENANT.
    // The mock's tenant_id===expectedTenant predicate filters the slot to
    // null at the .eq('tenant_id', ...) layer — same shape as a real
    // RLS-protected query.
    const supabase = makeSupabase({
      booking: baseBooking(),
      slot: baseSlot({ tenant_id: OTHER_TENANT }),
      approvals: [],
      expectedTenant: TENANT,
    });
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(outcome()),
      conflict: makeConflict(),
    });

    await expect(svc.assembleEditPlan(baseArgs())).rejects.toMatchObject({
      code: 'edit_booking.not_found',
      status: 404,
    });
  });

  // ── PLAN-C1 — fail-fast on require_approval-without-approvers ─────────
  it('throws 422 rule_missing_approvers when new_outcome is require_approval with approvalConfig=null', async () => {
    const supabase = makeSupabase({
      booking: baseBooking(),
      slot: baseSlot(),
      approvals: [],
    });
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(
        // Possible per rule-resolver.service.ts:514 (approval_config defaults to null).
        outcome({ final: 'require_approval', approvalConfig: null }),
      ),
      conflict: makeConflict(),
    });

    await expect(svc.assembleEditPlan(baseArgs({ space_id: SPACE_NEW }))).rejects.toMatchObject({
      code: 'edit_booking.rule_missing_approvers',
      status: 422,
    });
  });

  it('throws 422 rule_missing_approvers when new_outcome is require_approval with empty required_approvers', async () => {
    const supabase = makeSupabase({
      booking: baseBooking(),
      slot: baseSlot(),
      approvals: [],
    });
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(
        outcome({
          final: 'require_approval',
          approvalConfig: { required_approvers: [], threshold: 'all' },
        }),
      ),
      conflict: makeConflict(),
    });

    await expect(svc.assembleEditPlan(baseArgs({ space_id: SPACE_NEW }))).rejects.toMatchObject({
      code: 'edit_booking.rule_missing_approvers',
      status: 422,
    });
  });

  // ── I-PLAN-3 — discriminated-union dispatch ────────────────────────────
  // kind='one' moved out of the not-yet-implemented bucket in Step 2E
  // (see `describe('AssembleEditPlanService.assembleEditPlan — kind="one"', ...)`
  // below). kind='scope' stays deferred to Step 2F.
  it('throws 400 invalid_plan_shape for unimplemented kind="scope"', async () => {
    const supabase = makeSupabase({ booking: baseBooking(), slot: baseSlot(), approvals: [] });
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(outcome()),
      conflict: makeConflict(),
    });

    await expect(
      svc.assembleEditPlan({
        bookingId: BOOKING,
        tenantId: TENANT,
        slotId: SLOT,
        patch: { kind: 'scope' },
      }),
    ).rejects.toMatchObject({
      code: 'edit_booking.invalid_plan_shape',
      status: 400,
    });
  });

  // ── N-CODE-7 — applied_rule_ids lexicographic sort ─────────────────────
  it('emits applied_rule_ids in lexicographic order regardless of resolver fan-out', async () => {
    const supabase = makeSupabase({ booking: baseBooking(), slot: baseSlot(), approvals: [] });
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(
        outcome({
          // Resolver fan-out is not lex-sorted — the orchestrator must sort.
          matchedRules: [
            { id: 'rule-zeta' } as never,
            { id: 'rule-alpha' } as never,
            { id: 'rule-mu' } as never,
          ],
        }),
      ),
      conflict: makeConflict(),
    });

    const plan = await svc.assembleEditPlan(baseArgs({ space_id: SPACE_NEW }));
    expect(plan.booking.applied_rule_ids).toEqual(['rule-alpha', 'rule-mu', 'rule-zeta']);
  });
});

// ─────────────────────────────────────────────────────────────────────
// B.4 Step 2E — `kind: 'one'` tests.
//
// editOne (PATCH /reservations/:id) plan-assembly. Mirrors the kind='slot'
// coverage above but adds:
//   - host_person_id surfaces on booking_patch when patched.
//   - recurrence_overridden=true auto-set when booking has
//     recurrence_series_id and any patched field would change state.
//   - Booking-level fields don't leak into slot_patches[].
// ─────────────────────────────────────────────────────────────────────

const HOST = '88888888-8888-4888-8888-888888888888';
const SERIES = '99999999-9999-4999-8999-9999999999aa';

function oneArgs(
  patchOverrides: Partial<Omit<import('../assemble-edit-plan.service').AssembleEditPlanOnePatch, 'kind'>> = {},
): AssembleEditPlanArgs {
  return {
    bookingId: BOOKING,
    tenantId: TENANT,
    slotId: SLOT,
    patch: { kind: 'one', ...patchOverrides },
  };
}

describe('AssembleEditPlanService.assembleEditPlan — kind="one" (Step 2E)', () => {
  it('builds a plan for a geometry-only edit (same shape as kind="slot")', async () => {
    const supabase = makeSupabase({
      booking: baseBooking(),
      slot: baseSlot(),
      approvals: [],
    });
    const ruleResolver = makeRuleResolver(outcome());
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver,
      conflict: makeConflict(),
    });

    const plan = await svc.assembleEditPlan(
      oneArgs({ start_at: '2026-05-12T11:00:00Z', end_at: '2026-05-12T12:00:00Z' }),
    );

    expect(plan.booking.location_id).toBe(SPACE_OLD);
    expect(plan.booking.start_at).toBe('2026-05-12T11:00:00Z');
    expect(plan.booking.end_at).toBe('2026-05-12T12:00:00Z');
    expect(plan.slot_patches).toHaveLength(1);
    expect(plan.slot_patches[0].slot_id).toBe(SLOT);
    expect(plan.approval.old_outcome).toBe('allow');
    expect(plan.approval.new_outcome).toBe('allow');
    // No host_person_id key when patch didn't carry one — RPC's case-when
    // at 00364:763-767 falls back to v_booking.host_person_id.
    expect(plan.booking.host_person_id).toBeUndefined();
    // Non-series booking — never auto-set the override flag.
    expect(plan.booking.recurrence_overridden).toBeUndefined();
    expect((ruleResolver as unknown as { resolve: jest.Mock }).resolve).toHaveBeenCalledTimes(1);
  });

  it('puts host_person_id on booking_patch when patched (string)', async () => {
    const supabase = makeSupabase({
      booking: baseBooking(),
      slot: baseSlot(),
      approvals: [],
    });
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(outcome()),
      conflict: makeConflict(),
    });

    const plan = await svc.assembleEditPlan(oneArgs({ host_person_id: HOST }));

    expect(plan.booking.host_person_id).toBe(HOST);
    // Booking-level field doesn't leak into slot_patches — slot_patches
    // is the geometry payload; host belongs on the booking row.
    const slotPatch = plan.slot_patches[0] as Record<string, unknown>;
    expect(slotPatch).not.toHaveProperty('host_person_id');
  });

  it('treats explicit null host_person_id as "clear" (vs undefined = "preserve")', async () => {
    const supabase = makeSupabase({
      booking: baseBooking(),
      slot: baseSlot(),
      approvals: [],
    });
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(outcome()),
      conflict: makeConflict(),
    });

    const plan = await svc.assembleEditPlan(oneArgs({ host_person_id: null }));

    // Key is PRESENT with literal null value. The RPC's
    // `nullif(...,'')::uuid` at 00364:765 produces SQL NULL — the
    // "clear" semantics. Key absence would mean "preserve current".
    expect('host_person_id' in plan.booking).toBe(true);
    expect(plan.booking.host_person_id).toBeNull();
  });

  it('auto-sets recurrence_overridden=true when booking has recurrence_series_id and any field is patched', async () => {
    const supabase = makeSupabase({
      booking: baseBooking({ recurrence_series_id: SERIES }),
      slot: baseSlot(),
      approvals: [],
    });
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(outcome()),
      conflict: makeConflict(),
    });

    const plan = await svc.assembleEditPlan(oneArgs({ start_at: '2026-05-12T11:00:00Z' }));

    expect(plan.booking.recurrence_overridden).toBe(true);
  });

  it('auto-sets recurrence_overridden=true on booking-level-only patches (host_person_id)', async () => {
    const supabase = makeSupabase({
      booking: baseBooking({ recurrence_series_id: SERIES }),
      slot: baseSlot(),
      approvals: [],
    });
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(outcome()),
      conflict: makeConflict(),
    });

    const plan = await svc.assembleEditPlan(oneArgs({ host_person_id: HOST }));

    expect(plan.booking.recurrence_overridden).toBe(true);
  });

  it('does NOT auto-set recurrence_overridden on non-series bookings', async () => {
    const supabase = makeSupabase({
      booking: baseBooking({ recurrence_series_id: null }),
      slot: baseSlot(),
      approvals: [],
    });
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(outcome()),
      conflict: makeConflict(),
    });

    const plan = await svc.assembleEditPlan(oneArgs({ start_at: '2026-05-12T11:00:00Z' }));

    expect(plan.booking.recurrence_overridden).toBeUndefined();
  });

  it('does NOT auto-set recurrence_overridden when the patch carries no fields (no-op)', async () => {
    const supabase = makeSupabase({
      booking: baseBooking({ recurrence_series_id: SERIES }),
      slot: baseSlot(),
      approvals: [],
    });
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(outcome()),
      conflict: makeConflict(),
    });

    // Empty patch — no fields to override on. The legacy editOne path
    // early-returned in this case (reservation.service.ts:821-827);
    // post-cutover the controller's caller is expected to short-circuit
    // too. The plan-builder itself just doesn't set the override flag.
    const plan = await svc.assembleEditPlan(oneArgs());
    expect(plan.booking.recurrence_overridden).toBeUndefined();
  });

  it('reconciles approval the same way as kind="slot" (allow → require_approval)', async () => {
    const supabase = makeSupabase({
      booking: baseBooking(),
      slot: baseSlot(),
      approvals: [],
    });
    const newChain = approvalConfig({ type: 'person', id: APPROVER_A });
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(
        outcome({ final: 'require_approval', approvalConfig: newChain }),
      ),
      conflict: makeConflict(),
    });

    const plan = await svc.assembleEditPlan(oneArgs({ space_id: SPACE_NEW }));

    expect(plan.approval.old_outcome).toBe('allow');
    expect(plan.approval.new_outcome).toBe('require_approval');
    expect(plan.approval.chain_config_changed).toBe(true);
  });

  it('computes cost_amount_snapshot for kind="one" (same path as kind="slot")', async () => {
    const supabase = makeSupabase({
      booking: baseBooking(),
      slot: baseSlot(),
      approvals: [],
    });
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow({ costPerHour: '100' }),
      ruleResolver: makeRuleResolver(outcome()),
      conflict: makeConflict(),
    });

    const plan = await svc.assembleEditPlan(
      oneArgs({
        space_id: SPACE_NEW,
        start_at: '2026-05-12T11:00:00Z',
        end_at: '2026-05-12T12:30:00Z',
      }),
    );

    // 100 * (90 / 60) = 150.00 — same math as the kind="slot" cost test.
    expect(plan.booking.cost_amount_snapshot).toBe('150.00');
  });

  it('PLAN-C1 fail-fast still fires on require_approval-without-approvers (kind="one")', async () => {
    const supabase = makeSupabase({
      booking: baseBooking(),
      slot: baseSlot(),
      approvals: [],
    });
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(
        outcome({ final: 'require_approval', approvalConfig: null }),
      ),
      conflict: makeConflict(),
    });

    await expect(svc.assembleEditPlan(oneArgs({ space_id: SPACE_NEW }))).rejects.toMatchObject({
      code: 'edit_booking.rule_missing_approvers',
      status: 422,
    });
  });

  // ─── Self-review C-1 (2026-05-12) — asymmetric value/key parity ───
  //
  // Pre-cutover editOne (git show f5f01511^:reservation.service.ts:793-826)
  // value-compared geometry keys (`patch.start_at && patch.start_at !== r.start_at`)
  // and key-compared meta keys (`patch.attendee_count !== undefined → slotMetaPatch.attendee_count = ...`).
  // The Step 2E v1 cutover used a key-only predicate for BOTH, which would
  // flip recurrence_overridden=true on a same-value geometry resave of a
  // series booking — detaching the booking from the series silently.
  //
  // These tests pin the asymmetric parity at the assembler layer
  // (assemble-edit-plan.service.ts:477-512). The editOne entry-point
  // no-op (reservation.service.ts:846-880) is a separate gate; tests for
  // that live in reservation-edit-slot.spec.ts.
  it('C-1: same-value geometry on a series booking does NOT auto-set recurrence_overridden', async () => {
    const supabase = makeSupabase({
      booking: baseBooking({ recurrence_series_id: SERIES }),
      slot: baseSlot(),
      approvals: [],
    });
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(outcome()),
      conflict: makeConflict(),
    });

    // baseSlot().start_at === '2026-05-12T09:00:00Z'. Patching the same
    // value back is a frontend resave-with-no-change. Pre-C-1 this flipped
    // recurrence_overridden. Post-C-1 it must not.
    const plan = await svc.assembleEditPlan(
      oneArgs({ start_at: '2026-05-12T09:00:00Z' }),
    );
    expect(plan.booking.recurrence_overridden).toBeUndefined();
  });

  it('C-1: same-value space_id + same-value end_at on a series booking does NOT auto-set recurrence_overridden', async () => {
    const supabase = makeSupabase({
      booking: baseBooking({ recurrence_series_id: SERIES }),
      slot: baseSlot(),
      approvals: [],
    });
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(outcome()),
      conflict: makeConflict(),
    });

    // All three geometry keys present, all matching current slot values.
    // The classic "operator opens form, saves with no changes" shape.
    const plan = await svc.assembleEditPlan(
      oneArgs({
        space_id: SPACE_OLD, // baseSlot().space_id
        start_at: '2026-05-12T09:00:00Z',
        end_at: '2026-05-12T10:00:00Z',
      }),
    );
    expect(plan.booking.recurrence_overridden).toBeUndefined();
  });

  it('C-1: a meta-key present (attendee_count) on a series booking AUTO-SETS recurrence_overridden even when the value matches current state', async () => {
    const supabase = makeSupabase({
      booking: baseBooking({ recurrence_series_id: SERIES }),
      slot: baseSlot({ attendee_count: 4 }),
      approvals: [],
    });
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(outcome()),
      conflict: makeConflict(),
    });

    // attendee_count=4 IS the slot's current value, but the parity rule
    // for meta is KEY-COMPARE (legacy editOne treated `attendee_count: X → X`
    // as a real edit too — slotMetaPatch was built off key definedness,
    // not value diff). This test pins that asymmetry deliberately so a
    // future "make it symmetric" refactor is caught here.
    const plan = await svc.assembleEditPlan(oneArgs({ attendee_count: 4 }));
    expect(plan.booking.recurrence_overridden).toBe(true);
  });

  it('C-1: a meta-key present (host_person_id) on a series booking AUTO-SETS recurrence_overridden', async () => {
    const supabase = makeSupabase({
      booking: baseBooking({ recurrence_series_id: SERIES }),
      slot: baseSlot(),
      approvals: [],
    });
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(outcome()),
      conflict: makeConflict(),
    });

    const plan = await svc.assembleEditPlan(oneArgs({ host_person_id: HOST }));
    expect(plan.booking.recurrence_overridden).toBe(true);
  });

  // ─── Self-review I-1 (2026-05-12) — explicit-null host clear ───
  it('I-1: host_person_id=null surfaces as JSON null on booking_patch (clear semantics)', async () => {
    const supabase = makeSupabase({
      booking: baseBooking(),
      slot: baseSlot(),
      approvals: [],
    });
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(outcome()),
      conflict: makeConflict(),
    });

    const plan = await svc.assembleEditPlan(oneArgs({ host_person_id: null }));

    // RPC's nullif(...,'')::uuid at 00364:765 converts JSON null to SQL
    // NULL → clears the column. Key absence would mean "preserve" via
    // the case-when at 00364:763-767. This is the path the public DTO's
    // `string | null` widening (dto/dtos.ts:53-67) is meant to support.
    expect('host_person_id' in plan.booking).toBe(true);
    expect(plan.booking.host_person_id).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// B.4 Step 2F.2 — `assembleScopeEditPlan` tests.
//
// Multi-occurrence scope edit. New entry point (separate from
// `assembleEditPlan`); different return shape (`AssembleScopeEditPlanResult`).
//
// The fixture sets up N bookings in one series + their primary slots, then
// builds the supabase mock so per-occurrence reads inside
// `buildSingleSlotPlan` route to the right row. The resolver / conflict /
// bookingFlow mocks are call-keyed by booking_id so tests can assert
// per-occurrence divergence in cost + applied_rule_ids + approval outcome.
// ─────────────────────────────────────────────────────────────────────

const SCOPE_PIVOT = '11111111-1111-4111-8111-aaaaaaaaaaaa';
const SCOPE_SERIES = '22222222-2222-4222-8222-bbbbbbbbbbbb';

interface ScopeFixture {
  /** Booking ids in id-sorted order (the order DB returns + the order the
   * plan-builder loops in). */
  bookingIds: string[];
  /** Per-booking primary slot id. Return `null` to simulate a booking
   * with no primary slot (mock returns `{data: null}` for the slot
   * resolution query) — used to exercise the
   * `edit_booking_scope.primary_slot_not_found` invariant. */
  primarySlotId: (bookingId: string) => string | null;
  /** Per-booking row factory (used by both pivot read + per-occurrence
   * loadBookingAndSlot). */
  booking: (bookingId: string) => BookingRow;
  /** Per-slot row factory (used by per-occurrence loadBookingAndSlot). */
  slot: (slotId: string) => SlotRow;
  /** Live approvals per booking_id. Defaults to [] (no chain). */
  approvals: (bookingId: string) => ApprovalRow[];
  /** Tenant id used for predicate matching. */
  tenantId: string;
  /** Optional: filter bookingIds for the scope-list query. Lets tests
   * exercise empty_scope / too_many. Defaults to all bookingIds. */
  scopeRows?: () => Array<{ id: string }>;
}

/**
 * Build a supabase mock that supports the scope-edit query graph:
 *
 *   - bookings.select(id, tenant_id, recurrence_series_id).eq.eq.maybeSingle()
 *     → pivot read (single row).
 *   - bookings.select(id).eq.eq.neq.order(asc, id)
 *     → scope-rows read (array, awaited directly).
 *   - bookings.select(...).eq.eq.maybeSingle()   (buildSingleSlotPlan)
 *     → per-occurrence pre-edit snapshot.
 *   - booking_slots.select(id).eq.eq.order.order.limit(1).maybeSingle()
 *     → primary-slot resolution.
 *   - booking_slots.select(...).eq.eq.maybeSingle()   (buildSingleSlotPlan)
 *     → per-occurrence slot row.
 *   - approvals.select(...).eq.eq.eq.in.order.order   (loadCurrentApprovalChain)
 *     → live chain per booking.
 *
 * The mock examines captured eq/neq filters to decide which path it's on.
 * No fixture mutation; calls are stateless.
 */
function makeScopeSupabase(fx: ScopeFixture) {
  const fromMock = jest.fn((table: string) => {
    if (table === 'bookings') {
      const filters: Record<string, unknown> = {};
      const notFilters: Record<string, unknown> = {};
      // B.4 Step 2F.3 — capture `.gte('start_at', ...)` for the
      // forwardOnlyFromStartAt filter on dry-run scope='this_and_following'.
      const gteFilters: Record<string, unknown> = {};
      let lastOp: 'select' | 'eq' | 'neq' | 'gte' | 'order' | null = null;
      const chain: Record<string, jest.Mock | Function> = {};

      chain.select = jest.fn((cols: string) => {
        chain._cols = cols;
        lastOp = 'select';
        return chain as unknown;
      }) as never;
      chain.eq = jest.fn((col: string, val: unknown) => {
        filters[col] = val;
        lastOp = 'eq';
        return chain as unknown;
      }) as never;
      chain.neq = jest.fn((col: string, val: unknown) => {
        notFilters[col] = val;
        lastOp = 'neq';
        return chain as unknown;
      }) as never;
      chain.gte = jest.fn((col: string, val: unknown) => {
        gteFilters[col] = val;
        lastOp = 'gte';
        return chain as unknown;
      }) as never;
      chain.order = jest.fn(() => {
        lastOp = 'order';
        return chain as unknown;
      }) as never;
      chain.maybeSingle = (() => {
        // Pivot read OR per-occurrence pre-edit booking snapshot — identified
        // by an `id` filter on bookings.
        const bookingId =
          typeof filters.id === 'string' ? (filters.id as string) : null;
        if (bookingId === null || filters.tenant_id !== fx.tenantId) {
          return Promise.resolve({ data: null, error: null });
        }
        if (!fx.bookingIds.includes(bookingId)) {
          return Promise.resolve({ data: null, error: null });
        }
        const row = fx.booking(bookingId);
        // Ensure the row's own tenant matches the predicate (mirrors RLS).
        if (row.tenant_id !== fx.tenantId) {
          return Promise.resolve({ data: null, error: null });
        }
        return Promise.resolve({ data: row, error: null });
      }) as never;
      // Awaitable directly — scope-rows read uses `await chain` (no
      // `.maybeSingle()`). The TS plan-builder writes `.order(...)` then
      // awaits; supabase-js makes the builder itself a PromiseLike.
      (chain as unknown as PromiseLike<unknown>).then = (
        resolve: (v: unknown) => unknown,
      ) => {
        // Identify scope-list query by: tenant_id eq, recurrence_series_id
        // eq, status neq 'cancelled'. The pivot read uses maybeSingle so
        // it never reaches `.then()`.
        if (
          filters.tenant_id === fx.tenantId &&
          typeof filters.recurrence_series_id === 'string' &&
          notFilters.status === 'cancelled'
        ) {
          let rows = fx.scopeRows
            ? fx.scopeRows()
            : fx.bookingIds.map((id) => ({ id }));
          // B.4 Step 2F.3 — forwardOnlyFromStartAt filter. When the
          // caller passed `.gte('start_at', threshold)` on the scope-list
          // query, simulate the DB-side filter by dropping rows whose
          // booking start_at < threshold. fx.booking(id).start_at is the
          // authoritative per-occurrence time.
          const startAtThreshold = gteFilters.start_at;
          if (typeof startAtThreshold === 'string') {
            rows = rows.filter((row) => {
              const booking = fx.booking(row.id);
              return booking.start_at >= startAtThreshold;
            });
          }
          return Promise.resolve(resolve({ data: rows, error: null }));
        }
        // Unrecognised awaitable path — surface as error for test
        // visibility.
        return Promise.resolve(
          resolve({
            data: null,
            error: new Error(
              `unhandled bookings .then() path: filters=${JSON.stringify(filters)} not=${JSON.stringify(notFilters)} lastOp=${String(lastOp)}`,
            ),
          }),
        );
      };
      return chain as never;
    }

    if (table === 'booking_slots') {
      const filters: Record<string, unknown> = {};
      const chain: Record<string, jest.Mock | Function> = {};
      chain.select = jest.fn(() => chain as unknown) as never;
      chain.eq = jest.fn((col: string, val: unknown) => {
        filters[col] = val;
        return chain as unknown;
      }) as never;
      chain.order = jest.fn(() => chain as unknown) as never;
      chain.limit = jest.fn(() => chain as unknown) as never;
      chain.maybeSingle = (() => {
        // Two callers:
        //   1. Primary-slot resolution: filters has booking_id + tenant_id;
        //      no `id` filter. We resolve via fx.primarySlotId.
        //   2. loadBookingAndSlot: filters has `id` + tenant_id.
        if (filters.tenant_id !== fx.tenantId) {
          return Promise.resolve({ data: null, error: null });
        }
        if (typeof filters.id === 'string') {
          const slotId = filters.id as string;
          const slot = fx.slot(slotId);
          if (slot.tenant_id !== fx.tenantId) {
            return Promise.resolve({ data: null, error: null });
          }
          return Promise.resolve({ data: slot, error: null });
        }
        if (typeof filters.booking_id === 'string') {
          const bookingId = filters.booking_id as string;
          const slotId = fx.primarySlotId(bookingId);
          if (slotId === null || slotId === undefined) {
            return Promise.resolve({ data: null, error: null });
          }
          return Promise.resolve({ data: { id: slotId }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      }) as never;
      return chain as never;
    }

    if (table === 'approvals') {
      const filters: Record<string, unknown> = {};
      const builder: Record<string, jest.Mock> = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn((col: string, val: unknown) => {
          filters[col] = val;
          return builder as unknown;
        }) as unknown as jest.Mock,
        in: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
      };
      (builder as unknown as PromiseLike<unknown>).then = (
        resolve: (v: unknown) => unknown,
      ) => {
        const ok =
          filters.tenant_id === fx.tenantId &&
          filters.target_entity_type === 'booking' &&
          typeof filters.target_entity_id === 'string';
        if (!ok) {
          return Promise.resolve(resolve({ data: [], error: null }));
        }
        const rows = fx.approvals(filters.target_entity_id as string);
        return Promise.resolve(resolve({ data: rows, error: null }));
      };
      return builder;
    }

    const linked = linkedRowTableMock(table);
    if (linked) return linked;
    throw new Error(`unexpected table: ${table}`);
  });
  return { admin: { from: fromMock } } as never;
}

/**
 * Per-occurrence rule resolver. Returns a different outcome for the
 * indexed occurrence so tests can assert per-occurrence divergence.
 * The resolver is called with `space_id`/`start_at`/`end_at` from the
 * target state — we can't switch on booking_id directly, so we key on
 * `start_at` which is always the slot's start (per-occurrence-distinct
 * by construction in fixtures).
 */
function makeRuleResolverByStartAt(
  outcomes: Record<string, ResolveOutcome>,
  fallback: ResolveOutcome,
) {
  return {
    resolve: jest.fn(async (input: { start_at: string }) => {
      return outcomes[input.start_at] ?? fallback;
    }),
  } as never;
}

function scopeArgs(
  patchOverrides: Omit<AssembleEditPlanScopePatch, 'kind'> = {},
): {
  bookingId: string;
  tenantId: string;
  effectiveSeriesId: string;
  patch: AssembleEditPlanScopePatch;
} {
  return {
    bookingId: SCOPE_PIVOT,
    tenantId: TENANT,
    effectiveSeriesId: SCOPE_SERIES,
    patch: { kind: 'scope', ...patchOverrides },
  };
}

describe('AssembleEditPlanService.assembleScopeEditPlan (Step 2F.2)', () => {
  // Helper — build a 5-occurrence series fixture.
  function fiveOccurrenceFixture(opts: {
    space_id?: string;
    cost_per_hour?: string | null;
  } = {}): ScopeFixture {
    const ids = Array.from({ length: 5 }, (_, i) =>
      `${String(i + 1).repeat(8).slice(0, 8)}-1111-4111-8111-aaaaaaaaaaaa`,
    );
    // Pivot is index 0.
    ids[0] = SCOPE_PIVOT;
    const startsByBookingId: Record<string, string> = {};
    ids.forEach((id, i) => {
      // Daily occurrences at 09:00 UTC.
      startsByBookingId[id] = `2026-05-${String(12 + i).padStart(2, '0')}T09:00:00Z`;
    });
    return {
      bookingIds: [...ids].sort(),
      tenantId: TENANT,
      primarySlotId: (bookingId) => `slot-${bookingId.slice(0, 8)}`,
      booking: (bookingId) =>
        baseBooking({
          id: bookingId,
          location_id: opts.space_id ?? SPACE_OLD,
          recurrence_series_id: SCOPE_SERIES,
          start_at: startsByBookingId[bookingId] ?? '2026-05-12T09:00:00Z',
          end_at:
            (startsByBookingId[bookingId] ?? '2026-05-12T09:00:00Z').replace(
              '09:00',
              '10:00',
            ),
        }),
      slot: (slotId) => {
        // Reverse-derive booking from slot id (`slot-<8hex>`).
        const bookingPrefix = slotId.slice(5); // strip 'slot-'
        const bookingId = ids.find((id) => id.startsWith(bookingPrefix))!;
        return baseSlot({
          id: slotId,
          booking_id: bookingId,
          space_id: opts.space_id ?? SPACE_OLD,
          start_at: startsByBookingId[bookingId] ?? '2026-05-12T09:00:00Z',
          end_at: (
            startsByBookingId[bookingId] ?? '2026-05-12T09:00:00Z'
          ).replace('09:00', '10:00'),
        });
      },
      approvals: () => [],
    };
  }

  it('builds N per-occurrence plans for a 5-occurrence series (space_id change)', async () => {
    const fx = fiveOccurrenceFixture();
    const supabase = makeScopeSupabase(fx);
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(outcome()),
      conflict: makeConflict(),
    });

    const result = await svc.assembleScopeEditPlan(
      scopeArgs({ space_id: SPACE_NEW }),
    );

    expect(result.series_id).toBe(SCOPE_SERIES);
    expect(result.rpc_plans).toHaveLength(5);
    // Every plan targets SPACE_NEW.
    for (const { plan } of result.rpc_plans) {
      expect(plan.booking.location_id).toBe(SPACE_NEW);
      // No recurrence_overridden in the booking patch — 00371:219
      // rejects it on scope plans.
      expect(plan.booking.recurrence_overridden).toBeUndefined();
      // Slot patch present with the slot id corresponding to that booking.
      expect(plan.slot_patches).toHaveLength(1);
      expect(plan.slot_patches[0].space_id).toBe(SPACE_NEW);
    }
    // rpc_plans booking_ids match the fixture set (id-sorted).
    expect(result.rpc_plans.map((p) => p.booking_id).sort()).toEqual(
      [...fx.bookingIds].sort(),
    );
  });

  it('raises edit_booking_scope.time_shift_not_supported when patch carries start_at (non-TS smuggle)', async () => {
    const fx = fiveOccurrenceFixture();
    const supabase = makeScopeSupabase(fx);
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(outcome()),
      conflict: makeConflict(),
    });

    // Cast through `any` to simulate a non-TS caller smuggling start_at
    // via JSON. The typed union forbids these keys at compile time.
    const smuggled = {
      kind: 'scope',
      start_at: '2026-05-12T11:00:00Z',
    } as unknown as AssembleEditPlanScopePatch;
    await expect(
      svc.assembleScopeEditPlan({
        bookingId: SCOPE_PIVOT,
        tenantId: TENANT,
        effectiveSeriesId: SCOPE_SERIES,
        patch: smuggled,
      }),
    ).rejects.toMatchObject({
      code: 'edit_booking_scope.time_shift_not_supported',
      status: 422,
    });
  });

  it('raises edit_booking_scope.not_recurring when the pivot booking has no recurrence_series_id', async () => {
    const fx: ScopeFixture = {
      bookingIds: [SCOPE_PIVOT],
      tenantId: TENANT,
      primarySlotId: () => `slot-${SCOPE_PIVOT.slice(0, 8)}`,
      booking: () => baseBooking({ id: SCOPE_PIVOT, recurrence_series_id: null }),
      slot: () => baseSlot(),
      approvals: () => [],
    };
    const supabase = makeScopeSupabase(fx);
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(outcome()),
      conflict: makeConflict(),
    });

    await expect(
      svc.assembleScopeEditPlan(scopeArgs({ space_id: SPACE_NEW })),
    ).rejects.toMatchObject({
      code: 'edit_booking_scope.not_recurring',
      status: 422,
    });
  });

  it('raises edit_booking_scope.too_many_occurrences when N > 200 (TS-layer cap before RPC)', async () => {
    // 201 ids; pivot is one of them.
    const ids = Array.from({ length: 201 }, (_, i) =>
      `${String(i + 1).padStart(8, '0').slice(0, 8)}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    );
    ids[0] = SCOPE_PIVOT;
    const fx: ScopeFixture = {
      bookingIds: ids,
      tenantId: TENANT,
      primarySlotId: (bookingId) => `slot-${bookingId.slice(0, 8)}`,
      booking: (bookingId) =>
        baseBooking({
          id: bookingId,
          recurrence_series_id: SCOPE_SERIES,
        }),
      slot: () => baseSlot(),
      approvals: () => [],
    };
    const supabase = makeScopeSupabase(fx);
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(outcome()),
      conflict: makeConflict(),
    });

    await expect(
      svc.assembleScopeEditPlan(scopeArgs({ space_id: SPACE_NEW })),
    ).rejects.toMatchObject({
      code: 'edit_booking_scope.too_many_occurrences',
      status: 422,
    });
  });

  // B.4.A.5 sub-step H (2026-05-13) lifted the in-loop pre-flight gate.
  // Was: assembleScopeEditPlan rejected on the first approval-flipping
  // occurrence with `booking.edit_requires_notification_dispatch` (422).
  // Now: every occurrence's plan is built and returned; the RPC at 00394
  // commits chain rows + writes inbox rows + emits booking.approval_required
  // atomically per occurrence whose plan flipped (covered by
  // apps/api/test/concurrency/edit_booking_scope.spec.ts Scenarios 17/18,
  // inverted to post-H expectations in the same commit).
  it('B.4.A.5 post-H: plans every occurrence even when one would flip approval', async () => {
    const fx = fiveOccurrenceFixture();
    const supabase = makeScopeSupabase(fx);

    // Make occurrence #3 (start_at = 2026-05-14T09:00:00Z) require approval;
    // the rest allow.
    const APPROVER = '99999999-9999-4999-8999-cccccccccccc';
    const ruleResolver = makeRuleResolverByStartAt(
      {
        '2026-05-14T09:00:00Z': outcome({
          final: 'require_approval',
          approvalConfig: approvalConfig({ type: 'person', id: APPROVER }),
        }),
      },
      outcome(),
    );

    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver,
      conflict: makeConflict(),
    });

    const flippingBookingId = fx.bookingIds.find((bid) => {
      const b = fx.booking(bid);
      return b.start_at === '2026-05-14T09:00:00Z';
    })!;

    const result = await svc.assembleScopeEditPlan(
      scopeArgs({ space_id: SPACE_NEW }),
    );

    expect(result.rpc_plans).toHaveLength(5);
    // Every plan flowed through — including the flipping occurrence.
    const byId = new Map(result.rpc_plans.map((p) => [p.booking_id, p.plan]));
    expect(byId.has(flippingBookingId)).toBe(true);
    // The flipping occurrence carries the approval block that would have
    // tripped the pre-H gate; the RPC at 00394 consumes it and writes
    // chain rows + inbox rows atomically.
    const flippingPlan = byId.get(flippingBookingId)!;
    expect(flippingPlan.approval.new_outcome).toBe('require_approval');
    expect(flippingPlan.approval.chain_config_changed).toBe(true);
    // Non-flipping occurrences keep allow→allow.
    for (const [bookingId, plan] of byId.entries()) {
      if (bookingId === flippingBookingId) continue;
      expect(plan.approval.new_outcome).toBe('allow');
    }
  });

  it('computes cost_amount_snapshot per occurrence based on each occurrence-window × cost_per_hour', async () => {
    // 3-occurrence fixture; each occurrence has a different window so
    // cost recompute must differ per plan.
    const ids = [SCOPE_PIVOT, `cccccccc-3333-4333-8333-cccccccccccc`, `dddddddd-3333-4333-8333-dddddddddddd`].sort();
    const windows: Record<
      string,
      { start_at: string; end_at: string }
    > = {
      [ids[0]]: { start_at: '2026-05-12T09:00:00Z', end_at: '2026-05-12T10:00:00Z' }, // 1h × 50 = 50
      [ids[1]]: { start_at: '2026-05-13T09:00:00Z', end_at: '2026-05-13T11:00:00Z' }, // 2h × 50 = 100
      [ids[2]]: { start_at: '2026-05-14T09:00:00Z', end_at: '2026-05-14T10:30:00Z' }, // 1.5h × 50 = 75
    };
    const fx: ScopeFixture = {
      bookingIds: ids,
      tenantId: TENANT,
      primarySlotId: (bookingId) => `slot-${bookingId.slice(0, 8)}`,
      booking: (bookingId) =>
        baseBooking({
          id: bookingId,
          recurrence_series_id: SCOPE_SERIES,
          location_id: SPACE_OLD,
          start_at: windows[bookingId].start_at,
          end_at: windows[bookingId].end_at,
        }),
      slot: (slotId) => {
        const bookingPrefix = slotId.slice(5);
        const bookingId = ids.find((id) => id.startsWith(bookingPrefix))!;
        return baseSlot({
          id: slotId,
          booking_id: bookingId,
          space_id: SPACE_OLD,
          start_at: windows[bookingId].start_at,
          end_at: windows[bookingId].end_at,
        });
      },
      approvals: () => [],
    };
    const supabase = makeScopeSupabase(fx);
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow({ costPerHour: '50' }),
      ruleResolver: makeRuleResolver(outcome()),
      conflict: makeConflict(),
    });

    const result = await svc.assembleScopeEditPlan(scopeArgs());

    expect(result.rpc_plans).toHaveLength(3);
    // rpc_plans returned in DB order (id-sorted asc by the assembler's
    // `.order('id', { ascending: true })`). Pair each plan to its
    // expected cost by booking_id.
    const byId = new Map(result.rpc_plans.map((p) => [p.booking_id, p.plan]));
    expect(byId.get(ids[0])!.booking.cost_amount_snapshot).toBe('50.00');
    expect(byId.get(ids[1])!.booking.cost_amount_snapshot).toBe('100.00');
    expect(byId.get(ids[2])!.booking.cost_amount_snapshot).toBe('75.00');
  });

  it('emits per-occurrence applied_rule_ids from each occurrence\'s resolver call', async () => {
    const fx = (() => {
      const ids = [
        SCOPE_PIVOT,
        `aaaaaaab-3333-4333-8333-bbbbbbbbbbbb`,
        `aaaaaaac-3333-4333-8333-cccccccccccc`,
      ].sort();
      return {
        bookingIds: ids,
        tenantId: TENANT,
        primarySlotId: (bookingId: string) => `slot-${bookingId.slice(0, 8)}`,
        booking: (bookingId: string) =>
          baseBooking({
            id: bookingId,
            recurrence_series_id: SCOPE_SERIES,
            // Make start_at distinct per occurrence so the resolver mock can
            // key on it.
            start_at: `2026-05-${String(
              12 + ids.indexOf(bookingId),
            ).padStart(2, '0')}T09:00:00Z`,
            end_at: `2026-05-${String(
              12 + ids.indexOf(bookingId),
            ).padStart(2, '0')}T10:00:00Z`,
          }),
        slot: (slotId: string) => {
          const bookingPrefix = slotId.slice(5);
          const bookingId = ids.find((id) => id.startsWith(bookingPrefix))!;
          return baseSlot({
            id: slotId,
            booking_id: bookingId,
            start_at: `2026-05-${String(
              12 + ids.indexOf(bookingId),
            ).padStart(2, '0')}T09:00:00Z`,
            end_at: `2026-05-${String(
              12 + ids.indexOf(bookingId),
            ).padStart(2, '0')}T10:00:00Z`,
          });
        },
        approvals: () => [] as ApprovalRow[],
        _ids: ids,
      } as ScopeFixture & { _ids: string[] };
    })();
    const supabase = makeScopeSupabase(fx);

    // Different applied_rule_ids per occurrence (keyed on start_at).
    const ruleResolver = makeRuleResolverByStartAt(
      {
        '2026-05-12T09:00:00Z': outcome({
          matchedRules: [{ id: 'rule-A' } as never],
        }),
        '2026-05-13T09:00:00Z': outcome({
          matchedRules: [{ id: 'rule-B' } as never],
        }),
        '2026-05-14T09:00:00Z': outcome({
          matchedRules: [{ id: 'rule-C' } as never],
        }),
      },
      outcome(),
    );
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver,
      conflict: makeConflict(),
    });

    const result = await svc.assembleScopeEditPlan(scopeArgs());

    // Each plan's applied_rule_ids reflects its own resolver call —
    // not a single broadcast.
    const seenRuleIds = new Set<string>();
    for (const { plan } of result.rpc_plans) {
      expect(plan.booking.applied_rule_ids).toHaveLength(1);
      seenRuleIds.add(plan.booking.applied_rule_ids![0]);
    }
    expect(seenRuleIds).toEqual(new Set(['rule-A', 'rule-B', 'rule-C']));
  });

  it('never emits recurrence_overridden in any rpc_plans[i].plan.booking (00371:219 rejection)', async () => {
    const fx = fiveOccurrenceFixture();
    const supabase = makeScopeSupabase(fx);
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(outcome()),
      conflict: makeConflict(),
    });

    const result = await svc.assembleScopeEditPlan(
      scopeArgs({ space_id: SPACE_NEW, host_person_id: HOST }),
    );

    for (const { plan } of result.rpc_plans) {
      expect(
        Object.prototype.hasOwnProperty.call(plan.booking, 'recurrence_overridden'),
      ).toBe(false);
    }
  });

  it('returns rpc_plans entries with the wire shape {booking_id: string, plan: EditPlan}', async () => {
    const fx = fiveOccurrenceFixture();
    const supabase = makeScopeSupabase(fx);
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(outcome()),
      conflict: makeConflict(),
    });

    const result = await svc.assembleScopeEditPlan(
      scopeArgs({ space_id: SPACE_NEW }),
    );

    for (const entry of result.rpc_plans) {
      // Wire shape — exactly two keys, both with correct types. Extra
      // keys would silently expand the RPC's contract surface.
      expect(Object.keys(entry).sort()).toEqual(['booking_id', 'plan']);
      expect(typeof entry.booking_id).toBe('string');
      expect(typeof entry.plan).toBe('object');
      expect(entry.plan).not.toBeNull();
      // Minimal EditPlan shape sanity (required keys).
      expect(entry.plan.booking).toBeDefined();
      expect(Array.isArray(entry.plan.slot_patches)).toBe(true);
      expect(typeof entry.plan._resolution_at).toBe('string');
      expect(entry.plan.approval).toBeDefined();
      // Self-review 2026-05-12: the 00371 RPC at line 219 REJECTS scope
      // plans whose booking patch carries `recurrence_overridden`.
      // Assert absence on EVERY entry here (not only the dedicated
      // happy-path test) so any future change that leaks the key into
      // a scope plan fails fast.
      expect(
        Object.prototype.hasOwnProperty.call(entry.plan.booking, 'recurrence_overridden'),
      ).toBe(false);
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // Self-review remediation 2026-05-12 — coverage for error codes that
  // were registered in error-codes.ts but had no direct test (silent
  // codes). Each test exercises a real call to assembleScopeEditPlan
  // and asserts the typed code + status surface.
  // ─────────────────────────────────────────────────────────────────────

  it('raises edit_booking_scope.empty_scope when series resolves to 0 live bookings', async () => {
    // Pivot exists with a valid series id, but the scope-rows read
    // returns []  — every occurrence is cancelled or wiped between the
    // controller's split and the assembler's read.
    const fx: ScopeFixture = {
      bookingIds: [SCOPE_PIVOT],
      tenantId: TENANT,
      primarySlotId: () => `slot-${SCOPE_PIVOT.slice(0, 8)}`,
      booking: () =>
        baseBooking({
          id: SCOPE_PIVOT,
          recurrence_series_id: SCOPE_SERIES,
        }),
      slot: () => baseSlot(),
      approvals: () => [],
      // Empty scope-rows override — the pivot read still succeeds; only
      // the series-wide list returns [].
      scopeRows: () => [],
    };
    const supabase = makeScopeSupabase(fx);
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(outcome()),
      conflict: makeConflict(),
    });

    await expect(
      svc.assembleScopeEditPlan(scopeArgs({ space_id: SPACE_NEW })),
    ).rejects.toMatchObject({
      code: 'edit_booking_scope.empty_scope',
      status: 422,
    });
  });

  it('raises edit_booking_scope.series_mismatch when pivot.recurrence_series_id differs from effectiveSeriesId (500)', async () => {
    // Pivot's series id is one value; caller's effectiveSeriesId is
    // another. Defense-in-depth invariant: the controller's split-then-
    // pass path must keep them in sync. A mismatch indicates an internal
    // consistency bug (500), not user error.
    const OTHER_SERIES = '33333333-3333-4333-8333-eeeeeeeeeeee';
    const fx: ScopeFixture = {
      bookingIds: [SCOPE_PIVOT],
      tenantId: TENANT,
      primarySlotId: () => `slot-${SCOPE_PIVOT.slice(0, 8)}`,
      booking: () =>
        baseBooking({
          id: SCOPE_PIVOT,
          // Pivot's stored series id ≠ caller's effectiveSeriesId
          // (SCOPE_SERIES, used in scopeArgs() default).
          recurrence_series_id: OTHER_SERIES,
        }),
      slot: () => baseSlot(),
      approvals: () => [],
    };
    const supabase = makeScopeSupabase(fx);
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(outcome()),
      conflict: makeConflict(),
    });

    await expect(
      svc.assembleScopeEditPlan(scopeArgs({ space_id: SPACE_NEW })),
    ).rejects.toMatchObject({
      code: 'edit_booking_scope.series_mismatch',
      status: 500,
    });
  });

  it('raises edit_booking_scope.primary_slot_not_found when a scope booking has no primary slot (500)', async () => {
    // Two-booking series. The PIVOT has a primary slot; the OTHER
    // booking returns null from primarySlotId — simulates a corrupt
    // booking with zero slots (violates the 00043 ≥1-slot invariant).
    // The assembler must raise primary_slot_not_found 500 with the
    // offending booking_id in the detail.
    const ORPHAN = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
    const fx: ScopeFixture = {
      bookingIds: [SCOPE_PIVOT, ORPHAN].sort(),
      tenantId: TENANT,
      primarySlotId: (bookingId) => {
        // Pivot has a slot; orphan returns null to trigger the gate.
        if (bookingId === ORPHAN) return null;
        return `slot-${bookingId.slice(0, 8)}`;
      },
      booking: (bookingId) =>
        baseBooking({
          id: bookingId,
          recurrence_series_id: SCOPE_SERIES,
        }),
      slot: (slotId) => {
        const bookingPrefix = slotId.slice(5);
        const bookingId = [SCOPE_PIVOT, ORPHAN].find((id) =>
          id.startsWith(bookingPrefix),
        )!;
        return baseSlot({ id: slotId, booking_id: bookingId });
      },
      approvals: () => [],
    };
    const supabase = makeScopeSupabase(fx);
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(outcome()),
      conflict: makeConflict(),
    });

    await expect(
      svc.assembleScopeEditPlan(scopeArgs({ space_id: SPACE_NEW })),
    ).rejects.toMatchObject({
      code: 'edit_booking_scope.primary_slot_not_found',
      status: 500,
      // Offender's booking_id appears in detail so operators can
      // pinpoint which row needs slot-data repair.
      detail: expect.stringContaining(ORPHAN),
    });
  });

  it('SUCCEEDS at the inclusive N=200 boundary (mirror of N=201 rejection)', async () => {
    // Codex 2026-05-12: the N>200 rejection is asserted; the inclusive
    // success at N=200 is the sibling boundary. Build a 200-booking
    // series fixture (same shape as the N=201 test, minus one row) and
    // verify the assembler returns 200 plans without throwing.
    const ids = Array.from({ length: 200 }, (_, i) =>
      `${String(i + 1).padStart(8, '0').slice(0, 8)}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    );
    ids[0] = SCOPE_PIVOT;
    const fx: ScopeFixture = {
      bookingIds: ids,
      tenantId: TENANT,
      primarySlotId: (bookingId) => `slot-${bookingId.slice(0, 8)}`,
      booking: (bookingId) =>
        baseBooking({
          id: bookingId,
          recurrence_series_id: SCOPE_SERIES,
        }),
      slot: (slotId) => {
        // Each slot's booking_id must match the bookingId the loop is
        // processing, so loadBookingAndSlot's cross-booking guard
        // (assemble-edit-plan.service.ts:858) doesn't trip. Reverse-
        // derive the booking id from the slot id prefix the same way
        // the 5-occurrence fixture does.
        const bookingPrefix = slotId.slice(5); // strip 'slot-'
        const bookingId = ids.find((id) => id.startsWith(bookingPrefix))!;
        return baseSlot({ id: slotId, booking_id: bookingId });
      },
      approvals: () => [],
    };
    const supabase = makeScopeSupabase(fx);
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(outcome()),
      conflict: makeConflict(),
    });

    const result = await svc.assembleScopeEditPlan(
      scopeArgs({ space_id: SPACE_NEW }),
    );
    expect(result.rpc_plans).toHaveLength(200);
    expect(result.series_id).toBe(SCOPE_SERIES);
  });

  // ───────────────────────────────────────────────────────────────────
  // B.4 Step 2F.3 — `forwardOnlyFromStartAt` filter.
  //
  // Used by the controller's dry-run path on `scope='this_and_following'`:
  // splitSeries can't run on a preview (it commits side effects), so the
  // assembler is asked to filter to the FORWARD SUBSET of the CURRENT
  // series. The committed path doesn't need the filter (the new series
  // id only has forward rows by construction).
  // ───────────────────────────────────────────────────────────────────

  it('forwardOnlyFromStartAt: filters scope rows to those at-or-after the pivot start_at', async () => {
    // Fixture: 5 daily occurrences 2026-05-12 .. 2026-05-16. Pivot is
    // index 2 (2026-05-14). The filter should drop 2026-05-12 +
    // 2026-05-13 from the scope-list, leaving 3 occurrences for the
    // per-occurrence loop.
    const fx = fiveOccurrenceFixture();
    const supabase = makeScopeSupabase(fx);
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(outcome()),
      conflict: makeConflict(),
    });

    const result = await svc.assembleScopeEditPlan({
      bookingId: SCOPE_PIVOT,
      tenantId: TENANT,
      effectiveSeriesId: SCOPE_SERIES,
      patch: { kind: 'scope', space_id: SPACE_NEW },
      forwardOnlyFromStartAt: '2026-05-14T09:00:00Z',
    });

    // 3 forward occurrences (05-14, 05-15, 05-16) — id-sorted.
    expect(result.rpc_plans).toHaveLength(3);
    // Defense-in-depth: every plan's start_at is >= threshold.
    for (const { plan } of result.rpc_plans) {
      expect(plan.booking.start_at >= '2026-05-14T09:00:00Z').toBe(true);
    }
  });

  it('forwardOnlyFromStartAt: undefined (the default) walks every live occurrence', async () => {
    // No filter passed — every occurrence in the series flows through
    // the per-occurrence loop (committed `this_and_following` path post-
    // splitSeries + every `series` path).
    const fx = fiveOccurrenceFixture();
    const supabase = makeScopeSupabase(fx);
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(outcome()),
      conflict: makeConflict(),
    });

    const result = await svc.assembleScopeEditPlan({
      bookingId: SCOPE_PIVOT,
      tenantId: TENANT,
      effectiveSeriesId: SCOPE_SERIES,
      patch: { kind: 'scope', space_id: SPACE_NEW },
      // forwardOnlyFromStartAt deliberately omitted.
    });

    expect(result.rpc_plans).toHaveLength(5);
  });

  it('forwardOnlyFromStartAt: filtering to zero rows trips empty_scope (422)', async () => {
    // The threshold is past every occurrence, so the filter empties the
    // scope. The assembler's existing empty_scope guard
    // (assemble-edit-plan.service.ts:505-508) fires.
    const fx = fiveOccurrenceFixture();
    const supabase = makeScopeSupabase(fx);
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver(outcome()),
      conflict: makeConflict(),
    });

    await expect(
      svc.assembleScopeEditPlan({
        bookingId: SCOPE_PIVOT,
        tenantId: TENANT,
        effectiveSeriesId: SCOPE_SERIES,
        patch: { kind: 'scope', space_id: SPACE_NEW },
        forwardOnlyFromStartAt: '2030-01-01T00:00:00Z',
      }),
    ).rejects.toMatchObject({
      code: 'edit_booking_scope.empty_scope',
      status: 422,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Phase 8 (Tier B follow-up #2) — `edit_booking.tenant_context_mismatch`
// retired.
//
// The Step 2F.2 hard-assert tests previously here covered a runtime
// 500 that fired when `TenantContext.current()?.id !== args.tenantId`
// at the three plan-builder entry points. The data-plane helpers
// (BookingFlowService.loadSpace, RuleResolverService.resolve,
// ConflictGuardService.snapshotBuffersForBooking) now take `tenantId`
// as an explicit typed argument — the broken call (helpers reading a
// different tenant than args.tenantId) is no longer representable at
// the call-site. Compile-time guarantee replaces the runtime assertion;
// no test is needed (TS itself is the test).
// ─────────────────────────────────────────────────────────────────────

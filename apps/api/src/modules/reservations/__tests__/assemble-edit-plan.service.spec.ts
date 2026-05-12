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
import {
  AssembleEditPlanService,
  type AssembleEditPlanArgs,
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
    throw new Error(`unexpected table: ${table}`);
  });

  return { admin: { from: fromMock } } as never;
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

function makeService(deps: {
  supabase: ReturnType<typeof makeSupabase>;
  bookingFlow: ReturnType<typeof makeBookingFlow>;
  ruleResolver: ReturnType<typeof makeRuleResolver>;
  conflict: ReturnType<typeof makeConflict>;
}) {
  return new AssembleEditPlanService(deps.supabase, deps.bookingFlow, deps.ruleResolver, deps.conflict);
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
    expect((bookingFlow as unknown as { loadSpace: jest.Mock }).loadSpace).toHaveBeenCalledWith(
      SPACE_NEW,
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

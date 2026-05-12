/**
 * Unit tests for `../assemble-edit-plan.service` (B.4 step 2D-C).
 *
 * Coverage (mocked deps):
 *   1. Geometry-only patch (same room, time tweak) — no rule outcome change,
 *      chain_config_changed=false, single slot patch.
 *   2. Location change with allow→require_approval — new chain inserted,
 *      chain_config_changed=true.
 *   3. Location change preserving same chain — chain_config_changed=false.
 *   4. Location change with different chain config — chain_config_changed=true.
 *   5. Deny outcome — helper still builds plan; RPC will reject (the helper
 *      does NOT pre-empt deny — that's the RPC's Row 10).
 *   6. Missing booking → throws AppError (edit_booking.not_found, 404).
 *   7. Slot belongs to a different booking → throws AppError 404 (no leak).
 *   8. Cost recompute when target room has cost_per_hour.
 */

import { AppError } from '../../../common/errors';
import { AssembleEditPlanService, type AssembleEditPlanArgs } from '../assemble-edit-plan.service';
import type { ResolveOutcome } from '../../room-booking-rules/rule-resolver.service';
import type { ApprovalConfig } from '../../room-booking-rules/dto';

const TENANT = 't1';
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
 * Mock SupabaseService that routes from('<table>') to the right
 * fixture data. Each query path uses a thenable that resolves
 * differently depending on whether the call ended in `.maybeSingle()`
 * (single object) or a bare await (array of rows).
 */
function makeSupabase(opts: {
  booking: BookingRow | null;
  slot: SlotRow | null;
  approvals: ApprovalRow[];
}) {
  const admin = {
    from: jest.fn((table: string) => {
      if (table === 'bookings') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: opts.booking, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === 'booking_slots') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: opts.slot, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === 'approvals') {
        // Thenable for `await select().eq().eq().eq()` (no maybeSingle).
        const builder: Record<string, jest.Mock> = {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
        };
        (builder as unknown as PromiseLike<unknown>).then = (
          resolve: (v: unknown) => unknown,
        ) => Promise.resolve(resolve({ data: opts.approvals, error: null }));
        return builder;
      }
      throw new Error(`unexpected table: ${table}`);
    }),
  };
  return { admin } as never;
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

function makeRuleResolver(outcomes: { old: ResolveOutcome; new_: ResolveOutcome }) {
  let call = 0;
  return {
    resolve: jest.fn(async () => {
      const outcome = call === 0 ? outcomes.old : outcomes.new_;
      call += 1;
      return outcome;
    }),
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

function baseArgs(patchOverrides: AssembleEditPlanArgs['patch'] = {}): AssembleEditPlanArgs {
  return {
    bookingId: BOOKING,
    tenantId: TENANT,
    slotId: SLOT,
    patch: patchOverrides,
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
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver({ old: outcome(), new_: outcome() }),
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
  });

  it('flips to require_approval when target room rule resolver returns require_approval (allow → require_approval)', async () => {
    const supabase = makeSupabase({
      booking: baseBooking(),
      slot: baseSlot(),
      approvals: [], // no current chain
    });
    const newChain = approvalConfig({ type: 'person', id: APPROVER_A });
    const svc = makeService({
      supabase,
      bookingFlow: makeBookingFlow(),
      ruleResolver: makeRuleResolver({
        old: outcome({ final: 'allow' }),
        new_: outcome({ final: 'require_approval', approvalConfig: newChain }),
      }),
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
      ruleResolver: makeRuleResolver({
        old: outcome({ final: 'require_approval', approvalConfig: sameChain }),
        new_: outcome({ final: 'require_approval', approvalConfig: sameChain }),
      }),
      conflict: makeConflict(),
    });

    const plan = await svc.assembleEditPlan(baseArgs({ space_id: SPACE_NEW }));

    expect(plan.approval.old_outcome).toBe('require_approval');
    expect(plan.approval.new_outcome).toBe('require_approval');
    expect(plan.approval.chain_config_changed).toBe(false); // same chain — preserve
  });

  it('flips chain_config_changed=true when chain members differ', async () => {
    const oldChain = approvalConfig({ type: 'person', id: APPROVER_A });
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
      ruleResolver: makeRuleResolver({
        old: outcome({ final: 'require_approval', approvalConfig: oldChain }),
        new_: outcome({ final: 'require_approval', approvalConfig: newChain }),
      }),
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
      ruleResolver: makeRuleResolver({
        old: outcome({ final: 'allow' }),
        new_: outcome({ final: 'deny', denialMessages: ['Forbidden room.'] }),
      }),
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
      ruleResolver: makeRuleResolver({ old: outcome(), new_: outcome() }),
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
      ruleResolver: makeRuleResolver({ old: outcome(), new_: outcome() }),
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
      ruleResolver: makeRuleResolver({ old: outcome(), new_: outcome() }),
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
      ruleResolver: makeRuleResolver({ old: outcome(), new_: outcome() }),
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
      ruleResolver: makeRuleResolver({ old: outcome(), new_: outcome() }),
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
});

import { ApprovalRoutingService } from './approval-routing.service';
import { TenantContext } from '../../common/tenant-context';
import type { ServiceRuleOutcome } from '../service-catalog/dto/types';
import { planUuid } from '../booking-bundles/plan-uuid';

/**
 * Tests for `ApprovalRoutingService.assemblePlan` (B.0.C.3 — combined RPC
 * plan-builder path). The method mirrors `assemble`'s logic but returns the
 * AttachPlanApproval[] shape with pre-generated UUIDs and never writes to
 * the database.
 */

interface FakeSupabase {
  admin: {
    from: jest.Mock;
  };
}

function makeStubSupabase(opts: {
  /** When non-null, every call to `cost_centers.select.eq.eq.maybeSingle` returns this. */
  costCenterDefaultApprover?: string | null;
}): FakeSupabase {
  // Default: no role members, no cost-center default. Tests can wire in
  // specific approver_targets and the resolved persons inline.
  return {
    admin: {
      from: jest.fn((table: string) => {
        if (table === 'cost_centers') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: opts.costCenterDefaultApprover
                      ? { default_approver_person_id: opts.costCenterDefaultApprover }
                      : null,
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        // Fallback for unexpected tables — surface as test failure.
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  // eslint-disable-next-line @typescript-eslint/require-await
                  async then() {
                    throw new Error(`unexpected table: ${table}`);
                  },
                }),
              }),
            }),
          }),
        };
      }),
    },
  };
}

function outcomeWithPersonApprover(personId: string, ruleId: string): ServiceRuleOutcome {
  return {
    effect: 'require_approval',
    matched_rule_ids: [ruleId],
    denial_messages: [],
    warning_messages: [],
    approver_targets: [{ rule_id: ruleId, target: { kind: 'person', person_id: personId } }],
    requires_internal_setup: false,
    internal_setup_lead_time_minutes: null,
  };
}

const TENANT = { id: 'tenant-1', slug: 'acme', tier: 'standard' as const };

const BOOKING_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

describe('ApprovalRoutingService.assemblePlan', () => {
  it('returns empty array when no approver targets fire', async () => {
    const service = new ApprovalRoutingService(makeStubSupabase({}) as never);
    const result = await TenantContext.run(TENANT, () =>
      service.assemblePlan({
        target_entity_type: 'booking',
        target_entity_id: BOOKING_ID,
        per_line_outcomes: [],
        bundle_context: {
          cost_center_id: null,
          requester_person_id: 'requester-1',
          bundle_id: BOOKING_ID,
        },
        idempotencyKey: 'idem-1',
      }),
    );
    expect(result).toEqual([]);
  });

  it('produces one row per approver_person_id with deterministic ids', async () => {
    const service = new ApprovalRoutingService(makeStubSupabase({}) as never);
    const args = {
      target_entity_type: 'booking' as const,
      target_entity_id: BOOKING_ID,
      per_line_outcomes: [
        {
          line_key: 'oli-1',
          outcome: outcomeWithPersonApprover('person-bob', 'rule-1'),
          scope: { reservation_ids: [BOOKING_ID], order_ids: ['order-1'], order_line_item_ids: ['oli-1'] },
        },
        {
          line_key: 'oli-2',
          outcome: outcomeWithPersonApprover('person-alice', 'rule-2'),
          scope: { reservation_ids: [BOOKING_ID], order_ids: ['order-1'], order_line_item_ids: ['oli-2'] },
        },
      ],
      bundle_context: {
        cost_center_id: null,
        requester_person_id: 'requester-1',
        bundle_id: BOOKING_ID,
      },
      idempotencyKey: 'idem-key-stable',
    };

    const rowsA = await TenantContext.run(TENANT, () => service.assemblePlan(args));
    const rowsB = await TenantContext.run(TENANT, () => service.assemblePlan(args));

    // Two builds with the same args produce identical ids (deterministic).
    expect(rowsA.map((r) => r.id)).toEqual(rowsB.map((r) => r.id));

    // One row per approver_person_id.
    expect(rowsA).toHaveLength(2);
    const approverIds = rowsA.map((r) => r.approver_person_id).sort();
    expect(approverIds).toEqual(['person-alice', 'person-bob']);

    // Sorted ascending by approver_person_id (canonical sort).
    expect(rowsA[0].approver_person_id).toBe('person-alice');
    expect(rowsA[1].approver_person_id).toBe('person-bob');

    // Ids match planUuid(key, 'approval', approver_person_id) per §7.4.
    expect(rowsA[0].id).toBe(planUuid('idem-key-stable', 'approval', 'person-alice'));
    expect(rowsA[1].id).toBe(planUuid('idem-key-stable', 'approval', 'person-bob'));
  });

  it('merges scope_breakdown when one approver fires across multiple lines', async () => {
    const service = new ApprovalRoutingService(makeStubSupabase({}) as never);
    const result = await TenantContext.run(TENANT, () =>
      service.assemblePlan({
        target_entity_type: 'booking',
        target_entity_id: BOOKING_ID,
        per_line_outcomes: [
          {
            line_key: 'oli-1',
            outcome: outcomeWithPersonApprover('person-bob', 'rule-1'),
            scope: { reservation_ids: [BOOKING_ID], order_ids: ['order-1'], order_line_item_ids: ['oli-1'] },
          },
          {
            line_key: 'oli-2',
            outcome: outcomeWithPersonApprover('person-bob', 'rule-2'),
            scope: { reservation_ids: [BOOKING_ID], order_ids: ['order-1'], order_line_item_ids: ['oli-2'] },
          },
        ],
        bundle_context: {
          cost_center_id: null,
          requester_person_id: 'requester-1',
          bundle_id: BOOKING_ID,
        },
        idempotencyKey: 'idem-1',
      }),
    );

    expect(result).toHaveLength(1);
    const row = result[0];
    expect(row.approver_person_id).toBe('person-bob');
    expect(row.scope_breakdown.order_line_item_ids).toEqual(['oli-1', 'oli-2']);
    expect(row.scope_breakdown.reasons).toEqual([
      { rule_id: 'rule-1', denial_message: null },
      { rule_id: 'rule-2', denial_message: null },
    ]);
  });

  it('does NOT write to the approvals table (call site is the combined RPC)', async () => {
    const supabase = makeStubSupabase({});
    const service = new ApprovalRoutingService(supabase as never);
    await TenantContext.run(TENANT, () =>
      service.assemblePlan({
        target_entity_type: 'booking',
        target_entity_id: BOOKING_ID,
        per_line_outcomes: [
          {
            line_key: 'oli-1',
            outcome: outcomeWithPersonApprover('person-bob', 'rule-1'),
            scope: { order_line_item_ids: ['oli-1'] },
          },
        ],
        bundle_context: {
          cost_center_id: null,
          requester_person_id: 'requester-1',
          bundle_id: BOOKING_ID,
        },
        idempotencyKey: 'idem-1',
      }),
    );
    // Critical invariant: assemblePlan must never touch `approvals`.
    const tablesTouched = supabase.admin.from.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(tablesTouched).not.toContain('approvals');
  });

  it('produces byte-identical output for shuffled per_line_outcomes', async () => {
    const service = new ApprovalRoutingService(makeStubSupabase({}) as never);

    const a = {
      line_key: 'oli-1',
      outcome: outcomeWithPersonApprover('person-bob', 'rule-1'),
      scope: { order_line_item_ids: ['oli-1'] },
    };
    const b = {
      line_key: 'oli-2',
      outcome: outcomeWithPersonApprover('person-alice', 'rule-2'),
      scope: { order_line_item_ids: ['oli-2'] },
    };

    const baseArgs = {
      target_entity_type: 'booking' as const,
      target_entity_id: BOOKING_ID,
      bundle_context: {
        cost_center_id: null,
        requester_person_id: 'requester-1',
        bundle_id: BOOKING_ID,
      },
      idempotencyKey: 'idem-shuffle',
    };

    const ordered = await TenantContext.run(TENANT, () =>
      service.assemblePlan({ ...baseArgs, per_line_outcomes: [a, b] }),
    );
    const reversed = await TenantContext.run(TENANT, () =>
      service.assemblePlan({ ...baseArgs, per_line_outcomes: [b, a] }),
    );

    expect(JSON.stringify(ordered)).toBe(JSON.stringify(reversed));
  });
});

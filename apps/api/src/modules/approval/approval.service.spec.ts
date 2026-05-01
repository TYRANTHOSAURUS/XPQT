import { ApprovalService, type ApprovalActor } from './approval.service';
import { TenantContext } from '../../common/tenant-context';

/**
 * `getPendingForActor` previously filtered only on `approver_person_id`,
 * so approvals targeted at a team (`approver_team_id`) were silently
 * invisible to the team members' pending queue. The test below locks in
 * the OR-filter that surfaces both paths, plus the delegation expansion
 * that's been there since day one.
 *
 * The Supabase chain is faked at the `.from(table)` boundary — each table
 * returns a thenable chain that records the calls we care about and
 * resolves with whatever the test scenario needs. We don't try to fake
 * the full PostgrestFilterBuilder; the assertions only depend on the
 * specific operators the service actually uses.
 */

interface CallRecord {
  table: string;
  // The .or() string the service passed when querying approvals.
  orClause?: string;
  // The .in() column + values, recorded for the users/team_members lookups.
  inCol?: string;
  inValues?: string[];
}

function makeService(opts: {
  delegations?: Array<{ delegator_user_id: string }>;
  delegatorUsers?: Array<{ person_id: string | null }>;
  teamMemberships?: Array<{ team_id: string }>;
  approvals?: Array<Record<string, unknown>>;
}): { svc: ApprovalService; calls: CallRecord[] } {
  const calls: CallRecord[] = [];
  const supabase = {
    admin: {
      from(table: string) {
        const record: CallRecord = { table };
        calls.push(record);
        const chain: Record<string, (...args: unknown[]) => unknown> = {};
        const passthrough = () => chain;
        chain.select = passthrough;
        chain.eq = passthrough;
        chain.lte = passthrough;
        chain.gte = passthrough;
        chain.in = (col: unknown, values: unknown) => {
          record.inCol = col as string;
          record.inValues = values as string[];
          return chain;
        };
        chain.or = (clause: unknown) => {
          record.orClause = clause as string;
          return chain;
        };
        chain.order = () => {
          if (table === 'approvals') {
            return Promise.resolve({ data: opts.approvals ?? [], error: null });
          }
          return Promise.resolve({ data: [], error: null });
        };
        // Some callers chain .eq().eq().eq().lte().gte() with no terminal
        // method — they're awaited directly. Make the chain itself thenable
        // so `await this.supabase.admin.from(t).select().eq()...` resolves.
        chain.then = (resolve: (v: unknown) => unknown) => {
          if (table === 'delegations') return resolve({ data: opts.delegations ?? [], error: null });
          if (table === 'users') return resolve({ data: opts.delegatorUsers ?? [], error: null });
          if (table === 'team_members') return resolve({ data: opts.teamMemberships ?? [], error: null });
          return resolve({ data: [], error: null });
        };
        return chain;
      },
    },
  };

  // Tenant + downstream services are not exercised by getPendingForActor.
  jest
    .spyOn(require('../../common/tenant-context').TenantContext, 'current')
    .mockReturnValue({ id: 'T' } as never);

  const svc = new ApprovalService(
    supabase as never,
    { onApprovalDecision: jest.fn() } as never,
    { onApprovalDecided: jest.fn() } as never,
    { onApprovalDecided: jest.fn() } as never,
    { onApprovalDecided: jest.fn() } as never,
  );
  return { svc, calls };
}

const ACTOR: ApprovalActor = { userId: 'U-1', personId: 'P-1' };

describe('ApprovalService.getPendingForActor', () => {
  afterEach(() => jest.restoreAllMocks());

  it('OR-filters on both approver_person_id and approver_team_id when caller has team memberships', async () => {
    const { svc, calls } = makeService({
      delegations: [],
      teamMemberships: [{ team_id: 'TEAM-A' }, { team_id: 'TEAM-B' }],
      approvals: [{ id: 'apr-1' }],
    });

    const result = await svc.getPendingForActor(ACTOR);

    expect(result).toEqual([{ id: 'apr-1' }]);
    const approvalsCall = calls.find((c) => c.table === 'approvals');
    expect(approvalsCall?.orClause).toBeDefined();
    // The OR must surface team approvals — the bug was that this clause
    // contained ONLY approver_person_id and team approvals were invisible.
    expect(approvalsCall?.orClause).toContain('approver_person_id.in.(P-1)');
    expect(approvalsCall?.orClause).toContain('approver_team_id.in.(TEAM-A,TEAM-B)');
  });

  it('falls back to the person-only filter when caller has no team memberships', async () => {
    const { svc, calls } = makeService({
      delegations: [],
      teamMemberships: [],
      approvals: [],
    });

    await svc.getPendingForActor(ACTOR);

    const approvalsCall = calls.find((c) => c.table === 'approvals');
    expect(approvalsCall?.orClause).toBeDefined();
    expect(approvalsCall?.orClause).toContain('approver_person_id.in.(P-1)');
    expect(approvalsCall?.orClause).not.toContain('approver_team_id');
  });

  it('expands delegations into the approver_person_id list (preserves pre-fix behavior)', async () => {
    const { svc, calls } = makeService({
      delegations: [{ delegator_user_id: 'U-DELEGATOR' }],
      delegatorUsers: [{ person_id: 'P-DELEGATOR' }],
      teamMemberships: [],
      approvals: [],
    });

    await svc.getPendingForActor(ACTOR);

    const approvalsCall = calls.find((c) => c.table === 'approvals');
    expect(approvalsCall?.orClause).toBeDefined();
    // Both the caller's own person id AND the delegator's must be in the
    // approver_person_id IN list, and order doesn't matter.
    expect(approvalsCall?.orClause).toMatch(/approver_person_id\.in\.\((P-1,P-DELEGATOR|P-DELEGATOR,P-1)\)/);
  });
});

/**
 * Multi-approver gate for `target_entity_type='booking_bundle'`.
 *
 * Bug context: ApprovalRoutingService creates one row per unique approver
 * with no parallel_group / no chain. Treating "no group, no chain" as
 * "fire on first grant" would re-fire the deferred setup-work-order trigger
 * before the other approvers have responded — leaking facilities work for
 * orders that may still get rejected.
 *
 * The fix gates the single-step path behind `areAllTargetApprovalsApproved`,
 * which checks every row on the target. Tests below verify both the helper
 * and the wired-in handler.
 */
describe('ApprovalService — booking_bundle multi-approver resolution', () => {
  afterEach(() => jest.restoreAllMocks());

  function makeBundleService(opts: {
    rowsForTarget: Array<{ status: string }>;
  }): {
    svc: ApprovalService;
    bundleSpy: jest.Mock;
  } {
    const supabase = {
      admin: {
        from(table: string) {
          if (table !== 'approvals') {
            return {
              select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }),
            };
          }
          return {
            select: () => ({
              eq: () => ({
                eq: () => Promise.resolve({ data: opts.rowsForTarget, error: null }),
              }),
            }),
          };
        },
      },
    };

    jest.spyOn(TenantContext, 'current').mockReturnValue({ id: 'T' } as never);

    const bundleSpy = jest.fn().mockResolvedValue(undefined);
    const svc = new ApprovalService(
      supabase as never,
      { onApprovalDecision: jest.fn() } as never,
      { onApprovalDecided: jest.fn() } as never,
      { onApprovalDecided: bundleSpy } as never,
      { onApprovalDecided: jest.fn() } as never,
    );
    return { svc, bundleSpy };
  }

  it('areAllTargetApprovalsApproved returns false when any peer is still pending', async () => {
    const { svc } = makeBundleService({
      rowsForTarget: [
        { status: 'approved' },
        { status: 'pending' },
      ],
    });

    // Test the private helper directly — it's the load-bearing piece.
    const ok = await (svc as unknown as {
      areAllTargetApprovalsApproved: (id: string) => Promise<boolean>;
    }).areAllTargetApprovalsApproved('bundle-1');
    expect(ok).toBe(false);
  });

  it('areAllTargetApprovalsApproved returns true when every row is approved', async () => {
    const { svc } = makeBundleService({
      rowsForTarget: [
        { status: 'approved' },
        { status: 'approved' },
      ],
    });

    const ok = await (svc as unknown as {
      areAllTargetApprovalsApproved: (id: string) => Promise<boolean>;
    }).areAllTargetApprovalsApproved('bundle-1');
    expect(ok).toBe(true);
  });

  it('areAllTargetApprovalsApproved returns false when there are no rows (defensive)', async () => {
    const { svc } = makeBundleService({ rowsForTarget: [] });

    const ok = await (svc as unknown as {
      areAllTargetApprovalsApproved: (id: string) => Promise<boolean>;
    }).areAllTargetApprovalsApproved('bundle-1');
    expect(ok).toBe(false);
  });

  it('areAllTargetApprovalsApproved treats expired rows as resolved (line-cancel re-scope)', async () => {
    // BundleCascadeService.rescopeApprovalsAfterLineCancel sets status
    // 'expired' when an approval's scope_breakdown becomes empty after a
    // line cancel. Treating 'expired' as blocking would deadlock
    // multi-approver bundles whenever any line cancels.
    const { svc } = makeBundleService({
      rowsForTarget: [
        { status: 'expired' },
        { status: 'approved' },
      ],
    });

    const ok = await (svc as unknown as {
      areAllTargetApprovalsApproved: (id: string) => Promise<boolean>;
    }).areAllTargetApprovalsApproved('bundle-1');
    expect(ok).toBe(true);
  });

  it('areAllTargetApprovalsApproved blocks when any row is rejected (defensive)', async () => {
    // The rejection branch in handleBookingBundleApprovalDecided fires
    // before this helper is reached, but if a stale rejected row somehow
    // survives, the helper must not yield a false 'approved'.
    const { svc } = makeBundleService({
      rowsForTarget: [
        { status: 'approved' },
        { status: 'rejected' },
      ],
    });

    const ok = await (svc as unknown as {
      areAllTargetApprovalsApproved: (id: string) => Promise<boolean>;
    }).areAllTargetApprovalsApproved('bundle-1');
    expect(ok).toBe(false);
  });

  it('handleBookingBundleApprovalDecided does NOT call BundleService when peers are pending', async () => {
    const { svc, bundleSpy } = makeBundleService({
      rowsForTarget: [
        { status: 'approved' },
        { status: 'pending' },
      ],
    });

    await (svc as unknown as {
      handleBookingBundleApprovalDecided: (
        approval: { id: string; target_entity_id: string; parallel_group: string | null; approval_chain_id: string | null },
        dto: { status: 'approved' | 'rejected' },
      ) => Promise<void>;
    }).handleBookingBundleApprovalDecided(
      {
        id: 'apr-1',
        target_entity_id: 'bundle-1',
        parallel_group: null,
        approval_chain_id: null,
      },
      { status: 'approved' },
    );

    expect(bundleSpy).not.toHaveBeenCalled();
  });

  it('handleBookingBundleApprovalDecided calls BundleService once all peers are approved', async () => {
    const { svc, bundleSpy } = makeBundleService({
      rowsForTarget: [
        { status: 'approved' },
        { status: 'approved' },
      ],
    });

    await (svc as unknown as {
      handleBookingBundleApprovalDecided: (
        approval: { id: string; target_entity_id: string; parallel_group: string | null; approval_chain_id: string | null },
        dto: { status: 'approved' | 'rejected' },
      ) => Promise<void>;
    }).handleBookingBundleApprovalDecided(
      {
        id: 'apr-1',
        target_entity_id: 'bundle-1',
        parallel_group: null,
        approval_chain_id: null,
      },
      { status: 'approved' },
    );

    expect(bundleSpy).toHaveBeenCalledWith('bundle-1', 'approved');
  });

  it('handleBookingBundleApprovalDecided fires immediately on rejection — no peer wait', async () => {
    // Even with peers still pending, a rejection ends the bundle approval
    // immediately. Persisted args are cleared by BundleService so a later
    // peer-grant cannot accidentally re-fire.
    const { svc, bundleSpy } = makeBundleService({
      rowsForTarget: [
        { status: 'rejected' },
        { status: 'pending' },
      ],
    });

    await (svc as unknown as {
      handleBookingBundleApprovalDecided: (
        approval: { id: string; target_entity_id: string; parallel_group: string | null; approval_chain_id: string | null },
        dto: { status: 'approved' | 'rejected' },
      ) => Promise<void>;
    }).handleBookingBundleApprovalDecided(
      {
        id: 'apr-1',
        target_entity_id: 'bundle-1',
        parallel_group: null,
        approval_chain_id: null,
      },
      { status: 'rejected' },
    );

    expect(bundleSpy).toHaveBeenCalledWith('bundle-1', 'rejected');
  });
});

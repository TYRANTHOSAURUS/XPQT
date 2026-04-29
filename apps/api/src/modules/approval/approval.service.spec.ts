import { ApprovalService, type ApprovalActor } from './approval.service';

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

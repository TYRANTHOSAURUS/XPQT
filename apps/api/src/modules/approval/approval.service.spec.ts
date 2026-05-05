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
 * B.0.D.3 — booking-target approval grant goes through the atomic
 * `grant_booking_approval` RPC (00310 / spec §10.1). The TS-side multi-step
 * write (approvals CAS + booking_slots + bookings + bundle cascade) is
 * collapsed into one Postgres transaction.
 *
 * The pre-cutover tests exercised the all-resolved gate
 * (`areAllTargetApprovalsApproved`) directly — that helper is now retired
 * (its semantics live inside the RPC). The new tests exercise the
 * dispatcher: respond() calls the RPC, surfaces the `kind` outcomes, and
 * fires the post-RPC notification fan-out only on the `resolved` outcome.
 */
describe('ApprovalService — booking grant via grant_booking_approval RPC (B.0.D.3)', () => {
  afterEach(() => jest.restoreAllMocks());

  type RpcCall = { fn: string; args: Record<string, unknown> };
  type RpcStub = (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;

  function makeBookingService(opts: {
    approval: Record<string, unknown>;
    rpcStub: RpcStub;
    /** Returned for the post-RPC slot+booking re-read on `resolved` outcome. */
    refreshedSlot?: Record<string, unknown> | null;
  }): {
    svc: ApprovalService;
    rpcCalls: RpcCall[];
    notificationSpy: jest.Mock;
  } {
    const rpcCalls: RpcCall[] = [];
    const supabase = {
      admin: {
        rpc: jest.fn(async (fn: string, args: Record<string, unknown>) => {
          rpcCalls.push({ fn, args });
          return opts.rpcStub(fn, args);
        }),
        from(table: string) {
          if (table === 'approvals') {
            // .select('*').eq('id', ...).eq('tenant_id', ...).single()
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    single: () => Promise.resolve({ data: opts.approval, error: null }),
                  }),
                }),
              }),
            };
          }
          if (table === 'booking_slots') {
            // Post-RPC slot+booking re-read for the notification fan-out.
            // .select(SELECT).eq().eq().order().limit().maybeSingle()
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    order: () => ({
                      limit: () => ({
                        maybeSingle: () =>
                          Promise.resolve({ data: opts.refreshedSlot ?? null, error: null }),
                      }),
                    }),
                  }),
                }),
              }),
            };
          }
          // Fallback for the auth gate's team_members / users / delegations queries.
          return {
            select: () => ({
              eq: () => ({
                eq: () => Promise.resolve({ data: null, error: null }),
                maybeSingle: () => Promise.resolve({ data: null, error: null }),
              }),
            }),
          };
        },
      },
    };

    jest.spyOn(TenantContext, 'current').mockReturnValue({ id: 'T' } as never);

    const notificationSpy = jest.fn().mockResolvedValue(undefined);
    const svc = new ApprovalService(
      supabase as never,
      { onApprovalDecision: jest.fn() } as never,
      { onApprovalDecided: notificationSpy } as never,
      // BundleService is no longer called from the booking branch — but the
      // constructor still requires it. Provide a stub.
      { onApprovalDecided: jest.fn() } as never,
      { onApprovalDecided: jest.fn() } as never,
    );

    // Make `callerCanRespond` always succeed for the test's actor — the
    // tests below assume the caller is the named approver.
    jest
      .spyOn(svc as unknown as { callerCanRespond: () => Promise<boolean> }, 'callerCanRespond')
      .mockResolvedValue(true);

    return { svc, rpcCalls, notificationSpy };
  }

  function approvalRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'apr-1',
      tenant_id: 'T',
      target_entity_type: 'booking',
      target_entity_id: 'booking-1',
      parallel_group: null,
      approval_chain_id: null,
      status: 'pending',
      approver_person_id: 'P-1',
      approver_team_id: null,
      ...overrides,
    };
  }

  it('routes booking-target grant through grant_booking_approval RPC', async () => {
    const { svc, rpcCalls } = makeBookingService({
      approval: approvalRow(),
      rpcStub: () =>
        Promise.resolve({
          data: {
            kind: 'resolved',
            approval_id: 'apr-1',
            booking_id: 'booking-1',
            final_decision: 'approved',
            new_status: 'confirmed',
            slots_transitioned: 1,
            booking_transitioned: true,
            setup_emit: { emitted_count: 0 },
          },
          error: null,
        }),
    });

    const result = await svc.respond(
      'apr-1',
      { status: 'approved' },
      'P-1',
      'U-1',
      '11111111-1111-4111-8111-111111111111',
    );

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe('grant_booking_approval');
    expect(rpcCalls[0].args).toMatchObject({
      p_approval_id: 'apr-1',
      p_tenant_id: 'T',
      p_actor_user_id: 'U-1',
      p_decision: 'approved',
    });
    expect((result as { kind: string }).kind).toBe('resolved');
  });

  it('threads idempotency_key as `approval.grant:${approvalId}:${clientRequestId}`', async () => {
    const { svc, rpcCalls } = makeBookingService({
      approval: approvalRow(),
      rpcStub: () =>
        Promise.resolve({
          data: { kind: 'partial_approved', approval_id: 'apr-1', remaining: 1 },
          error: null,
        }),
    });

    await svc.respond(
      'apr-1',
      { status: 'approved' },
      'P-1',
      'U-1',
      'aaaa1111-2222-4333-8444-555566667777',
    );

    expect(rpcCalls[0].args.p_idempotency_key).toBe(
      'approval.grant:apr-1:aaaa1111-2222-4333-8444-555566667777',
    );
  });

  it('surfaces the partial_approved RPC outcome to the caller (waiting on peers)', async () => {
    const { svc, notificationSpy } = makeBookingService({
      approval: approvalRow(),
      rpcStub: () =>
        Promise.resolve({
          data: { kind: 'partial_approved', approval_id: 'apr-1', remaining: 2 },
          error: null,
        }),
    });

    const result = await svc.respond('apr-1', { status: 'approved' }, 'P-1', 'U-1');

    expect(result).toMatchObject({ kind: 'partial_approved', remaining: 2 });
    // Notification only fires on `resolved` — partial_approved means
    // peers are still pending, so the requester shouldn't be told yet.
    expect(notificationSpy).not.toHaveBeenCalled();
  });

  it('fires post-RPC notification on resolved approved outcome', async () => {
    const refreshedSlot = {
      id: 'slot-1',
      tenant_id: 'T',
      booking_id: 'booking-1',
      bookings: {
        id: 'booking-1',
        tenant_id: 'T',
        title: null,
        description: null,
        requester_person_id: 'P-REQ',
        host_person_id: null,
        booked_by_user_id: 'U-1',
        location_id: 'space-1',
        start_at: '2026-05-01T09:00:00Z',
        end_at: '2026-05-01T10:00:00Z',
        timezone: 'UTC',
        status: 'confirmed',
        source: 'portal',
        cost_center_id: null,
        cost_amount_snapshot: null,
        policy_snapshot: { matched_rule_ids: [], effects_seen: [] },
        applied_rule_ids: [],
        config_release_id: null,
        recurrence_series_id: null,
        recurrence_index: null,
        recurrence_overridden: false,
        recurrence_skipped: false,
        template_id: null,
        calendar_event_id: null,
        calendar_provider: null,
        calendar_etag: null,
        calendar_last_synced_at: null,
        created_at: '2026-05-01T08:00:00Z',
        updated_at: '2026-05-01T08:00:00Z',
      },
      slot_type: 'room',
      space_id: 'space-1',
      start_at: '2026-05-01T09:00:00Z',
      end_at: '2026-05-01T10:00:00Z',
      attendee_count: 4,
      attendee_person_ids: [],
      setup_buffer_minutes: 0,
      teardown_buffer_minutes: 0,
      status: 'confirmed',
      check_in_required: false,
      check_in_grace_minutes: 15,
      checked_in_at: null,
      released_at: null,
      cancellation_grace_until: null,
      display_order: 0,
    };

    const { svc, notificationSpy } = makeBookingService({
      approval: approvalRow(),
      refreshedSlot,
      rpcStub: () =>
        Promise.resolve({
          data: {
            kind: 'resolved',
            approval_id: 'apr-1',
            booking_id: 'booking-1',
            final_decision: 'approved',
            new_status: 'confirmed',
            slots_transitioned: 1,
            booking_transitioned: true,
            setup_emit: { emitted_count: 1 },
          },
          error: null,
        }),
    });

    await svc.respond('apr-1', { status: 'approved' }, 'P-1', 'U-1');

    expect(notificationSpy).toHaveBeenCalledTimes(1);
    expect(notificationSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'booking-1' }),
      'approved',
      undefined,
    );
  });

  it('does not throw if notification fan-out fails (best-effort post-RPC)', async () => {
    const { svc, notificationSpy } = makeBookingService({
      approval: approvalRow(),
      refreshedSlot: null, // no slot row → notification short-circuits cleanly
      rpcStub: () =>
        Promise.resolve({
          data: {
            kind: 'resolved',
            approval_id: 'apr-1',
            booking_id: 'booking-1',
            final_decision: 'rejected',
            new_status: 'cancelled',
            slots_transitioned: 1,
            booking_transitioned: true,
            setup_emit: { emitted_count: 0, reason: 'rejected' },
          },
          error: null,
        }),
    });

    await expect(
      svc.respond('apr-1', { status: 'rejected' }, 'P-1', 'U-1'),
    ).resolves.toMatchObject({ kind: 'resolved', final_decision: 'rejected' });
    expect(notificationSpy).not.toHaveBeenCalled();
  });

  it('maps already_responded RPC outcome to BadRequestException', async () => {
    const { svc } = makeBookingService({
      approval: approvalRow(),
      rpcStub: () =>
        Promise.resolve({
          data: {
            kind: 'already_responded',
            approval_id: 'apr-1',
            prior_status: 'approved',
          },
          error: null,
        }),
    });

    await expect(
      svc.respond('apr-1', { status: 'approved' }, 'P-1', 'U-1'),
    ).rejects.toThrow('Approval already responded to');
  });

  it('maps RPC error approval.cas_lost to ConflictException', async () => {
    const { svc } = makeBookingService({
      approval: approvalRow(),
      rpcStub: () =>
        Promise.resolve({
          data: null,
          error: { code: 'P0001', message: 'approval.cas_lost id=apr-1' },
        }),
    });

    await expect(
      svc.respond('apr-1', { status: 'approved' }, 'P-1', 'U-1'),
    ).rejects.toThrow(/Approval state changed/);
  });

  it('maps RPC error approval.not_found to NotFoundException', async () => {
    const { svc } = makeBookingService({
      approval: approvalRow(),
      rpcStub: () =>
        Promise.resolve({
          data: null,
          error: { code: 'P0002', message: 'approval.not_found id=apr-1 tenant=T' },
        }),
    });

    await expect(
      svc.respond('apr-1', { status: 'approved' }, 'P-1', 'U-1'),
    ).rejects.toThrow('Approval not found');
  });

  it('does NOT call grant_booking_approval for non-booking targets', async () => {
    // Ticket-target approvals stay on the legacy TS path — verify the
    // dispatcher routes them away from the booking-RPC.
    const { svc, rpcCalls } = makeBookingService({
      approval: approvalRow({ target_entity_type: 'ticket' }),
      rpcStub: () => Promise.resolve({ data: null, error: null }),
    });

    // The legacy path's `from('approvals').update(...).eq().select().maybeSingle()`
    // will hit the fallback chain; we don't assert its result here, just
    // that the RPC wasn't called.
    try {
      await svc.respond('apr-1', { status: 'approved' }, 'P-1', 'U-1');
    } catch {
      // The legacy path may throw because the fallback mock is
      // intentionally minimal — that's fine for this test.
    }

    expect(rpcCalls.find((c) => c.fn === 'grant_booking_approval')).toBeUndefined();
  });
});

/**
 * ReceptionService — today-view + walk-up + checkout unit tests.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §7
 *
 * Collaborators are mocked at their public surface:
 *   - DbService — answers the today-view + search + daily-list + count
 *     queries with canned rows. Tests assert which SQL fired and what
 *     params landed (visibility scoping is the visible-CTE — we don't
 *     re-test the SQL function, we trust it).
 *   - VisitorService — transitionStatus is the only path that writes
 *     visitors.status; we capture calls and assert ordering.
 *   - InvitationService — quickAddWalkup composes via .create(); we
 *     assert the outgoing DTO + actor shape.
 *   - VisitorPassPoolService — return / mark-missing called from
 *     markCheckedOut depending on `pass_returned`.
 *   - HostNotificationService — fan-out fires inline on arrival.
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ReceptionService } from './reception.service';
import { TenantContext } from '../../common/tenant-context';
import type { QuickAddWalkupDto } from './dto/reception.dto';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = '99999999-9999-4999-8999-999999999999';
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PERSON_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BUILDING_ID = '22222222-2222-4222-8222-222222222222';
const VISITOR_ID = '33333333-3333-4333-8333-333333333333';
const HOST_PERSON_ID = '44444444-4444-4444-8444-444444444444';
const PASS_ID = '55555555-5555-4555-8555-555555555555';
const TYPE_GUEST = '66666666-6666-4666-8666-666666666666';
const TYPE_INTERVIEW = '77777777-7777-4777-8777-777777777777';
const TYPE_DELIVERY_NO_WALKUP = '88888888-8888-4888-8888-888888888888';

const ACTOR = { user_id: USER_ID, person_id: PERSON_ID, tenant_id: TENANT_ID };

interface FakeOpts {
  /** Rows to return for the today-view query. */
  todayRows?: Array<Record<string, unknown>>;
  /** Rows for trigram search. */
  trigramRows?: Array<Record<string, unknown>>;
  /** Rows for ilike fallback. */
  ilikeRows?: Array<Record<string, unknown>>;
  /** Rows for daily list. */
  dailyRows?: Array<Record<string, unknown>>;
  /** Visitor type loaded for quick-add. */
  visitorType?: {
    id: string;
    tenant_id: string;
    requires_approval: boolean;
    allow_walk_up: boolean;
    default_expected_until_offset_minutes: number;
    active: boolean;
  } | null;
  /** Visitor row for markCheckedOut / loadVisitorExpectedAt. */
  visitorRow?: {
    id: string;
    tenant_id: string;
    visitor_pass_id: string | null;
    expected_at?: string | null;
  } | null;
  /** Auto-check-out aggregate for yesterdayLooseEnds. */
  autoCount?: number;
  /** Bounced invites returned by VisitorMailDeliveryAdapter mock. */
  bouncedInvites?: Array<Record<string, unknown>>;
}

function makeHarness(opts: FakeOpts = {}) {
  const sqlCalls: Array<{ sql: string; params?: unknown[] }> = [];

  const db = {
    queryMany: jest.fn(async (sql: string, params?: unknown[]) => {
      sqlCalls.push({ sql, params });
      const trimmed = sql.trim().toLowerCase();
      // Order matters — daily-list is a superset of trigram/today, so
      // distinguish first.
      if (trimmed.includes('similarity(')) {
        return opts.trigramRows ?? [];
      }
      if (trimmed.includes('ilike $4')) {
        return opts.ilikeRows ?? [];
      }
      if (trimmed.includes('case')) {
        return opts.todayRows ?? [];
      }
      if (trimmed.includes('order by coalesce(v.expected_at, v.arrived_at) asc')) {
        return opts.dailyRows ?? [];
      }
      return [];
    }),
    queryOne: jest.fn(async (sql: string, _params?: unknown[]) => {
      sqlCalls.push({ sql });
      const trimmed = sql.trim().toLowerCase();
      if (trimmed.includes('from public.visitor_types')) {
        return opts.visitorType === null ? null : (opts.visitorType ?? null);
      }
      if (trimmed.includes('select id, tenant_id, visitor_pass_id from public.visitors')) {
        return opts.visitorRow ?? null;
      }
      if (trimmed.includes('select expected_at, tenant_id from public.visitors')) {
        return opts.visitorRow ?? null;
      }
      if (trimmed.includes('auto_checked_out_count')) {
        return { auto_checked_out_count: opts.autoCount ?? 0 };
      }
      return null;
    }),
    queryOneFromVisitors: jest.fn(),
    tx: jest.fn(),
  };

  const transitionCalls: Array<{
    visitor_id: string;
    to: string;
    actor: { user_id: string; person_id: string | null };
    opts?: Record<string, unknown>;
  }> = [];
  const visitors = {
    transitionStatus: jest.fn(
      async (
        visitor_id: string,
        to: string,
        actor: { user_id: string; person_id: string | null },
        txOpts?: Record<string, unknown>,
      ) => {
        transitionCalls.push({ visitor_id, to, actor, opts: txOpts });
        return { id: visitor_id, status: to };
      },
    ),
  };

  const inviteCalls: Array<{ dto: Record<string, unknown>; actor: Record<string, unknown> }> = [];
  const invitations = {
    create: jest.fn(async (dto: Record<string, unknown>, actor: Record<string, unknown>) => {
      inviteCalls.push({ dto, actor });
      return { visitor_id: VISITOR_ID, status: 'expected', approval_id: null, cancel_token: 'tok' };
    }),
  };

  const passPoolCalls: Array<{ method: string; args: unknown[] }> = [];
  const passPool = {
    returnPass: jest.fn(async (...args: unknown[]) => {
      passPoolCalls.push({ method: 'returnPass', args });
    }),
    markPassMissing: jest.fn(async (...args: unknown[]) => {
      passPoolCalls.push({ method: 'markPassMissing', args });
    }),
    unreturnedPassesForBuilding: jest.fn(async () => []),
  };

  const hostNotifyCalls: Array<{ visitor_id: string; tenant_id: string }> = [];
  const hostNotifications = {
    notifyArrival: jest.fn(async (visitor_id: string, tenant_id: string) => {
      hostNotifyCalls.push({ visitor_id, tenant_id });
    }),
  };

  const mailDeliveryCalls: Array<{ method: string; args: unknown[] }> = [];
  const mailDelivery = {
    bouncedInvitesForBuildingSince: jest.fn(async (...args: unknown[]) => {
      mailDeliveryCalls.push({ method: 'bouncedInvitesForBuildingSince', args });
      return opts.bouncedInvites ?? [];
    }),
  };

  jest.spyOn(TenantContext, 'current').mockReturnValue({ id: TENANT_ID } as never);

  const svc = new ReceptionService(
    db as never,
    visitors as never,
    invitations as never,
    passPool as never,
    hostNotifications as never,
    mailDelivery as never,
  );

  return {
    svc,
    sqlCalls,
    transitionCalls,
    inviteCalls,
    passPoolCalls,
    hostNotifyCalls,
    mailDeliveryCalls,
    db,
    visitors,
    invitations,
    passPool,
    hostNotifications,
    mailDelivery,
  };
}

const TYPE_GUEST_ROW = {
  id: TYPE_GUEST,
  tenant_id: TENANT_ID,
  requires_approval: false,
  allow_walk_up: true,
  default_expected_until_offset_minutes: 240,
  active: true,
};

describe('ReceptionService', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('today()', () => {
    it('partitions visitors into the four buckets per their bucket tag', async () => {
      const ctx = makeHarness({
        todayRows: [
          {
            visitor_id: 'v1',
            first_name: 'Alice',
            last_name: null,
            company: null,
            primary_host_first_name: 'Anne',
            primary_host_last_name: null,
            expected_at: null,
            arrived_at: '2026-05-01T08:55:00Z',
            status: 'arrived',
            visitor_pass_id: null,
            pass_number: null,
            visitor_type_id: TYPE_GUEST,
            bucket: 'currently_arriving',
          },
          {
            visitor_id: 'v2',
            first_name: 'Bob',
            last_name: null,
            company: null,
            primary_host_first_name: 'Henk',
            primary_host_last_name: null,
            expected_at: '2026-05-01T10:00:00Z',
            arrived_at: null,
            status: 'expected',
            visitor_pass_id: null,
            pass_number: null,
            visitor_type_id: TYPE_GUEST,
            bucket: 'expected',
          },
          {
            visitor_id: 'v3',
            first_name: 'Carol',
            last_name: null,
            company: null,
            primary_host_first_name: 'Joep',
            primary_host_last_name: null,
            expected_at: null,
            arrived_at: '2026-05-01T08:00:00Z',
            status: 'in_meeting',
            visitor_pass_id: null,
            pass_number: null,
            visitor_type_id: TYPE_GUEST,
            bucket: 'in_meeting',
          },
          {
            visitor_id: 'v4',
            first_name: 'Dan',
            last_name: null,
            company: null,
            primary_host_first_name: 'Anne',
            primary_host_last_name: null,
            expected_at: null,
            arrived_at: '2026-05-01T08:00:00Z',
            status: 'checked_out',
            visitor_pass_id: null,
            pass_number: null,
            visitor_type_id: TYPE_GUEST,
            bucket: 'checked_out_today',
          },
        ],
      });

      const view = await ctx.svc.today(TENANT_ID, BUILDING_ID, USER_ID);
      expect(view.currently_arriving).toHaveLength(1);
      expect(view.expected).toHaveLength(1);
      expect(view.in_meeting).toHaveLength(1);
      expect(view.checked_out_today).toHaveLength(1);
      expect(view.building_id).toBe(BUILDING_ID);
    });

    it('returns arrived rows even when arrived_at is older than the 30-minute window', async () => {
      // Regression for the "all my visitors are gone" bug: the WHERE
      // clause used to require `arrived_at >= now - 30min` for `arrived`
      // rows, which silently dropped any visitor who arrived more than
      // 30 minutes ago and was never transitioned to in_meeting. The
      // backend now returns them under bucket='in_meeting' so the
      // frontend's buildTodayBuckets() can route them to the on-site
      // bucket via status + arrived_at.
      const ctx = makeHarness({
        todayRows: [
          {
            visitor_id: 'v_old_arrived',
            first_name: 'Old',
            last_name: null,
            company: null,
            primary_host_first_name: null,
            primary_host_last_name: null,
            expected_at: null,
            arrived_at: '2026-05-01T07:00:00Z',
            status: 'arrived',
            visitor_pass_id: null,
            pass_number: null,
            visitor_type_id: TYPE_GUEST,
            bucket: 'in_meeting',
          },
        ],
      });
      const view = await ctx.svc.today(TENANT_ID, BUILDING_ID, USER_ID);
      expect(view.in_meeting).toHaveLength(1);
      expect(view.in_meeting[0].visitor_id).toBe('v_old_arrived');
      expect(view.currently_arriving).toHaveLength(0);
    });

    it("includes 'arrived' rows unconditionally in the today WHERE clause", async () => {
      // Pin the SQL shape so a future regression (re-adding `and v.arrived_at >= $4`
      // to the arrived branch) fails this test directly rather than only
      // surfacing as missing rows in production.
      const ctx = makeHarness({ todayRows: [] });
      await ctx.svc.today(TENANT_ID, BUILDING_ID, USER_ID);
      const todayCall = ctx.sqlCalls.find((c) =>
        c.sql.toLowerCase().includes('visitor_visibility_ids'),
      );
      expect(todayCall).toBeTruthy();
      // The 'arrived' branch in the WHERE must NOT carry an arrived_at
      // window; the bucket label uses $4 but the predicate doesn't.
      expect(todayCall!.sql).toMatch(/v\.status = 'arrived'\)\s*or/);
    });

    it('passes user_id + tenant_id to the visibility CTE', async () => {
      const ctx = makeHarness({ todayRows: [] });
      await ctx.svc.today(TENANT_ID, BUILDING_ID, USER_ID);
      const todayCall = ctx.sqlCalls.find((c) =>
        c.sql.toLowerCase().includes('visitor_visibility_ids'),
      );
      expect(todayCall).toBeTruthy();
      // params: [userId, tenantId, buildingId, arrivedSince, dayStart, dayEnd]
      expect(todayCall!.params?.[0]).toBe(USER_ID);
      expect(todayCall!.params?.[1]).toBe(TENANT_ID);
      expect(todayCall!.params?.[2]).toBe(BUILDING_ID);
    });

    it('rejects when tenant context does not match', async () => {
      const ctx = makeHarness({});
      await expect(ctx.svc.today(OTHER_TENANT_ID, BUILDING_ID, USER_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('search()', () => {
    it('uses the trigram path when results exist', async () => {
      const ctx = makeHarness({
        trigramRows: [
          {
            visitor_id: VISITOR_ID,
            first_name: 'Marleen',
            last_name: 'Visser',
            company: null,
            primary_host_first_name: 'Anne',
            primary_host_last_name: null,
            expected_at: '2026-05-01T09:30:00Z',
            arrived_at: null,
            status: 'expected',
            visitor_pass_id: null,
            pass_number: null,
            visitor_type_id: TYPE_GUEST,
            score: 0.9,
          },
        ],
      });
      const rows = await ctx.svc.search(TENANT_ID, BUILDING_ID, USER_ID, 'marl');
      expect(rows).toHaveLength(1);
      expect(rows[0].first_name).toBe('Marleen');
      // ILIKE fallback should NOT have been queried
      const trigram = ctx.sqlCalls.filter((c) => c.sql.toLowerCase().includes('similarity('));
      const ilike = ctx.sqlCalls.filter((c) => c.sql.toLowerCase().includes('ilike $4'));
      expect(trigram).toHaveLength(1);
      expect(ilike).toHaveLength(0);
    });

    it('falls back to ILIKE when trigram returns 0 rows', async () => {
      const ctx = makeHarness({
        trigramRows: [],
        ilikeRows: [
          {
            visitor_id: VISITOR_ID,
            first_name: 'Bo',
            last_name: null,
            company: null,
            primary_host_first_name: null,
            primary_host_last_name: null,
            expected_at: null,
            arrived_at: '2026-05-01T08:55:00Z',
            status: 'arrived',
            visitor_pass_id: null,
            pass_number: null,
            visitor_type_id: TYPE_GUEST,
            score: 0,
          },
        ],
      });
      const rows = await ctx.svc.search(TENANT_ID, BUILDING_ID, USER_ID, 'bo');
      expect(rows).toHaveLength(1);
      const ilike = ctx.sqlCalls.filter((c) => c.sql.toLowerCase().includes('ilike $4'));
      expect(ilike).toHaveLength(1);
    });

    it('returns [] when query is empty', async () => {
      const ctx = makeHarness({});
      const rows = await ctx.svc.search(TENANT_ID, BUILDING_ID, USER_ID, '   ');
      expect(rows).toEqual([]);
      expect(ctx.sqlCalls).toHaveLength(0);
    });

    it('rejects when tenant context does not match', async () => {
      const ctx = makeHarness({});
      await expect(
        ctx.svc.search(OTHER_TENANT_ID, BUILDING_ID, USER_ID, 'x'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('quickAddWalkup()', () => {
    const dto: QuickAddWalkupDto = {
      first_name: 'Hans',
      company: 'Pieter Vendor',
      visitor_type_id: TYPE_GUEST,
      primary_host_person_id: HOST_PERSON_ID,
    };

    it('creates a visitor at status=expected then transitions to arrived', async () => {
      const ctx = makeHarness({ visitorType: TYPE_GUEST_ROW });
      const result = await ctx.svc.quickAddWalkup(TENANT_ID, BUILDING_ID, dto, ACTOR);
      expect(result.visitor_id).toBe(VISITOR_ID);

      // InvitationService.create called with the actor as the host.
      expect(ctx.inviteCalls).toHaveLength(1);
      expect(ctx.inviteCalls[0].actor).toMatchObject({
        user_id: USER_ID,
        person_id: HOST_PERSON_ID,  // host is the inviter
        tenant_id: TENANT_ID,
      });
      expect(ctx.inviteCalls[0].dto).toMatchObject({
        first_name: 'Hans',
        building_id: BUILDING_ID,
      });

      // VisitorService.transitionStatus called with arrived
      expect(ctx.transitionCalls).toHaveLength(1);
      expect(ctx.transitionCalls[0].to).toBe('arrived');
      expect(ctx.transitionCalls[0].actor).toMatchObject({ user_id: USER_ID, person_id: PERSON_ID });

      // HostNotificationService fired inline
      expect(ctx.hostNotifyCalls).toHaveLength(1);
      expect(ctx.hostNotifyCalls[0]).toMatchObject({ visitor_id: VISITOR_ID, tenant_id: TENANT_ID });
    });

    it('blocks when visitor type disallows walk-up', async () => {
      const ctx = makeHarness({
        visitorType: {
          ...TYPE_GUEST_ROW,
          id: TYPE_DELIVERY_NO_WALKUP,
          allow_walk_up: false,
        },
      });
      await expect(
        ctx.svc.quickAddWalkup(TENANT_ID, BUILDING_ID, { ...dto, visitor_type_id: TYPE_DELIVERY_NO_WALKUP }, ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(ctx.inviteCalls).toHaveLength(0);
    });

    it('blocks when visitor type requires approval', async () => {
      const ctx = makeHarness({
        visitorType: {
          ...TYPE_GUEST_ROW,
          id: TYPE_INTERVIEW,
          requires_approval: true,
        },
      });
      await expect(
        ctx.svc.quickAddWalkup(TENANT_ID, BUILDING_ID, { ...dto, visitor_type_id: TYPE_INTERVIEW }, ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(ctx.inviteCalls).toHaveLength(0);
    });

    it('rejects when actor.tenant_id does not match the call', async () => {
      const ctx = makeHarness({ visitorType: TYPE_GUEST_ROW });
      await expect(
        ctx.svc.quickAddWalkup(TENANT_ID, BUILDING_ID, dto, { ...ACTOR, tenant_id: OTHER_TENANT_ID }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects future arrived_at', async () => {
      const ctx = makeHarness({ visitorType: TYPE_GUEST_ROW });
      const future = new Date(Date.now() + 10 * 60_000).toISOString();
      await expect(
        ctx.svc.quickAddWalkup(TENANT_ID, BUILDING_ID, { ...dto, arrived_at: future }, ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('returns NotFound when visitor type is missing', async () => {
      const ctx = makeHarness({ visitorType: null });
      await expect(
        ctx.svc.quickAddWalkup(TENANT_ID, BUILDING_ID, dto, ACTOR),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('markArrived()', () => {
    it('routes through VisitorService.transitionStatus with the arrived_at opt', async () => {
      const ctx = makeHarness({
        visitorRow: { id: VISITOR_ID, tenant_id: TENANT_ID, visitor_pass_id: null, expected_at: '2026-05-01T09:00:00Z' },
      });
      const arrived = '2026-05-01T08:55:00Z';
      await ctx.svc.markArrived(
        TENANT_ID,
        VISITOR_ID,
        { user_id: USER_ID, person_id: PERSON_ID },
        { arrived_at: arrived },
      );
      expect(ctx.transitionCalls).toHaveLength(1);
      expect(ctx.transitionCalls[0]).toMatchObject({
        visitor_id: VISITOR_ID,
        to: 'arrived',
        opts: { arrived_at: arrived },
      });
      // Host notify fired inline
      expect(ctx.hostNotifyCalls).toHaveLength(1);
    });

    it('rejects future arrived_at', async () => {
      const ctx = makeHarness({
        visitorRow: { id: VISITOR_ID, tenant_id: TENANT_ID, visitor_pass_id: null, expected_at: '2026-05-01T09:00:00Z' },
      });
      const future = new Date(Date.now() + 10 * 60_000).toISOString();
      await expect(
        ctx.svc.markArrived(
          TENANT_ID,
          VISITOR_ID,
          { user_id: USER_ID, person_id: PERSON_ID },
          { arrived_at: future },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects arrived_at more than 24h before expected_at', async () => {
      const ctx = makeHarness({
        visitorRow: {
          id: VISITOR_ID,
          tenant_id: TENANT_ID,
          visitor_pass_id: null,
          expected_at: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
        },
      });
      // arrived 26h before expected
      const fakeArrived = new Date(
        new Date(ctx.visitors.transitionStatus as never).valueOf() // unused
          ? Date.now()
          : Date.now() - 26 * 60 * 60_000,
      ).toISOString();
      // simpler:
      const tooEarly = new Date(Date.now() - 30 * 60 * 60_000).toISOString();
      await expect(
        ctx.svc.markArrived(
          TENANT_ID,
          VISITOR_ID,
          { user_id: USER_ID, person_id: PERSON_ID },
          { arrived_at: tooEarly },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fakeArrived).toBeTruthy(); // silence unused
    });
  });

  describe('markCheckedOut()', () => {
    it('returns the pass when pass_returned=true', async () => {
      const ctx = makeHarness({
        visitorRow: { id: VISITOR_ID, tenant_id: TENANT_ID, visitor_pass_id: PASS_ID },
      });
      await ctx.svc.markCheckedOut(
        TENANT_ID,
        VISITOR_ID,
        { user_id: USER_ID, person_id: PERSON_ID },
        { checkout_source: 'reception', pass_returned: true },
      );
      expect(ctx.transitionCalls[0]).toMatchObject({
        to: 'checked_out',
        opts: { checkout_source: 'reception', visitor_pass_id: PASS_ID },
      });
      const returned = ctx.passPoolCalls.find((c) => c.method === 'returnPass');
      expect(returned).toBeTruthy();
      expect(returned!.args[0]).toBe(PASS_ID);
    });

    it('marks the pass missing when pass_returned=false', async () => {
      const ctx = makeHarness({
        visitorRow: { id: VISITOR_ID, tenant_id: TENANT_ID, visitor_pass_id: PASS_ID },
      });
      await ctx.svc.markCheckedOut(
        TENANT_ID,
        VISITOR_ID,
        { user_id: USER_ID, person_id: PERSON_ID },
        { checkout_source: 'reception', pass_returned: false },
      );
      const missing = ctx.passPoolCalls.find((c) => c.method === 'markPassMissing');
      expect(missing).toBeTruthy();
      expect(missing!.args[0]).toBe(PASS_ID);
    });

    it('skips pass actions when pass_returned is omitted (reconcile later)', async () => {
      const ctx = makeHarness({
        visitorRow: { id: VISITOR_ID, tenant_id: TENANT_ID, visitor_pass_id: PASS_ID },
      });
      await ctx.svc.markCheckedOut(
        TENANT_ID,
        VISITOR_ID,
        { user_id: USER_ID, person_id: PERSON_ID },
        { checkout_source: 'reception' },
      );
      expect(ctx.passPoolCalls).toHaveLength(0);
    });

    it('skips pass actions when visitor has no pass', async () => {
      const ctx = makeHarness({
        visitorRow: { id: VISITOR_ID, tenant_id: TENANT_ID, visitor_pass_id: null },
      });
      await ctx.svc.markCheckedOut(
        TENANT_ID,
        VISITOR_ID,
        { user_id: USER_ID, person_id: PERSON_ID },
        { checkout_source: 'host', pass_returned: true },
      );
      expect(ctx.passPoolCalls).toHaveLength(0);
    });

    it('rejects unknown checkout sources from this surface', async () => {
      const ctx = makeHarness({
        visitorRow: { id: VISITOR_ID, tenant_id: TENANT_ID, visitor_pass_id: null },
      });
      await expect(
        ctx.svc.markCheckedOut(
          TENANT_ID,
          VISITOR_ID,
          { user_id: USER_ID, person_id: PERSON_ID },
          { checkout_source: 'eod_sweep' as never },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws NotFound when visitor is missing', async () => {
      const ctx = makeHarness({ visitorRow: null });
      await expect(
        ctx.svc.markCheckedOut(
          TENANT_ID,
          VISITOR_ID,
          { user_id: USER_ID, person_id: PERSON_ID },
          { checkout_source: 'reception' },
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('markNoShow()', () => {
    it('routes through transitionStatus to no_show', async () => {
      const ctx = makeHarness({});
      await ctx.svc.markNoShow(TENANT_ID, VISITOR_ID, { user_id: USER_ID, person_id: PERSON_ID });
      expect(ctx.transitionCalls[0]).toMatchObject({ to: 'no_show', visitor_id: VISITOR_ID });
    });
  });

  describe('yesterdayLooseEnds()', () => {
    it('aggregates auto_checked_out count + delegates passes to passPool', async () => {
      const ctx = makeHarness({ autoCount: 12 });
      ctx.passPool.unreturnedPassesForBuilding.mockResolvedValue([
        {
          id: PASS_ID,
          tenant_id: TENANT_ID,
          space_id: BUILDING_ID,
          space_kind: 'building',
          pass_number: '042',
          pass_type: 'standard',
          status: 'lost',
          current_visitor_id: null,
          reserved_for_visitor_id: null,
          last_assigned_at: '2026-04-30T16:00:00Z',
          notes: null,
          created_at: '2026-04-30T08:00:00Z',
          updated_at: '2026-04-30T08:00:00Z',
        },
      ] as never);

      const result = await ctx.svc.yesterdayLooseEnds(TENANT_ID, BUILDING_ID, USER_ID);
      expect(result.auto_checked_out_count).toBe(12);
      expect(result.unreturned_passes).toHaveLength(1);
      expect(result.bounced_emails).toEqual([]);
    });

    it('populates bounced_emails from VisitorMailDeliveryAdapter (slice 2c)', async () => {
      const bounced = [
        {
          visitor_id: VISITOR_ID,
          first_name: 'Anna',
          last_name: 'Visser',
          company: 'ABC',
          primary_host_first_name: 'Marleen',
          primary_host_last_name: null,
          recipient_email: 'gone@acme.com',
          bounce_type: 'hard',
          reason: 'mailbox unknown',
          occurred_at: '2026-04-30T08:30:00Z',
          event_type: 'bounced' as const,
          expected_at: '2026-05-01T09:00:00Z',
          arrived_at: null,
          status: 'expected',
          visitor_pass_id: null,
          pass_number: null,
          visitor_type_id: null,
        },
      ];
      const ctx = makeHarness({ autoCount: 0, bouncedInvites: bounced });
      const result = await ctx.svc.yesterdayLooseEnds(TENANT_ID, BUILDING_ID, USER_ID);
      expect(result.bounced_emails).toEqual(bounced);
      expect(ctx.mailDeliveryCalls).toHaveLength(1);
      expect(ctx.mailDeliveryCalls[0]!.method).toBe('bouncedInvitesForBuildingSince');
      // Args: buildingId, tenantId, since
      const args = ctx.mailDeliveryCalls[0]!.args;
      expect(args[0]).toBe(BUILDING_ID);
      expect(args[1]).toBe(TENANT_ID);
      expect(args[2]).toBeInstanceOf(Date);
    });

    it('returns [] for bounced_emails when adapter throws (defensive)', async () => {
      const ctx = makeHarness({ autoCount: 0 });
      ctx.mailDelivery.bouncedInvitesForBuildingSince.mockRejectedValueOnce(
        new Error('database down'),
      );
      const result = await ctx.svc.yesterdayLooseEnds(TENANT_ID, BUILDING_ID, USER_ID);
      expect(result.bounced_emails).toEqual([]);
    });
  });

  describe('dailyListForBuilding()', () => {
    it('returns flat row list ordered by expected_at', async () => {
      const ctx = makeHarness({
        dailyRows: [
          {
            visitor_id: 'd1',
            first_name: 'Alice',
            last_name: null,
            company: null,
            primary_host_first_name: 'Anne',
            primary_host_last_name: null,
            expected_at: '2026-05-01T09:00:00Z',
            arrived_at: null,
            status: 'expected',
            visitor_pass_id: null,
            pass_number: null,
            visitor_type_id: TYPE_GUEST,
          },
        ],
      });
      const list = await ctx.svc.dailyListForBuilding(TENANT_ID, BUILDING_ID, USER_ID);
      expect(list).toHaveLength(1);
      expect(list[0].first_name).toBe('Alice');
    });
  });
});

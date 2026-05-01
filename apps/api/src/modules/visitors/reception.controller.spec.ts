/**
 * ReceptionController unit tests.
 *
 * Covers:
 *   - permission guard rejection
 *   - body validation (zod) on walk-up + check-out + pass actions
 *   - actor resolution + delegation to ReceptionService / VisitorPassPoolService
 *   - SSE host-arrivals stream filters by tenant + person_id
 */

import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { Subject } from 'rxjs';
import { TenantContext } from '../../common/tenant-context';
import { ReceptionController } from './reception.controller';
import type { HostNotificationEvent } from './visitor-event-bus';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = '99999999-9999-4999-8999-999999999999';
const AUTH_UID = 'auth-uid-1';
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PERSON_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_PERSON_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BUILDING_ID = '33333333-3333-4333-8333-333333333333';
const VISITOR_ID = '66666666-6666-4666-8666-666666666666';
const PASS_ID = '77777777-7777-4777-8777-777777777777';
const VISITOR_TYPE_ID = '44444444-4444-4444-8444-444444444444';

interface HarnessOpts {
  permissionDenied?: boolean;
  userRow?: { id: string; person_id: string | null } | null;
}

function makeHarness(opts: HarnessOpts = {}) {
  jest.spyOn(TenantContext, 'current').mockReturnValue({
    id: TENANT_ID,
    slug: 'acme',
    tier: 'standard',
  });

  const subject = new Subject<HostNotificationEvent>();
  const events = {
    events$: subject.asObservable(),
    emit: (e: HostNotificationEvent) => subject.next(e),
  };

  const supabase = {
    admin: {
      from: jest.fn(() => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: opts.userRow === undefined
                  ? { id: USER_ID, person_id: PERSON_ID }
                  : opts.userRow,
                error: null,
              }),
            }),
          }),
        }),
      })),
    },
  };

  const reception = {
    today: jest.fn(async () => ({ generated_at: 'x' })),
    search: jest.fn(async () => []),
    quickAddWalkup: jest.fn(async () => ({ visitor_id: VISITOR_ID })),
    markArrived: jest.fn(async () => undefined),
    markCheckedOut: jest.fn(async () => undefined),
    markNoShow: jest.fn(async () => undefined),
    yesterdayLooseEnds: jest.fn(async () => ({ auto_checked_out_count: 0, unreturned_passes: [], bounced_emails: [] })),
    dailyListForBuilding: jest.fn(async () => []),
  };

  const passPool = {
    assignPass: jest.fn(async () => undefined),
    reservePass: jest.fn(async () => undefined),
    returnPass: jest.fn(async () => undefined),
    markPassMissing: jest.fn(async () => undefined),
    markPassRecovered: jest.fn(async () => undefined),
  };

  const permissions = {
    requirePermission: jest.fn(async () => {
      if (opts.permissionDenied) throw new ForbiddenException();
      return { userId: USER_ID };
    }),
  };

  const controller = new ReceptionController(
    reception as never,
    passPool as never,
    events as never,
    supabase as never,
    permissions as never,
  );
  return { controller, reception, passPool, events, subject, supabase, permissions };
}

const makeReq = (
  authUid: string | null = AUTH_UID,
  headers: Record<string, string> = {},
): Request =>
  ({
    user: authUid ? { id: authUid } : undefined,
    headers,
  }) as unknown as Request;

describe('ReceptionController', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('permission gate', () => {
    it('rejects today() without visitors.reception', async () => {
      const h = makeHarness({ permissionDenied: true });
      await expect(
        h.controller.today(makeReq(), BUILDING_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
    it('rejects walkup without visitors.reception', async () => {
      const h = makeHarness({ permissionDenied: true });
      await expect(
        h.controller.walkup(makeReq(AUTH_UID, { 'x-building-id': BUILDING_ID }), {}),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('today / search / daglijst (read)', () => {
    it('today requires building_id', async () => {
      const h = makeHarness();
      await expect(h.controller.today(makeReq(), undefined)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('today delegates to ReceptionService.today with tenant + actor', async () => {
      const h = makeHarness();
      await h.controller.today(makeReq(), BUILDING_ID);
      expect(h.reception.today).toHaveBeenCalledWith(TENANT_ID, BUILDING_ID, USER_ID);
    });

    it('search requires building_id', async () => {
      const h = makeHarness();
      await expect(h.controller.search(makeReq(), undefined, 'q')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('daglijst requires building_id', async () => {
      const h = makeHarness();
      await expect(h.controller.daglijst(makeReq(), undefined)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('walkup', () => {
    it('rejects malformed body', async () => {
      const h = makeHarness();
      await expect(
        h.controller.walkup(makeReq(AUTH_UID, { 'x-building-id': BUILDING_ID }), { first_name: '' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects missing X-Building-Id header', async () => {
      const h = makeHarness();
      await expect(
        h.controller.walkup(makeReq(), {
          first_name: 'X',
          visitor_type_id: VISITOR_TYPE_ID,
          primary_host_person_id: PERSON_ID,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('happy path: delegates with X-Building-Id header', async () => {
      const h = makeHarness();
      await h.controller.walkup(makeReq(AUTH_UID, { 'x-building-id': BUILDING_ID }), {
        first_name: 'Marleen',
        visitor_type_id: VISITOR_TYPE_ID,
        primary_host_person_id: PERSON_ID,
      });
      expect(h.reception.quickAddWalkup).toHaveBeenCalledWith(
        TENANT_ID,
        BUILDING_ID,
        expect.objectContaining({ first_name: 'Marleen' }),
        expect.objectContaining({ user_id: USER_ID, person_id: PERSON_ID, tenant_id: TENANT_ID }),
      );
    });
  });

  describe('check-in / out / no-show', () => {
    it('check-in accepts empty body and uses default arrived_at', async () => {
      const h = makeHarness();
      await h.controller.checkIn(makeReq(), VISITOR_ID, {});
      expect(h.reception.markArrived).toHaveBeenCalled();
    });

    it('check-out requires checkout_source', async () => {
      const h = makeHarness();
      await expect(
        h.controller.checkOut(makeReq(), VISITOR_ID, { pass_returned: true }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('check-out happy path passes through pass_returned', async () => {
      const h = makeHarness();
      await h.controller.checkOut(makeReq(), VISITOR_ID, {
        checkout_source: 'reception',
        pass_returned: true,
      });
      expect(h.reception.markCheckedOut).toHaveBeenCalledWith(
        TENANT_ID,
        VISITOR_ID,
        expect.any(Object),
        expect.objectContaining({ checkout_source: 'reception', pass_returned: true }),
      );
    });

    it('no-show delegates without body', async () => {
      const h = makeHarness();
      await h.controller.noShow(makeReq(), VISITOR_ID);
      expect(h.reception.markNoShow).toHaveBeenCalled();
    });
  });

  describe('pass actions', () => {
    it('assignPass requires visitor_id in body', async () => {
      const h = makeHarness();
      await expect(
        h.controller.assignPass(makeReq(), PASS_ID, {}),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('assignPass delegates with tenant', async () => {
      const h = makeHarness();
      await h.controller.assignPass(makeReq(), PASS_ID, { visitor_id: VISITOR_ID });
      expect(h.passPool.assignPass).toHaveBeenCalledWith(PASS_ID, VISITOR_ID, TENANT_ID);
    });

    it('reservePass requires visitor_id', async () => {
      const h = makeHarness();
      await expect(
        h.controller.reservePass(makeReq(), PASS_ID, {}),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('returnPass / markRecovered delegate', async () => {
      const h = makeHarness();
      await h.controller.returnPass(makeReq(), PASS_ID);
      expect(h.passPool.returnPass).toHaveBeenCalled();
      await h.controller.markRecovered(makeReq(), PASS_ID);
      expect(h.passPool.markPassRecovered).toHaveBeenCalled();
    });

    it('markMissing accepts empty body and string reason', async () => {
      const h = makeHarness();
      await h.controller.markMissing(makeReq(), PASS_ID, {});
      expect(h.passPool.markPassMissing).toHaveBeenCalledWith(PASS_ID, TENANT_ID, undefined);
      await h.controller.markMissing(makeReq(), PASS_ID, { reason: 'walked off' });
      expect(h.passPool.markPassMissing).toHaveBeenCalledWith(PASS_ID, TENANT_ID, 'walked off');
    });
  });

  describe('SSE host-arrivals', () => {
    it('rejects when no auth user', async () => {
      const h = makeHarness();
      await expect(h.controller.hostArrivals(makeReq(null))).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('emits only this host\'s events for this tenant', async () => {
      const h = makeHarness();
      const stream$ = await h.controller.hostArrivals(makeReq());

      const seen: unknown[] = [];
      const sub = stream$.subscribe((e) => seen.push(e));

      // Should reach: matches (TENANT_ID + PERSON_ID).
      h.events.emit({
        tenant_id: TENANT_ID,
        host_person_id: PERSON_ID,
        visitor_id: VISITOR_ID,
        kind: 'visitor.arrived',
        occurred_at: '2026-05-01T09:00:00Z',
      });
      // Should NOT reach: different host.
      h.events.emit({
        tenant_id: TENANT_ID,
        host_person_id: OTHER_PERSON_ID,
        visitor_id: VISITOR_ID,
        kind: 'visitor.arrived',
        occurred_at: '2026-05-01T09:01:00Z',
      });
      // Should NOT reach: different tenant.
      h.events.emit({
        tenant_id: OTHER_TENANT_ID,
        host_person_id: PERSON_ID,
        visitor_id: VISITOR_ID,
        kind: 'visitor.arrived',
        occurred_at: '2026-05-01T09:02:00Z',
      });

      sub.unsubscribe();
      expect(seen).toHaveLength(1);
      expect((seen[0] as { data: { host_person_id: string } }).data.host_person_id).toBe(PERSON_ID);
    });
  });
});

/**
 * KioskController unit tests.
 *
 * Coverage:
 *   - body validation (zod) on every write endpoint
 *   - delegates to KioskService with kioskContext
 *   - visitor-types + host-search filter on tenant
 *
 * KioskAuthGuard is tested separately via kiosk-auth.guard tests; here we
 * stub the request with a synthetic kioskContext as if the guard already
 * validated the token.
 */

import { BadRequestException } from '@nestjs/common';
import { KioskController } from './kiosk.controller';
import type { RequestWithKioskContext } from './kiosk-auth.guard';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BUILDING_ID = '33333333-3333-4333-8333-333333333333';
const KIOSK_TOKEN_ID = '22222222-2222-4222-8222-222222222222';
const VISITOR_ID = '66666666-6666-4666-8666-666666666666';
const VISITOR_TYPE_ID = '44444444-4444-4444-8444-444444444444';
const HOST_PERSON_ID = '55555555-5555-4555-8555-555555555555';

function makeHarness() {
  const queryMany = jest.fn(async () => []);
  const queryOne = jest.fn(async () => null);

  const kiosk = {
    searchExpectedAtKiosk: jest.fn(async () => []),
    checkInWithQrToken: jest.fn(async () => ({
      visitor_id: VISITOR_ID,
      host_first_name: 'Jan',
      has_reception_at_building: true,
    })),
    checkInByName: jest.fn(async () => ({
      host_first_name: 'Jan',
      has_reception_at_building: false,
    })),
    walkupAtKiosk: jest.fn(async () => ({ visitor_id: VISITOR_ID, status: 'arrived' })),
  };

  const db = { queryMany, queryOne } as never;

  const controller = new KioskController(kiosk as never, db as never);
  return { controller, kiosk, db, queryMany, queryOne };
}

const ctx = { tenantId: TENANT_ID, buildingId: BUILDING_ID, kioskTokenId: KIOSK_TOKEN_ID };
const makeReq = (): RequestWithKioskContext =>
  ({ kioskContext: ctx, headers: {} }) as unknown as RequestWithKioskContext;

describe('KioskController', () => {
  describe('expectedSearch', () => {
    it('passes empty query through (service handles trim/empty)', async () => {
      const h = makeHarness();
      await h.controller.expectedSearch(makeReq(), undefined);
      expect(h.kiosk.searchExpectedAtKiosk).toHaveBeenCalledWith(ctx, '');
    });

    it('passes the kioskContext through', async () => {
      const h = makeHarness();
      await h.controller.expectedSearch(makeReq(), 'mar');
      expect(h.kiosk.searchExpectedAtKiosk).toHaveBeenCalledWith(ctx, 'mar');
    });
  });

  describe('checkInQr', () => {
    it('rejects empty body', async () => {
      const h = makeHarness();
      await expect(h.controller.checkInQr(makeReq(), {})).rejects.toBeInstanceOf(BadRequestException);
    });
    it('rejects too-short token', async () => {
      const h = makeHarness();
      await expect(h.controller.checkInQr(makeReq(), { token: 'abc' })).rejects.toBeInstanceOf(BadRequestException);
    });
    it('happy path delegates with kioskContext + token', async () => {
      const h = makeHarness();
      await h.controller.checkInQr(makeReq(), { token: 'a-valid-plaintext-token-string' });
      expect(h.kiosk.checkInWithQrToken).toHaveBeenCalledWith(ctx, 'a-valid-plaintext-token-string');
    });
  });

  describe('checkInByName', () => {
    it('rejects missing visitor_id', async () => {
      const h = makeHarness();
      await expect(
        h.controller.checkInByName(makeReq(), { host_first_name_confirmation: 'Jan' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
    it('rejects missing host_first_name_confirmation', async () => {
      const h = makeHarness();
      await expect(
        h.controller.checkInByName(makeReq(), { visitor_id: VISITOR_ID }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
    it('happy path delegates', async () => {
      const h = makeHarness();
      await h.controller.checkInByName(makeReq(), {
        visitor_id: VISITOR_ID,
        host_first_name_confirmation: 'Jan',
      });
      expect(h.kiosk.checkInByName).toHaveBeenCalledWith(ctx, VISITOR_ID, 'Jan');
    });
  });

  describe('walkup', () => {
    it('rejects missing first_name', async () => {
      const h = makeHarness();
      await expect(
        h.controller.walkup(makeReq(), {
          visitor_type_id: VISITOR_TYPE_ID,
          primary_host_person_id: HOST_PERSON_ID,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
    it('happy path delegates', async () => {
      const h = makeHarness();
      await h.controller.walkup(makeReq(), {
        first_name: 'Marleen',
        visitor_type_id: VISITOR_TYPE_ID,
        primary_host_person_id: HOST_PERSON_ID,
      });
      expect(h.kiosk.walkupAtKiosk).toHaveBeenCalledWith(
        ctx,
        expect.objectContaining({ first_name: 'Marleen', visitor_type_id: VISITOR_TYPE_ID }),
      );
    });
  });

  describe('visitorTypes', () => {
    it('queries scoped to kioskContext.tenantId', async () => {
      const h = makeHarness();
      await h.controller.visitorTypes(makeReq());
      expect(h.queryMany).toHaveBeenCalled();
      const args = h.queryMany.mock.calls[0]!;
      expect(args[1]).toEqual([TENANT_ID]);
    });
  });

  describe('hostSearch', () => {
    it('returns empty array on empty/whitespace query', async () => {
      const h = makeHarness();
      const r1 = await h.controller.hostSearch(makeReq(), undefined);
      const r2 = await h.controller.hostSearch(makeReq(), '   ');
      expect(r1).toEqual([]);
      expect(r2).toEqual([]);
      expect(h.queryMany).not.toHaveBeenCalled();
    });

    it('queries scoped to kioskContext.tenantId on non-empty query', async () => {
      const h = makeHarness();
      await h.controller.hostSearch(makeReq(), 'jan');
      expect(h.queryMany).toHaveBeenCalled();
      const args = h.queryMany.mock.calls[0]!;
      expect(args[1]?.[0]).toBe(TENANT_ID);
    });
  });
});

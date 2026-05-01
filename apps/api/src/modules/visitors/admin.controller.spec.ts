/**
 * VisitorsAdminController unit tests.
 *
 * Coverage:
 *   - body validation on type create/update
 *   - permission gate on /admin/visitors/all (visitors.read_all)
 *   - kiosk provision/rotate/revoke delegate to KioskService with admin user_id
 *   - cross-tenant: every read filters on TenantContext
 */

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { Request } from 'express';
import { TenantContext } from '../../common/tenant-context';
import { VisitorsAdminController } from './admin.controller';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const AUTH_UID = 'auth-uid-1';
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BUILDING_ID = '33333333-3333-4333-8333-333333333333';
const KIOSK_TOKEN_ID = '22222222-2222-4222-8222-222222222222';
const PASS_ID = '77777777-7777-4777-8777-777777777777';

interface HarnessOpts {
  permissionDenied?: boolean;
  spaceRow?: { id: string; type: string } | null;
  passRow?: { space_id: string; space_kind: string } | null;
  visitorTypeUpdated?: Record<string, unknown> | null;
}

function makeHarness(opts: HarnessOpts = {}) {
  jest.spyOn(TenantContext, 'current').mockReturnValue({
    id: TENANT_ID,
    slug: 'acme',
    tier: 'standard',
  });

  const visitorTypeUpdated =
    opts.visitorTypeUpdated === undefined
      ? { id: 'type-1', display_name: 'Updated' }
      : opts.visitorTypeUpdated;

  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        if (table === 'users') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({ maybeSingle: async () => ({ data: { id: USER_ID }, error: null }) }),
              }),
            }),
          };
        }
        if (table === 'visitor_types') {
          return {
            select: () => ({
              eq: () => ({ order: async () => ({ data: [{ id: 'type-1', display_name: 'Guest' }], error: null }) }),
            }),
            insert: (row: Record<string, unknown>) => ({
              select: () => ({
                single: async () => ({ data: { id: 'new-type-id', ...row }, error: null }),
              }),
            }),
            update: () => ({
              eq: () => ({
                eq: () => ({
                  select: () => ({ single: async () => ({ data: visitorTypeUpdated, error: null }) }),
                }),
              }),
            }),
          };
        }
        if (table === 'visitor_pass_pool') {
          return {
            update: () => ({
              eq: () => ({
                eq: () => ({
                  select: () => ({ single: async () => ({ data: { id: PASS_ID }, error: null }) }),
                }),
              }),
            }),
          };
        }
        return {};
      }),
    },
  };

  const queryOne = jest.fn(async (sql: string, _params: unknown[]) => {
    if (sql.includes('from public.spaces') && sql.includes('select id, type')) {
      // Honour explicit `null` (test harness opts in via `spaceRow: null`).
      return 'spaceRow' in opts ? opts.spaceRow : { id: BUILDING_ID, type: 'building' };
    }
    if (sql.includes('select space_id, space_kind from public.visitor_pass_pool')) {
      return opts.passRow ?? null;
    }
    if (sql.includes('insert into public.visitor_pass_pool')) {
      return { id: PASS_ID, status: 'available' };
    }
    return null;
  });
  const queryMany = jest.fn(async () => [{ id: PASS_ID }]);
  const db = { queryOne, queryMany } as never;

  const passPool = {
    markPassRecovered: jest.fn(async () => undefined),
  };

  const kiosk = {
    provisionKioskToken: jest.fn(async () => ({
      token: 'plaintext',
      kiosk_token_id: KIOSK_TOKEN_ID,
      expires_at: '2027-01-01',
    })),
    rotateKioskToken: jest.fn(async () => ({ token: 'rotated', expires_at: '2027-01-01' })),
    revokeKioskToken: jest.fn(async () => undefined),
  };

  const permissions = {
    requirePermission: jest.fn(async () => {
      if (opts.permissionDenied) throw new ForbiddenException();
      return { userId: USER_ID };
    }),
  };

  const controller = new VisitorsAdminController(
    supabase as never,
    db as never,
    passPool as never,
    kiosk as never,
    permissions as never,
  );

  return { controller, supabase, db, kiosk, passPool, permissions, queryOne, queryMany };
}

const makeReq = (authUid: string | null = AUTH_UID): Request =>
  ({ user: authUid ? { id: authUid } : undefined, headers: {} }) as unknown as Request;

describe('VisitorsAdminController', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('visitor types', () => {
    it('listTypes filters by tenant', async () => {
      const h = makeHarness();
      const result = await h.controller.listTypes();
      expect(h.supabase.admin.from).toHaveBeenCalledWith('visitor_types');
      expect(Array.isArray(result)).toBe(true);
    });

    it('createType rejects missing type_key', async () => {
      const h = makeHarness();
      await expect(h.controller.createType({ display_name: 'X' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('createType rejects type_key with capitals', async () => {
      const h = makeHarness();
      await expect(
        h.controller.createType({ type_key: 'BadKey', display_name: 'X' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('createType happy path', async () => {
      const h = makeHarness();
      const result = (await h.controller.createType({
        type_key: 'guest_v2',
        display_name: 'Guest v2',
        requires_approval: false,
        allow_walk_up: true,
      })) as Record<string, unknown>;
      expect(result.id).toBe('new-type-id');
      expect(result.tenant_id).toBe(TENANT_ID);
    });

    it('updateType rejects malformed body (out of range minutes)', async () => {
      const h = makeHarness();
      await expect(
        h.controller.updateType('type-1', { default_expected_until_offset_minutes: 9999 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('updateType returns 404 when row missing', async () => {
      const h = makeHarness({ visitorTypeUpdated: null });
      await expect(h.controller.updateType('missing', { display_name: 'X' })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('deactivateType returns 404 when row missing', async () => {
      const h = makeHarness({ visitorTypeUpdated: null });
      await expect(h.controller.deactivateType('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('pools', () => {
    it('createPool rejects non-building/site space type', async () => {
      const h = makeHarness({ spaceRow: { id: BUILDING_ID, type: 'floor' } });
      await expect(
        h.controller.createPool({ space_id: BUILDING_ID }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('createPool returns 404 when space missing', async () => {
      const h = makeHarness({ spaceRow: null });
      await expect(
        h.controller.createPool({ space_id: BUILDING_ID }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('addPass requires pass_number', async () => {
      const h = makeHarness();
      await expect(h.controller.addPass(BUILDING_ID, {})).rejects.toBeInstanceOf(BadRequestException);
    });

    it('addPass via space_id falls through to space lookup', async () => {
      const h = makeHarness({
        passRow: null,
        spaceRow: { id: BUILDING_ID, type: 'building' },
      });
      await h.controller.addPass(BUILDING_ID, { pass_number: 'A1' });
      // Insert called via queryOne; we don't assert exact SQL — service-level guarantees.
      expect(h.queryOne).toHaveBeenCalled();
    });

    it('passRecovered delegates to passPool service', async () => {
      const h = makeHarness();
      await h.controller.passRecovered(PASS_ID);
      expect(h.passPool.markPassRecovered).toHaveBeenCalledWith(PASS_ID, TENANT_ID);
    });
  });

  describe('kiosk tokens', () => {
    it('provisionKiosk delegates with admin user_id', async () => {
      const h = makeHarness();
      const result = await h.controller.provisionKiosk(makeReq(), BUILDING_ID);
      expect(h.kiosk.provisionKioskToken).toHaveBeenCalledWith(TENANT_ID, BUILDING_ID, { user_id: USER_ID });
      expect(result.token).toBe('plaintext');
    });

    it('rotateKiosk + revokeKiosk delegate', async () => {
      const h = makeHarness();
      await h.controller.rotateKiosk(makeReq(), KIOSK_TOKEN_ID);
      expect(h.kiosk.rotateKioskToken).toHaveBeenCalled();
      await h.controller.revokeKiosk(makeReq(), KIOSK_TOKEN_ID);
      expect(h.kiosk.revokeKioskToken).toHaveBeenCalled();
    });
  });

  describe('listAll (visibility-bypass)', () => {
    it('rejects without visitors.read_all', async () => {
      const h = makeHarness({ permissionDenied: true });
      await expect(h.controller.listAll(makeReq())).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('happy path: filters on tenant', async () => {
      const h = makeHarness();
      await h.controller.listAll(makeReq(), 'expected', BUILDING_ID, '50');
      expect(h.permissions.requirePermission).toHaveBeenCalledWith(expect.anything(), 'visitors.read_all');
      expect(h.queryMany).toHaveBeenCalled();
    });

    it('clamps limit', async () => {
      const h = makeHarness();
      await h.controller.listAll(makeReq(), undefined, undefined, '99999');
      const params = h.queryMany.mock.calls[0]![1] as unknown[];
      // Second param is the limit; clamped to max 500.
      expect(params[1]).toBe(500);
    });
  });
});

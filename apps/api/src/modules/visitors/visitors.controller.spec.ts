/**
 * VisitorsController unit tests.
 *
 * Coverage:
 *   - createInvitation: zod validation + permission gate + actor resolution
 *   - cancelByToken: SQLSTATE → HTTP mapping + cross-tenant defence
 *   - acknowledge: ownership gate (must be in visitor_hosts)
 *   - getOne: visibility gating
 *
 * The controller depends on InvitationService / VisitorService /
 * HostNotificationService / SupabaseService / DbService / PermissionGuard
 * — each is mocked at the public-method boundary. We don't reach the
 * real services; their unit tests already cover their logic.
 */

import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { TenantContext } from '../../common/tenant-context';
import { VisitorsController, mapTokenError } from './visitors.controller';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = '99999999-9999-4999-8999-999999999999';
const AUTH_UID = 'auth-uid-1';
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PERSON_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VISITOR_ID = '66666666-6666-4666-8666-666666666666';

interface HarnessOpts {
  /** users row for resolveActor. null → no linked user. */
  userRow?: { id: string; person_id: string | null } | null;
  /** queryOne overrides keyed by SQL prefix. */
  queryOneResults?: Map<string, unknown>;
  /** queryMany override. */
  queryManyResult?: unknown[];
  /** Throw on validate_invitation_token call with this errcode. */
  tokenError?: { code: string };
  /** Result returned by validate_invitation_token (visitor_id + tenant_id). */
  tokenResolves?: { visitor_id: string; tenant_id: string } | null;
  /** Whether requirePermission throws. */
  permissionDenied?: boolean;
  /** Throw on transitionStatus. */
  transitionError?: Error;
}

function makeHarness(opts: HarnessOpts = {}) {
  jest.spyOn(TenantContext, 'current').mockReturnValue({
    id: TENANT_ID,
    slug: 'acme',
    tier: 'standard',
  });
  jest.spyOn(TenantContext, 'currentOrNull').mockReturnValue({
    id: TENANT_ID,
    slug: 'acme',
    tier: 'standard',
  });

  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        if (table === 'users') {
          return {
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
          };
        }
        if (table === 'visitor_hosts') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({ data: [], error: null }),
              }),
            }),
          };
        }
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
        };
      }),
    },
  };

  const queryOne = jest.fn(async (sql: string, _params: unknown[]) => {
    if (sql.includes('validate_invitation_token')) {
      if (opts.tokenError) {
        throw opts.tokenError;
      }
      return opts.tokenResolves ?? null;
    }
    if (sql.includes('visitor_hosts')) {
      const results = opts.queryOneResults?.get('visitor_hosts');
      return results ?? { exists: true };
    }
    if (sql.includes('with visible')) {
      if (opts.queryOneResults?.has('visible')) {
        return opts.queryOneResults.get('visible');
      }
      return { id: VISITOR_ID };
    }
    return null;
  });
  const queryMany = jest.fn(async () => opts.queryManyResult ?? []);
  const db = { queryOne, queryMany } as never;

  const invitations = {
    create: jest.fn(async () => ({
      visitor_id: VISITOR_ID,
      status: 'expected',
      approval_id: null,
      cancel_token: 'plain-token',
    })),
  };

  const visitorService = {
    transitionStatus: jest.fn(async () => {
      if (opts.transitionError) throw opts.transitionError;
      return { id: VISITOR_ID } as never;
    }),
  };

  const hostNotifications = {
    acknowledge: jest.fn(async () => undefined),
  };

  const permissions = {
    requirePermission: jest.fn(async () => {
      if (opts.permissionDenied) throw new ForbiddenException();
      return { userId: USER_ID };
    }),
  };

  const controller = new VisitorsController(
    invitations as never,
    visitorService as never,
    hostNotifications as never,
    supabase as never,
    db as never,
    permissions as never,
  );

  return { controller, supabase, db, invitations, visitorService, hostNotifications, permissions };
}

const makeReq = (authUid: string | null = AUTH_UID): Request =>
  ({
    user: authUid ? { id: authUid } : undefined,
    headers: {},
  }) as unknown as Request;

describe('VisitorsController', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('createInvitation', () => {
    it('rejects without permission', async () => {
      const h = makeHarness({ permissionDenied: true });
      await expect(
        h.controller.createInvitation(makeReq(), { first_name: 'X' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects malformed body (zod 400)', async () => {
      const h = makeHarness();
      await expect(
        h.controller.createInvitation(makeReq(), { first_name: '' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('happy path — does NOT leak cancel_token in response', async () => {
      const h = makeHarness();
      const result = (await h.controller.createInvitation(makeReq(), {
        first_name: 'Marleen',
        visitor_type_id: '44444444-4444-4444-8444-444444444444',
        expected_at: '2026-05-02T09:00:00.000Z',
        building_id: '33333333-3333-4333-8333-333333333333',
      })) as Record<string, unknown>;
      expect(result.visitor_id).toBe(VISITOR_ID);
      expect(result.status).toBe('expected');
      expect(result).not.toHaveProperty('cancel_token');
    });

    it('rejects when no auth user', async () => {
      const h = makeHarness();
      await expect(
        h.controller.createInvitation(makeReq(null), {
          first_name: 'X',
          visitor_type_id: '44444444-4444-4444-8444-444444444444',
          expected_at: '2026-05-02T09:00:00.000Z',
          building_id: '33333333-3333-4333-8333-333333333333',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects when user has no linked person row', async () => {
      const h = makeHarness({ userRow: { id: USER_ID, person_id: null } });
      await expect(
        h.controller.createInvitation(makeReq(), {
          first_name: 'X',
          visitor_type_id: '44444444-4444-4444-8444-444444444444',
          expected_at: '2026-05-02T09:00:00.000Z',
          building_id: '33333333-3333-4333-8333-333333333333',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('cancelByToken (public)', () => {
    it('happy path: transitions to cancelled', async () => {
      const h = makeHarness({
        tokenResolves: { visitor_id: VISITOR_ID, tenant_id: TENANT_ID },
      });
      const result = await h.controller.cancelByToken('plaintext-token');
      expect(result).toEqual({ ok: true, visitor_id: VISITOR_ID });
      expect(h.visitorService.transitionStatus).toHaveBeenCalledWith(
        VISITOR_ID,
        'cancelled',
        expect.objectContaining({ user_id: 'visitor_self_serve' }),
      );
    });

    it('cross-tenant defence: token from tenant B accessed via tenant A → 410', async () => {
      const h = makeHarness({
        tokenResolves: { visitor_id: VISITOR_ID, tenant_id: OTHER_TENANT_ID },
      });
      await expect(h.controller.cancelByToken('plaintext-token')).rejects.toBeInstanceOf(GoneException);
      expect(h.visitorService.transitionStatus).not.toHaveBeenCalled();
    });

    it('rejects empty token (400)', async () => {
      const h = makeHarness();
      await expect(h.controller.cancelByToken('')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('SQLSTATE 45001 → 410 invalid_token', async () => {
      const h = makeHarness({ tokenError: { code: '45001' } });
      const err = await h.controller.cancelByToken('bad-token').catch((e) => e);
      expect(err).toBeInstanceOf(GoneException);
      expect((err.getResponse() as { code: string }).code).toBe('invalid_token');
    });

    it('SQLSTATE 45002 → 410 token_already_used', async () => {
      const h = makeHarness({ tokenError: { code: '45002' } });
      const err = await h.controller.cancelByToken('used-token').catch((e) => e);
      expect(err).toBeInstanceOf(GoneException);
      expect((err.getResponse() as { code: string }).code).toBe('token_already_used');
    });

    it('SQLSTATE 45003 → 410 token_expired', async () => {
      const h = makeHarness({ tokenError: { code: '45003' } });
      const err = await h.controller.cancelByToken('expired-token').catch((e) => e);
      expect(err).toBeInstanceOf(GoneException);
      expect((err.getResponse() as { code: string }).code).toBe('token_expired');
    });

    it('transitionStatus 400 (e.g. already arrived) → 410 transition_not_allowed', async () => {
      const h = makeHarness({
        tokenResolves: { visitor_id: VISITOR_ID, tenant_id: TENANT_ID },
        transitionError: new BadRequestException('invalid_transition: arrived -> cancelled'),
      });
      const err = await h.controller.cancelByToken('plaintext-token').catch((e) => e);
      expect(err).toBeInstanceOf(GoneException);
      expect((err.getResponse() as { code: string }).code).toBe('transition_not_allowed');
    });
  });

  describe('acknowledge', () => {
    it('rejects when actor is not a host on the visit', async () => {
      const h = makeHarness({
        queryOneResults: new Map([['visitor_hosts', { exists: false }]]),
      });
      await expect(
        h.controller.acknowledge(makeReq(), VISITOR_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('happy path: delegates to HostNotificationService.acknowledge', async () => {
      const h = makeHarness({
        queryOneResults: new Map([['visitor_hosts', { exists: true }]]),
      });
      await h.controller.acknowledge(makeReq(), VISITOR_ID);
      expect(h.hostNotifications.acknowledge).toHaveBeenCalledWith(
        VISITOR_ID,
        PERSON_ID,
        TENANT_ID,
      );
    });
  });

  describe('getOne', () => {
    it('returns 404 when visibility function does not include the id', async () => {
      const h = makeHarness({
        queryOneResults: new Map([['visible', null]]),
      });
      await expect(h.controller.getOne(makeReq(), VISITOR_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

describe('mapTokenError', () => {
  it('maps 45001 / 45002 / 45003 to GoneException', () => {
    expect(mapTokenError({ code: '45001' })).toBeInstanceOf(GoneException);
    expect(mapTokenError({ code: '45002' })).toBeInstanceOf(GoneException);
    expect(mapTokenError({ code: '45003' })).toBeInstanceOf(GoneException);
  });

  it('passes other errors through', () => {
    const err = new Error('boom');
    expect(mapTokenError(err)).toBe(err);
  });
});

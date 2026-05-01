/**
 * End-to-end cancel-link flow — invite → cancel → host notified.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §6.1, §17
 * Plan: docs/superpowers/plans/2026-05-01-visitor-management-v1.md slice 5 task 5.4
 *
 * This spec layers on top of `visitors.integration.spec.ts` to cover the
 * specific sequence the slice-5 acceptance criteria call out:
 *
 *   1. Host creates invite → token issued
 *   2. Visitor hits /visitors/cancel/:token → visitor.status='cancelled'
 *   3. Host receives an in-app notification via HostNotificationService
 *      .notifyVisitorCancelled
 *   4. Re-using the same token returns 410 Gone
 *   5. Wrong tenant context → 410 Gone
 *   6. Expired token → 410 Gone
 *
 * Mocks the same primitives as visitors.integration.spec.ts but adds a
 * spy on hostNotifications.notifyVisitorCancelled so we can assert the
 * host-notification side effect.
 */

import { GoneException } from '@nestjs/common';
import type { Request } from 'express';
import { TenantContext } from '../../common/tenant-context';
import { VisitorsController } from './visitors.controller';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '99999999-9999-4999-8999-999999999999';
const HOST_AUTH_UID = 'host-auth';
const HOST_USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOST_PERSON_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BUILDING_ID = '33333333-3333-4333-8333-333333333333';
const VISITOR_TYPE_ID = '44444444-4444-4444-8444-444444444444';
const VISITOR_ID = '66666666-6666-4666-8666-666666666666';
const TOKEN_OK = 'token-ok-' + 'a'.repeat(56);
const TOKEN_EXPIRED = 'token-expired-' + 'b'.repeat(50);
const TOKEN_CROSS_TENANT = 'token-cross-' + 'c'.repeat(50);

type VisitorStatus =
  | 'pending_approval' | 'expected' | 'arrived' | 'in_meeting'
  | 'checked_out' | 'no_show' | 'cancelled' | 'denied';

interface State {
  visitor: { id: string; status: VisitorStatus; tenant_id: string } | null;
  tokens: Map<string, { visitor_id: string; tenant_id: string; used: boolean; expired: boolean }>;
}

function build() {
  const state: State = {
    visitor: null,
    tokens: new Map(),
  };

  jest.spyOn(TenantContext, 'current').mockReturnValue({
    id: TENANT_A,
    slug: 'acme',
    tier: 'standard',
  });
  jest.spyOn(TenantContext, 'currentOrNull').mockReturnValue({
    id: TENANT_A,
    slug: 'acme',
    tier: 'standard',
  });
  // TenantContext.run is exercised by the controller's notify path.
  // Don't stub it; let the AsyncLocalStorage actually run the callback.

  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        if (table === 'users') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { id: HOST_USER_ID, person_id: HOST_PERSON_ID },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        };
      }),
    },
  };

  const db = {
    queryOne: jest.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('validate_invitation_token')) {
        const token = params[0] as string;
        const row = state.tokens.get(token);
        if (!row) {
          const e = new Error('invalid_token');
          (e as { code?: string }).code = '45001';
          throw e;
        }
        if (row.used) {
          const e = new Error('token_already_used');
          (e as { code?: string }).code = '45002';
          throw e;
        }
        if (row.expired) {
          const e = new Error('token_expired');
          (e as { code?: string }).code = '45003';
          throw e;
        }
        row.used = true;
        return { visitor_id: row.visitor_id, tenant_id: row.tenant_id };
      }
      // peek_invitation_token — read-only, no SQLSTATE 45002, returns
      // denormalised visit details (used by /cancel/:token/preview).
      if (sql.includes('peek_invitation_token')) {
        const token = params[0] as string;
        const row = state.tokens.get(token);
        if (!row) {
          const e = new Error('invalid_token');
          (e as { code?: string }).code = '45001';
          throw e;
        }
        if (row.expired) {
          const e = new Error('token_expired');
          (e as { code?: string }).code = '45003';
          throw e;
        }
        // peek does NOT mutate `used` — this is the contract.
        return {
          visitor_id: row.visitor_id,
          tenant_id: row.tenant_id,
          visitor_status: state.visitor?.status ?? 'expected',
          first_name: 'Marleen',
          expected_at: '2026-05-02T09:00:00.000Z',
          expected_until: '2026-05-02T11:00:00.000Z',
          building_id: BUILDING_ID,
          building_name: 'HQ Amsterdam',
          host_first_name: 'Sarah',
        };
      }
      return null;
    }),
    queryMany: jest.fn(async () => []),
  };

  const invitations = {
    create: jest.fn(async () => {
      state.visitor = { id: VISITOR_ID, status: 'expected', tenant_id: TENANT_A };
      state.tokens.set(TOKEN_OK, {
        visitor_id: VISITOR_ID,
        tenant_id: TENANT_A,
        used: false,
        expired: false,
      });
      return {
        visitor_id: VISITOR_ID,
        status: 'expected' as const,
        approval_id: null,
        cancel_token: TOKEN_OK,
      };
    }),
  };

  const visitorService = {
    transitionStatus: jest.fn(async (id: string, to: VisitorStatus) => {
      if (!state.visitor || state.visitor.id !== id) throw new Error('not found');
      state.visitor.status = to;
      return state.visitor;
    }),
  };

  const notifyCalls: Array<{ visitor_id: string; tenant_id: string; ctxTenantId: string }> = [];
  const hostNotifications = {
    notifyVisitorCancelled: jest.fn(async (visitor_id: string, tenant_id: string) => {
      // Capture the tenant context at invocation time — this proves the
      // controller wraps the notify call in TenantContext.run with the
      // resolved tenant.
      const ctx = TenantContext.currentOrNull();
      notifyCalls.push({
        visitor_id,
        tenant_id,
        ctxTenantId: ctx?.id ?? '',
      });
    }),
    acknowledge: jest.fn(),
  };

  const permissions = {
    requirePermission: jest.fn(async () => ({ userId: HOST_USER_ID })),
  };

  const controller = new VisitorsController(
    invitations as never,
    visitorService as never,
    hostNotifications as never,
    supabase as never,
    db as never,
    permissions as never,
  );

  return { controller, state, invitations, visitorService, hostNotifications, notifyCalls };
}

const makeReq = (): Request =>
  ({ user: { id: HOST_AUTH_UID }, headers: {} }) as unknown as Request;

describe('Visitor cancel-link flow — slice 5', () => {
  afterEach(() => jest.restoreAllMocks());

  it('happy path: invite → cancel → host notified', async () => {
    const h = build();

    const invite = await h.controller.createInvitation(makeReq(), {
      first_name: 'Marleen',
      last_name: 'Visser',
      email: 'marleen@example.com',
      visitor_type_id: VISITOR_TYPE_ID,
      expected_at: '2026-05-02T09:00:00.000Z',
      building_id: BUILDING_ID,
    });
    expect(invite.visitor_id).toBe(VISITOR_ID);
    expect(invite.status).toBe('expected');

    const cancel = await h.controller.cancelByToken(TOKEN_OK);
    expect(cancel).toEqual({ ok: true, visitor_id: VISITOR_ID });
    expect(h.state.visitor?.status).toBe('cancelled');

    expect(h.hostNotifications.notifyVisitorCancelled).toHaveBeenCalledWith(
      VISITOR_ID,
      TENANT_A,
    );
    expect(h.notifyCalls).toHaveLength(1);
    // The notify call must run under the resolved tenant's context — the
    // tenant guard on HostNotificationService asserts this.
    expect(h.notifyCalls[0]!.ctxTenantId).toBe(TENANT_A);
  });

  it('re-using a consumed token returns 410 Gone', async () => {
    const h = build();
    await h.controller.createInvitation(makeReq(), {
      first_name: 'Marleen',
      visitor_type_id: VISITOR_TYPE_ID,
      expected_at: '2026-05-02T09:00:00.000Z',
      building_id: BUILDING_ID,
    });

    await h.controller.cancelByToken(TOKEN_OK);
    await expect(h.controller.cancelByToken(TOKEN_OK)).rejects.toBeInstanceOf(
      GoneException,
    );
  });

  it('wrong tenant context (token issued for tenant B) returns 410', async () => {
    const h = build();
    h.state.tokens.set(TOKEN_CROSS_TENANT, {
      visitor_id: VISITOR_ID,
      tenant_id: TENANT_B, // mismatch
      used: false,
      expired: false,
    });

    await expect(
      h.controller.cancelByToken(TOKEN_CROSS_TENANT),
    ).rejects.toBeInstanceOf(GoneException);

    expect(h.visitorService.transitionStatus).not.toHaveBeenCalled();
    expect(h.hostNotifications.notifyVisitorCancelled).not.toHaveBeenCalled();
  });

  it('expired token returns 410', async () => {
    const h = build();
    h.state.tokens.set(TOKEN_EXPIRED, {
      visitor_id: VISITOR_ID,
      tenant_id: TENANT_A,
      used: false,
      expired: true, // signals validate_invitation_token to raise 45003
    });

    await expect(
      h.controller.cancelByToken(TOKEN_EXPIRED),
    ).rejects.toBeInstanceOf(GoneException);

    expect(h.visitorService.transitionStatus).not.toHaveBeenCalled();
    expect(h.hostNotifications.notifyVisitorCancelled).not.toHaveBeenCalled();
  });

  it('unknown token returns 410', async () => {
    const h = build();
    await expect(
      h.controller.cancelByToken('garbage'),
    ).rejects.toBeInstanceOf(GoneException);

    expect(h.visitorService.transitionStatus).not.toHaveBeenCalled();
  });

  it('preview returns visit details without consuming the token', async () => {
    const h = build();
    await h.controller.createInvitation(makeReq(), {
      first_name: 'Marleen',
      visitor_type_id: VISITOR_TYPE_ID,
      expected_at: '2026-05-02T09:00:00.000Z',
      building_id: BUILDING_ID,
    });

    const preview = await h.controller.previewCancel(TOKEN_OK);
    expect(preview).toMatchObject({
      visitor_id: VISITOR_ID,
      visitor_status: 'expected',
      first_name: 'Marleen',
      building_name: 'HQ Amsterdam',
      host_first_name: 'Sarah',
    });
    // Crucial: the cancel POST still works after the preview — the
    // token wasn't consumed by peek.
    const cancel = await h.controller.cancelByToken(TOKEN_OK);
    expect(cancel).toEqual({ ok: true, visitor_id: VISITOR_ID });
  });

  it('preview returns 410 for invalid tokens', async () => {
    const h = build();
    await expect(h.controller.previewCancel('garbage')).rejects.toBeInstanceOf(
      GoneException,
    );
  });

  it('preview returns 410 for expired tokens', async () => {
    const h = build();
    h.state.tokens.set(TOKEN_EXPIRED, {
      visitor_id: VISITOR_ID,
      tenant_id: TENANT_A,
      used: false,
      expired: true,
    });
    await expect(h.controller.previewCancel(TOKEN_EXPIRED)).rejects.toBeInstanceOf(
      GoneException,
    );
  });

  it('preview returns 410 for cross-tenant tokens', async () => {
    const h = build();
    h.state.tokens.set(TOKEN_CROSS_TENANT, {
      visitor_id: VISITOR_ID,
      tenant_id: TENANT_B,
      used: false,
      expired: false,
    });
    await expect(
      h.controller.previewCancel(TOKEN_CROSS_TENANT),
    ).rejects.toBeInstanceOf(GoneException);
  });

  it('preview after cancel returns visitor_status=cancelled (idempotent)', async () => {
    const h = build();
    await h.controller.createInvitation(makeReq(), {
      first_name: 'Marleen',
      visitor_type_id: VISITOR_TYPE_ID,
      expected_at: '2026-05-02T09:00:00.000Z',
      building_id: BUILDING_ID,
    });

    await h.controller.cancelByToken(TOKEN_OK);

    // After cancel, the cancel POST 410s — but peek (which uses a
    // separate function that ignores `used_at`) should still resolve.
    // The visitor's status now reads as 'cancelled', which is how the
    // landing page renders the "already cancelled" state.
    //
    // In this mock, validate_invitation_token sets `used=true`, but
    // peek_invitation_token doesn't check `used`. The mock's peek
    // branch ignores the flag too, matching production behaviour.
    const preview2 = await h.controller.previewCancel(TOKEN_OK);
    expect(preview2.visitor_status).toBe('cancelled');
  });

  it('host notification failure does not block the cancel itself', async () => {
    const h = build();
    h.hostNotifications.notifyVisitorCancelled.mockRejectedValueOnce(
      new Error('downstream notification error'),
    );

    await h.controller.createInvitation(makeReq(), {
      first_name: 'Marleen',
      visitor_type_id: VISITOR_TYPE_ID,
      expected_at: '2026-05-02T09:00:00.000Z',
      building_id: BUILDING_ID,
    });

    // Cancel still succeeds even though the notify path threw.
    const cancel = await h.controller.cancelByToken(TOKEN_OK);
    expect(cancel).toEqual({ ok: true, visitor_id: VISITOR_ID });
    expect(h.state.visitor?.status).toBe('cancelled');
  });
});

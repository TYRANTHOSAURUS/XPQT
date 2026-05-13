/**
 * NotificationTemplatesController — unit tests.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step G.
 *
 * Coverage:
 *   1. GET /admin/notification-templates rejects without permission (403).
 *   2. GET /:eventKind rejects without permission (403).
 *   3. PUT /:eventKind rejects without permission (403).
 *   4. PUT rejects malformed body (missing locale → 400).
 *   5. PUT rejects bad locale value (400).
 *   6. PUT rejects non-string non-null override fields (400).
 *   7. Happy path forwards userId from PermissionGuard into service.upsert.
 */

import type { Request } from 'express';
import { AppErrors } from '../../common/errors';
import { NotificationTemplatesController } from './template-overrides.controller';

const AUTH_UID = '11111111-1111-4111-8111-111111111111';
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

interface HarnessOpts {
  permissionDenied?: boolean;
}

function makeHarness(opts: HarnessOpts = {}) {
  const service = {
    list: jest.fn(async () => []),
    getByEventKind: jest.fn(async (eventKind: string) => ({
      eventKind,
      en: null,
      nl: null,
    })),
    upsert: jest.fn(async () => ({
      id: 'row-1',
      tenant_id: 't1',
      event_kind: 'booking.approval_required',
      locale: 'en' as const,
      subject_override: 'subj',
      cta_text_override: null,
      body_intro_override: null,
      updated_at: '2026-05-13T10:00:00.000Z',
      updated_by_user_id: USER_ID,
    })),
  };

  const permissions = {
    requirePermission: jest.fn(async () => {
      if (opts.permissionDenied) throw AppErrors.permissionDenied();
      return { userId: USER_ID };
    }),
  };

  const controller = new NotificationTemplatesController(
    service as never,
    permissions as never,
  );
  return { controller, service, permissions };
}

const makeReq = (): Request =>
  ({ user: { id: AUTH_UID }, headers: {} }) as unknown as Request;

describe('NotificationTemplatesController', () => {
  describe('permission gate', () => {
    it('GET / rejects without notifications.manage_templates (403)', async () => {
      const h = makeHarness({ permissionDenied: true });
      await expect(h.controller.list(makeReq())).rejects.toMatchObject({ status: 403 });
      expect(h.service.list).not.toHaveBeenCalled();
    });

    it('GET /:eventKind rejects without permission (403)', async () => {
      const h = makeHarness({ permissionDenied: true });
      await expect(
        h.controller.getOne(makeReq(), 'booking.approval_required'),
      ).rejects.toMatchObject({ status: 403 });
      expect(h.service.getByEventKind).not.toHaveBeenCalled();
    });

    it('PUT /:eventKind rejects without permission (403)', async () => {
      const h = makeHarness({ permissionDenied: true });
      await expect(
        h.controller.upsert(makeReq(), 'booking.approval_required', {
          locale: 'en',
          subject_override: 'x',
        }),
      ).rejects.toMatchObject({ status: 403 });
      expect(h.service.upsert).not.toHaveBeenCalled();
    });

    it('all routes call requirePermission with notifications.manage_templates', async () => {
      const h = makeHarness();
      await h.controller.list(makeReq());
      await h.controller.getOne(makeReq(), 'booking.approval_required');
      await h.controller.upsert(makeReq(), 'booking.approval_required', { locale: 'en' });

      for (const call of h.permissions.requirePermission.mock.calls) {
        expect(call[1]).toBe('notifications.manage_templates');
      }
    });
  });

  describe('PUT body validation', () => {
    it('rejects missing body (400)', async () => {
      const h = makeHarness();
      await expect(
        h.controller.upsert(makeReq(), 'booking.approval_required', undefined as never),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('rejects bad locale (400)', async () => {
      const h = makeHarness();
      await expect(
        h.controller.upsert(makeReq(), 'booking.approval_required', {
          locale: 'fr' as 'en',
        }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('rejects non-string non-null override field (400)', async () => {
      const h = makeHarness();
      await expect(
        h.controller.upsert(makeReq(), 'booking.approval_required', {
          locale: 'en',
          subject_override: 42 as unknown as string,
        }),
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('happy path', () => {
    it('forwards userId from PermissionGuard into service.upsert', async () => {
      const h = makeHarness();
      await h.controller.upsert(makeReq(), 'booking.approval_required', {
        locale: 'en',
        subject_override: 'Hello',
      });
      expect(h.service.upsert).toHaveBeenCalledWith(
        'booking.approval_required',
        'en',
        expect.objectContaining({ subject_override: 'Hello' }),
        { userId: USER_ID },
      );
    });
  });
});

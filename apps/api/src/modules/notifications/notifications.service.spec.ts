/**
 * NotificationsService — unit tests.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step C.
 *
 * Coverage:
 *   - dispatch() resolves template + calls EmailChannel with the rendered output.
 *   - Idempotency-Key passthrough.
 *   - Tenant + user + locale forwarded unmodified.
 *   - Returns the EmailChannel's DispatchResult.
 *   - Undelivered result is returned (not thrown).
 */

import { NotificationsService } from './notifications.service';
import type { BookingApprovalRequiredPayload } from './templates/types';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

const PAYLOAD: BookingApprovalRequiredPayload = {
  bookingId: 'b1',
  chainId: 'c1',
  bookingTitle: 'Quarterly review',
  requesterName: 'Marleen Visser',
  spaceName: 'Boardroom 4',
  startAt: '2026-05-13T09:00:00Z',
  endAt: '2026-05-13T10:30:00Z',
  approvalCtaUrl: 'https://app.example.com/desk/approvals/abc',
};

function makeHarness() {
  const templateCalls: Array<Record<string, unknown>> = [];
  const emailCalls: Array<Record<string, unknown>> = [];

  const templates = {
    resolve: jest.fn(async (args: Record<string, unknown>) => {
      templateCalls.push(args);
      return {
        subject: 'Resolved subject',
        html: '<html>Resolved body</html>',
        text: 'Resolved body',
        ctaText: 'Click me',
      };
    }),
  };

  const email = {
    id: 'email' as const,
    dispatch: jest.fn(async (args: Record<string, unknown>) => {
      emailCalls.push(args);
      return {
        channelId: 'email' as const,
        externalId: 'resend-msg-xyz',
        delivered: true,
      };
    }),
  };

  const service = new NotificationsService(templates as never, email as never);
  return { service, templates, email, templateCalls, emailCalls };
}

const BASE_ARGS = {
  tenantId: TENANT_ID,
  userId: USER_ID,
  locale: 'en' as const,
  eventKind: 'booking.approval_required' as const,
  payload: PAYLOAD,
  idempotencyKey: 'evt-1:user-1',
  context: {
    entityType: 'booking',
    entityId: 'b1',
    tenantSlug: 'acme',
  },
};

describe('NotificationsService.dispatch', () => {
  it('resolves template then dispatches email with rendered output', async () => {
    const { service, templateCalls, emailCalls } = makeHarness();

    const result = await service.dispatch(BASE_ARGS);

    expect(templateCalls).toHaveLength(1);
    expect(templateCalls[0]).toEqual({
      tenantId: TENANT_ID,
      eventKind: 'booking.approval_required',
      locale: 'en',
      payload: PAYLOAD,
    });

    expect(emailCalls).toHaveLength(1);
    expect(emailCalls[0]).toEqual({
      tenantId: TENANT_ID,
      userId: USER_ID,
      locale: 'en',
      rendered: {
        subject: 'Resolved subject',
        html: '<html>Resolved body</html>',
        text: 'Resolved body',
        ctaText: 'Click me',
      },
      idempotencyKey: 'evt-1:user-1',
      context: {
        entityType: 'booking',
        entityId: 'b1',
        tenantSlug: 'acme',
      },
    });

    expect(result).toEqual({
      channelId: 'email',
      externalId: 'resend-msg-xyz',
      delivered: true,
    });
  });

  it('forwards locale to both resolver and channel', async () => {
    const { service, templateCalls, emailCalls } = makeHarness();
    await service.dispatch({ ...BASE_ARGS, locale: 'nl' });
    expect(templateCalls[0].locale).toBe('nl');
    expect(emailCalls[0].locale).toBe('nl');
  });

  it('returns undelivered result without throwing', async () => {
    const { service, email } = makeHarness();
    (email.dispatch as jest.Mock).mockResolvedValueOnce({
      channelId: 'email',
      delivered: false,
    });

    const result = await service.dispatch(BASE_ARGS);
    expect(result).toEqual({ channelId: 'email', delivered: false });
  });

  it('propagates email channel errors (caller handles outbox retry)', async () => {
    const { service, email } = makeHarness();
    (email.dispatch as jest.Mock).mockRejectedValueOnce(new Error('email.dispatch_failed: vendor rejected'));

    await expect(service.dispatch(BASE_ARGS)).rejects.toThrow(/email\.dispatch_failed/);
  });
});

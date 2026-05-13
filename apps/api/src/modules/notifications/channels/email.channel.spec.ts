/**
 * EmailChannel — unit tests.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step C.
 *
 * Coverage:
 *   - Happy path: user resolved → mail provider called with correct shape →
 *     DispatchResult contains externalId + delivered=true.
 *   - User not found → returns delivered=false, no throw.
 *   - User found but no email → returns delivered=false, no throw.
 *   - Cross-tenant user lookup (tenant filter applied).
 *   - Mail provider throws → re-thrown as AppError(email.dispatch_failed).
 *   - Idempotency-Key passed through to MAIL_PROVIDER.
 *   - Tags forwarded for audit/routing.
 */

import { AppError } from '../../../common/errors';
import type { MailMessage, MailProvider } from '../../../common/mail/mail-provider';
import { EmailChannel } from './email.channel';
import type { DispatchInput } from './notification-channel.interface';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = '99999999-9999-4999-8999-999999999999';
const USER_ID = '22222222-2222-4222-8222-222222222222';

interface UserRow {
  id: string;
  email: string | null;
  tenant_id?: string;
}

function makeHarness(opts: {
  user?: UserRow | null;
  userError?: { message: string } | null;
  mailResult?: { messageId: string; acceptedAt: string };
  mailError?: Error;
} = {}) {
  const userFilters: Array<{ id?: string; tenant_id?: string }> = [];
  const mailCalls: MailMessage[] = [];

  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        if (table !== 'users') {
          throw new Error(`unexpected table: ${table}`);
        }
        const filter: { id?: string; tenant_id?: string } = {};
        userFilters.push(filter);
        const builder = {
          select: () => builder,
          eq: (col: string, val: string) => {
            (filter as Record<string, string>)[col] = val;
            return builder;
          },
          maybeSingle: async () => {
            if (opts.userError) return { data: null, error: opts.userError };
            return { data: opts.user ?? null, error: null };
          },
        };
        return builder;
      }),
    },
  };

  const mailProvider: MailProvider = {
    send: jest.fn(async (msg: MailMessage) => {
      mailCalls.push(msg);
      if (opts.mailError) throw opts.mailError;
      return opts.mailResult ?? {
        messageId: 'resend-msg-abc',
        acceptedAt: '2026-05-13T12:00:00Z',
      };
    }),
    verifyWebhook: jest.fn(),
  };

  const channel = new EmailChannel(mailProvider, supabase as never);

  return { channel, mailProvider, mailCalls, userFilters };
}

const BASE_INPUT: DispatchInput = {
  tenantId: TENANT_ID,
  userId: USER_ID,
  locale: 'en',
  rendered: {
    subject: 'Approval needed',
    html: '<html><body>Approval needed</body></html>',
    text: 'Approval needed',
    ctaText: 'Review',
    ctaUrl: 'https://example.com/approve',
  },
  idempotencyKey: 'evt-123:user-456',
  context: {
    entityType: 'booking',
    entityId: 'booking-uuid',
    tenantSlug: 'acme',
  },
};

describe('EmailChannel.dispatch', () => {
  it('resolves user → calls MAIL_PROVIDER with the correct shape (happy path)', async () => {
    const { channel, mailCalls } = makeHarness({
      user: { id: USER_ID, email: 'approver@example.com' },
    });

    const result = await channel.dispatch(BASE_INPUT);

    expect(result).toEqual({
      channelId: 'email',
      externalId: 'resend-msg-abc',
      delivered: true,
    });

    expect(mailCalls).toHaveLength(1);
    const call = mailCalls[0];
    expect(call.to).toBe('approver@example.com');
    expect(call.subject).toBe('Approval needed');
    expect(call.htmlBody).toBe('<html><body>Approval needed</body></html>');
    expect(call.textBody).toBe('Approval needed');
    expect(call.tenantId).toBe(TENANT_ID);
    expect(call.idempotencyKey).toBe('evt-123:user-456');
    expect(call.messageStream).toBe('transactional');
    expect(call.tags).toEqual({
      channel: 'notifications',
      entity_type: 'booking',
      entity_id: 'booking-uuid',
    });
  });

  it('filters user lookup by tenant_id (cross-tenant defense)', async () => {
    const { channel, userFilters } = makeHarness({
      user: { id: USER_ID, email: 'approver@example.com' },
    });

    await channel.dispatch({ ...BASE_INPUT, tenantId: OTHER_TENANT_ID });

    expect(userFilters[0]).toEqual({ id: USER_ID, tenant_id: OTHER_TENANT_ID });
  });

  it('returns delivered=false when user not found (no throw)', async () => {
    const { channel, mailProvider } = makeHarness({ user: null });

    const result = await channel.dispatch(BASE_INPUT);

    expect(result).toEqual({ channelId: 'email', delivered: false });
    expect(mailProvider.send).not.toHaveBeenCalled();
  });

  it('returns delivered=false when user has no email (no throw)', async () => {
    const { channel, mailProvider } = makeHarness({
      user: { id: USER_ID, email: null },
    });

    const result = await channel.dispatch(BASE_INPUT);

    expect(result).toEqual({ channelId: 'email', delivered: false });
    expect(mailProvider.send).not.toHaveBeenCalled();
  });

  it('returns delivered=false on a transient supabase error (no throw)', async () => {
    const { channel, mailProvider } = makeHarness({
      userError: { message: 'connection reset' },
    });

    const result = await channel.dispatch(BASE_INPUT);

    expect(result).toEqual({ channelId: 'email', delivered: false });
    expect(mailProvider.send).not.toHaveBeenCalled();
  });

  it('re-throws as AppError(email.dispatch_failed) when MAIL_PROVIDER throws', async () => {
    const { channel } = makeHarness({
      user: { id: USER_ID, email: 'approver@example.com' },
      mailError: new Error('Resend rejected: invalid recipient'),
    });

    await expect(channel.dispatch(BASE_INPUT)).rejects.toMatchObject({
      code: 'email.dispatch_failed',
    });

    // Defensive: confirm it's actually our AppError type, not a leaked
    // raw Error.
    try {
      await channel.dispatch(BASE_INPUT);
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('email.dispatch_failed');
    }
  });

  it('uses RESEND_FROM_EMAIL env when set', async () => {
    const ORIG = process.env.RESEND_FROM_EMAIL;
    process.env.RESEND_FROM_EMAIL = 'custom@prequest.app';
    try {
      const { channel, mailCalls } = makeHarness({
        user: { id: USER_ID, email: 'approver@example.com' },
      });

      await channel.dispatch(BASE_INPUT);
      expect(mailCalls[0].from).toBe('custom@prequest.app');
    } finally {
      if (ORIG === undefined) delete process.env.RESEND_FROM_EMAIL;
      else process.env.RESEND_FROM_EMAIL = ORIG;
    }
  });

  it('falls back to RESEND_DEFAULT_FROM_EMAIL when RESEND_FROM_EMAIL unset', async () => {
    const ORIG_FROM = process.env.RESEND_FROM_EMAIL;
    const ORIG_DEFAULT = process.env.RESEND_DEFAULT_FROM_EMAIL;
    delete process.env.RESEND_FROM_EMAIL;
    process.env.RESEND_DEFAULT_FROM_EMAIL = 'fallback@prequest.app';
    try {
      const { channel, mailCalls } = makeHarness({
        user: { id: USER_ID, email: 'approver@example.com' },
      });

      await channel.dispatch(BASE_INPUT);
      expect(mailCalls[0].from).toBe('fallback@prequest.app');
    } finally {
      if (ORIG_FROM !== undefined) process.env.RESEND_FROM_EMAIL = ORIG_FROM;
      if (ORIG_DEFAULT === undefined) delete process.env.RESEND_DEFAULT_FROM_EMAIL;
      else process.env.RESEND_DEFAULT_FROM_EMAIL = ORIG_DEFAULT;
    }
  });

  it('exposes a stable channel id', () => {
    const { channel } = makeHarness({
      user: { id: USER_ID, email: 'a@b.c' },
    });
    expect(channel.id).toBe('email');
  });
});

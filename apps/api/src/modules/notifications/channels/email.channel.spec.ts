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
 *   - Transient supabase user lookup error THROWS as
 *     AppError(email.dispatch_failed) (self-review I1 — was returning
 *     delivered:false, which dead-lettered recoverable errors).
 *   - Idempotency-Key passed through to MAIL_PROVIDER.
 *   - Tags forwarded for audit/routing.
 *   - ConfigService injection (self-review C2 — was constructor-cached
 *     `process.env.*` reads, the codex 2026-04-28 bug pattern).
 */

import { ConfigService } from '@nestjs/config';
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
  configValues?: Record<string, string>;
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

  // Self-review C2: EmailChannel takes ConfigService, not raw process.env.
  // Tests construct a stub ConfigService that reads from `configValues`
  // (mirrors the @nestjs/config behaviour without booting the full module).
  const config = {
    get: jest.fn((key: string) => opts.configValues?.[key]),
  };

  const channel = new EmailChannel(
    mailProvider,
    supabase as never,
    config as unknown as ConfigService,
  );

  return { channel, mailProvider, mailCalls, userFilters, config };
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

  it('throws AppError(email.dispatch_failed) on a transient supabase error (self-review I1)', async () => {
    // Self-review I1: transient supabase errors used to return
    // { delivered: false } which dead-lettered recoverable errors. Now
    // they throw so the outbox handler retry picks them up. Permanent
    // failures (no email) still return delivered=false (see prior test).
    const { channel, mailProvider } = makeHarness({
      userError: { message: 'connection reset' },
    });

    await expect(channel.dispatch(BASE_INPUT)).rejects.toMatchObject({
      code: 'email.dispatch_failed',
    });
    expect(mailProvider.send).not.toHaveBeenCalled();

    // Defensive: confirm AppError type, not raw Error.
    try {
      await channel.dispatch(BASE_INPUT);
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('email.dispatch_failed');
    }
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

  it('reads RESEND_FROM_EMAIL via ConfigService (self-review C2)', async () => {
    // Self-review C2: was reading process.env at constructor time — the
    // exact codex 2026-04-28 bug pattern that shipped LoggingMailProvider
    // to prod. Now ConfigService.get is called at dispatch time, after
    // ConfigModule.forRoot has loaded `.env`.
    const { channel, mailCalls, config } = makeHarness({
      user: { id: USER_ID, email: 'approver@example.com' },
      configValues: { RESEND_FROM_EMAIL: 'custom@prequest.app' },
    });

    await channel.dispatch(BASE_INPUT);

    expect(mailCalls[0].from).toBe('custom@prequest.app');
    // ConfigService.get was actually called — not bypassed.
    expect(config.get).toHaveBeenCalledWith('RESEND_FROM_EMAIL');
  });

  it('falls back to RESEND_DEFAULT_FROM_EMAIL via ConfigService', async () => {
    const { channel, mailCalls } = makeHarness({
      user: { id: USER_ID, email: 'approver@example.com' },
      configValues: { RESEND_DEFAULT_FROM_EMAIL: 'fallback@prequest.app' },
    });

    await channel.dispatch(BASE_INPUT);
    expect(mailCalls[0].from).toBe('fallback@prequest.app');
  });

  it('falls back to hard-coded default when no config provided', async () => {
    const { channel, mailCalls } = makeHarness({
      user: { id: USER_ID, email: 'approver@example.com' },
      configValues: {},
    });

    await channel.dispatch(BASE_INPUT);
    expect(mailCalls[0].from).toBe('notifications@prequest.app');
    expect(mailCalls[0].fromName).toBe('Prequest');
  });

  it('does not cache config at construction time (self-review C2)', async () => {
    // Regression test for the exact bug the C2 fix prevents: if config
    // were resolved in the constructor, mutating configValues after the
    // EmailChannel was constructed would NOT affect subsequent dispatch
    // calls. With ConfigService.get called per-dispatch, the change is
    // visible.
    const configValues: Record<string, string> = {
      RESEND_FROM_EMAIL: 'first@prequest.app',
    };
    const { channel, mailCalls } = makeHarness({
      user: { id: USER_ID, email: 'approver@example.com' },
      configValues,
    });

    await channel.dispatch(BASE_INPUT);
    expect(mailCalls[0].from).toBe('first@prequest.app');

    // Mutate config AFTER construction.
    configValues.RESEND_FROM_EMAIL = 'second@prequest.app';
    await channel.dispatch(BASE_INPUT);
    expect(mailCalls[1].from).toBe('second@prequest.app');
  });

  it('exposes a stable channel id', () => {
    const { channel } = makeHarness({
      user: { id: USER_ID, email: 'a@b.c' },
    });
    expect(channel.id).toBe('email');
  });
});

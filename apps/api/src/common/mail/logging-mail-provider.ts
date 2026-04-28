import { Injectable, Logger } from '@nestjs/common';
import {
  type MailMessage,
  type MailProvider,
  type MailSendResult,
  type MailWebhookEvent,
  type VerifyWebhookArgs,
} from './mail-provider';

/**
 * Dev-mode mail provider — logs the message instead of dispatching.
 *
 * Used by:
 *   - local dev (no provider credentials needed)
 *   - tests (deterministic, no network)
 *   - tenant-onboarding before a real provider is configured
 *
 * Production wires PostmarkMailProvider via the same DI token.
 */
@Injectable()
export class LoggingMailProvider implements MailProvider {
  private readonly log = new Logger(LoggingMailProvider.name);

  async send(message: MailMessage): Promise<MailSendResult> {
    const att = message.attachments?.length ?? 0;
    this.log.warn(
      `event=mail_send tenant=${message.tenantId} ` +
      `to="${message.to}" subject="${message.subject}" ` +
      `stream=${message.messageStream ?? 'transactional'} ` +
      `attachments=${att} ` +
      `idempotency_key=${message.idempotencyKey ?? '-'}`,
    );
    /* Synthetic id encodes the idempotency key when supplied so log-driven
       assertions (e.g. "did the same key get reused?") are visible. */
    const synthetic = message.idempotencyKey
      ? `dev:${message.idempotencyKey}`
      : `dev:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    return {
      messageId: synthetic,
      acceptedAt: new Date().toISOString(),
    };
  }

  verifyWebhook(_args: VerifyWebhookArgs): MailWebhookEvent[] {
    /* No webhook source in dev — return empty so callers can still call
       the verifier without branching on environment. Real providers
       throw on signature mismatch. */
    return [];
  }
}

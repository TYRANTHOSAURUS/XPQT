import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { LoggingMailProvider } from './logging-mail-provider';
import { MailWebhookController } from './mail-webhook.controller';
import { MAIL_PROVIDER } from './mail-provider';
import { PostmarkMailProvider } from './postmark-mail-provider';

/**
 * Boot-time provider selection. When POSTMARK_SERVER_TOKEN is set in
 * the environment, use the real EU Postmark adapter. Otherwise fall
 * back to the LoggingMailProvider. Tests + local dev get logs without
 * needing credentials; staging / production point at Postmark via env.
 *
 * Per-tenant provider selection (tenant A on Postmark, tenant B on
 * Resend) is a Sprint 5 follow-up — for v1 the platform owns the
 * sender domain + token.
 */
const provider = process.env.POSTMARK_SERVER_TOKEN
  ? PostmarkMailProvider
  : LoggingMailProvider;

@Module({
  imports: [DbModule],
  controllers: [MailWebhookController],
  providers: [
    LoggingMailProvider,
    PostmarkMailProvider,
    {
      provide: MAIL_PROVIDER,
      useExisting: provider,
    },
  ],
  exports: [MAIL_PROVIDER],
})
export class MailModule {}

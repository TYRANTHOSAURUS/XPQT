import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DbModule } from '../db/db.module';
import { LoggingMailProvider } from './logging-mail-provider';
import { MailWebhookController } from './mail-webhook.controller';
import { MAIL_PROVIDER, type MailProvider } from './mail-provider';
import { ResendMailProvider } from './resend-mail-provider';

/**
 * Mail-delivery substrate module. The MAIL_PROVIDER token resolves to
 * the real provider when env credentials are configured, otherwise the
 * dev-mode LoggingMailProvider.
 *
 * Codex 2026-04-28 round-1 caught: provider-selection at module-import
 * time read process.env BEFORE ConfigModule.forRoot() loaded `.env`,
 * leaving production permanently bound to LoggingMailProvider. Fix:
 * useFactory with ConfigService injection so resolution happens at
 * runtime after the env is loaded.
 *
 * Per-tenant provider routing (tenant A on Resend, tenant B on SES)
 * is a Sprint 5 follow-up — for v1 the platform owns the sender
 * domain + token.
 */
@Module({
  imports: [DbModule],
  controllers: [MailWebhookController],
  providers: [
    LoggingMailProvider,
    ResendMailProvider,
    {
      provide: MAIL_PROVIDER,
      inject: [ConfigService, ResendMailProvider, LoggingMailProvider],
      useFactory: (
        config: ConfigService,
        resend: ResendMailProvider,
        logging: LoggingMailProvider,
      ): MailProvider => {
        const apiKey = config.get<string>('RESEND_API_KEY');
        return apiKey ? resend : logging;
      },
    },
  ],
  exports: [MAIL_PROVIDER],
})
export class MailModule {}

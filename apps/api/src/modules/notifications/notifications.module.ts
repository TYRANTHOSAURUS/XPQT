import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MailModule } from '../../common/mail/mail.module';
import { SupabaseModule } from '../../common/supabase/supabase.module';
import { EmailChannel } from './channels/email.channel';
import { NotificationsService } from './notifications.service';
import { NotificationTemplateService } from './template-overrides.service';
import { TemplateResolverService } from './templates/template-resolver.service';

/**
 * NotificationsModule (PLURAL — not to be confused with the legacy
 * NotificationModule (singular) at apps/api/src/modules/notification/).
 *
 * The legacy module owns:
 *   - the older `notifications` table (in-app + email rows);
 *   - `notification_templates` config_entities entries;
 *   - the in-app notification preferences flow.
 *
 * It is the v0 substrate. This module (PLURAL) is the v1 dispatch
 * substrate built around React Email + per-tenant overrides + the
 * shared MAIL_PROVIDER. It will eventually subsume the legacy module's
 * responsibilities; for B.4.A.5 they coexist with no overlap (the legacy
 * surface is consumed by approval / SLA / vendor-portal flows that we
 * don't touch in this slice).
 *
 * Exports `NotificationsService` for the outbox handler in sub-step D.
 */
@Module({
  imports: [ConfigModule, MailModule, SupabaseModule],
  providers: [
    EmailChannel,
    TemplateResolverService,
    NotificationsService,
    // Self-review I6: stub shipped in sub-step C so the module exports a
    // service token for sub-step G's admin CRUD. The contract docblock in
    // template-overrides.service.ts is binding for sub-step G.
    NotificationTemplateService,
  ],
  exports: [NotificationsService, NotificationTemplateService],
})
export class NotificationsModule {}

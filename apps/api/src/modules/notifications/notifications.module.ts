import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MailModule } from '../../common/mail/mail.module';
import { PermissionGuard } from '../../common/permission-guard';
import { SupabaseModule } from '../../common/supabase/supabase.module';
import { EmailChannel } from './channels/email.channel';
import { NotificationsService } from './notifications.service';
import { NotificationTemplateService } from './template-overrides.service';
import { NotificationTemplatesController } from './template-overrides.controller';
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
  controllers: [NotificationTemplatesController],
  providers: [
    EmailChannel,
    TemplateResolverService,
    NotificationsService,
    // Sub-step G: CRUD for `notification_template_overrides` plus the
    // admin HTTP surface that drives the Email-templates settings page.
    NotificationTemplateService,
    // PermissionGuard is module-scoped DI per the daily-list / visitors
    // module convention. The global APP_GUARD already gates auth; this
    // guard adds the `notifications.manage_templates` check inside each
    // controller method (call shape mirrors daily-list-admin.controller).
    PermissionGuard,
  ],
  exports: [NotificationsService, NotificationTemplateService],
})
export class NotificationsModule {}

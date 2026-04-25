/**
 * NEEDS WIRING — Phase H integration step
 *
 * This module is NOT yet imported in apps/api/src/app.module.ts. When you
 * integrate Phase H, add it to the imports array AND update the
 * TenantMiddleware exclude list to skip `api/webhooks/outlook` (the Graph
 * notification endpoint is unauthenticated and resolves tenant from
 * subscription_id internally).
 *
 *   imports: [
 *     ...,
 *     CalendarSyncModule,
 *   ]
 *
 *   consumer
 *     .apply(TenantMiddleware)
 *     .exclude('api/health', 'api/webhooks/ingest', 'api/webhooks/outlook')
 *     .forRoutes('*');
 *
 * Phase C wiring: BookingFlowService should register itself with
 * RoomMailboxService.registerIntercept() inside its onModuleInit. The
 * registered callback receives `{ draft, graphEvent, spaceId, tenantId }`
 * and must return `{ outcome: 'accepted'|'denied'|'conflict', denialMessage? }`.
 * Until that wiring lands, the default impl returns `{ outcome: 'deferred' }`
 * which audits the intercept but neither accepts nor rejects in Outlook.
 */
import { Module } from '@nestjs/common';
import { CalendarSyncController, AdminCalendarSyncController } from './calendar-sync.controller';
import { CalendarSyncService } from './calendar-sync.service';
import { OutlookSyncAdapter } from './outlook-sync.adapter';
import { OutlookWebhookController } from './outlook-webhook.controller';
import { ReconcilerService } from './reconciler.service';
import { RoomMailboxService } from './room-mailbox.service';
import { TokenEncryptionService } from './token-encryption.service';
import { WebhookRenewalService } from './webhook-renewal.service';

@Module({
  controllers: [
    CalendarSyncController,
    AdminCalendarSyncController,
    OutlookWebhookController,
  ],
  providers: [
    CalendarSyncService,
    OutlookSyncAdapter,
    ReconcilerService,
    RoomMailboxService,
    TokenEncryptionService,
    WebhookRenewalService,
  ],
  exports: [
    CalendarSyncService,
    OutlookSyncAdapter,
    RoomMailboxService,
  ],
})
export class CalendarSyncModule {}

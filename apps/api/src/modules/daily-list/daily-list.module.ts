import { Module } from '@nestjs/common';
import { DbModule } from '../../common/db/db.module';
import { PermissionGuard } from '../../common/permission-guard';
import { SupabaseModule } from '../../common/supabase/supabase.module';
import { PrivacyComplianceModule } from '../privacy-compliance/privacy-compliance.module';
import { DailyListAdminController } from './daily-list-admin.controller';
import { DailyListFollowupController } from './daily-list-followup.controller';
import { DailyListFollowupService } from './daily-list-followup.service';
import {
  DAILY_LIST_MAILER,
  LoggingDailyListMailer,
} from './daily-list-mailer.service';
import { DailyListSchedulerService } from './daily-list-scheduler.service';
import { DailyListService } from './daily-list.service';
import { PdfRendererService } from './pdf-renderer.service';

/**
 * Vendor daily-list subsystem — Dutch market name "daglijst", but every
 * code identifier is in English. The PDF template still emits the NL
 * "Daglijst" title because that's the vendor-facing string Dutch
 * caterers expect; FR / EN / DE templates ship in Sprint 4 and use the
 * appropriate localised title.
 *
 * Sprint 1: schema + assemble/record skeleton + audit event taxonomy.
 * Sprint 2: @react-pdf/renderer NL template + Supabase Storage upload +
 *   DailyListMailer abstraction (LoggingDailyListMailer for dev;
 *   Sprint 4 swaps real EU email) + DailyListSchedulerService cron.
 *   Plus 3 codex-driven hardening rounds: CAS state machine, sweeper,
 *   lease fencing, stable correlationId for provider idempotency.
 * Sprint 3 (this commit): admin Fulfillment endpoints (preview,
 *   regenerate, history, download), post-cutoff lock-workflow trigger
 *   (migration 00178), and desk follow-up controller backing the
 *   "Today's late changes" widget.
 * Sprint 4: FR + EN templates + status inference + polish.
 *
 * Spec: docs/superpowers/specs/2026-04-27-vendor-portal-phase-a-daglijst-design.md.
 */
@Module({
  imports: [DbModule, SupabaseModule, PrivacyComplianceModule],
  controllers: [DailyListAdminController, DailyListFollowupController],
  providers: [
    PermissionGuard,
    DailyListService,
    DailyListFollowupService,
    PdfRendererService,
    DailyListSchedulerService,
    LoggingDailyListMailer,
    {
      provide: DAILY_LIST_MAILER,
      useExisting: LoggingDailyListMailer,
    },
  ],
  exports: [DailyListService, PdfRendererService, DAILY_LIST_MAILER],
})
export class DailyListModule {}

import { Module } from '@nestjs/common';
import { DbModule } from '../../common/db/db.module';
import { PermissionGuard } from '../../common/permission-guard';
import { SupabaseModule } from '../../common/supabase/supabase.module';
import { PrivacyComplianceModule } from '../privacy-compliance/privacy-compliance.module';
import { DailyListAdminController } from './daily-list-admin.controller';
import { DailyListFollowupController } from './daily-list-followup.controller';
import { DailyListFollowupService } from './daily-list-followup.service';
import { MailModule } from '../../common/mail/mail.module';
import {
  DAILY_LIST_MAILER,
  ProviderDailyListMailer,
} from './daily-list-mailer.service';
import { DailyListSchedulerService } from './daily-list-scheduler.service';
import { DailyListService } from './daily-list.service';
import { PdfRendererService } from './pdf-renderer.service';
import { DailyListStatusInferenceService } from './status-inference.service';

/**
 * Vendor daily-list subsystem — Dutch market name "daglijst", but every
 * code identifier is in English. Three places intentionally retain the
 * Dutch term:
 *   1. The NL PDF template title ("Daglijst catering") because that's
 *      the string Dutch caterers expect on their printed list.
 *      FR/EN/DE templates ship in Sprint 4 with localised titles.
 *   2. The Supabase Storage bucket name `daglijst-pdfs` — renaming a
 *      live bucket requires creating a new one + moving objects + RLS
 *      policy migration; deferred behind a flag day. Storage path
 *      shape (`<tenant>/<vendor>/<date>/<building>/...pdf`) is
 *      module-internal so callers can't see the bucket.
 *   3. DB column names on `vendors` and `order_line_items`:
 *      daglijst_email, daglijst_language, daglijst_cutoff_offset_minutes,
 *      daglijst_send_clock_time, daglijst_inferred_status_grace_minutes,
 *      daglijst_locked_at, daglijst_id. RENAME COLUMN is cheap but every
 *      code path touching them needs flipping in the same migration;
 *      deferred until a clean batch sweep.
 *
 * If you need to rename any of those three, do it as one focused
 * migration + code sweep — don't fix in passing.
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
  imports: [DbModule, SupabaseModule, PrivacyComplianceModule, MailModule],
  controllers: [DailyListAdminController, DailyListFollowupController],
  providers: [
    PermissionGuard,
    DailyListService,
    DailyListFollowupService,
    DailyListStatusInferenceService,
    PdfRendererService,
    DailyListSchedulerService,
    ProviderDailyListMailer,
    {
      provide: DAILY_LIST_MAILER,
      useExisting: ProviderDailyListMailer,
    },
  ],
  exports: [DailyListService, PdfRendererService, DAILY_LIST_MAILER],
})
export class DailyListModule {}

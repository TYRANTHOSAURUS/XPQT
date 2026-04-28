import { Module } from '@nestjs/common';
import { DbModule } from '../../common/db/db.module';
import { SupabaseModule } from '../../common/supabase/supabase.module';
import { PrivacyComplianceModule } from '../privacy-compliance/privacy-compliance.module';
import {
  DAGLIJST_MAILER,
  LoggingDaglijstMailer,
} from './daglijst-mailer.service';
import { DaglijstSchedulerService } from './daglijst-scheduler.service';
import { DaglijstService } from './daglijst.service';
import { PdfRendererService } from './pdf-renderer.service';

/**
 * Daglijst Phase A — paper-vendor "daily list" subsystem.
 *
 * Sprint 1: schema + assemble/record skeleton + audit event taxonomy.
 * Sprint 2 (this commit): @react-pdf/renderer NL template + Supabase
 *   Storage upload + DaglijstMailer abstraction (LoggingDaglijstMailer
 *   for dev; Sprint 4 swaps real EU email) + DaglijstSchedulerService
 *   cron worker.
 * Sprint 3: admin Fulfillment tab + post-cutoff lock workflow + desk
 *   follow-up dashboard.
 * Sprint 4: FR + EN templates + status inference + polish.
 *
 * Spec: docs/superpowers/specs/2026-04-27-vendor-portal-phase-a-daglijst-design.md.
 */
@Module({
  imports: [DbModule, SupabaseModule, PrivacyComplianceModule],
  providers: [
    DaglijstService,
    PdfRendererService,
    DaglijstSchedulerService,
    LoggingDaglijstMailer,
    {
      provide: DAGLIJST_MAILER,
      useExisting: LoggingDaglijstMailer,
    },
  ],
  exports: [DaglijstService, PdfRendererService, DAGLIJST_MAILER],
})
export class DaglijstModule {}

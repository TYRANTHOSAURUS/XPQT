import { Module } from '@nestjs/common';
import { DbModule } from '../../common/db/db.module';
import { PrivacyComplianceModule } from '../privacy-compliance/privacy-compliance.module';
import { DaglijstService } from './daglijst.service';

/**
 * Daglijst Phase A — paper-vendor "daily list" subsystem.
 *
 * Sprint 1 ships: schema migrations + DaglijstService skeleton (assemble +
 * record + history) + audit event taxonomy.
 *
 * Sprint 2 (next): @react-pdf/renderer template, Supabase Storage upload,
 * email delivery with bounce tracking, scheduling worker.
 *
 * Sprint 3: admin UI tab + post-cutoff lock workflow + desk follow-up
 * dashboard.
 *
 * Spec: docs/superpowers/specs/2026-04-27-vendor-portal-phase-a-daglijst-design.md.
 */
@Module({
  imports: [DbModule, PrivacyComplianceModule],
  providers: [DaglijstService],
  exports: [DaglijstService],
})
export class DaglijstModule {}

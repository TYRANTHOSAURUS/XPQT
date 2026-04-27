import { Module } from '@nestjs/common';
import { DbModule } from '../../common/db/db.module';
import { AuditOutboxService } from './audit-outbox.service';
import { AuditOutboxWorker } from './audit-outbox.worker';
import { DataCategoryRegistry } from './data-category-registry.service';
import { RetentionService } from './retention.service';
import { RetentionWorker } from './retention.worker';

/**
 * Privacy compliance / GDPR baseline subsystem.
 *
 * Wave 0 Sprint 1 deliverables (per gdpr-baseline-design.md §15):
 *   - audit_outbox infrastructure (cross-spec shared per cross-spec map §3.2)
 *   - retention category registry + adapter contract
 *   - RetentionService for settings + apply
 *   - Background workers (audit drain, nightly retention, partition maintenance)
 *
 * Sprint 2 will register concrete DataCategoryAdapter implementations.
 * Sprint 3 wires the @LogPersonalDataAccess decorator + access endpoint.
 * Sprint 4 ships the admin UI + erasure endpoint.
 */
@Module({
  imports: [DbModule],
  providers: [
    AuditOutboxService,
    AuditOutboxWorker,
    DataCategoryRegistry,
    RetentionService,
    RetentionWorker,
  ],
  exports: [
    // Other modules import these — they're the entry points for emitting
    // audits + registering data categories from outside the privacy module.
    AuditOutboxService,
    DataCategoryRegistry,
    RetentionService,
  ],
})
export class PrivacyComplianceModule {}

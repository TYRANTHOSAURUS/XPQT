import { Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { DbModule } from '../../common/db/db.module';
import { DbService } from '../../common/db/db.service';
import { PermissionGuard } from '../../common/permission-guard';
import { SupabaseModule } from '../../common/supabase/supabase.module';
import { AnonymizationAuditService } from './anonymization-audit.service';
import { AuditOutboxService } from './audit-outbox.service';
import { AuditOutboxWorker } from './audit-outbox.worker';
import { DataCategoryRegistry } from './data-category-registry.service';
import { DataSubjectService } from './data-subject.service';
import { GdprAdminController } from './gdpr-admin.controller';
import { LegalHoldService } from './legal-hold.service';
import { PersonalDataAccessInterceptor } from './personal-data-access.interceptor';
import { PersonalDataAccessLogService } from './personal-data-access-log.service';
import { RetentionService } from './retention.service';
import { RetentionWorker } from './retention.worker';
import { VisitorRecordsAdapter } from './adapters/visitor-records.adapter';
import { PersonsAdapter } from './adapters/persons.adapter';
import { AuditEventsAdapter } from './adapters/audit-events.adapter';
import {
  buildEmailNotificationsAdapter,
  buildNoOpAdapters,
  buildPendingSpecAdapters,
  buildWebhookNotificationsAdapter,
} from './adapters/concrete-adapters';

/**
 * Privacy compliance / GDPR baseline subsystem.
 *
 * Sprint 1 shipped: outbox + registry + retention service + worker scaffolding.
 * Sprint 2 shipped: 16 concrete adapters wired into the registry; boot-time
 * coverage check guards against silently missing categories.
 *
 * Per gdpr-baseline-design.md §17 (risk: "Adapter coverage incomplete"),
 * onApplicationBootstrap diff-checks the registered adapters vs. the seed
 * function's category set — warnings surface anything missing.
 */
@Module({
  imports: [DbModule, SupabaseModule],
  controllers: [GdprAdminController],
  providers: [
    AuditOutboxService,
    AuditOutboxWorker,
    AnonymizationAuditService,
    DataCategoryRegistry,
    RetentionService,
    RetentionWorker,
    PersonalDataAccessLogService,
    DataSubjectService,
    LegalHoldService,
    PermissionGuard,

    // Class-based adapters for the categories that need bespoke logic.
    VisitorRecordsAdapter,
    PersonsAdapter,
    AuditEventsAdapter,

    // Global interceptor — observes every controller response and queues
    // an access-log entry whenever the handler is decorated with
    // @LogPersonalDataAccess. Cheap when no metadata is set (early return).
    {
      provide: APP_INTERCEPTOR,
      useClass: PersonalDataAccessInterceptor,
    },
  ],
  exports: [
    AuditOutboxService,
    AnonymizationAuditService,
    DataCategoryRegistry,
    RetentionService,
    PersonalDataAccessLogService,
    DataSubjectService,
    LegalHoldService,
  ],
})
export class PrivacyComplianceModule implements OnApplicationBootstrap {
  private readonly log = new Logger(PrivacyComplianceModule.name);

  constructor(
    private readonly db: DbService,
    private readonly registry: DataCategoryRegistry,
    private readonly retention: RetentionService,
    private readonly visitorRecords: VisitorRecordsAdapter,
    private readonly persons: PersonsAdapter,
    private readonly auditEvents: AuditEventsAdapter,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // 1. Register class-based adapters (DI-built, share connections).
    this.registry.register(this.visitorRecords);
    this.registry.register(this.persons);
    this.registry.register(this.auditEvents);

    // 2. Register factory-built adapters (composition-based).
    this.registry.register(buildWebhookNotificationsAdapter(this.db));
    this.registry.register(buildEmailNotificationsAdapter(this.db));
    for (const a of buildNoOpAdapters()) this.registry.register(a);
    for (const a of buildPendingSpecAdapters()) this.registry.register(a);

    // 3. Coverage check — depends on direct pg. Skip silently when the
    //    pool isn't configured (e.g. preview/demo deploys without
    //    SUPABASE_DB_PASS / SUPABASE_DB_URL) so the API can still boot.
    try {
      const tenants = await this.retention.listActiveTenantIds();
      if (tenants.length === 0) {
        this.log.warn('coverage check skipped — no active tenants yet');
        return;
      }

      const seeded = await this.retention.listSeededCategories(tenants[0]);
      const unimplemented = this.registry.unimplementedCategories(seeded);

      if (unimplemented.length > 0) {
        this.log.error(
          `GDPR adapter coverage gap: ${unimplemented.length} seeded categories have no adapter: ` +
          unimplemented.join(', '),
        );
      } else {
        this.log.log(`GDPR adapter coverage: ${seeded.length}/${seeded.length} categories registered`);
      }
    } catch (err) {
      this.log.warn(
        `GDPR coverage check skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

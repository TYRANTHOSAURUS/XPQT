import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TenantMiddleware } from './common/middleware/tenant.middleware';
import { AuthGuard } from './modules/auth/auth.guard';
import { SupabaseModule } from './common/supabase/supabase.module';
import { HealthController } from './health.controller';
import { TenantModule } from './modules/tenant/tenant.module';
import { AuthModule } from './modules/auth/auth.module';
import { TicketModule } from './modules/ticket/ticket.module';
import { SpaceModule } from './modules/space/space.module';
import { ConfigEngineModule } from './modules/config-engine/config-engine.module';
import { RoutingModule } from './modules/routing/routing.module';
import { SlaModule } from './modules/sla/sla.module';
import { ApprovalModule } from './modules/approval/approval.module';
import { NotificationModule } from './modules/notification/notification.module';
import { WorkflowModule } from './modules/workflow/workflow.module';
import { ReportingModule } from './modules/reporting/reporting.module';
import { PersonModule } from './modules/person/person.module';
import { TeamModule } from './modules/team/team.module';
import { AssetModule } from './modules/asset/asset.module';
import { BusinessHoursModule } from './modules/business-hours/business-hours.module';
import { DelegationModule } from './modules/delegation/delegation.module';
import { UserManagementModule } from './modules/user-management/user-management.module';
import { VendorModule } from './modules/vendor/vendor.module';
import { CatalogMenuModule } from './modules/catalog-menu/catalog-menu.module';
import { PortalModule } from './modules/portal/portal.module';
import { OrgNodeModule } from './modules/org-node/org-node.module';
import { WebhookModule } from './modules/webhook/webhook.module';
import { PortalAppearanceModule } from './modules/portal-appearance/portal-appearance.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '../../.env',
    }),
    ScheduleModule.forRoot(),
    SupabaseModule,
    TenantModule,
    AuthModule,
    TicketModule,
    SpaceModule,
    ConfigEngineModule,
    RoutingModule,
    SlaModule,
    ApprovalModule,
    NotificationModule,
    WorkflowModule,
    ReportingModule,
    PersonModule,
    TeamModule,
    AssetModule,
    BusinessHoursModule,
    DelegationModule,
    UserManagementModule,
    VendorModule,
    CatalogMenuModule,
    PortalModule,
    OrgNodeModule,
    WebhookModule,
    PortalAppearanceModule,
  ],
  controllers: [HealthController],
  providers: [
    // Secure by default: every route requires a valid Supabase Bearer token.
    // Opt out with @Public() on the specific handler or controller.
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(TenantMiddleware)
      .exclude('api/health', 'api/webhooks/ingest')
      .forRoutes('*');
  }
}

import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TenantMiddleware } from './common/middleware/tenant.middleware';
import { AuthGuard } from './modules/auth/auth.guard';
import { SupabaseModule } from './common/supabase/supabase.module';
import { DbModule } from './common/db/db.module';
import { HealthController } from './health.controller';
import { TenantModule } from './modules/tenant/tenant.module';
import { AuthModule } from './modules/auth/auth.module';
import { TicketModule } from './modules/ticket/ticket.module';
import { WorkOrdersModule } from './modules/work-orders/work-orders.module';
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
import { PortalAnnouncementsModule } from './modules/portal-announcements/portal-announcements.module';
import { RoomBookingRulesModule } from './modules/room-booking-rules/room-booking-rules.module';
import { CalendarSyncModule } from './modules/calendar-sync/calendar-sync.module';
import { ReservationsModule } from './modules/reservations/reservations.module';
import { SearchModule } from './modules/search/search.module';
import { BookingBundlesModule } from './modules/booking-bundles/booking-bundles.module';
import { ServiceCatalogModule } from './modules/service-catalog/service-catalog.module';
import { OrdersModule } from './modules/orders/orders.module';
import { BundleTemplatesModule } from './modules/bundle-templates/bundle-templates.module';
import { CostCentersModule } from './modules/cost-centers/cost-centers.module';
import { ServiceRoutingModule } from './modules/service-routing/service-routing.module';
import { PrivacyComplianceModule } from './modules/privacy-compliance/privacy-compliance.module';
import { DailyListModule } from './modules/daily-list/daily-list.module';
import { VendorPortalModule } from './modules/vendor-portal/vendor-portal.module';
import { MailModule } from './common/mail/mail.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '../../.env',
    }),
    ScheduleModule.forRoot(),
    SupabaseModule,
    DbModule,
    TenantModule,
    AuthModule,
    TicketModule,
    WorkOrdersModule,
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
    PortalAnnouncementsModule,
    RoomBookingRulesModule,
    CalendarSyncModule,
    ReservationsModule,
    SearchModule,
    BookingBundlesModule,
    ServiceCatalogModule,
    OrdersModule,
    BundleTemplatesModule,
    CostCentersModule,
    ServiceRoutingModule,
    PrivacyComplianceModule,
    DailyListModule,
    VendorPortalModule,
    MailModule,
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
      .exclude(
        'api/health',
        'api/webhooks/ingest',
        'api/webhooks/outlook',
        'api/webhooks/mail',           // signed by provider, no tenant header
      )
      .forRoutes('*');
  }
}

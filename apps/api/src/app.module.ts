import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TenantMiddleware } from './common/middleware/tenant.middleware';
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
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(TenantMiddleware)
      .exclude('api/health')
      .forRoutes('*');
  }
}

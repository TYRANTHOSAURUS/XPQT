import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TenantMiddleware } from './common/middleware/tenant.middleware';
import { SupabaseModule } from './common/supabase/supabase.module';
import { TenantModule } from './modules/tenant/tenant.module';
import { AuthModule } from './modules/auth/auth.module';
import { TicketModule } from './modules/ticket/ticket.module';

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
    // Modules will be added here as we build them:
    // SpaceModule,
    // AssetModule,
    // WorkflowModule,
    // ApprovalModule,
    // ReservationModule,
    // VisitorModule,
    // OrderModule,
    // SlaModule,
    // NotificationModule,
    // RoutingModule,
    // ReportingModule,
    // ConfigEngineModule,
    // SearchModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(TenantMiddleware)
      .exclude('/api/health')
      .forRoutes('*');
  }
}

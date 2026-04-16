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

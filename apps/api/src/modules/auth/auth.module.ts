import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthGuard } from './auth.guard';
import { AdminGuard } from './admin.guard';
import { AuthEventsService } from './auth-events.service';
import { AuthEventsController } from './auth-events.controller';

@Module({
  imports: [ConfigModule],
  controllers: [AuthEventsController],
  providers: [AuthGuard, AdminGuard, AuthEventsService],
  exports: [AuthGuard, AdminGuard, AuthEventsService],
})
export class AuthModule {}

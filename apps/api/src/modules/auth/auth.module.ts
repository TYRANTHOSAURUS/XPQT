import { Module } from '@nestjs/common';
import { AuthGuard } from './auth.guard';
import { AdminGuard } from './admin.guard';

@Module({
  providers: [AuthGuard, AdminGuard],
  exports: [AuthGuard, AdminGuard],
})
export class AuthModule {}

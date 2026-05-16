import { Module } from '@nestjs/common';
import { DelegationService } from './delegation.service';
import { DelegationController } from './delegation.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  providers: [DelegationService],
  controllers: [DelegationController],
  exports: [DelegationService],
})
export class DelegationModule {}

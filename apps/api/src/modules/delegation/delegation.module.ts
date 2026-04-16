import { Module } from '@nestjs/common';
import { DelegationService } from './delegation.service';
import { DelegationController } from './delegation.controller';

@Module({
  providers: [DelegationService],
  controllers: [DelegationController],
  exports: [DelegationService],
})
export class DelegationModule {}

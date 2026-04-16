import { Module } from '@nestjs/common';
import { SlaService } from './sla.service';
import { SlaController } from './sla.controller';
import { SlaPolicyController } from './sla-policy.controller';

@Module({
  providers: [SlaService],
  controllers: [SlaController, SlaPolicyController],
  exports: [SlaService],
})
export class SlaModule {}

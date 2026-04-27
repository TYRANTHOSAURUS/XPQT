import { Module } from '@nestjs/common';

import { PermissionGuard } from '../../common/permission-guard';
import { CostCentersController } from './cost-centers.controller';
import { CostCentersService } from './cost-centers.service';

@Module({
  providers: [PermissionGuard, CostCentersService],
  controllers: [CostCentersController],
  exports: [CostCentersService],
})
export class CostCentersModule {}

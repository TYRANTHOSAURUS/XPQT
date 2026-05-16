import { Module } from '@nestjs/common';
import { BusinessHoursService } from './business-hours.service';
import { BusinessHoursController } from './business-hours.controller';
import { PermissionGuard } from '../../common/permission-guard';
import { PermissionMetadataGuard } from '../../common/require-permission.decorator';

@Module({
  providers: [BusinessHoursService, PermissionGuard, PermissionMetadataGuard],
  controllers: [BusinessHoursController],
  exports: [BusinessHoursService],
})
export class BusinessHoursModule {}

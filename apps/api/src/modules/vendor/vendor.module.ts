import { Module } from '@nestjs/common';
import { VendorService } from './vendor.service';
import { VendorController } from './vendor.controller';
import { PermissionGuard } from '../../common/permission-guard';
import { PermissionMetadataGuard } from '../../common/require-permission.decorator';

@Module({
  providers: [VendorService, PermissionGuard, PermissionMetadataGuard],
  controllers: [VendorController],
  exports: [VendorService],
})
export class VendorModule {}

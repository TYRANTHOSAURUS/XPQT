import { Module } from '@nestjs/common';

import { PermissionGuard } from '../../common/permission-guard';
import { BundleTemplatesController } from './bundle-templates.controller';
import { BundleTemplatesService } from './bundle-templates.service';

@Module({
  providers: [PermissionGuard, BundleTemplatesService],
  controllers: [BundleTemplatesController],
  exports: [BundleTemplatesService],
})
export class BundleTemplatesModule {}

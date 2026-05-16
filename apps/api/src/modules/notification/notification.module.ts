import { Module } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { NotificationController, NotificationTemplateController } from './notification.controller';
import { PermissionGuard } from '../../common/permission-guard';
import { PermissionMetadataGuard } from '../../common/require-permission.decorator';

@Module({
  providers: [NotificationService, PermissionGuard, PermissionMetadataGuard],
  controllers: [NotificationController, NotificationTemplateController],
  exports: [NotificationService],
})
export class NotificationModule {}

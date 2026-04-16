import { Module } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { NotificationController, NotificationTemplateController } from './notification.controller';

@Module({
  providers: [NotificationService],
  controllers: [NotificationController, NotificationTemplateController],
  exports: [NotificationService],
})
export class NotificationModule {}

import { Module } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { NotificationController, NotificationTemplateController } from './notification.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  providers: [NotificationService],
  controllers: [NotificationController, NotificationTemplateController],
  exports: [NotificationService],
})
export class NotificationModule {}

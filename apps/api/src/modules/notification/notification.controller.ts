import { Controller, Get, Post, Param, Query } from '@nestjs/common';
import { NotificationService } from './notification.service';

@Controller('notifications')
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @Get('person/:personId')
  async getForPerson(
    @Param('personId') personId: string,
    @Query('unread_only') unreadOnly?: string,
  ) {
    return this.notificationService.getInAppForPerson(personId, unreadOnly === 'true');
  }

  @Get('person/:personId/unread-count')
  async getUnreadCount(@Param('personId') personId: string) {
    return this.notificationService.getUnreadCount(personId);
  }

  @Post(':id/read')
  async markAsRead(@Param('id') id: string) {
    return this.notificationService.markAsRead(id);
  }

  @Post('person/:personId/read-all')
  async markAllAsRead(@Param('personId') personId: string) {
    return this.notificationService.markAllAsRead(personId);
  }
}

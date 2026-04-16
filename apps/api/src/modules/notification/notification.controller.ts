import { Controller, Get, Post, Patch, Param, Query, Body } from '@nestjs/common';
import { NotificationService, CreateNotificationTemplateDto } from './notification.service';

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

  // ─── Templates (nested under /notifications/templates) ───────────────────

  @Get('templates')
  async listTemplates() {
    return this.notificationService.listTemplates();
  }

  @Post('templates')
  async createTemplate(@Body() dto: CreateNotificationTemplateDto) {
    return this.notificationService.createTemplate(dto);
  }

  @Patch('templates/:id')
  async updateTemplate(
    @Param('id') id: string,
    @Body() dto: Partial<CreateNotificationTemplateDto>,
  ) {
    return this.notificationService.updateTemplate(id, dto);
  }
}

@Controller('notification-templates')
export class NotificationTemplateController {
  constructor(private readonly notificationService: NotificationService) {}

  @Get()
  async list() {
    return this.notificationService.listTemplates();
  }

  @Post()
  async create(@Body() dto: CreateNotificationTemplateDto) {
    return this.notificationService.createTemplate(dto);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: Partial<CreateNotificationTemplateDto>,
  ) {
    return this.notificationService.updateTemplate(id, dto);
  }
}

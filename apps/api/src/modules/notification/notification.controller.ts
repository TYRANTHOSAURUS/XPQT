import { Controller, Get, Post, Patch, Param, Query, Body, UseGuards } from '@nestjs/common';
import { NotificationService, CreateNotificationTemplateDto } from './notification.service';
import { AdminGuard } from '../auth/admin.guard';

// docs/follow-ups/audits/04-rls-security.md Slice 10 (2026-05-16).
// Notification TEMPLATE mutations are tenant-wide comms config →
// admin-only. The per-person self-service routes (GET/POST
// person/:personId*, POST :id/read) are deliberately NOT guarded —
// every user manages their OWN in-app notifications.
// NOTE (follow-up, not this slice): POST :id/read takes a bare
// notification id with no ownership check — a same-tenant IDOR
// (mark-anyone's-notification-read). Integrity-class, not
// escalation; logged in the closure ledger.
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
  @UseGuards(AdminGuard)
  async createTemplate(@Body() dto: CreateNotificationTemplateDto) {
    return this.notificationService.createTemplate(dto);
  }

  @Patch('templates/:id')
  @UseGuards(AdminGuard)
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
  @UseGuards(AdminGuard)
  async create(@Body() dto: CreateNotificationTemplateDto) {
    return this.notificationService.createTemplate(dto);
  }

  @Patch(':id')
  @UseGuards(AdminGuard)
  async update(
    @Param('id') id: string,
    @Body() dto: Partial<CreateNotificationTemplateDto>,
  ) {
    return this.notificationService.updateTemplate(id, dto);
  }
}

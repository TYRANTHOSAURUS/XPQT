import { Controller, Get, Post, Patch, Param, Body } from '@nestjs/common';
import { NotificationService, CreateNotificationTemplateDto } from './notification.service';
import { RequirePermission } from '../../common/require-permission.decorator';

// docs/follow-ups/audits/04-rls-security.md (codex 2026-05-18, remaining
// #1). The legacy per-person/id consumer routes (GET/POST
// person/:personId*, POST :id/read, .../read-all) were a same-tenant
// IDOR: they read/flipped read-state by a caller-supplied id/personId
// with NO recipient binding, and `supabase.admin` bypasses RLS, so any
// authed same-tenant user could touch anyone's notifications. They had
// zero callers — the user-facing inbox is the server-derived,
// auth-bound `/me/inbox/*` surface (InboxController, B.4.A.5). The dead
// routes were deleted rather than re-secured (no point hardening an
// unused redundant surface). Only the tenant-wide notification TEMPLATE
// admin routes remain here, gated `notifications.manage_templates`.
@Controller('notifications')
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  // ─── Templates (nested under /notifications/templates) ───────────────────

  @Get('templates')
  async listTemplates() {
    return this.notificationService.listTemplates();
  }

  @Post('templates')
  @RequirePermission('notifications.manage_templates')
  async createTemplate(@Body() dto: CreateNotificationTemplateDto) {
    return this.notificationService.createTemplate(dto);
  }

  @Patch('templates/:id')
  @RequirePermission('notifications.manage_templates')
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
  @RequirePermission('notifications.manage_templates')
  async create(@Body() dto: CreateNotificationTemplateDto) {
    return this.notificationService.createTemplate(dto);
  }

  @Patch(':id')
  @RequirePermission('notifications.manage_templates')
  async update(
    @Param('id') id: string,
    @Body() dto: Partial<CreateNotificationTemplateDto>,
  ) {
    return this.notificationService.updateTemplate(id, dto);
  }
}

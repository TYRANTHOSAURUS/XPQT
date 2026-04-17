import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { WorkflowWebhookService } from './workflow-webhook.service';

/**
 * Tenant-scoped admin CRUD for workflow webhooks.
 * Runs through TenantMiddleware (like all other tenanted routes).
 */
@Controller('workflow-webhooks')
export class WorkflowWebhookController {
  constructor(private readonly svc: WorkflowWebhookService) {}

  @Get()
  async list() {
    return this.svc.list();
  }

  @Post()
  async create(@Body() dto: {
    name: string;
    workflow_id: string;
    ticket_defaults?: Record<string, unknown>;
    field_mapping?: Record<string, string>;
  }) {
    return this.svc.create(dto);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: {
    name?: string;
    active?: boolean;
    ticket_defaults?: Record<string, unknown>;
    field_mapping?: Record<string, string>;
    workflow_id?: string;
  }) {
    return this.svc.update(id, dto);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.svc.remove(id);
    return { ok: true };
  }

  @Post(':id/rotate-token')
  async rotate(@Param('id') id: string) {
    return this.svc.rotateToken(id);
  }
}

/**
 * Public receive endpoint — no auth, no tenant middleware.
 * Registered at the root so we can exclude it from TenantMiddleware in app.module.
 */
@Controller('webhooks')
export class WorkflowWebhookReceiveController {
  constructor(private readonly svc: WorkflowWebhookService) {}

  @Post(':token')
  async receive(@Param('token') token: string, @Body() body: Record<string, unknown>) {
    return this.svc.receive(token, body ?? {});
  }
}

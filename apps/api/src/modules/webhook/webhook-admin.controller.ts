import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { WebhookAdminService, WebhookUpsertDto } from './webhook-admin.service';
import type { WebhookEventRow } from './webhook-event.service';
import { RequirePermission } from '../../common/require-permission.decorator';

@Controller('workflow-webhooks')
export class WebhookAdminController {
  constructor(private readonly svc: WebhookAdminService) {}

  @Get()
  @RequirePermission('webhooks.read')
  list() {
    return this.svc.list();
  }

  @Post()
  @RequirePermission('webhooks.create')
  create(@Body() dto: WebhookUpsertDto) {
    return this.svc.create(dto);
  }

  @Patch(':id')
  @RequirePermission('webhooks.update')
  update(@Param('id') id: string, @Body() dto: Partial<WebhookUpsertDto>) {
    return this.svc.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('webhooks.delete')
  async remove(@Param('id') id: string) {
    await this.svc.remove(id);
    return { ok: true };
  }

  @Post(':id/api-key/rotate')
  @RequirePermission('webhooks.rotate_key')
  rotateApiKey(@Param('id') id: string) {
    return this.svc.rotateApiKey(id);
  }

  @Get(':id/events')
  @RequirePermission('webhooks.read')
  listEvents(
    @Param('id') id: string,
    @Query('status') status?: WebhookEventRow['status'],
    @Query('external_id') externalId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.listEvents(id, {
      status,
      external_id: externalId,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post(':id/test')
  @RequirePermission('webhooks.test')
  test(@Param('id') id: string, @Body() body: { payload: Record<string, unknown> }) {
    return this.svc.testPayload(id, body?.payload ?? {});
  }
}

import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { WebhookAdminService, WebhookUpsertDto } from './webhook-admin.service';
import type { WebhookEventRow } from './webhook-event.service';

@Controller('workflow-webhooks')
export class WebhookAdminController {
  constructor(private readonly svc: WebhookAdminService) {}

  @Get()
  list() {
    return this.svc.list();
  }

  @Post()
  create(@Body() dto: WebhookUpsertDto) {
    return this.svc.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: Partial<WebhookUpsertDto>) {
    return this.svc.update(id, dto);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.svc.remove(id);
    return { ok: true };
  }

  @Post(':id/api-key/rotate')
  rotateApiKey(@Param('id') id: string) {
    return this.svc.rotateApiKey(id);
  }

  @Get(':id/events')
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
  test(@Param('id') id: string, @Body() body: { payload: Record<string, unknown> }) {
    return this.svc.testPayload(id, body?.payload ?? {});
  }
}

import { Controller, Get, Post, Patch, Param, Body, Query } from '@nestjs/common';
import { ConfigEngineService, CreateConfigEntityDto, UpdateConfigVersionDto } from './config-engine.service';
import { RequirePermission } from '../../common/require-permission.decorator';

/**
 * Generic versioned config-entity store. Today this exclusively backs
 * request-type **form schemas** (`config_type: 'form_schema'`) — the
 * form-builder behind request types (see the sibling
 * RequestTypeController, which is gated `request_types.*`, and the
 * frontend `@/api/config-entities` callers under form-schema-detail /
 * request-type-dialog). So it is gated on the `request_types` domain to
 * match that sibling, NOT `routing.*` (the routing policy store is the
 * separate RoutingPoliciesController on PolicyStoreService). RLS audit
 * Slice 11.3.
 *
 * Slice 11.4 (codex DECISION A): `GET /:id` is on the REQUESTER portal
 * critical path (submit-request.tsx renders a request type's form via
 * this) and the desk create-ticket dialog — neither caller is admin.
 * Pre-11.3 it was class-level AdminGuard (so they were already 403'd —
 * a pre-existing latent defect). It is gated `request_types.use` (a
 * portal-reachable key granted to every ticket-creating template), NOT
 * the admin `request_types.read` that backs the form-schema management
 * surface. `list` + mutations stay admin-tier (`request_types.read` /
 * `.create` / `.update` / `.publish`).
 */
@Controller('config-entities')
export class ConfigEntityController {
  constructor(private readonly configEngineService: ConfigEngineService) {}

  @Get()
  @RequirePermission('request_types.read')
  async list(@Query('type') type?: string) {
    if (!type) return [];
    return this.configEngineService.listByType(type);
  }

  @Get(':id')
  @RequirePermission('request_types.use')
  async getById(@Param('id') id: string) {
    return this.configEngineService.getById(id);
  }

  @Post()
  @RequirePermission('request_types.create')
  async create(@Body() dto: CreateConfigEntityDto) {
    return this.configEngineService.create(dto);
  }

  @Post(':id/draft')
  @RequirePermission('request_types.update')
  async createDraft(@Param('id') id: string, @Body() dto: UpdateConfigVersionDto) {
    return this.configEngineService.createDraft(id, dto);
  }

  @Patch(':id/draft')
  @RequirePermission('request_types.update')
  async updateDraft(@Param('id') id: string, @Body() dto: UpdateConfigVersionDto) {
    return this.configEngineService.updateDraft(id, dto);
  }

  @Post(':id/publish')
  @RequirePermission('request_types.publish')
  async publish(@Param('id') id: string) {
    return this.configEngineService.publish(id);
  }

  @Post(':id/rollback/:versionId')
  @RequirePermission('request_types.publish')
  async rollback(@Param('id') id: string, @Param('versionId') versionId: string) {
    return this.configEngineService.rollback(id, versionId);
  }
}

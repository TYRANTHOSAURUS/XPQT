import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { RequestTypeService } from './request-type.service';
import { PermissionGuard } from '../../common/permission-guard';

@Controller('request-types')
export class RequestTypeController {
  constructor(
    private readonly requestTypeService: RequestTypeService,
    private readonly permissions: PermissionGuard,
  ) {}

  @Get()
  async list(@Query('domain') domain?: string) {
    return this.requestTypeService.list(domain);
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.requestTypeService.getById(id);
  }

  @Post()
  async create(
    @Req() request: Request,
    @Body() dto: {
      name: string;
      domain?: string;
      form_schema_id?: string;
      workflow_definition_id?: string;
      sla_policy_id?: string;
      fulfillment_strategy?: 'asset' | 'location' | 'fixed' | 'auto';
      requires_asset?: boolean;
      asset_required?: boolean;
      asset_type_filter?: string[];
      requires_location?: boolean;
      location_required?: boolean;
      location_granularity?: string | null;
      default_team_id?: string | null;
      default_vendor_id?: string | null;
      requires_approval?: boolean;
      approval_approver_team_id?: string | null;
      approval_approver_person_id?: string | null;
    },
  ) {
    // RT mutations mirror into service_items via triggers 00070/00071/00072.
    // Require BOTH permissions so a role with only request_types:manage can't
    // indirectly edit portal-facing catalog data without service_catalog:manage.
    // Admin seeds get both (migrations 00054 + 00067). Codex end-to-end finding #3.
    await this.permissions.requirePermission(request, 'request_types:manage');
    await this.permissions.requirePermission(request, 'service_catalog:manage');
    return this.requestTypeService.create(dto);
  }

  @Patch(':id')
  async update(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: Record<string, unknown>,
  ) {
    // RT mutations mirror into service_items via triggers 00070/00071/00072.
    // Require BOTH permissions so a role with only request_types:manage can't
    // indirectly edit portal-facing catalog data without service_catalog:manage.
    // Admin seeds get both (migrations 00054 + 00067). Codex end-to-end finding #3.
    await this.permissions.requirePermission(request, 'request_types:manage');
    await this.permissions.requirePermission(request, 'service_catalog:manage');
    return this.requestTypeService.update(id, dto);
  }
}

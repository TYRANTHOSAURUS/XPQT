import { Controller, Get, Post, Patch, Param, Body, Query } from '@nestjs/common';
import { RequestTypeService } from './request-type.service';

@Controller('request-types')
export class RequestTypeController {
  constructor(private readonly requestTypeService: RequestTypeService) {}

  @Get()
  async list(@Query('domain') domain?: string) {
    return this.requestTypeService.list(domain);
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.requestTypeService.getById(id);
  }

  @Post()
  async create(@Body() dto: {
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
    default_team_id?: string | null;
    default_vendor_id?: string | null;
    requires_approval?: boolean;
    approval_approver_team_id?: string | null;
    approval_approver_person_id?: string | null;
  }) {
    return this.requestTypeService.create(dto);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: Record<string, unknown>) {
    return this.requestTypeService.update(id, dto);
  }
}

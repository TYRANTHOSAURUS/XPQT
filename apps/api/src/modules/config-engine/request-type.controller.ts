import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  AudienceRuleInput,
  CoverageRuleInput,
  FormVariantInput,
  OnBehalfRuleInput,
  RequestTypeService,
  ScopeOverrideInput,
} from './request-type.service';
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
  async create(@Req() request: Request, @Body() dto: Record<string, unknown>) {
    await this.permissions.requirePermission(request, 'request_types:manage');
    return this.requestTypeService.create(dto as Parameters<RequestTypeService['create']>[0]);
  }

  @Patch(':id')
  async update(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: Record<string, unknown>,
  ) {
    await this.permissions.requirePermission(request, 'request_types:manage');
    return this.requestTypeService.update(id, dto);
  }

  @Delete(':id')
  async remove(@Req() request: Request, @Param('id') id: string) {
    // Soft-delete: mark inactive. Hard deletion would orphan tickets/history.
    await this.permissions.requirePermission(request, 'request_types:manage');
    return this.requestTypeService.update(id, { active: false });
  }

  // ── Per-request-type satellite tables ─────────────────────────────────
  // Each endpoint is a PUT-replace: the request body is the new full set of
  // rows for this request type. The service guards DB invariants (scope XOR,
  // handler shape, non-empty override, at-most-one-default variant) plus
  // cross-tenant FK validation for every referenced id.
  // See docs/service-catalog-live.md §10.
  //
  // Both GET and PUT require request_types:manage. The satellite rows expose
  // handler/vendor/workflow/SLA/policy identifiers that are not user-safe to
  // enumerate without the admin grant — no separate read-permission today.

  @Get(':id/categories')
  async listCategories(@Req() request: Request, @Param('id') id: string) {
    await this.permissions.requirePermission(request, 'request_types:manage');
    return this.requestTypeService.listCategories(id);
  }

  @Put(':id/categories')
  async putCategories(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: { category_ids: string[] },
  ) {
    await this.permissions.requirePermission(request, 'request_types:manage');
    return this.requestTypeService.putCategories(id, body.category_ids ?? []);
  }

  @Get(':id/coverage')
  async listCoverage(@Req() request: Request, @Param('id') id: string) {
    await this.permissions.requirePermission(request, 'request_types:manage');
    return this.requestTypeService.listCoverage(id);
  }

  @Put(':id/coverage')
  async putCoverage(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: { rules: CoverageRuleInput[] },
  ) {
    await this.permissions.requirePermission(request, 'request_types:manage');
    return this.requestTypeService.putCoverage(id, body.rules ?? []);
  }

  @Get(':id/audience')
  async listAudience(@Req() request: Request, @Param('id') id: string) {
    await this.permissions.requirePermission(request, 'request_types:manage');
    return this.requestTypeService.listAudience(id);
  }

  @Put(':id/audience')
  async putAudience(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: { rules: AudienceRuleInput[] },
  ) {
    await this.permissions.requirePermission(request, 'request_types:manage');
    return this.requestTypeService.putAudience(id, body.rules ?? []);
  }

  @Get(':id/form-variants')
  async listFormVariants(@Req() request: Request, @Param('id') id: string) {
    await this.permissions.requirePermission(request, 'request_types:manage');
    return this.requestTypeService.listFormVariants(id);
  }

  @Put(':id/form-variants')
  async putFormVariants(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: { variants: FormVariantInput[] },
  ) {
    await this.permissions.requirePermission(request, 'request_types:manage');
    return this.requestTypeService.putFormVariants(id, body.variants ?? []);
  }

  @Get(':id/on-behalf-rules')
  async listOnBehalfRules(@Req() request: Request, @Param('id') id: string) {
    await this.permissions.requirePermission(request, 'request_types:manage');
    return this.requestTypeService.listOnBehalfRules(id);
  }

  @Put(':id/on-behalf-rules')
  async putOnBehalfRules(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: { rules: OnBehalfRuleInput[] },
  ) {
    await this.permissions.requirePermission(request, 'request_types:manage');
    return this.requestTypeService.putOnBehalfRules(id, body.rules ?? []);
  }

  @Get(':id/scope-overrides')
  async listScopeOverrides(@Req() request: Request, @Param('id') id: string) {
    await this.permissions.requirePermission(request, 'request_types:manage');
    return this.requestTypeService.listScopeOverrides(id);
  }

  @Get(':id/coverage-matrix')
  async getCoverageMatrix(@Req() request: Request, @Param('id') id: string) {
    await this.permissions.requirePermission(request, 'request_types:manage');
    return this.requestTypeService.getCoverageMatrix(id);
  }

  @Put(':id/scope-overrides')
  async putScopeOverrides(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: { overrides: ScopeOverrideInput[] },
  ) {
    await this.permissions.requirePermission(request, 'request_types:manage');
    return this.requestTypeService.putScopeOverrides(id, body.overrides ?? []);
  }
}

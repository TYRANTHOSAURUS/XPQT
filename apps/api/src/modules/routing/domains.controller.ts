import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { TenantContext } from '../../common/tenant-context';
import { DomainRegistryService } from './domain-registry.service';

/**
 * HTTP surface for the domain registry (public.domains).
 *
 * Distinct from the legacy DomainParentsController (`/domain-parents`) which
 * edits the free-text `domain_parents` table. This new controller powers the
 * Routing Studio's domain-registry editor. During dual-run both endpoints
 * coexist; Artifact D step 9 retires the legacy one.
 */
@Controller('admin/routing/domains')
export class RoutingDomainsController {
  constructor(private readonly registry: DomainRegistryService) {}

  @Get()
  async list() {
    const tenant = TenantContext.current();
    return this.registry.list(tenant.id);
  }

  @Get('lookup')
  async lookup(@Query('key') key?: string) {
    if (!key) throw new BadRequestException('key query param is required');
    const tenant = TenantContext.current();
    const hit = await this.registry.findByKey(tenant.id, key);
    return { domain: hit };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const tenant = TenantContext.current();
    return this.registry.get(tenant.id, id);
  }

  @Post()
  async create(@Body() body: CreateDomainBody) {
    if (!body?.key) throw new BadRequestException('key is required');
    if (!body.display_name) throw new BadRequestException('display_name is required');
    const tenant = TenantContext.current();
    return this.registry.create({
      tenant_id: tenant.id,
      key: body.key,
      display_name: body.display_name,
      parent_domain_id: body.parent_domain_id ?? null,
    });
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: UpdateDomainBody) {
    const tenant = TenantContext.current();
    return this.registry.update({
      tenant_id: tenant.id,
      id,
      display_name: body?.display_name,
      parent_domain_id: body?.parent_domain_id,
      active: body?.active,
    });
  }

  @Delete(':id')
  async deactivate(@Param('id') id: string) {
    const tenant = TenantContext.current();
    return this.registry.deactivate(tenant.id, id);
  }
}

interface CreateDomainBody {
  key: string;
  display_name: string;
  parent_domain_id?: string | null;
}

interface UpdateDomainBody {
  display_name?: string;
  parent_domain_id?: string | null;
  active?: boolean;
}

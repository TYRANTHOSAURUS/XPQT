import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
} from '@nestjs/common';
import { ROUTING_STUDIO_SCHEMAS, type RoutingStudioConfigType } from '@prequest/shared';
import { TenantContext } from '../../common/tenant-context';
import { PolicyStoreService } from './policy-store.service';

/**
 * HTTP surface for the v2 routing policies built on config_entities +
 * config_versions. Admin-only (relies on the same subdomain/header-based
 * tenant resolution the rest of the admin area uses; no extra auth guard
 * today, matching existing controllers like DomainParentsController).
 *
 * Shape:
 *   GET    /admin/routing/policies/:config_type                       — list entities of a type
 *   GET    /admin/routing/policies/:config_type/:entity_id            — fetch entity + its published definition
 *   POST   /admin/routing/policies/:config_type                       — create entity
 *   POST   /admin/routing/policies/:config_type/:entity_id/versions   — create draft version
 *   POST   /admin/routing/policies/versions/:version_id/publish       — publish draft → published
 */
@Controller('admin/routing/policies')
export class RoutingPoliciesController {
  constructor(private readonly store: PolicyStoreService) {}

  @Get('schemas')
  getSchemas() {
    return Object.keys(ROUTING_STUDIO_SCHEMAS);
  }

  @Get(':config_type')
  async list(@Param('config_type') configType: string) {
    const type = assertRoutingType(configType);
    const tenant = TenantContext.current();
    return this.store.listEntities(tenant.id, type);
  }

  @Get(':config_type/:entity_id')
  async get(
    @Param('config_type') configType: string,
    @Param('entity_id') entityId: string,
  ) {
    const type = assertRoutingType(configType);
    const tenant = TenantContext.current();
    const entity = await this.store.getEntity(tenant.id, entityId);
    if (entity.config_type !== type) {
      throw new BadRequestException(
        `entity ${entityId} is ${entity.config_type}, not ${type}`,
      );
    }
    const published = await this.store.getPublishedDefinition(tenant.id, entityId);
    return { entity, published };
  }

  @Post(':config_type')
  async create(
    @Param('config_type') configType: string,
    @Body() body: CreateEntityBody,
  ) {
    const type = assertRoutingType(configType);
    if (!body?.slug || typeof body.slug !== 'string') {
      throw new BadRequestException('slug (string) is required');
    }
    if (!body.display_name || typeof body.display_name !== 'string') {
      throw new BadRequestException('display_name (string) is required');
    }
    const tenant = TenantContext.current();
    return this.store.createEntity({
      tenant_id: tenant.id,
      config_type: type,
      slug: body.slug,
      display_name: body.display_name,
    });
  }

  @Post(':config_type/:entity_id/versions')
  async createVersion(
    @Param('config_type') configType: string,
    @Param('entity_id') entityId: string,
    @Body() body: CreateVersionBody,
  ) {
    assertRoutingType(configType); // sanity — the store re-checks via the entity
    if (!body || body.definition === undefined) {
      throw new BadRequestException('definition is required');
    }
    const tenant = TenantContext.current();
    return this.store.createDraftVersion({
      tenant_id: tenant.id,
      entity_id: entityId,
      definition: body.definition,
      created_by: body.created_by ?? null,
    });
  }

  @Post('versions/:version_id/publish')
  async publish(
    @Param('version_id') versionId: string,
    @Body() body?: PublishVersionBody,
  ) {
    const tenant = TenantContext.current();
    return this.store.publishVersion({
      tenant_id: tenant.id,
      version_id: versionId,
      published_by: body?.published_by ?? null,
    });
  }
}

function assertRoutingType(raw: string): RoutingStudioConfigType {
  if (raw in ROUTING_STUDIO_SCHEMAS) return raw as RoutingStudioConfigType;
  throw new BadRequestException(
    `config_type "${raw}" is not a routing-studio policy type`,
  );
}

interface CreateEntityBody {
  slug: string;
  display_name: string;
}

interface CreateVersionBody {
  definition: unknown;
  created_by?: string | null;
}

interface PublishVersionBody {
  published_by?: string | null;
}

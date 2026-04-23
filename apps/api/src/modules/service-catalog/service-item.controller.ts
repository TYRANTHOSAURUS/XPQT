import {
  Controller,
  Get,
  GoneException,
  Param,
  Post,
  Put,
  Patch,
  Delete,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ServiceItemService } from './service-item.service';
import { PermissionGuard } from '../../common/permission-guard';

/**
 * Frozen-for-retirement controller.
 *
 * The service-catalog collapse moved authoring to /request-types/:id/*.
 * Phase D deleted the frontend callers; this controller stays mounted for
 * Phase E's codepath audit, but every mutator now returns 410 Gone so no
 * admin tool can silently create drift between the legacy service_item_*
 * tables and the live request_type_* tables. The legacy one-way mirror
 * triggers still propagate from request_types → service_items so the
 * snapshot tables stay consistent until Phase E drops them.
 *
 * GET endpoints remain available for audit + migration sanity checks. They
 * are guarded by service_catalog:manage (the seeded admin permission). When
 * Phase E deletes the whole service_items schema, this module is unregistered
 * in the same commit.
 */
@Controller('admin/service-items')
export class ServiceItemController {
  constructor(
    private readonly service: ServiceItemService,
    private readonly permissions: PermissionGuard,
  ) {}

  private retiredMessage = {
    code: 'service_items_retired',
    message:
      '/admin/service-items is retired. Manage catalog configuration via /request-types/:id/{categories,coverage,audience,form-variants,on-behalf-rules,scope-overrides}. See docs/service-catalog-live.md.',
  } as const;

  private refuse(): never {
    throw new GoneException(this.retiredMessage);
  }

  @Get()
  async list(@Req() request: Request) {
    await this.permissions.requirePermission(request, 'service_catalog:manage');
    return this.service.list();
  }

  @Get(':id')
  async getById(@Req() request: Request, @Param('id') id: string) {
    await this.permissions.requirePermission(request, 'service_catalog:manage');
    return this.service.getById(id);
  }

  @Get('by-request-type/:requestTypeId')
  async getByRequestTypeId(
    @Req() request: Request,
    @Param('requestTypeId') requestTypeId: string,
  ) {
    await this.permissions.requirePermission(request, 'service_catalog:manage');
    return this.service.getByRequestTypeId(requestTypeId);
  }

  @Get(':id/coverage-matrix')
  async coverageMatrix(@Req() request: Request, @Param('id') id: string) {
    await this.permissions.requirePermission(request, 'service_catalog:manage');
    return this.service.getCoverageMatrix(id);
  }

  @Post()
  create(): never { return this.refuse(); }

  @Patch(':id')
  update(): never { return this.refuse(); }

  @Delete(':id')
  remove(): never { return this.refuse(); }

  @Put(':id/offerings')
  putOfferings(): never { return this.refuse(); }

  @Put(':id/categories')
  putCategories(): never { return this.refuse(); }

  @Put(':id/handler-at')
  setHandlerAt(): never { return this.refuse(); }
}

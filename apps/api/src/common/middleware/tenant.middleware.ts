import { Injectable, NestMiddleware, NotFoundException } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { TenantContext, TenantInfo } from '../tenant-context';
import { TenantService } from '../../modules/tenant/tenant.service';

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(private readonly tenantService: TenantService) {}

  async use(req: Request, _res: Response, next: NextFunction) {
    const tenant = await this.resolveTenant(req);
    if (!tenant) {
      throw new NotFoundException('Unknown tenant');
    }

    TenantContext.run(tenant, () => next());
  }

  private async resolveTenant(req: Request): Promise<TenantInfo | null> {
    // Method 1: Subdomain (primary — acme.platform.com)
    const host = req.hostname;
    const subdomain = host.split('.')[0];
    if (subdomain && subdomain !== 'www' && subdomain !== 'localhost') {
      return this.tenantService.resolveBySlug(subdomain);
    }

    // Method 2: Header (for API consumers)
    const headerTenantId = req.headers['x-tenant-id'] as string;
    if (headerTenantId) {
      return this.tenantService.resolveById(headerTenantId);
    }

    // Local development: use default tenant or first available
    if (host === 'localhost' || host === '127.0.0.1') {
      return this.tenantService.resolveDefault();
    }

    return null;
  }
}

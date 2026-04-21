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
    // Method 1: Header (for API consumers — explicit wins)
    const headerTenantId = req.headers['x-tenant-id'] as string;
    if (headerTenantId) {
      const t = await this.tenantService.resolveById(headerTenantId);
      if (t) return t;
    }

    // Method 2: Subdomain (primary — acme.platform.com)
    const host = req.hostname;
    const subdomain = host.split('.')[0];
    if (subdomain && subdomain !== 'www' && subdomain !== 'localhost') {
      const t = await this.tenantService.resolveBySlug(subdomain);
      if (t) return t;
    }

    // Local development / single-tenant deploy: resolve a default tenant.
    const isLocal = host === 'localhost' || host === '127.0.0.1';
    const fallbackSlug = process.env.DEFAULT_TENANT_SLUG;
    if (isLocal || fallbackSlug) {
      if (fallbackSlug) {
        const t = await this.tenantService.resolveBySlug(fallbackSlug);
        if (t) return t;
      }
      return this.tenantService.resolveDefault();
    }

    return null;
  }
}

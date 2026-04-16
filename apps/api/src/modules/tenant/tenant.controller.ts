import { Controller, Get } from '@nestjs/common';
import { TenantContext } from '../../common/tenant-context';

@Controller('tenants')
export class TenantController {
  @Get('current')
  getCurrentTenant() {
    const tenant = TenantContext.current();
    return { id: tenant.id, slug: tenant.slug, tier: tenant.tier };
  }
}

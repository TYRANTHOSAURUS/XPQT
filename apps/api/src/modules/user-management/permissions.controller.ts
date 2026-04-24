import { Controller, Get, Param } from '@nestjs/common';
import { PERMISSION_CATALOG } from '@prequest/shared';
import { UserManagementService } from './user-management.service';

@Controller('permissions')
export class PermissionsController {
  constructor(private readonly service: UserManagementService) {}

  /**
   * Returns the static permission catalog so the admin UI can render the
   * grouped permission picker. The catalog lives in @prequest/shared; this
   * endpoint exists so the frontend doesn't need to bundle it, and so
   * future per-tenant overrides (if ever introduced) can be layered in.
   */
  @Get('catalog')
  getCatalog() {
    return { catalog: PERMISSION_CATALOG };
  }

  /**
   * Resolves the granted permission set for a user — union of their active
   * role assignments with wildcard expansion, plus attribution metadata
   * (which role granted each permission and under which scope).
   */
  @Get('users/:userId/effective')
  async effective(@Param('userId') userId: string) {
    return this.service.getEffectivePermissions(userId);
  }
}

import { Controller, Get, Param } from '@nestjs/common';
import { PERMISSION_CATALOG } from '@prequest/shared';
import { RequirePermission } from '../../common/require-permission.decorator';
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
  // Slice 11.6(A): intentionally NOT gated. The catalog is the static
  // @prequest/shared PERMISSION_CATALOG constant — zero tenant data, no
  // PII — and the role-permission picker needs it for any authenticated
  // user editing a role. Gating it would break the picker and discloses
  // nothing. Pinned open by require-permission-routes.spec MUST_BE_OPEN.
  @Get('catalog')
  getCatalog() {
    return { catalog: PERMISSION_CATALOG };
  }

  /**
   * Resolves the granted permission set for a user — union of their active
   * role assignments with wildcard expansion, plus attribution metadata
   * (which role granted each permission and under which scope).
   */
  // Slice 11.6(A): a specific user's effective permission set — admin
  // user-detail "Effective Permissions" panel only (codex-verified no
  // operator reach). Gated to existing `roles.read` (the permission/
  // role resolution is a roles-admin read; Auditor *.read / Tenant
  // Admin *.* hold it). Was ungated → this closes that P2 leak.
  @Get('users/:userId/effective')
  @RequirePermission('roles.read')
  async effective(@Param('userId') userId: string) {
    return this.service.getEffectivePermissions(userId);
  }
}

import { Injectable } from '@nestjs/common';
import type { PermissionKey } from '@prequest/shared';
import type { Request } from 'express';
import { SupabaseService } from './supabase/supabase.service';
import { TenantContext } from './tenant-context';
import { AppErrors } from './errors';

/**
 * Checks `user_has_permission(platformUserId, tenant, key)` for the
 * caller. Throws 403 if missing.
 *
 * The `permission` parameter is typed against PERMISSION_CATALOG via
 * @prequest/shared#PermissionKey, so unknown keys (typos, drift between
 * controller and catalog) fail to compile. Wildcards (`tickets.*`, `*.read`,
 * `*.*`) are allowed by the type.
 *
 * The platform user id comes from `request.user.platformUserId`, which
 * AuthGuard attaches after its global auth_uid → users bridge
 * (docs/follow-ups/audits/04-rls-security.md Slice 1). On `@Public()`
 * routes AuthGuard does not run; a permission check there is
 * nonsensical and surfaces as 401 here.
 *
 * Typical callers:
 *   await this.requirePermission(req, 'people.update');
 */
@Injectable()
export class PermissionGuard {
  constructor(private readonly supabase: SupabaseService) {}

  async requirePermission(
    request: Request,
    permission: PermissionKey,
  ): Promise<{ userId: string }> {
    const platformUserId = (
      request as { user?: { platformUserId?: string } }
    ).user?.platformUserId;
    if (!platformUserId)
      throw AppErrors.unauthorized('No linked user in this tenant');
    const tenant = TenantContext.current();

    const { data, error } = await this.supabase.admin.rpc(
      'user_has_permission',
      {
        p_user_id: platformUserId,
        p_tenant_id: tenant.id,
        p_permission: permission,
      },
    );
    if (error) throw error;

    if (!data) {
      throw AppErrors.permissionDenied(permission);
    }

    return { userId: platformUserId };
  }
}

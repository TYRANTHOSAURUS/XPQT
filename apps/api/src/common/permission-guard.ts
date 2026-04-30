import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { PermissionKey } from '@prequest/shared';
import type { Request } from 'express';
import { SupabaseService } from './supabase/supabase.service';
import { TenantContext } from './tenant-context';

/**
 * Resolves authUid → userId, then checks user_has_permission() for the given
 * permission key. Throws 403 if missing.
 *
 * The `permission` parameter is typed against PERMISSION_CATALOG via
 * @prequest/shared#PermissionKey, so unknown keys (typos, drift between
 * controller and catalog) fail to compile. Wildcards (`tickets.*`, `*.read`,
 * `*.*`) are allowed by the type.
 *
 * Typical callers:
 *   await this.requirePermission(req, 'people.update');
 */
@Injectable()
export class PermissionGuard {
  constructor(private readonly supabase: SupabaseService) {}

  async requirePermission(request: Request, permission: PermissionKey): Promise<{ userId: string }> {
    const authUid = (request as { user?: { id: string } }).user?.id;
    if (!authUid) throw new UnauthorizedException('No auth user');
    const tenant = TenantContext.current();

    const userLookup = await this.supabase.admin
      .from('users')
      .select('id')
      .eq('tenant_id', tenant.id)
      .eq('auth_uid', authUid)
      .maybeSingle();
    const userId = (userLookup.data as { id: string } | null)?.id;
    if (!userId) throw new UnauthorizedException('No linked user in this tenant');

    const { data, error } = await this.supabase.admin.rpc('user_has_permission', {
      p_user_id: userId,
      p_tenant_id: tenant.id,
      p_permission: permission,
    });
    if (error) throw error;

    if (!data) {
      throw new ForbiddenException({ code: 'permission_denied', permission });
    }

    return { userId };
  }
}

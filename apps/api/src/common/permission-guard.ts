import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { SupabaseService } from './supabase/supabase.service';
import { TenantContext } from './tenant-context';

/**
 * Resolves authUid → userId, then checks user_has_permission() for the given
 * permission key. Throws 403 if missing.
 *
 * Typical callers:
 *   await this.requirePermission(req, 'people:manage');
 */
@Injectable()
export class PermissionGuard {
  constructor(private readonly supabase: SupabaseService) {}

  async requirePermission(request: Request, permission: string): Promise<{ userId: string }> {
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

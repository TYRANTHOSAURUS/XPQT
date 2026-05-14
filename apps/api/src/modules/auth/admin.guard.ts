import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { AppErrors } from '../../common/errors';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly supabase: SupabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // AuthGuard runs globally (app.module.ts APP_GUARD) and attaches
    // the resolved `public.users.id` as `platformUserId` after its
    // auth_uid → users bridge. If platformUserId is missing, AuthGuard
    // didn't run (eg. @Public() route — admin gate is then nonsensical)
    // or the bridge failed (already 403'd before we got here).
    const request = context
      .switchToHttp()
      .getRequest<{ user?: { platformUserId?: string } }>();
    const platformUserId = request.user?.platformUserId;
    if (!platformUserId) throw AppErrors.unauthorized('Missing user context');

    const tenant = TenantContext.current();

    const { data, error } = await this.supabase.admin
      .from('user_role_assignments')
      .select('role:roles(type)')
      .eq('user_id', platformUserId)
      .eq('tenant_id', tenant.id);

    if (error) {
      throw AppErrors.server('auth.role_lookup_failed', {
        detail: 'Role lookup failed',
        cause: error,
      });
    }

    const roleAssignments = (data ?? []) as {
      role?: { type?: string } | null;
    }[];
    const isAdmin = roleAssignments.some((ra) => ra.role?.type === 'admin');
    if (!isAdmin)
      throw AppErrors.forbidden('auth.admin_required', 'Admin role required');

    return true;
  }
}

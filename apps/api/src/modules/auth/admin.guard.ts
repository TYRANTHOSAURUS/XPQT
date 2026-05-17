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

    // Validity must mirror public.user_has_permission
    // (00109_permissions_wildcards.sql:70-73) exactly, or AdminGuard is
    // weaker than the permission RPC: a deactivated admin role, or an
    // expired / not-yet-started admin assignment, would still authorize
    // admin controllers. The four conditions:
    //   - user_role_assignments.active = true   (00003:86)
    //   - roles.active = true                   (the role itself)
    //   - starts_at is null OR starts_at <= now (00109:23, :72)
    //   - ends_at   is null OR ends_at   >  now (00109:24, :73)
    // active flags are filtered in the query; the time bounds are
    // filtered in TS because PostgREST can't express the OR-null pair
    // cleanly in the builder.
    const { data, error } = await this.supabase.admin
      .from('user_role_assignments')
      .select('starts_at, ends_at, role:roles(type, active)')
      .eq('user_id', platformUserId)
      .eq('tenant_id', tenant.id)
      .eq('active', true);

    if (error) {
      throw AppErrors.server('auth.role_lookup_failed', {
        detail: 'Role lookup failed',
        cause: error,
      });
    }

    const now = Date.now();
    const roleAssignments = (data ?? []) as {
      starts_at: string | null;
      ends_at: string | null;
      role?: { type?: string; active?: boolean } | null;
    }[];
    const isAdmin = roleAssignments.some((ra) => {
      if (ra.role?.type !== 'admin') return false;
      if (ra.role?.active !== true) return false;
      if (ra.starts_at && new Date(ra.starts_at).getTime() > now) return false;
      if (ra.ends_at && new Date(ra.ends_at).getTime() <= now) return false;
      return true;
    });
    if (!isAdmin)
      throw AppErrors.forbidden('auth.admin_required', 'Admin role required');

    return true;
  }
}

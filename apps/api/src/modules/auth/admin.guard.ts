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
    const request = context.switchToHttp().getRequest<{ user?: { id?: string } }>();
    const authUid = request.user?.id;
    if (!authUid) throw AppErrors.unauthorized('Missing user context');

    const tenant = TenantContext.current();

    const { data, error } = await this.supabase.admin
      .from('users')
      .select('id, role_assignments:user_role_assignments(role:roles(type))')
      .eq('auth_uid', authUid)
      .eq('tenant_id', tenant.id)
      .maybeSingle();

    if (error) throw AppErrors.server('auth.role_lookup_failed', { detail: 'Role lookup failed', cause: error });
    if (!data) throw AppErrors.forbidden('auth.user_not_in_tenant', 'User not found in tenant');

    const roleAssignments = (data as { role_assignments?: { role?: { type?: string } | null }[] })
      .role_assignments ?? [];
    const isAdmin = roleAssignments.some((ra) => ra.role?.type === 'admin');
    if (!isAdmin) throw AppErrors.forbidden('auth.admin_required', 'Admin role required');

    return true;
  }
}

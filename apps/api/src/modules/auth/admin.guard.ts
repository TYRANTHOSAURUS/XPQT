import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly supabase: SupabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ user?: { id?: string } }>();
    const authUid = request.user?.id;
    if (!authUid) throw new UnauthorizedException('Missing user context');

    const tenant = TenantContext.current();

    const { data, error } = await this.supabase.admin
      .from('users')
      .select('id, role_assignments:user_role_assignments(role:roles(type))')
      .eq('auth_uid', authUid)
      .eq('tenant_id', tenant.id)
      .maybeSingle();

    if (error) throw new InternalServerErrorException('Role lookup failed');
    if (!data) throw new ForbiddenException('User not found in tenant');

    const roleAssignments = (data as { role_assignments?: { role?: { type?: string } | null }[] })
      .role_assignments ?? [];
    const isAdmin = roleAssignments.some((ra) => ra.role?.type === 'admin');
    if (!isAdmin) throw new ForbiddenException('Admin role required');

    return true;
  }
}

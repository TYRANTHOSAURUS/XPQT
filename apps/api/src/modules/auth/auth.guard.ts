import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { IS_PUBLIC_KEY } from './public.decorator';
import { AppErrors } from '../../common/errors';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers['authorization'];

    if (!authHeader?.startsWith('Bearer ')) {
      throw AppErrors.unauthorized('Missing authorization header');
    }

    const token = authHeader.slice(7);
    const { data, error } = await this.supabase.admin.auth.getUser(token);

    if (error || !data.user) {
      throw AppErrors.unauthorized('Invalid token');
    }

    // Global tenant binding (docs/follow-ups/audits/04-rls-security.md
    // Slice 1, P0). Bridge auth_uid → public.users(id) for the resolved
    // tenant. If the JWT-holder has no users row in the current tenant,
    // the request is a cross-tenant header-flip — reject with the same
    // 403 AdminGuard already uses (admin.guard.ts:29).
    //
    // Defensive: TenantContext.current() throws a raw Error if the
    // request bypassed TenantMiddleware. Surface that as a clean 400
    // tenant.missing_context instead of a 500 stack trace.
    //
    // Filter on status='active' — the users table allows 'inactive'
    // and 'suspended' (00003_people_users_roles.sql:42). An inactive
    // user with a still-valid Supabase JWT must NOT pass.
    let tenant;
    try {
      tenant = TenantContext.current();
    } catch {
      throw AppErrors.notFoundWithCode(
        'tenant.unknown',
        'Tenant context missing',
      );
    }
    const userLookup = await this.supabase.admin
      .from('users')
      .select('id')
      .eq('tenant_id', tenant.id)
      .eq('auth_uid', data.user.id)
      .eq('status', 'active')
      .maybeSingle();
    if (userLookup.error) {
      throw AppErrors.server('auth.role_lookup_failed', {
        detail: 'User lookup failed',
        cause: userLookup.error,
      });
    }
    const platformUserId = (userLookup.data as { id: string } | null)?.id;
    if (!platformUserId) {
      throw AppErrors.forbidden(
        'auth.user_not_in_tenant',
        'User not found in tenant',
      );
    }

    // Attach the resolved platform user id so downstream guards
    // (AdminGuard, PermissionGuard) and services don't repeat the
    // lookup. See admin.guard.ts + permission-guard.ts.
    request.user = Object.assign(data.user, { platformUserId });
    return true;
  }
}

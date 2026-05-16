import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { PermissionKey } from '@prequest/shared';
import { PermissionGuard } from './permission-guard';

/**
 * `@RequirePermission('domain.action')` — declarative permission gate.
 *
 * docs/follow-ups/audits/04-rls-security.md Slice 11 (2026-05-16,
 * codex-decided). Slices 2/9/10 used blanket `@UseGuards(AdminGuard)`,
 * which hard-checks `role.type==='admin'` and so 403s a legitimate
 * non-admin role that holds the granted permission (role-defaults.ts
 * grants non-admin roles `spaces.*`/`teams.*`/`vendors.admin`/…). This
 * decorator gates on the CI-enforced `PERMISSION_CATALOG` instead, via
 * the SAME canonical path the in-body `PermissionGuard.requirePermission`
 * already uses (criteria-set.controller.ts is the sibling pattern):
 * `platformUserId` (set by the global AuthGuard) + `TenantContext` +
 * the `public.user_has_permission` RPC. Security semantics are
 * identical to the in-body call; the only change is decorator vs.
 * imperative call (less boilerplate, can't be forgotten on a new
 * method).
 *
 * The `permission` arg is typed `PermissionKey`, so a typo or a key
 * that drifts from the catalog fails to compile.
 *
 * Composition: `SetMetadata(PERMISSION_KEY)` carries the key;
 * `PermissionMetadataGuard` reads it and delegates. Both
 * `PermissionMetadataGuard` AND `PermissionGuard` must be in the
 * consuming module's `providers` (the established per-module-local
 * pattern — there is no shared CommonModule; `SupabaseService` is
 * `@Global()` so its transitive dep resolves anywhere).
 */
export const PERMISSION_KEY = 'requiredPermission';

@Injectable()
export class PermissionMetadataGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const permission = this.reflector.getAllAndOverride<PermissionKey>(
      PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    // No metadata on this route → this guard is a no-op (the route is
    // either ungated by design or gated by another mechanism).
    if (!permission) return true;

    const request = context.switchToHttp().getRequest<Request>();
    // Delegates to the canonical path: throws 401 if there's no
    // platformUserId (eg. a @Public() route — putting
    // @RequirePermission there is nonsensical and correctly 401s),
    // 403 if the user's roles don't grant the permission.
    await this.permissions.requirePermission(request, permission);
    return true;
  }
}

export function RequirePermission(permission: PermissionKey) {
  return applyDecorators(
    SetMetadata(PERMISSION_KEY, permission),
    UseGuards(PermissionMetadataGuard),
  );
}

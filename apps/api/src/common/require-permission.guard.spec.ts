import { Reflector } from '@nestjs/core';
import { PermissionMetadataGuard, PERMISSION_KEY } from './require-permission.decorator';
import { AppErrors } from './errors';

describe('PermissionMetadataGuard', () => {
  const ctx = (handlerMeta?: unknown) =>
    ({
      getHandler: () => 'h',
      getClass: () => 'c',
      switchToHttp: () => ({ getRequest: () => ({ user: { platformUserId: 'u-1' } }) }),
    }) as any;

  const reflectorReturning = (val: unknown) =>
    ({ getAllAndOverride: () => val }) as unknown as Reflector;

  it('is a no-op (returns true) when the route has no permission metadata', async () => {
    const perms = { requirePermission: jest.fn() };
    const guard = new PermissionMetadataGuard(
      reflectorReturning(undefined),
      perms as any,
    );
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    expect(perms.requirePermission).not.toHaveBeenCalled();
  });

  it('delegates to PermissionGuard.requirePermission with the metadata key', async () => {
    const perms = { requirePermission: jest.fn().mockResolvedValue({ userId: 'u-1' }) };
    const guard = new PermissionMetadataGuard(
      reflectorReturning('spaces.create'),
      perms as any,
    );
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    expect(perms.requirePermission).toHaveBeenCalledWith(
      expect.objectContaining({ user: { platformUserId: 'u-1' } }),
      'spaces.create',
    );
  });

  it('propagates the 403 when the user lacks the permission', async () => {
    const perms = {
      requirePermission: jest
        .fn()
        .mockRejectedValue(AppErrors.permissionDenied('spaces.create')),
    };
    const guard = new PermissionMetadataGuard(
      reflectorReturning('spaces.create'),
      perms as any,
    );
    const err = await guard.canActivate(ctx()).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { status?: number }).status).toBe(403);
  });

  it('propagates the 401 when there is no linked user (eg. @Public route)', async () => {
    const perms = {
      requirePermission: jest
        .fn()
        .mockRejectedValue(AppErrors.unauthorized('No linked user in this tenant')),
    };
    const guard = new PermissionMetadataGuard(
      reflectorReturning('spaces.create'),
      perms as any,
    );
    const err = await guard.canActivate(ctx()).catch((e) => e);
    expect((err as { status?: number }).status).toBe(401);
  });

  it('PERMISSION_KEY is stable (decorator/guard contract)', () => {
    expect(PERMISSION_KEY).toBe('requiredPermission');
  });
});

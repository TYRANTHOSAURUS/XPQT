import { AdminGuard } from './admin.guard';
import { TenantContext } from '../../common/tenant-context';
import { AppError } from '../../common/errors';

describe('AdminGuard', () => {
  const makeContext = (user: unknown) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
    }) as any;

  // After Slice 1 (docs/follow-ups/audits/04-rls-security.md), the
  // auth_uid → public.users bridge moved to the global AuthGuard.
  // AdminGuard now only checks role_assignments, keyed off the
  // resolved `req.user.platformUserId` AuthGuard attached.
  const makeSupabase = (
    roles: { type: string }[] | null,
    error: unknown = null,
  ) =>
    ({
      admin: {
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: async () => ({
                  data:
                    roles === null
                      ? null
                      : roles.map((r) => ({ role: { type: r.type } })),
                  error,
                }),
              }),
            }),
          }),
        }),
      },
    }) as any;

  const withTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    TenantContext.run({ id: 'tenant-1', slug: 'acme', tier: 'standard' }, fn);

  it('rejects requests with no platformUserId on the request', async () => {
    const guard = new AdminGuard(makeSupabase([]));
    const err = await withTenant(() =>
      guard.canActivate(makeContext(undefined)),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(401);
    expect((err as AppError).code).toBe('auth.unauthorized');
  });

  it('rejects users with no admin role', async () => {
    const guard = new AdminGuard(
      makeSupabase([{ type: 'employee' }, { type: 'agent' }]),
    );
    const err = await withTenant(() =>
      guard.canActivate(makeContext({ id: 'auth-uid-1', platformUserId: 'u-1' })),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(403);
    expect((err as AppError).code).toBe('auth.admin_required');
  });

  it('allows users with an admin role', async () => {
    const guard = new AdminGuard(makeSupabase([{ type: 'admin' }]));
    await expect(
      withTenant(() =>
        guard.canActivate(
          makeContext({ id: 'auth-uid-1', platformUserId: 'u-1' }),
        ),
      ),
    ).resolves.toBe(true);
  });

  it('throws 500 when the role lookup fails with a DB error', async () => {
    const guard = new AdminGuard(
      makeSupabase([], { message: 'connection lost' }),
    );
    const err = await withTenant(() =>
      guard.canActivate(makeContext({ id: 'auth-uid-1', platformUserId: 'u-1' })),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(500);
    expect((err as AppError).code).toBe('auth.role_lookup_failed');
  });
});

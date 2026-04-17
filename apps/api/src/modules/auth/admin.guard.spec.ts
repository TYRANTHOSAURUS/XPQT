import { ForbiddenException, InternalServerErrorException, UnauthorizedException } from '@nestjs/common';
import { AdminGuard } from './admin.guard';
import { TenantContext } from '../../common/tenant-context';

describe('AdminGuard', () => {
  const makeContext = (user: unknown) => ({
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  }) as any;

  const makeSupabase = (roles: { type: string }[] | null, error: unknown = null) => ({
    admin: {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: roles === null ? null : { role_assignments: roles.map((r) => ({ role: { type: r.type } })) },
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

  it('rejects requests with no user on the request', async () => {
    const guard = new AdminGuard(makeSupabase([]));
    await expect(withTenant(() => guard.canActivate(makeContext(undefined))))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects users with no admin role', async () => {
    const guard = new AdminGuard(makeSupabase([{ type: 'employee' }, { type: 'agent' }]));
    await expect(withTenant(() => guard.canActivate(makeContext({ id: 'auth-uid-1' }))))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows users with an admin role', async () => {
    const guard = new AdminGuard(makeSupabase([{ type: 'admin' }]));
    await expect(withTenant(() => guard.canActivate(makeContext({ id: 'auth-uid-1' }))))
      .resolves.toBe(true);
  });

  it('rejects when the user row is not found', async () => {
    const guard = new AdminGuard(makeSupabase(null));
    await expect(withTenant(() => guard.canActivate(makeContext({ id: 'auth-uid-1' }))))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throws 500 when the role lookup fails with a DB error', async () => {
    const guard = new AdminGuard(makeSupabase([], { message: 'connection lost' }));
    await expect(withTenant(() => guard.canActivate(makeContext({ id: 'auth-uid-1' }))))
      .rejects.toBeInstanceOf(InternalServerErrorException);
  });
});

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

  // After Slice 1 (docs/follow-ups/audits/04-rls-security.md) the
  // auth_uid → public.users bridge moved to the global AuthGuard.
  // AdminGuard keys role_assignments off the resolved
  // `req.user.platformUserId`. Slice 9 (2026-05-16) added validity
  // parity with public.user_has_permission: role.active + the
  // starts_at / ends_at time bounds (00109:70-73).
  type Assignment = {
    type: string;
    roleActive?: boolean; // default true
    starts_at?: string | null;
    ends_at?: string | null;
  };
  const makeSupabase = (
    assignments: Assignment[] | null,
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
                    assignments === null
                      ? null
                      : assignments.map((a) => ({
                          starts_at: a.starts_at ?? null,
                          ends_at: a.ends_at ?? null,
                          role: {
                            type: a.type,
                            active: a.roleActive ?? true,
                          },
                        })),
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

  const callAs = (supabase: unknown) =>
    withTenant(() =>
      new AdminGuard(supabase as any).canActivate(
        makeContext({ id: 'auth-uid-1', platformUserId: 'u-1' }),
      ),
    );

  const ISO = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

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
    const err = await callAs(
      makeSupabase([{ type: 'employee' }, { type: 'agent' }]),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(403);
    expect((err as AppError).code).toBe('auth.admin_required');
  });

  it('allows users with an active admin role and no time bounds', async () => {
    await expect(callAs(makeSupabase([{ type: 'admin' }]))).resolves.toBe(true);
  });

  it('allows an admin assignment inside its time window', async () => {
    await expect(
      callAs(
        makeSupabase([
          { type: 'admin', starts_at: ISO(-60_000), ends_at: ISO(60_000) },
        ]),
      ),
    ).resolves.toBe(true);
  });

  it('rejects when the admin role itself is inactive', async () => {
    const err = await callAs(
      makeSupabase([{ type: 'admin', roleActive: false }]),
    ).catch((e) => e);
    expect((err as AppError).status).toBe(403);
    expect((err as AppError).code).toBe('auth.admin_required');
  });

  it('rejects an expired admin assignment (ends_at in the past)', async () => {
    const err = await callAs(
      makeSupabase([{ type: 'admin', ends_at: ISO(-1000) }]),
    ).catch((e) => e);
    expect((err as AppError).status).toBe(403);
    expect((err as AppError).code).toBe('auth.admin_required');
  });

  it('rejects a not-yet-started admin assignment (starts_at in the future)', async () => {
    const err = await callAs(
      makeSupabase([{ type: 'admin', starts_at: ISO(60_000) }]),
    ).catch((e) => e);
    expect((err as AppError).status).toBe(403);
    expect((err as AppError).code).toBe('auth.admin_required');
  });

  it('throws 500 when the role lookup fails with a DB error', async () => {
    const err = await callAs(
      makeSupabase([], { message: 'connection lost' }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(500);
    expect((err as AppError).code).toBe('auth.role_lookup_failed');
  });
});

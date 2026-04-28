import { AuthEventsService, type SupabaseAuthEvent } from './auth-events.service';

const TENANT = '11111111-1111-1111-1111-111111111111';
const USER   = '22222222-2222-2222-2222-222222222222';

interface InsertCall { table: string; row: Record<string, unknown>; }
interface UpdateCall { table: string; values: Record<string, unknown>; eq: Record<string, unknown>; }

function makeSupabase(opts: { userRow?: { tenant_id: string } | null; insertConflict?: boolean } = {}) {
  const inserts: InsertCall[] = [];
  const updates: UpdateCall[] = [];

  const adminFrom = (table: string) => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({
          data: opts.userRow !== undefined ? opts.userRow : { tenant_id: TENANT },
          error: null,
        }),
      }),
    }),
    insert: (row: Record<string, unknown>) => ({
      select: () => ({
        maybeSingle: async () => {
          if (opts.insertConflict) {
            return { data: null, error: { code: '23505' } };
          }
          inserts.push({ table, row });
          return { data: { id: 'evt-1' }, error: null };
        },
      }),
    }),
    update: (values: Record<string, unknown>) => ({
      eq: (col: string, val: unknown) => ({
        select: () => ({
          maybeSingle: async () => {
            updates.push({ table, values, eq: { [col]: val } });
            return { data: null, error: null };
          },
        }),
      }),
    }),
  });

  return {
    admin: { from: adminFrom },
    inserts,
    updates,
  };
}

describe('AuthEventsService', () => {
  it('inserts a sign_in row and updates last_login_at', async () => {
    const supabase = makeSupabase();
    const svc = new AuthEventsService(supabase as never);

    const event: SupabaseAuthEvent = {
      type: 'sign_in',
      user_id: USER,
      session_id: 'sess-abc',
      ip_address: '1.2.3.4',
      user_agent: 'Mozilla/5.0',
      method: 'password',
      provider: null,
      mfa_used: false,
      occurred_at: '2026-04-28T10:00:00Z',
    };

    await svc.recordSignIn(event);

    const insert = supabase.inserts.find((i) => i.table === 'auth_sign_in_events');
    expect(insert).toBeTruthy();
    expect(insert!.row).toMatchObject({
      tenant_id: TENANT,
      user_id: USER,
      event_kind: 'sign_in',
      session_id: 'sess-abc',
      ip_address: '1.2.3.4',
      user_agent: 'Mozilla/5.0',
      method: 'password',
      mfa_used: false,
      success: true,
    });

    const update = supabase.updates.find((u) => u.table === 'users');
    expect(update).toBeTruthy();
    expect(update!.values).toHaveProperty('last_login_at');
    expect(update!.eq).toEqual({ id: USER });
  });

  it('treats unique-constraint conflict as a no-op (idempotent)', async () => {
    const supabase = makeSupabase({ insertConflict: true });
    const svc = new AuthEventsService(supabase as never);

    await expect(
      svc.recordSignIn({
        type: 'sign_in',
        user_id: USER,
        session_id: 'sess-abc',
        ip_address: null,
        user_agent: null,
        method: 'password',
        provider: null,
        mfa_used: false,
        occurred_at: '2026-04-28T10:00:00Z',
      }),
    ).resolves.not.toThrow();
  });

  it('throws when user is unknown in public.users', async () => {
    const supabase = makeSupabase({ userRow: null });
    const svc = new AuthEventsService(supabase as never);

    await expect(
      svc.recordSignIn({
        type: 'sign_in',
        user_id: USER,
        session_id: 'sess-abc',
        ip_address: null,
        user_agent: null,
        method: 'password',
        provider: null,
        mfa_used: false,
        occurred_at: '2026-04-28T10:00:00Z',
      }),
    ).rejects.toThrow(/unknown user/i);
  });

  it('recordSignOut inserts but does NOT touch last_login_at', async () => {
    const supabase = makeSupabase();
    const svc = new AuthEventsService(supabase as never);

    await svc.recordSignOut({
      type: 'sign_out',
      user_id: USER,
      session_id: 'sess-abc',
      ip_address: null,
      user_agent: null,
      method: null,
      provider: null,
      mfa_used: false,
      occurred_at: '2026-04-28T11:00:00Z',
    });

    expect(supabase.inserts.some((i) => i.row.event_kind === 'sign_out')).toBe(true);
    expect(supabase.updates.some((u) => u.table === 'users')).toBe(false);
  });

  it('recordSignInFailed writes success=false and bypasses session_id dedupe', async () => {
    const supabase = makeSupabase();
    const svc = new AuthEventsService(supabase as never);

    await svc.recordSignInFailed({
      type: 'sign_in_failed',
      user_id: USER,
      session_id: null,
      ip_address: '5.6.7.8',
      user_agent: null,
      method: 'password',
      provider: null,
      mfa_used: false,
      occurred_at: '2026-04-28T12:00:00Z',
      failure_reason: 'invalid_password',
    });

    const row = supabase.inserts[0]!.row;
    expect(row).toMatchObject({
      event_kind: 'sign_in_failed',
      success: false,
      failure_reason: 'invalid_password',
      session_id: null,
    });
  });
});

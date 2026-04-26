import { SearchService } from './search.service';
import { TenantContext } from '../../common/tenant-context';

/**
 * Verifies the SearchService surface contract — independent of the SQL RPC,
 * which is exercised end-to-end via the curl smoke against the live PostgREST.
 *
 * What we test here:
 * 1. Length gate — q < 2 chars returns an empty response without ever touching
 *    the Supabase client. (No round-trip on background keystrokes.)
 * 2. Auth-uid → user.id resolution failure returns empty (zero results, no
 *    throw). This is the path a foreign-tenant JWT would take.
 * 3. The RPC is called with the resolved user_id + tenant.id, so a malicious
 *    p_tenant_id from the client cannot bypass the tenant gate.
 * 4. Server response is grouped by `kind` for the frontend.
 */

const T1 = '00000000-0000-0000-0000-000000000001';
const U1 = '95100000-0000-0000-0000-000000000001';
const TENANT = { id: T1, slug: 't1', tier: 'standard' as const };

function makeSupabase(opts: {
  user?: { id: string } | null;
  rpcRows?: unknown[];
  rpcError?: { message: string } | null;
} = {}) {
  const { user = { id: U1 }, rpcRows = [], rpcError = null } = opts;
  const userQuery = {
    select: () => userQuery,
    eq: () => userQuery,
    maybeSingle: async () => ({ data: user, error: null }),
  };
  const rpc = jest.fn(async () => ({ data: rpcRows, error: rpcError }));
  return {
    admin: {
      from: jest.fn(() => userQuery),
      rpc,
    },
  } as unknown as ConstructorParameters<typeof SearchService>[0] & {
    admin: { rpc: jest.Mock };
  };
}

function withTenant<T>(fn: () => Promise<T>): Promise<T> {
  return TenantContext.run(TENANT, fn);
}

describe('SearchService.search', () => {
  it('returns empty for a 1-char query (length gate, no RPC)', async () => {
    const supabase = makeSupabase();
    const svc = new SearchService(supabase);

    const result = await withTenant(() => svc.search(U1, 'a'));

    expect(result.total).toBe(0);
    expect(result.groups).toEqual({});
    // Critical: no work done on every keystroke before threshold.
    expect(supabase.admin.rpc).not.toHaveBeenCalled();
  });

  it('returns empty for a whitespace-only query', async () => {
    const supabase = makeSupabase();
    const svc = new SearchService(supabase);

    const result = await withTenant(() => svc.search(U1, '   '));

    expect(result.total).toBe(0);
    expect(supabase.admin.rpc).not.toHaveBeenCalled();
  });

  it('returns empty (not throw) when auth_uid does not match any tenant user', async () => {
    // A foreign-tenant JWT lookups would land here.
    const supabase = makeSupabase({ user: null });
    const svc = new SearchService(supabase);

    const result = await withTenant(() => svc.search('foreign-uid', 'meeting'));

    expect(result.total).toBe(0);
    expect(result.groups).toEqual({});
    // Important: never invoked the RPC, so we don't leak even an error code.
    expect(supabase.admin.rpc).not.toHaveBeenCalled();
  });

  it('passes the resolved user_id + tenant.id to the RPC (tenant gate)', async () => {
    const supabase = makeSupabase({ rpcRows: [] });
    const svc = new SearchService(supabase);

    await withTenant(() => svc.search('any-auth-uid', 'meeting'));

    expect(supabase.admin.rpc).toHaveBeenCalledWith(
      'search_global',
      expect.objectContaining({
        p_user_id: U1,
        p_tenant_id: T1,
        p_q: 'meeting',
      }),
    );
  });

  it('groups RPC rows by kind for the frontend', async () => {
    const rows = [
      { kind: 'ticket', id: 'a', title: 'A', subtitle: null, breadcrumb: null, score: 0.9, extra: null },
      { kind: 'ticket', id: 'b', title: 'B', subtitle: null, breadcrumb: null, score: 0.8, extra: null },
      { kind: 'room', id: 'r', title: 'R', subtitle: null, breadcrumb: null, score: 0.7, extra: null },
    ];
    const supabase = makeSupabase({ rpcRows: rows });
    const svc = new SearchService(supabase);

    const result = await withTenant(() => svc.search('any', 'meeting'));

    expect(result.total).toBe(3);
    expect(result.groups.ticket).toHaveLength(2);
    expect(result.groups.room).toHaveLength(1);
    expect(result.groups.ticket?.[0].id).toBe('a');
  });

  it('clamps per-type limit to a sane range', async () => {
    const supabase = makeSupabase({ rpcRows: [] });
    const svc = new SearchService(supabase);

    await withTenant(() => svc.search('any', 'meeting', undefined, 999));

    expect(supabase.admin.rpc).toHaveBeenCalledWith(
      'search_global',
      expect.objectContaining({ p_per_type_limit: 20 }),
    );
  });

  it('forwards types filter as an array, or null when omitted', async () => {
    const supabase = makeSupabase({ rpcRows: [] });
    const svc = new SearchService(supabase);

    await withTenant(() => svc.search('any', 'meeting', ['ticket', 'room']));
    expect(supabase.admin.rpc).toHaveBeenLastCalledWith(
      'search_global',
      expect.objectContaining({ p_types: ['ticket', 'room'] }),
    );

    await withTenant(() => svc.search('any', 'meeting'));
    expect(supabase.admin.rpc).toHaveBeenLastCalledWith(
      'search_global',
      expect.objectContaining({ p_types: null }),
    );
  });

  it('throws on RPC errors so callers see the Postgres reason', async () => {
    const supabase = makeSupabase({
      rpcRows: [],
      rpcError: { message: 'permission denied for function search_global' },
    });
    const svc = new SearchService(supabase);

    await expect(withTenant(() => svc.search('any', 'meeting'))).rejects.toMatchObject({
      message: expect.stringContaining('permission denied'),
    });
  });
});

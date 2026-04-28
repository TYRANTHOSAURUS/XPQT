import { UserManagementService } from './user-management.service';
import { TenantContext } from '../../common/tenant-context';

const TENANT = '11111111-1111-1111-1111-111111111111';
const USER   = '22222222-2222-2222-2222-222222222222';

interface SupabaseCalls { eqs: Array<[string, unknown]>; orderField?: string; limitVal?: number; }

function makeSupabase(rows: unknown[] = []) {
  const calls: SupabaseCalls = { eqs: [] };
  const builder: any = {
    select: () => builder,
    eq: (col: string, val: unknown) => { calls.eqs.push([col, val]); return builder; },
    order: (col: string) => { calls.orderField = col; return builder; },
    limit: (n: number) => { calls.limitVal = n; return Promise.resolve({ data: rows, error: null }); },
  };
  return {
    admin: { from: () => builder },
    calls,
  };
}

describe('UserManagementService.listSignIns', () => {
  it('filters by tenant + user + event_kind=sign_in and respects limit', async () => {
    const supabase = makeSupabase([
      {
        id: 'e1',
        signed_in_at: '2026-04-28T10:00:00Z',
        ip_address: '1.2.3.4',
        user_agent: 'UA',
        country: null,
        city: null,
        method: 'password',
        provider: null,
        mfa_used: false,
        success: true,
        failure_reason: null,
      },
    ]);

    const tenantStore = { id: TENANT, slug: 't', tier: 'standard' as const };
    const rows = await TenantContext.run(tenantStore, async () => {
      const svc = new UserManagementService(supabase as never);
      return svc.listSignIns(USER, 5);
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'e1', ip_address: '1.2.3.4' });
    expect(supabase.calls.eqs).toEqual(expect.arrayContaining([
      ['tenant_id', TENANT],
      ['user_id', USER],
      ['event_kind', 'sign_in'],
    ]));
    expect(supabase.calls.limitVal).toBe(5);
    expect(supabase.calls.orderField).toBe('signed_in_at');
  });

  it('returns an empty array when there are no rows', async () => {
    const supabase = makeSupabase([]);
    const tenantStore = { id: TENANT, slug: 't', tier: 'standard' as const };
    const rows = await TenantContext.run(tenantStore, async () => {
      const svc = new UserManagementService(supabase as never);
      return svc.listSignIns(USER);
    });
    expect(rows).toEqual([]);
  });
});

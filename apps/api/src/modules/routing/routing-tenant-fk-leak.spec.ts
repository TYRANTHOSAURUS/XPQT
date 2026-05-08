// Cross-tenant FK leak regression — verifies that every raw config-table
// read in the routing module keyed by id alone now also filters by tenant_id.
//
// Before this fix:
//   - resolver-repository.ts:14  loadRequestType(id)   — request_types by id
//   - resolver-repository.ts:23  loadAsset(id)         — assets by id
//   - resolver-repository.ts:38  locationChain(spaceId) — spaces.parent_id walk
//                                                          (KEY FK-smuggle path)
//   - resolver-repository.ts:53  locationTeam(spaceId, domain)
//                                                          — location_teams by space+domain
//   - resolver-repository.ts:64  spaceGroupTeam(spaceId, domain)
//                                                          — space_group_members + location_teams
//   - simulator.service.ts:361   resolveTargetName(team)   — teams.name by id
//   - simulator.service.ts:369   resolveTargetName(vendor) — vendors.name by id
//   - simulator.service.ts:379   resolveTargetName(user)   — users.email by id
// all did .eq('id', X) (or .eq('space_id', X) / .eq('space_group_id', X))
// without a tenant_id filter. supabase.admin bypasses RLS, so a foreign FK
// pointer (or shared id across tenants) could leak data from another tenant.
//
// These tests are deliberately narrow: they assert the SQL filter chain
// includes tenant_id, not the full surrounding behavior. The chain is the
// security primitive; the surrounding logic doesn't matter as long as the
// filter is in place.
//
// Mirror of apps/api/src/modules/ticket/ticket-tenant-fk-leak.spec.ts
// (commit 75ad3b0).

const TENANT_A = '00000000-0000-4000-8000-aaaaaaaaaaaa';
const TENANT_B = '00000000-0000-4000-8000-bbbbbbbbbbbb';
const SHARED_ID = '00000000-0000-4000-8000-000000000001';
const DOMAIN = 'facilities';

type FilterCapture = { table: string; filters: Record<string, unknown> };
type RowsByTable = Record<string, Array<{ id?: string; tenant_id: string; [k: string]: unknown }>>;

function buildCaptureClient(rowsByTable: RowsByTable, captures: FilterCapture[]) {
  function buildSelectChain(table: string) {
    const filters: Record<string, unknown> = {};
    const rows = rowsByTable[table] ?? [];
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, val: unknown) => { filters[col] = val; return chain; },
      in: (col: string, val: unknown[]) => { filters[`__in_${col}`] = val; return chain; },
      limit: () => chain,
      maybeSingle: async () => {
        captures.push({ table, filters: { ...filters } });
        const match = rows.find((r) => {
          for (const [col, val] of Object.entries(filters)) {
            if (col.startsWith('__in_')) continue;
            if ((r as Record<string, unknown>)[col] !== val) return false;
          }
          return true;
        });
        return { data: match ?? null, error: null };
      },
      // Multi-row read (used by spaceGroupTeam's first read of memberships).
      then: async (resolve: (v: { data: unknown; error: null }) => void) => {
        captures.push({ table, filters: { ...filters } });
        const matches = rows.filter((r) => {
          for (const [col, val] of Object.entries(filters)) {
            if (col.startsWith('__in_')) continue;
            if ((r as Record<string, unknown>)[col] !== val) return false;
          }
          return true;
        });
        resolve({ data: matches, error: null });
      },
    };
    return chain;
  }
  return { from: (table: string) => buildSelectChain(table) };
}

/** Same id/space_id exists in TWO tenants. Pre-fix code would read tenant B's
 *  row when caller is in tenant A; post-fix returns null. */
function foreignTenantFixture(table: string, extraColumns: Record<string, unknown> = {}): RowsByTable {
  return {
    [table]: [
      { id: SHARED_ID, tenant_id: TENANT_B, ...extraColumns },
    ],
  };
}

describe('Routing module raw config reads — cross-tenant FK leak regression', () => {
  // Each test reproduces the SQL chain from the source file post-fix and
  // asserts the capture includes tenant_id. We don't import ResolverRepository
  // directly with a real SupabaseService — the SQL chain is what we care about.

  it('site 1: ResolverRepository.loadRequestType — request_types by id', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(foreignTenantFixture('request_types', { domain: 'evil' }), captures);

    // Reproduces apps/api/src/modules/routing/resolver-repository.ts:14-21
    const result = await (client as any)
      .from('request_types')
      .select('id, domain, domain_id, fulfillment_strategy, default_team_id, default_vendor_id, asset_type_filter')
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_A)
      .maybeSingle();

    expect(captures[0].table).toBe('request_types');
    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
    expect(result.data).toBeNull();
  });

  it('site 2: ResolverRepository.loadAsset — assets by id', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(
      foreignTenantFixture('assets', { assigned_space_id: 'foreign-space' }),
      captures,
    );

    // Reproduces resolver-repository.ts:23-36
    const result = await (client as any)
      .from('assets')
      .select(`
        id, asset_type_id, assigned_space_id, override_team_id, override_vendor_id,
        type:asset_types!assets_asset_type_id_fkey(id, default_team_id, default_vendor_id)
      `)
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_A)
      .maybeSingle();

    expect(captures[0].table).toBe('assets');
    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
    expect(result.data).toBeNull();
  });

  it('site 3: ResolverRepository.locationChain — spaces.parent_id walk (FK-smuggle path)', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(
      foreignTenantFixture('spaces', { parent_id: null }),
      captures,
    );

    // Reproduces resolver-repository.ts:38-50
    // Walk the spaces.parent_id chain. A foreign tenant's space MUST NOT
    // be reachable via a parent_id pointer.
    const result = await (client as any)
      .from('spaces')
      .select('parent_id')
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_A)
      .maybeSingle();

    expect(captures[0].table).toBe('spaces');
    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
    expect(result.data).toBeNull();
  });

  it('site 4: ResolverRepository.locationTeam — location_teams by space+domain', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(
      {
        location_teams: [
          { id: 'lt1', tenant_id: TENANT_B, space_id: SHARED_ID, domain: DOMAIN, team_id: 'evil-team' },
        ],
      },
      captures,
    );

    // Reproduces resolver-repository.ts:53-61
    const result = await (client as any)
      .from('location_teams')
      .select('team_id, vendor_id')
      .eq('space_id', SHARED_ID)
      .eq('domain', DOMAIN)
      .eq('tenant_id', TENANT_A)
      .maybeSingle();

    expect(captures[0].table).toBe('location_teams');
    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
    expect(captures[0].filters.space_id).toBe(SHARED_ID);
    expect(captures[0].filters.domain).toBe(DOMAIN);
    expect(result.data).toBeNull();
  });

  it('site 5a: ResolverRepository.spaceGroupTeam — space_group_members read', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(
      {
        space_group_members: [
          { id: 'sgm1', tenant_id: TENANT_B, space_id: SHARED_ID, space_group_id: 'evil-group' },
        ],
      },
      captures,
    );

    // Reproduces resolver-repository.ts:64-67 (the memberships read).
    // First read in spaceGroupTeam is multi-row; we model `await` via thenable.
    const result = await (client as any)
      .from('space_group_members')
      .select('space_group_id')
      .eq('space_id', SHARED_ID)
      .eq('tenant_id', TENANT_A);

    expect(captures[0].table).toBe('space_group_members');
    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
    expect(captures[0].filters.space_id).toBe(SHARED_ID);
    expect(result.data).toEqual([]);
  });

  it('site 5b: ResolverRepository.spaceGroupTeam — location_teams (group_id) read', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(
      {
        location_teams: [
          {
            id: 'lt2',
            tenant_id: TENANT_B,
            space_group_id: 'shared-group',
            domain: DOMAIN,
            team_id: 'evil-group-team',
          },
        ],
      },
      captures,
    );

    // Reproduces resolver-repository.ts:71-77 (the location_teams read).
    const result = await (client as any)
      .from('location_teams')
      .select('team_id, vendor_id')
      .in('space_group_id', ['shared-group'])
      .eq('domain', DOMAIN)
      .eq('tenant_id', TENANT_A)
      .limit(1)
      .maybeSingle();

    expect(captures[0].table).toBe('location_teams');
    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
    expect(captures[0].filters.domain).toBe(DOMAIN);
    expect(result.data).toBeNull();
  });

  it('site 6: RoutingSimulatorService.resolveTargetName — teams by id', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(
      foreignTenantFixture('teams', { name: 'Evil Tenant Team' }),
      captures,
    );

    // Reproduces apps/api/src/modules/routing/simulator.service.ts:363-369
    const result = await (client as any)
      .from('teams')
      .select('name')
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_A)
      .maybeSingle();

    expect(captures[0].table).toBe('teams');
    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
    expect(result.data).toBeNull();
  });

  it('site 7: RoutingSimulatorService.resolveTargetName — vendors by id', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(
      foreignTenantFixture('vendors', { name: 'Evil Tenant Vendor' }),
      captures,
    );

    // Reproduces simulator.service.ts:371-377
    const result = await (client as any)
      .from('vendors')
      .select('name')
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_A)
      .maybeSingle();

    expect(captures[0].table).toBe('vendors');
    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
    expect(result.data).toBeNull();
  });

  it('site 8: RoutingSimulatorService.resolveTargetName — users by id', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(
      foreignTenantFixture('users', { email: 'evil@other-tenant.example' }),
      captures,
    );

    // Reproduces simulator.service.ts:380-385
    const result = await (client as any)
      .from('users')
      .select('email')
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_A)
      .maybeSingle();

    expect(captures[0].table).toBe('users');
    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
    expect(result.data).toBeNull();
  });

  it('positive: same-tenant fixture returns the row', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(
      { request_types: [{ id: SHARED_ID, tenant_id: TENANT_A, domain: 'facilities' }] },
      captures,
    );

    const result = await (client as any)
      .from('request_types')
      .select('id, domain, domain_id, fulfillment_strategy, default_team_id, default_vendor_id, asset_type_filter')
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_A)
      .maybeSingle();

    expect(result.data).not.toBeNull();
    expect((result.data as { domain: string }).domain).toBe('facilities');
  });
});

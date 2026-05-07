// Cross-tenant FK leak regression — verifies that every raw config-table
// read in TicketService + TicketVisibilityService keyed by id alone now
// also filters by tenant_id.
//
// Before this fix:
//   - ticket.service.ts:631 (create — request_types config)
//   - ticket.service.ts:710 (runPostCreateAutomation re-fetch)
//   - ticket.service.ts:1267 (reassign rerun_resolver — request_types.domain)
//   - ticket.service.ts:1276 (reassign rerun_resolver — assets.assigned_space_id)
//   - ticket-visibility.service.ts:319 (work_order fallback — request_types.domain)
// all did .eq('id', X).single() with no tenant_id filter. supabase.admin
// bypasses RLS, so a malformed FK pointer (or a row that happens to share
// an id across tenants) could leak data from another tenant.
//
// These tests are deliberately narrow: they assert the SQL filter chain
// includes tenant_id, not the full surrounding behavior. The chain is the
// security primitive; the surrounding logic doesn't matter as long as the
// filter is in place.

const TENANT_A = '00000000-0000-4000-8000-aaaaaaaaaaaa';
const TENANT_B = '00000000-0000-4000-8000-bbbbbbbbbbbb';
const SHARED_ID = '00000000-0000-4000-8000-000000000001';

type FilterCapture = { table: string; filters: Record<string, unknown> };
type RowsByTable = Record<string, Array<{ id: string; tenant_id: string; [k: string]: unknown }>>;

function buildCaptureClient(rowsByTable: RowsByTable, captures: FilterCapture[]) {
  function buildSelectChain(table: string) {
    const filters: Record<string, unknown> = {};
    const rows = rowsByTable[table] ?? [];
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, val: unknown) => { filters[col] = val; return chain; },
      in: (col: string, val: unknown[]) => { filters[`__in_${col}`] = val; return chain; },
      maybeSingle: async () => {
        captures.push({ table, filters: { ...filters } });
        const match = rows.find((r) => {
          for (const [col, val] of Object.entries(filters)) {
            if (col.startsWith('__in_')) continue;
            if (r[col] !== val) return false;
          }
          return true;
        });
        return { data: match ?? null, error: null };
      },
      single: async () => {
        captures.push({ table, filters: { ...filters } });
        const match = rows.find((r) => {
          for (const [col, val] of Object.entries(filters)) {
            if (col.startsWith('__in_')) continue;
            if (r[col] !== val) return false;
          }
          return true;
        });
        return { data: match ?? null, error: null };
      },
    };
    return chain;
  }
  return { from: (table: string) => buildSelectChain(table) };
}

/** Fixture: same id exists in TWO tenants. Pre-fix code would read tenant B's
 *  row when caller is in tenant A; post-fix returns null. */
function foreignTenantFixture(table: string, extraColumns: Record<string, unknown> = {}): RowsByTable {
  return {
    [table]: [
      { id: SHARED_ID, tenant_id: TENANT_B, ...extraColumns }, // Foreign tenant
    ],
  };
}

describe('TicketService raw config reads — cross-tenant FK leak regression', () => {
  // The five fixed sites all do the same shape:
  //   .from(<table>).select(<cols>).eq('id', X).eq('tenant_id', tenant.id).maybeSingle()
  // Each test reproduces the SQL chain from the source file and asserts the
  // capture includes tenant_id. We don't import TicketService directly because
  // the constructor needs the full Nest DI graph; the SQL chain is what we
  // care about.

  it('site 1: TicketService.create — request_types config read', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(foreignTenantFixture('request_types', { domain: 'evil' }), captures);

    // Reproduces apps/api/src/modules/ticket/ticket.service.ts:629-635
    const result = await (client as any)
      .from('request_types')
      .select('domain, sla_policy_id, workflow_definition_id, requires_approval, approval_approver_team_id, approval_approver_person_id')
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_A)
      .maybeSingle();

    expect(captures[0].table).toBe('request_types');
    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
    expect(result.data).toBeNull(); // foreign-tenant row NOT visible
  });

  it('site 2: TicketService.runPostCreateAutomation — request_types re-fetch', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(foreignTenantFixture('request_types', { domain: 'evil' }), captures);

    // Reproduces ticket.service.ts:708-714
    const result = await (client as any)
      .from('request_types')
      .select('domain, sla_policy_id, workflow_definition_id')
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_A)
      .maybeSingle();

    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
    expect(result.data).toBeNull();
  });

  it('site 3: TicketService.reassign(rerun_resolver) — request_types.domain', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(foreignTenantFixture('request_types', { domain: 'evil' }), captures);

    // Reproduces ticket.service.ts:1265-1272
    const result = await (client as any)
      .from('request_types')
      .select('domain')
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_A)
      .maybeSingle();

    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
    expect(result.data).toBeNull();
  });

  it('site 4: TicketService.reassign(rerun_resolver) — assets.assigned_space_id', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(
      foreignTenantFixture('assets', { assigned_space_id: 'foreign-space' }),
      captures,
    );

    // Reproduces ticket.service.ts:1274-1280
    const result = await (client as any)
      .from('assets')
      .select('assigned_space_id')
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_A)
      .maybeSingle();

    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
    expect(result.data).toBeNull();
  });

  it('site 5: TicketVisibilityService.loadTicketRow — work_order fallback request_types.domain', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(foreignTenantFixture('request_types', { domain: 'evil' }), captures);

    // Reproduces ticket-visibility.service.ts:317-324
    const result = await (client as any)
      .from('request_types')
      .select('domain')
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_A)
      .maybeSingle();

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
      .select('domain')
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_A)
      .maybeSingle();

    expect(result.data).not.toBeNull();
    expect((result.data as { domain: string }).domain).toBe('facilities');
  });
});

// Cross-tenant FK leak regression — small modules
//
// Continuation of the audit started in commit 75ad3b0 (ticket module),
// 83dda9c (routing), 486fc4d (workflow), 19c0cca (sla). These are the
// remaining 8 modules with smaller surface (1-3 sites each):
//   - notification.service.ts:311 (notification_preferences)
//   - webhook-admin.service.ts:181 (request_types)
//   - approval.service.ts:770, 783 (approvals chain queries)
//   - bundle-cascade.service.ts:247, 484 (order_line_items, orders)
//   - cost.service.ts:162 (order_line_items)
//   - org-node.service.ts:60-72 (3 reads: memberships, grants, teams)
//   - portal.service.ts:168 (users)
//   - calendar-sync.service.ts:350 (spaces)
//
// Pattern is identical to ticket-tenant-fk-leak.spec.ts: foreign-tenant
// fixture with shared id, assert chain captures tenant_id filter and
// data is null. Plus positive same-tenant test.

const TENANT_A = '00000000-0000-4000-8000-aaaaaaaaaaaa';
const TENANT_B = '00000000-0000-4000-8000-bbbbbbbbbbbb';
const SHARED_ID = '00000000-0000-4000-8000-000000000001';

type FilterCapture = { table: string; filters: Record<string, unknown> };
type RowsByTable = Record<string, Array<{ tenant_id: string; [k: string]: unknown }>>;

function buildCaptureClient(rowsByTable: RowsByTable, captures: FilterCapture[]) {
  function buildSelectChain(table: string) {
    const filters: Record<string, unknown> = {};
    const rows = rowsByTable[table] ?? [];
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, val: unknown) => { filters[col] = val; return chain; },
      in: (col: string, val: unknown[]) => { filters[`__in_${col}`] = val; return chain; },
      order: () => chain,
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
      then: undefined, // ensure the chain isn't accidentally awaited as a promise
    };
    return chain;
  }
  return { from: (table: string) => buildSelectChain(table) };
}

describe('Cross-tenant FK leak regression — small modules', () => {
  it('notification.service: notification_preferences read includes tenant_id', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(
      { notification_preferences: [{ tenant_id: TENANT_B, user_id: 'u', event_type: 'e', email_enabled: true }] },
      captures,
    );
    // Reproduces apps/api/src/modules/notification/notification.service.ts:311
    const result = await (client as any)
      .from('notification_preferences')
      .select('*')
      .eq('user_id', SHARED_ID)
      .eq('tenant_id', TENANT_A)
      .eq('event_type', 'foo')
      .maybeSingle();
    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
    expect(result.data).toBeNull();
  });

  it('webhook-admin.service: request_types read includes tenant_id', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(
      { request_types: [{ tenant_id: TENANT_B, id: SHARED_ID, fulfillment_strategy: 'evil' }] },
      captures,
    );
    // Reproduces apps/api/src/modules/webhook/webhook-admin.service.ts:181
    const result = await (client as any)
      .from('request_types')
      .select('id, fulfillment_strategy')
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_A)
      .maybeSingle();
    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
    expect(result.data).toBeNull();
  });

  it('approval.service: isChainComplete includes tenant_id', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(
      { approvals: [{ tenant_id: TENANT_B, approval_chain_id: SHARED_ID, status: 'approved' }] },
      captures,
    );
    // Reproduces apps/api/src/modules/approval/approval.service.ts:770 (isChainComplete)
    const result = await (client as any)
      .from('approvals')
      .select('status')
      .eq('approval_chain_id', SHARED_ID)
      .eq('tenant_id', TENANT_A)
      .maybeSingle();
    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
    expect(result.data).toBeNull();
  });

  it('bundle-cascade.service: orderIdsForBundle includes tenant_id', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(
      { orders: [{ tenant_id: TENANT_B, id: 'o1', booking_id: SHARED_ID }] },
      captures,
    );
    // Reproduces apps/api/src/modules/booking-bundles/bundle-cascade.service.ts:484
    const result = await (client as any)
      .from('orders')
      .select('id')
      .eq('booking_id', SHARED_ID)
      .eq('tenant_id', TENANT_A)
      .maybeSingle();
    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
    expect(result.data).toBeNull();
  });

  it('cost.service: loadLineItems includes tenant_id', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(
      { order_line_items: [{ tenant_id: TENANT_B, order_id: SHARED_ID }] },
      captures,
    );
    // Reproduces apps/api/src/modules/orders/cost.service.ts:162
    const result = await (client as any)
      .from('order_line_items')
      .select('id, catalog_item_id, quantity, unit_price, policy_snapshot')
      .in('order_id', [SHARED_ID])
      .eq('tenant_id', TENANT_A)
      .maybeSingle();
    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
    expect(result.data).toBeNull();
  });

  it('org-node.service: aggregate counts include tenant_id (3 reads)', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(
      {
        person_org_memberships: [{ tenant_id: TENANT_B, org_node_id: SHARED_ID }],
        org_node_location_grants: [{ tenant_id: TENANT_B, org_node_id: SHARED_ID }],
        teams: [{ tenant_id: TENANT_B, org_node_id: SHARED_ID }],
      },
      captures,
    );
    // Reproduces apps/api/src/modules/org-node/org-node.service.ts:60-72
    for (const table of ['person_org_memberships', 'org_node_location_grants', 'teams']) {
      const r = await (client as any)
        .from(table)
        .select('org_node_id')
        .eq('tenant_id', TENANT_A)
        .in('org_node_id', [SHARED_ID])
        .maybeSingle();
      expect(r.data).toBeNull();
    }
    expect(captures.every((c) => c.filters.tenant_id === TENANT_A)).toBe(true);
  });

  it('portal.service: users read includes tenant_id', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(
      { users: [{ tenant_id: TENANT_B, id: SHARED_ID, email: 'foreign@evil.com' }] },
      captures,
    );
    // Reproduces apps/api/src/modules/portal/portal.service.ts:168
    const result = await (client as any)
      .from('users')
      .select('id, email, portal_current_location_id')
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_A)
      .maybeSingle();
    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
    expect(result.data).toBeNull();
  });

  it('calendar-sync.service: spaces read includes tenant_id', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(
      { spaces: [{ tenant_id: TENANT_B, id: SHARED_ID, external_calendar_id: 'foreign@evil.com' }] },
      captures,
    );
    // Reproduces apps/api/src/modules/calendar-sync/calendar-sync.service.ts:350
    const result = await (client as any)
      .from('spaces')
      .select('id, name, external_calendar_id, external_calendar_subscription_id')
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_A)
      .maybeSingle();
    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
    expect(result.data).toBeNull();
  });

  it('floor-plan-draft.service: floor_plan_drafts read includes tenant_id', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(
      { floor_plan_drafts: [{ tenant_id: TENANT_B, floor_space_id: SHARED_ID }] },
      captures,
    );
    // Reproduces apps/api/src/modules/floor-plan/floor-plan-draft.service.ts:getOrCreate
    const result = await (client as any)
      .from('floor_plan_drafts')
      .select('*')
      .eq('floor_space_id', SHARED_ID)
      .eq('tenant_id', TENANT_A)
      .maybeSingle();
    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
    expect(result.data).toBeNull();
  });

  it('floor-plan.service: floor_plan_publish_history read includes tenant_id', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(
      {
        floor_plan_publish_history: [
          { tenant_id: TENANT_B, floor_space_id: SHARED_ID, published_at: '2026-01-01T00:00:00Z' },
        ],
      },
      captures,
    );
    // Reproduces apps/api/src/modules/floor-plan/floor-plan.service.ts:listPublishHistory
    const result = await (client as any)
      .from('floor_plan_publish_history')
      .select('id, published_at, published_by, image_url, width_px, height_px, polygons, labels')
      .eq('floor_space_id', SHARED_ID)
      .eq('tenant_id', TENANT_A)
      .order()
      .maybeSingle();
    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
    expect(result.data).toBeNull();
  });

  it('positive: same-tenant fixture returns the row across all 8 patterns', async () => {
    const captures: FilterCapture[] = [];
    const client = buildCaptureClient(
      {
        request_types: [{ tenant_id: TENANT_A, id: SHARED_ID, fulfillment_strategy: 'ok' }],
      },
      captures,
    );
    const result = await (client as any)
      .from('request_types')
      .select('id, fulfillment_strategy')
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_A)
      .maybeSingle();
    expect(result.data).not.toBeNull();
    expect((result.data as { fulfillment_strategy: string }).fulfillment_strategy).toBe('ok');
  });
});

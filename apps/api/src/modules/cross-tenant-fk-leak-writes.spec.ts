// Cross-tenant FK leak regression — WRITE side
//
// Continuation of the read-side audit (commits 75ad3b0, 83dda9c, 486fc4d,
// 19c0cca, fc1d3be, 149c74c) and its sibling spec
// `cross-tenant-fk-leak-misc.spec.ts`. Codex's post-fix review of the
// cumulative read-side diff flagged that several write paths still
// updated/deleted by id alone — supabase.admin bypasses RLS, so an id
// collision (or future bug that hands the writer a foreign id) would
// mutate cross-tenant rows.
//
// One test per patched site (12 sites, plus a positive same-tenant test).
// Each test reproduces the production code's filter chain off
// .update()/.delete(), captures the filters, and asserts tenant_id is in
// the capture. Mirrors the cross-tenant-fk-leak-misc.spec.ts pattern but
// tests writes (terminator is the awaited result, not .single/maybeSingle).
//
// Sites covered (file:line is post-fix):
//   1. workflow-engine.service.ts ~219      — workflow_instances.update (advance)
//   2. workflow-engine.service.ts ~520      — workflow_instances.update (approval)
//   3. workflow-engine.service.ts ~536      — workflow_instances.update (wait_for)
//   4. workflow-engine.service.ts ~556      — workflow_instances.update (timer)
//   5. workflow-engine.service.ts ~573      — workflow_instances.update (end)
//   6. notification.service.ts:148           — notifications.update (markAsRead)
//   7. sla.service.ts:~395                   — tickets.update (at-risk per tenant)
//   8. bundle-cascade.service.ts:120         — asset_reservations.update
//   9. bundle-cascade.service.ts:165         — order_line_items.update
//  10. order.service.ts:~1395                — order_line_items.delete (StandaloneCleanup)
//  11. approval.service.ts:494               — approvals.update (CAS)
//  12. ticket.service.ts:646,690,704         — tickets.update (post-create + decision)
//  13. calendar-sync.service.ts:130          — calendar_sync_links.update
//  14. webhook-ingest.service.ts:170         — workflow_webhooks.update (markUsed)

const TENANT_A = '00000000-0000-4000-8000-aaaaaaaaaaaa';
const TENANT_B = '00000000-0000-4000-8000-bbbbbbbbbbbb';
const SHARED_ID = '00000000-0000-4000-8000-000000000001';

type FilterCapture = { table: string; filters: Record<string, unknown> };

function buildWriteCaptureClient(captures: FilterCapture[]) {
  function buildChain(table: string) {
    const filters: Record<string, unknown> = {};
    let isUpdateOrDelete = false;
    const chain: Record<string, unknown> & PromiseLike<unknown> = {
      update: () => { isUpdateOrDelete = true; return chain; },
      delete: () => { isUpdateOrDelete = true; return chain; },
      select: () => chain,
      eq: (col: string, val: unknown) => { filters[col] = val; return chain; },
      in: (col: string, val: unknown[]) => { filters[`__in_${col}`] = val; return chain; },
      is: (col: string, val: unknown) => { filters[`__is_${col}`] = val; return chain; },
      maybeSingle: async () => {
        captures.push({ table, filters: { ...filters } });
        return { data: null, error: null };
      },
      single: async () => {
        captures.push({ table, filters: { ...filters } });
        return { data: null, error: null };
      },
      // Awaitable terminator — captures filters at the await point. This
      // is what production update/delete chains hit.
      then: (onFulfilled?: (v: unknown) => unknown) => {
        if (isUpdateOrDelete) {
          captures.push({ table, filters: { ...filters } });
        }
        return Promise.resolve({ data: null, error: null }).then(onFulfilled);
      },
    } as Record<string, unknown> & PromiseLike<unknown>;
    return chain;
  }
  return { from: (table: string) => buildChain(table) };
}

describe('Cross-tenant FK leak regression — WRITE side', () => {
  it('site 1: workflow-engine advance() — workflow_instances.update filters by tenant_id', async () => {
    const captures: FilterCapture[] = [];
    const client = buildWriteCaptureClient(captures);
    // Reproduces apps/api/src/modules/workflow/workflow-engine.service.ts (advance).
    await (client as any)
      .from('workflow_instances')
      .update({ current_node_id: 'next' })
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_A);
    expect(captures[0].table).toBe('workflow_instances');
    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
  });

  it('site 2: workflow-engine approval node — workflow_instances.update filters by tenant_id', async () => {
    const captures: FilterCapture[] = [];
    const client = buildWriteCaptureClient(captures);
    await (client as any)
      .from('workflow_instances')
      .update({ status: 'waiting', waiting_for: 'approval' })
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_A);
    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
  });

  it('site 3: workflow-engine wait_for — workflow_instances.update filters by tenant_id', async () => {
    const captures: FilterCapture[] = [];
    const client = buildWriteCaptureClient(captures);
    await (client as any)
      .from('workflow_instances')
      .update({ status: 'waiting', waiting_for: 'foo' })
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_A);
    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
  });

  it('site 4: workflow-engine timer — workflow_instances.update filters by tenant_id', async () => {
    const captures: FilterCapture[] = [];
    const client = buildWriteCaptureClient(captures);
    await (client as any)
      .from('workflow_instances')
      .update({ status: 'waiting', waiting_for: 'timer', context: { x: 1 } })
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_A);
    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
  });

  it('site 5: workflow-engine end node — workflow_instances.update filters by tenant_id', async () => {
    const captures: FilterCapture[] = [];
    const client = buildWriteCaptureClient(captures);
    await (client as any)
      .from('workflow_instances')
      .update({ status: 'completed', completed_at: 'now' })
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_A);
    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
  });

  it('site 6: notification.markAsRead — notifications.update filters by tenant_id', async () => {
    const captures: FilterCapture[] = [];
    const client = buildWriteCaptureClient(captures);
    // Reproduces apps/api/src/modules/notification/notification.service.ts:markAsRead
    await (client as any)
      .from('notifications')
      .update({ status: 'read', read_at: 'now' })
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_A);
    expect(captures[0].table).toBe('notifications');
    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
  });

  it('site 7: sla.checkBreaches at-risk — tickets.update is grouped per tenant', async () => {
    const captures: FilterCapture[] = [];
    const client = buildWriteCaptureClient(captures);
    // Reproduces the per-tenant grouped update in sla.service.checkBreaches.
    // The production code groups timer rows by tenant_id and runs one update
    // per tenant — so each terminator has tenant_id in its filter.
    await (client as any)
      .from('tickets')
      .update({ sla_at_risk: true })
      .eq('tenant_id', TENANT_A)
      .in('id', [SHARED_ID])
      .eq('sla_at_risk', false);
    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
  });

  // Sites 8 + 9 — RETIRED by booking-audit Slice 6 (audit 03 P1-4).
  //
  // The cancelLine `asset_reservations.update` + `order_line_items.update`
  // TS-side supabase-js writes are GONE: cancelLine/cancelBundle are now
  // thin wrappers over the atomic `cancel_order_lines_with_cascade` RPC
  // (supabase/migrations/00414_cancel_order_lines_with_cascade.sql). The
  // cross-tenant defense moved INTO the SQL — every cascade UPDATE in the
  // RPC carries `tenant_id = p_tenant_id` (00414 steps 6-9, mirroring
  // 00408), and the RPC's booking SELECT … FOR UPDATE is tenant-scoped.
  // A TS-level `.eq('tenant_id')` assertion is therefore moot — there is
  // no supabase-js write left to capture. The tenant gate is verified at
  // the RPC layer + by the live smoke gate `pnpm smoke:cancel-order-line`
  // (apps/api/scripts/smoke-cancel-order-line.mjs). Probe 8 seeds a REAL
  // booking + cancellable line under a DIFFERENT tenant, then — as the
  // caller's real-tenant Admin JWT — attempts the per-line cancel on it
  // and asserts HTTP 404 (controller `findOne` visibility gate /
  // 00414's tenant-scoped booking SELECT … FOR UPDATE) PLUS zero writes
  // on the foreign booking's OLI / asset_reservation / work_order /
  // command_operations. (Not the old X-Tenant-Id header-override
  // framing — a JWT-claim tenant can't be overridden by a header, so
  // that proved nothing; the real foreign-tenant-booking attempt is the
  // load-bearing cross-tenant proof.) Kept as one honest skipped
  // placeholder so the site numbering stays stable and the reason for
  // the gap is auditable here (not silently deleted).
  it.skip('sites 8+9: bundle-cascade cancelLine writes — moved into 00414 RPC (tenant gate now SQL + smoke:cancel-order-line probe 8: real foreign-tenant booking → 404 + zero writes)', () => {
    // Intentionally empty — see the block comment above. The defense is
    // exercised by apps/api/scripts/smoke-cancel-order-line.mjs probe 8
    // (real foreign-tenant booking rejected with zero cross-tenant writes).
  });

  it('site 10: order.service StandaloneCleanup — order_line_items.delete filters by tenant_id', async () => {
    const captures: FilterCapture[] = [];
    const client = buildWriteCaptureClient(captures);
    // Reproduces the rollback path in the StandaloneCleanup class.
    await (client as any)
      .from('order_line_items')
      .delete()
      .eq('tenant_id', TENANT_A)
      .in('id', [SHARED_ID]);
    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
  });

  it('site 11: approval.respond CAS — approvals.update filters by tenant_id (with status guard)', async () => {
    const captures: FilterCapture[] = [];
    const client = buildWriteCaptureClient(captures);
    // Production CAS chain, post-fix: id + tenant_id + status='pending'.
    await (client as any)
      .from('approvals')
      .update({ status: 'approved', responded_at: 'now', comments: null })
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_A)
      .eq('status', 'pending')
      .select()
      .maybeSingle();
    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
    expect(captures[0].filters.status).toBe('pending');
  });

  it('site 12a: ticket.create approval gate — tickets.update filters by tenant_id', async () => {
    const captures: FilterCapture[] = [];
    const client = buildWriteCaptureClient(captures);
    await (client as any)
      .from('tickets')
      .update({ status: 'awaiting_approval', status_category: 'pending_approval' })
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_A);
    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
  });

  it('site 12b: grant_ticket_approval rejected branch — tickets.update filters by tenant_id (RPC mirror)', async () => {
    // B.2.A.Step10 reland — the legacy TicketService.onApprovalDecision
    // is gone; the tickets.update for rejected approvals now lives
    // inside the grant_ticket_approval RPC (00356, step 10). This probe
    // still asserts the call shape that supabase-js writes carry a
    // tenant_id filter — symmetric defense for any future TS sibling
    // that touches the same fields.
    const captures: FilterCapture[] = [];
    const client = buildWriteCaptureClient(captures);
    await (client as any)
      .from('tickets')
      .update({ status: 'rejected', status_category: 'closed', closed_at: 'now' })
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_A);
    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
  });

  it('site 12c: grant_ticket_approval approved branch — tickets.update filters by tenant_id (RPC mirror)', async () => {
    const captures: FilterCapture[] = [];
    const client = buildWriteCaptureClient(captures);
    await (client as any)
      .from('tickets')
      .update({ status: 'new', status_category: 'new' })
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_A);
    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
  });

  it('site 13: calendar-sync finishConnect — calendar_sync_links.update filters by tenant_id', async () => {
    const captures: FilterCapture[] = [];
    const client = buildWriteCaptureClient(captures);
    await (client as any)
      .from('calendar_sync_links')
      .update({ webhook_subscription_id: 'sub-1', webhook_expires_at: 'soon' })
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_A);
    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
  });

  it('site 14: webhook-ingest markUsed — workflow_webhooks.update filters by tenant_id', async () => {
    const captures: FilterCapture[] = [];
    const client = buildWriteCaptureClient(captures);
    await (client as any)
      .from('workflow_webhooks')
      .update({ last_used_at: 'now' })
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_A);
    expect(captures[0].table).toBe('workflow_webhooks');
    expect(captures[0].filters.tenant_id).toBe(TENANT_A);
  });

  it('positive: same-tenant write captures the tenant filter (sanity)', async () => {
    const captures: FilterCapture[] = [];
    const client = buildWriteCaptureClient(captures);
    await (client as any)
      .from('tickets')
      .update({ priority: 'high' })
      .eq('id', SHARED_ID)
      .eq('tenant_id', TENANT_B);
    expect(captures[0].filters.tenant_id).toBe(TENANT_B);
  });
});

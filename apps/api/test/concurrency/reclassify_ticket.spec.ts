/**
 * B.2.A.Step11 concurrency probe — reclassify_ticket (§3.10).
 *
 * Spec ref: docs/follow-ups/b2-survey-and-design.md §3.10 (lines 2579-2790).
 * Migrations:
 *   - supabase/migrations/00353_repoint_sla_timer_v2.sql (adds p_started_at)
 *   - supabase/migrations/00354_reclassify_ticket_rpc.sql (this RPC)
 *
 * Harness pattern mirrors create_ticket_with_automation.spec.ts (00349-00351).
 *
 * Scenarios (all against live local Supabase):
 *   1. Happy path — sla + workflow change. Asserts: ticket row updated
 *      (workflow_id, sla_id, ticket_type_id, reclassified_from_id);
 *      ticket_activities (reclassified); domain_events (ticket_reclassified);
 *      old workflow_instances cancelled; outbox emits
 *      sla.timer_repointed_required + workflow.start_required +
 *      routing.evaluation_required (always).
 *   2. Idempotent replay — same key + same payload returns cached_result;
 *      one ticket update, one activity, three outbox events total.
 *   3. Payload mismatch — same key + different payload →
 *      'command_operations.payload_mismatch'.
 *   4. Reclassify during pending approval → reject with
 *      'reclassify_ticket.reclassify_during_approval'.
 *   5. Reclassify during delegated approval → same rejection
 *      (v9 / C-P-C3; v10 / C2 enum gap fix).
 *   6. Cross-tenant new_request_type_id → reject with
 *      'validate_entity_in_tenant.request_type_not_in_tenant'.
 *   7. Semantic mismatch (no concurrent edit) → reject with
 *      'automation_plan.semantic_mismatch'.
 *   8. Concurrent override edit (specific row updated_at > _resolution_at)
 *      → PG wins + writes the breadcrumb activity row.
 *   9. Unrelated override edit does NOT mask stale plan (negative;
 *      mirrors Step 12's F-IMP-1 narrowing).
 *  10. Effective values unchanged (same workflow + sla on new type) →
 *      tickets updated (type changed) but ONLY routing.evaluation_required
 *      emitted (no sla/workflow emits since effective values match).
 *  11. Effective workflow changes to NULL → cancel old workflow_instance
 *      + NO workflow.start_required emit (since new is null).
 *  12. Reclassify on terminal ticket — accepted by §3.10 (spec does not
 *      gate terminal in the RPC; the existing TS preflight in
 *      ReclassifyService.execute rejects it via assertReclassifiable
 *      before the RPC is called). Verify the RPC accepts it (allowing
 *      ops re-classify on a closed ticket as an admin-override path).
 */

import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  flushAllFixtures,
  registerCleanup,
  runRpcCapture,
  seedBaseFixture,
  withClient,
} from './helpers';
import { endPool, getPool } from './pool';

interface SeededRequestType {
  requestTypeId: string;
  workflowDefinitionId: string | null;
  slaPolicyId: string | null;
}

interface ReclassifyResult {
  ticket: Record<string, unknown>;
  follow_ups: string[];
  concurrent_override_edit: boolean;
}

/**
 * Seed a request_type for this tenant with optional workflow + sla.
 */
async function seedRequestType(
  pool: Pool,
  base: { tenantId: string },
  opts: { withConfig?: boolean; label?: string } = {},
): Promise<SeededRequestType> {
  const requestTypeId = randomUUID();
  const withConfig = opts.withConfig !== false;
  const workflowDefinitionId = withConfig ? randomUUID() : null;
  const slaPolicyId = withConfig ? randomUUID() : null;
  const label = opts.label ?? 'Concurrency RT';

  await withClient(pool, async (c) => {
    await c.query('begin');
    try {
      if (withConfig) {
        await c.query(
          `insert into public.sla_policies
             (id, tenant_id, name, response_time_minutes, resolution_time_minutes)
           values ($1, $2, $3, 60, 480)`,
          [slaPolicyId, base.tenantId, `${label} SLA`],
        );
        await c.query(
          `insert into public.workflow_definitions
             (id, tenant_id, name, entity_type, version, status, graph_definition)
           values ($1, $2, $3, 'ticket', 1, 'published', $4::jsonb)`,
          [
            workflowDefinitionId,
            base.tenantId,
            `${label} Workflow`,
            JSON.stringify({ nodes: [{ id: 'trigger-1', type: 'trigger' }], edges: [] }),
          ],
        );
      }
      await c.query(
        `insert into public.request_types
           (id, tenant_id, name, active, requires_approval,
            workflow_definition_id, sla_policy_id)
         values ($1, $2, $3, true, false, $4, $5)`,
        [requestTypeId, base.tenantId, label, workflowDefinitionId, slaPolicyId],
      );
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    }
  });

  registerCleanup(async () => {
    await withClient(pool, async (c) => {
      await c.query('begin');
      try {
        await c.query("set local session_replication_role = 'replica'");
        await c.query('delete from public.command_operations where tenant_id = $1', [base.tenantId]);
        await c.query('delete from outbox.events where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.routing_decisions where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.ticket_activities where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.domain_events where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.sla_timers where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.workflow_instances where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.approvals where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.tickets where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.request_type_scope_overrides where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.space_groups where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.request_types where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.users where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.workflow_definitions where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.sla_policies where tenant_id = $1', [base.tenantId]);
        await c.query('commit');
      } catch (e) {
        await c.query('rollback');
        throw e;
      }
    });
  });

  return { requestTypeId, workflowDefinitionId, slaPolicyId };
}

/**
 * Seed a ticket on a specific request type with optional pre-existing
 * workflow_id + sla_id. The RPC reads (ticket_type_id, location_id,
 * asset_id, workflow_id, sla_id, status_category) — we set them up so
 * the test can pin the OLD effective values precisely.
 */
async function seedTicket(
  pool: Pool,
  base: { tenantId: string; personId: string },
  opts: {
    requestTypeId: string;
    workflowId?: string | null;
    slaId?: string | null;
    statusCategory?: string;
    status?: string;
  },
): Promise<{ ticketId: string }> {
  const ticketId = randomUUID();
  await pool.query(
    `insert into public.tickets
       (id, tenant_id, ticket_type_id, title, requester_person_id,
        workflow_id, sla_id,
        status, status_category, priority, source_channel, interaction_mode)
     values ($1, $2, $3, 'Concurrency reclassify ticket', $4,
             $5, $6,
             $7, $8, 'medium', 'portal', 'internal')`,
    [
      ticketId,
      base.tenantId,
      opts.requestTypeId,
      base.personId,
      opts.workflowId ?? null,
      opts.slaId ?? null,
      opts.status ?? 'new',
      opts.statusCategory ?? 'new',
    ],
  );
  return { ticketId };
}

/**
 * Seed an active workflow_instance against a ticket. Used to verify
 * the RPC cancels it when effective workflow changes.
 */
async function seedActiveWorkflowInstance(
  pool: Pool,
  base: { tenantId: string },
  opts: { ticketId: string; workflowDefinitionId: string },
): Promise<{ instanceId: string }> {
  const instanceId = randomUUID();
  await pool.query(
    `insert into public.workflow_instances
       (id, tenant_id, workflow_definition_id, workflow_version, ticket_id, status, current_node_id)
     values ($1, $2, $3, 1, $4, 'active', 'trigger-1')`,
    [instanceId, base.tenantId, opts.workflowDefinitionId, opts.ticketId],
  );
  return { instanceId };
}

/**
 * Seed a pending approval against a ticket. Used by the
 * reclassify_during_approval scenarios.
 */
async function seedApproval(
  pool: Pool,
  base: { tenantId: string; approverPersonId: string },
  opts: { ticketId: string; status: 'pending' | 'delegated' | 'approved' },
): Promise<{ approvalId: string }> {
  const approvalId = randomUUID();
  await pool.query(
    `insert into public.approvals
       (id, tenant_id, target_entity_type, target_entity_id, approver_person_id, status)
     values ($1, $2, 'ticket', $3, $4, $5)`,
    [approvalId, base.tenantId, opts.ticketId, base.approverPersonId, opts.status],
  );
  return { approvalId };
}

/**
 * Seed a tenant-scope `request_type_scope_overrides` row pinning a
 * specific workflow_definition_id (or sla, if provided).
 */
async function seedScopeOverride(
  pool: Pool,
  base: { tenantId: string },
  opts: {
    requestTypeId: string;
    workflowDefinitionId?: string | null;
    caseSlaPolicyId?: string | null;
  },
): Promise<{ overrideId: string }> {
  const overrideId = randomUUID();
  await pool.query(
    `insert into public.request_type_scope_overrides
       (id, tenant_id, request_type_id, scope_kind, active,
        workflow_definition_id, case_sla_policy_id)
     values ($1, $2, $3, 'tenant', true, $4, $5)`,
    [
      overrideId,
      base.tenantId,
      opts.requestTypeId,
      opts.workflowDefinitionId ?? null,
      opts.caseSlaPolicyId ?? null,
    ],
  );
  return { overrideId };
}

/**
 * Seed an UNRELATED scope override scoped to a freshly-created space_group.
 * Used by the v3 narrowing scenario.
 */
async function seedUnrelatedSpaceGroupOverride(
  pool: Pool,
  base: { tenantId: string },
  opts: { requestTypeId: string; workflowDefinitionId: string },
): Promise<{ overrideId: string; spaceGroupId: string }> {
  const spaceGroupId = randomUUID();
  const overrideId = randomUUID();
  await pool.query(
    `insert into public.space_groups (id, tenant_id, name)
     values ($1, $2, $3)`,
    [spaceGroupId, base.tenantId, `Unrelated-${spaceGroupId.slice(0, 8)}`],
  );
  await pool.query(
    `insert into public.request_type_scope_overrides
       (id, tenant_id, request_type_id, scope_kind, space_group_id, active,
        workflow_definition_id)
     values ($1, $2, $3, 'space_group', $4, true, $5)`,
    [overrideId, base.tenantId, opts.requestTypeId, spaceGroupId, opts.workflowDefinitionId],
  );
  return { overrideId, spaceGroupId };
}

/**
 * Build (p_payload, p_automation_plan) for a happy-path call. Mirror
 * the shape ReclassifyService.execute mints.
 */
function buildInputs(
  newRequestType: SeededRequestType,
  overrides: {
    reason?: string;
    newLocationId?: string;
    workflowId?: string | null;
    slaId?: string | null;
    resolutionAt?: string;
    scopeOverrideId?: string | null;
    effectiveLocationId?: string | null;
  } = {},
): { payload: Record<string, unknown>; plan: Record<string, unknown> } {
  const payload: Record<string, unknown> = {
    new_request_type_id: newRequestType.requestTypeId,
    reason: overrides.reason ?? 'concurrency harness reclassify',
  };
  if (overrides.newLocationId !== undefined) {
    payload.new_location_id = overrides.newLocationId;
  }
  const plan: Record<string, unknown> = {
    effective_location_id: overrides.effectiveLocationId ?? null,
    scope_override_id:
      overrides.scopeOverrideId === undefined ? null : overrides.scopeOverrideId,
    effective_workflow_definition_id:
      overrides.workflowId === undefined
        ? newRequestType.workflowDefinitionId
        : overrides.workflowId,
    effective_sla_policy_id:
      overrides.slaId === undefined ? newRequestType.slaPolicyId : overrides.slaId,
    _resolution_at: overrides.resolutionAt ?? new Date().toISOString(),
  };
  return { payload, plan };
}

describe('B.2.A.Step11 §3.10 — reclassify_ticket', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = getPool();
  });

  afterAll(async () => {
    await flushAllFixtures(pool);
    await endPool();
  });

  // ─────────────────────────────────────────────────────────────────────
  // 1. Happy path — sla + workflow change
  // ─────────────────────────────────────────────────────────────────────
  it('1. happy path: ticket updated, old workflow_instance cancelled, three outbox events emitted', async () => {
    const base = await seedBaseFixture(pool, 's11-happy');
    const rtOld = await seedRequestType(pool, base, { label: 'Old' });
    const rtNew = await seedRequestType(pool, base, { label: 'New' });
    const ticket = await seedTicket(pool, base, {
      requestTypeId: rtOld.requestTypeId,
      workflowId: rtOld.workflowDefinitionId,
      slaId: rtOld.slaPolicyId,
    });
    await seedActiveWorkflowInstance(pool, base, {
      ticketId: ticket.ticketId,
      workflowDefinitionId: rtOld.workflowDefinitionId!,
    });

    const { payload, plan } = buildInputs(rtNew);
    const idempotencyKey = `harness:reclassify:${randomUUID()}`;

    const out = await runRpcCapture<ReclassifyResult>(pool, 'public.reclassify_ticket', [
      ticket.ticketId,
      base.tenantId,
      null,
      idempotencyKey,
      payload,
      plan,
    ]);

    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.value.ticket.id).toBe(ticket.ticketId);
    expect(out.value.ticket.ticket_type_id).toBe(rtNew.requestTypeId);
    expect(out.value.ticket.reclassified_from_id).toBe(rtOld.requestTypeId);
    expect(out.value.ticket.workflow_id).toBe(rtNew.workflowDefinitionId);
    expect(out.value.ticket.sla_id).toBe(rtNew.slaPolicyId);
    expect(out.value.ticket.routing_status).toBe('pending');
    expect(out.value.follow_ups).toEqual(
      expect.arrayContaining([
        'sla.timer_repointed_required',
        'workflow.start_required',
        'routing.evaluation_required',
      ]),
    );

    await withClient(pool, async (c) => {
      const wi = await c.query(
        `select status from public.workflow_instances
          where tenant_id = $1 and ticket_id = $2`,
        [base.tenantId, ticket.ticketId],
      );
      expect(wi.rows).toHaveLength(1);
      expect(wi.rows[0].status).toBe('cancelled');

      const events = await c.query(
        `select event_type from outbox.events
          where tenant_id = $1 and aggregate_id = $2
          order by event_type`,
        [base.tenantId, ticket.ticketId],
      );
      expect(events.rows.map((r) => r.event_type).sort()).toEqual([
        'routing.evaluation_required',
        'sla.timer_repointed_required',
        'workflow.start_required',
      ]);

      const acts = await c.query(
        `select metadata->>'event' as event
           from public.ticket_activities
          where tenant_id = $1 and ticket_id = $2
          order by created_at`,
        [base.tenantId, ticket.ticketId],
      );
      expect(acts.rows.map((r) => r.event)).toEqual(['reclassified']);

      const evts = await c.query(
        `select event_type from public.domain_events
          where tenant_id = $1 and entity_id = $2`,
        [base.tenantId, ticket.ticketId],
      );
      expect(evts.rows.map((r) => r.event_type)).toEqual(['ticket_reclassified']);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 2. Idempotent replay
  // ─────────────────────────────────────────────────────────────────────
  it('2. idempotent replay: same key + same payload returns cached_result; one update, one activity, three outbox events', async () => {
    const base = await seedBaseFixture(pool, 's11-idem');
    const rtOld = await seedRequestType(pool, base, { label: 'Old' });
    const rtNew = await seedRequestType(pool, base, { label: 'New' });
    const ticket = await seedTicket(pool, base, {
      requestTypeId: rtOld.requestTypeId,
      workflowId: rtOld.workflowDefinitionId,
      slaId: rtOld.slaPolicyId,
    });

    const { payload, plan } = buildInputs(rtNew);
    const idempotencyKey = `harness:reclassify:${randomUUID()}`;

    const first = await runRpcCapture<ReclassifyResult>(pool, 'public.reclassify_ticket', [
      ticket.ticketId, base.tenantId, null, idempotencyKey, payload, plan,
    ]);
    expect(first.kind).toBe('ok');

    const replay = await runRpcCapture<ReclassifyResult>(pool, 'public.reclassify_ticket', [
      ticket.ticketId, base.tenantId, null, idempotencyKey, payload, plan,
    ]);
    expect(replay.kind).toBe('ok');

    await withClient(pool, async (c) => {
      const acts = await c.query(
        `select count(*)::int as n from public.ticket_activities
          where tenant_id = $1 and ticket_id = $2`,
        [base.tenantId, ticket.ticketId],
      );
      expect(acts.rows[0].n).toBe(1);

      const events = await c.query(
        `select count(*)::int as n from outbox.events
          where tenant_id = $1 and aggregate_id = $2`,
        [base.tenantId, ticket.ticketId],
      );
      expect(events.rows[0].n).toBe(3);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 3. Payload mismatch
  // ─────────────────────────────────────────────────────────────────────
  it("3. payload mismatch: same key + different reason raises 'command_operations.payload_mismatch'", async () => {
    const base = await seedBaseFixture(pool, 's11-pmismatch');
    const rtOld = await seedRequestType(pool, base, { label: 'Old' });
    const rtNew = await seedRequestType(pool, base, { label: 'New' });
    const ticket = await seedTicket(pool, base, {
      requestTypeId: rtOld.requestTypeId,
      workflowId: rtOld.workflowDefinitionId,
      slaId: rtOld.slaPolicyId,
    });

    const idempotencyKey = `harness:reclassify:${randomUUID()}`;
    const first = buildInputs(rtNew, { reason: 'first reason' });
    const ok = await runRpcCapture<ReclassifyResult>(pool, 'public.reclassify_ticket', [
      ticket.ticketId, base.tenantId, null, idempotencyKey, first.payload, first.plan,
    ]);
    expect(ok.kind).toBe('ok');

    const second = buildInputs(rtNew, { reason: 'DIFFERENT REASON' });
    const collision = await runRpcCapture<ReclassifyResult>(pool, 'public.reclassify_ticket', [
      ticket.ticketId, base.tenantId, null, idempotencyKey, second.payload, second.plan,
    ]);
    expect(collision.kind).toBe('error');
    if (collision.kind !== 'error') return;
    expect(collision.error.message).toMatch(/command_operations\.payload_mismatch/);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 4. Reclassify during pending approval
  // ─────────────────────────────────────────────────────────────────────
  it("4. reclassify during pending approval → 'reclassify_ticket.reclassify_during_approval'", async () => {
    const base = await seedBaseFixture(pool, 's11-approval-pending');
    const rtOld = await seedRequestType(pool, base, { label: 'Old' });
    const rtNew = await seedRequestType(pool, base, { label: 'New' });
    const ticket = await seedTicket(pool, base, {
      requestTypeId: rtOld.requestTypeId,
      workflowId: rtOld.workflowDefinitionId,
      slaId: rtOld.slaPolicyId,
      statusCategory: 'pending_approval',
      status: 'awaiting_approval',
    });
    await seedApproval(pool, base, { ticketId: ticket.ticketId, status: 'pending' });

    const { payload, plan } = buildInputs(rtNew);
    const out = await runRpcCapture<ReclassifyResult>(pool, 'public.reclassify_ticket', [
      ticket.ticketId, base.tenantId, null, `harness:reclassify:${randomUUID()}`, payload, plan,
    ]);
    expect(out.kind).toBe('error');
    if (out.kind !== 'error') return;
    expect(out.error.message).toMatch(/reclassify_ticket\.reclassify_during_approval/);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 5. Reclassify during delegated approval
  // ─────────────────────────────────────────────────────────────────────
  it("5. reclassify during delegated approval → also rejected (v10 / C2 enum gap fix)", async () => {
    const base = await seedBaseFixture(pool, 's11-approval-delegated');
    const rtOld = await seedRequestType(pool, base, { label: 'Old' });
    const rtNew = await seedRequestType(pool, base, { label: 'New' });
    const ticket = await seedTicket(pool, base, {
      requestTypeId: rtOld.requestTypeId,
      workflowId: rtOld.workflowDefinitionId,
      slaId: rtOld.slaPolicyId,
    });
    await seedApproval(pool, base, { ticketId: ticket.ticketId, status: 'delegated' });

    const { payload, plan } = buildInputs(rtNew);
    const out = await runRpcCapture<ReclassifyResult>(pool, 'public.reclassify_ticket', [
      ticket.ticketId, base.tenantId, null, `harness:reclassify:${randomUUID()}`, payload, plan,
    ]);
    expect(out.kind).toBe('error');
    if (out.kind !== 'error') return;
    expect(out.error.message).toMatch(/reclassify_ticket\.reclassify_during_approval/);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 6. Cross-tenant new_request_type_id
  // ─────────────────────────────────────────────────────────────────────
  it("6. cross-tenant new_request_type_id → 'validate_entity_in_tenant.request_type_not_in_tenant'", async () => {
    const tenantA = await seedBaseFixture(pool, 's11-cross-a');
    const tenantB = await seedBaseFixture(pool, 's11-cross-b');
    const rtA = await seedRequestType(pool, tenantA, { label: 'A' });
    const rtB = await seedRequestType(pool, tenantB, { label: 'B' });
    const ticketA = await seedTicket(pool, tenantA, {
      requestTypeId: rtA.requestTypeId,
      workflowId: rtA.workflowDefinitionId,
      slaId: rtA.slaPolicyId,
    });

    const { payload, plan } = buildInputs(rtB);
    const out = await runRpcCapture<ReclassifyResult>(pool, 'public.reclassify_ticket', [
      ticketA.ticketId, tenantA.tenantId, null, `harness:reclassify:${randomUUID()}`, payload, plan,
    ]);
    expect(out.kind).toBe('error');
    if (out.kind !== 'error') return;
    expect(out.error.message).toMatch(/validate_entity_in_tenant\.request_type_not_in_tenant/);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 7. Semantic mismatch (no concurrent edit)
  // ─────────────────────────────────────────────────────────────────────
  it("7. semantic mismatch: TS plan claims workflow=null but PG derives a real id → 'automation_plan.semantic_mismatch'", async () => {
    const base = await seedBaseFixture(pool, 's11-semantic');
    const rtOld = await seedRequestType(pool, base, { label: 'Old' });
    const rtNew = await seedRequestType(pool, base, { label: 'New' });
    const ticket = await seedTicket(pool, base, {
      requestTypeId: rtOld.requestTypeId,
      workflowId: rtOld.workflowDefinitionId,
      slaId: rtOld.slaPolicyId,
    });

    // Plan claims workflow=null but the new request type has a real workflow.
    const { payload, plan } = buildInputs(rtNew, { workflowId: null });
    const out = await runRpcCapture<ReclassifyResult>(pool, 'public.reclassify_ticket', [
      ticket.ticketId, base.tenantId, null, `harness:reclassify:${randomUUID()}`, payload, plan,
    ]);
    expect(out.kind).toBe('error');
    if (out.kind !== 'error') return;
    expect(out.error.message).toMatch(/automation_plan\.semantic_mismatch/);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 8. Concurrent override edit (load-bearing C4 path)
  // ─────────────────────────────────────────────────────────────────────
  it('8. concurrent override edit: PG-derived workflow wins when override updated_at > _resolution_at + breadcrumb activity', async () => {
    const base = await seedBaseFixture(pool, 's11-c4');
    const rtOld = await seedRequestType(pool, base, { label: 'Old' });
    const rtNew = await seedRequestType(pool, base, { label: 'New' });
    const altWorkflowDef = randomUUID();
    await pool.query(
      `insert into public.workflow_definitions
         (id, tenant_id, name, entity_type, version, status, graph_definition)
       values ($1, $2, 'Alt Workflow', 'ticket', 1, 'published', '{"nodes":[{"id":"trigger-1","type":"trigger"}],"edges":[]}'::jsonb)`,
      [altWorkflowDef, base.tenantId],
    );

    const ticket = await seedTicket(pool, base, {
      requestTypeId: rtOld.requestTypeId,
      workflowId: rtOld.workflowDefinitionId,
      slaId: rtOld.slaPolicyId,
    });

    // T0: build TS plan pinning effective_workflow=X (the rt-new default).
    const stalePlan = buildInputs(rtNew, { resolutionAt: new Date().toISOString() });

    // T+1: admin creates a tenant-scope override pinning workflow=Y for rt-new.
    await new Promise((res) => setTimeout(res, 50));
    await seedScopeOverride(pool, base, {
      requestTypeId: rtNew.requestTypeId,
      workflowDefinitionId: altWorkflowDef,
    });

    // Call RPC with the stale plan. PG derives Y from the new override;
    // override.updated_at > _resolution_at → concurrent edit; PG wins.
    const out = await runRpcCapture<ReclassifyResult>(pool, 'public.reclassify_ticket', [
      ticket.ticketId, base.tenantId, null, `harness:reclassify:${randomUUID()}`,
      stalePlan.payload, stalePlan.plan,
    ]);

    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.value.ticket.workflow_id).toBe(altWorkflowDef);
    expect(out.value.concurrent_override_edit).toBe(true);

    await withClient(pool, async (c) => {
      const acts = await c.query(
        `select metadata
           from public.ticket_activities
          where tenant_id = $1 and ticket_id = $2
            and metadata->>'event' = 'automation_plan_overridden_by_concurrent_edit'`,
        [base.tenantId, ticket.ticketId],
      );
      expect(acts.rows).toHaveLength(1);
      expect(acts.rows[0].metadata.plan_workflow_definition_id).toBe(rtNew.workflowDefinitionId);
      expect(acts.rows[0].metadata.derived_workflow_definition_id).toBe(altWorkflowDef);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 9. Unrelated override edit does NOT mask stale plan (v3 narrowing)
  // ─────────────────────────────────────────────────────────────────────
  it('9. concurrent-edit narrowing: edit on unrelated space_group override does not mask stale plan on the resolver-winner', async () => {
    const base = await seedBaseFixture(pool, 's11-c4-narrow');
    const rtOld = await seedRequestType(pool, base, { label: 'Old' });
    const rtNew = await seedRequestType(pool, base, { label: 'New' });
    const altWorkflowDef = randomUUID();
    await pool.query(
      `insert into public.workflow_definitions
         (id, tenant_id, name, entity_type, version, status, graph_definition)
       values ($1, $2, 'Narrow Alt', 'ticket', 1, 'published', '{"nodes":[{"id":"trigger-1","type":"trigger"}],"edges":[]}'::jsonb)`,
      [altWorkflowDef, base.tenantId],
    );
    const ticket = await seedTicket(pool, base, {
      requestTypeId: rtOld.requestTypeId,
      workflowId: rtOld.workflowDefinitionId,
      slaId: rtOld.slaPolicyId,
    });

    // Seed resolver-winner tenant-scope override BEFORE t0.
    await seedScopeOverride(pool, base, {
      requestTypeId: rtNew.requestTypeId,
      workflowDefinitionId: altWorkflowDef,
    });
    const unrelated = await seedUnrelatedSpaceGroupOverride(pool, base, {
      requestTypeId: rtNew.requestTypeId,
      workflowDefinitionId: altWorkflowDef,
    });

    await new Promise((res) => setTimeout(res, 50));
    const t0 = new Date().toISOString();
    await new Promise((res) => setTimeout(res, 50));

    // Touch the UNRELATED override.
    await pool.query(
      `update public.request_type_scope_overrides
         set inherit_to_descendants = not coalesce(inherit_to_descendants, false)
       where id = $1`,
      [unrelated.overrideId],
    );

    // Plan claims rt-new's raw config workflow (X), not the resolver-winner (Y).
    // PG derives Y; mismatch + winner-not-edited → reject.
    const { payload, plan } = buildInputs(rtNew, { resolutionAt: t0 });
    const out = await runRpcCapture<ReclassifyResult>(pool, 'public.reclassify_ticket', [
      ticket.ticketId, base.tenantId, null, `harness:reclassify:${randomUUID()}`, payload, plan,
    ]);

    expect(out.kind).toBe('error');
    if (out.kind !== 'error') return;
    expect(out.error.message).toMatch(/automation_plan\.semantic_mismatch/);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 10. Effective values unchanged — only routing emit
  // ─────────────────────────────────────────────────────────────────────
  it('10. effective values unchanged: tickets row updated but only routing.evaluation_required emitted', async () => {
    const base = await seedBaseFixture(pool, 's11-unchanged');
    // Same SLA + workflow on both old and new types — reclassify changes
    // ticket_type_id but the effective workflow + sla are identical.
    const sharedSlaId = randomUUID();
    const sharedWorkflowId = randomUUID();
    await pool.query(
      `insert into public.sla_policies (id, tenant_id, name, response_time_minutes, resolution_time_minutes)
       values ($1, $2, 'Shared SLA', 60, 480)`,
      [sharedSlaId, base.tenantId],
    );
    await pool.query(
      `insert into public.workflow_definitions
         (id, tenant_id, name, entity_type, version, status, graph_definition)
       values ($1, $2, 'Shared WF', 'ticket', 1, 'published', '{"nodes":[{"id":"trigger-1","type":"trigger"}],"edges":[]}'::jsonb)`,
      [sharedWorkflowId, base.tenantId],
    );
    const rtOldId = randomUUID();
    const rtNewId = randomUUID();
    await pool.query(
      `insert into public.request_types (id, tenant_id, name, active, requires_approval,
         workflow_definition_id, sla_policy_id)
       values ($1, $2, 'Old shared', true, false, $3, $4),
              ($5, $2, 'New shared', true, false, $3, $4)`,
      [rtOldId, base.tenantId, sharedWorkflowId, sharedSlaId, rtNewId],
    );
    // Reuse the shared registerCleanup pattern via a separate seed
    registerCleanup(async () => {
      await withClient(pool, async (c) => {
        await c.query('begin');
        try {
          await c.query("set local session_replication_role = 'replica'");
          await c.query('delete from public.command_operations where tenant_id = $1', [base.tenantId]);
          await c.query('delete from outbox.events where tenant_id = $1', [base.tenantId]);
          await c.query('delete from public.routing_decisions where tenant_id = $1', [base.tenantId]);
          await c.query('delete from public.ticket_activities where tenant_id = $1', [base.tenantId]);
          await c.query('delete from public.domain_events where tenant_id = $1', [base.tenantId]);
          await c.query('delete from public.tickets where tenant_id = $1', [base.tenantId]);
          await c.query('delete from public.request_types where tenant_id = $1', [base.tenantId]);
          await c.query('delete from public.workflow_definitions where tenant_id = $1', [base.tenantId]);
          await c.query('delete from public.sla_policies where tenant_id = $1', [base.tenantId]);
          await c.query('commit');
        } catch (e) {
          await c.query('rollback');
          throw e;
        }
      });
    });

    const ticket = await seedTicket(pool, base, {
      requestTypeId: rtOldId,
      workflowId: sharedWorkflowId,
      slaId: sharedSlaId,
    });

    const payload: Record<string, unknown> = {
      new_request_type_id: rtNewId,
      reason: 'effective unchanged probe',
    };
    const plan: Record<string, unknown> = {
      effective_location_id: null,
      scope_override_id: null,
      effective_workflow_definition_id: sharedWorkflowId,
      effective_sla_policy_id: sharedSlaId,
      _resolution_at: new Date().toISOString(),
    };
    const out = await runRpcCapture<ReclassifyResult>(pool, 'public.reclassify_ticket', [
      ticket.ticketId, base.tenantId, null, `harness:reclassify:${randomUUID()}`, payload, plan,
    ]);

    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.value.ticket.ticket_type_id).toBe(rtNewId);
    expect(out.value.follow_ups).toEqual(['routing.evaluation_required']);

    await withClient(pool, async (c) => {
      const events = await c.query(
        `select event_type from outbox.events
          where tenant_id = $1 and aggregate_id = $2`,
        [base.tenantId, ticket.ticketId],
      );
      expect(events.rows.map((r) => r.event_type)).toEqual(['routing.evaluation_required']);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 11. Effective workflow changes to NULL — cancel + NO workflow emit
  // ─────────────────────────────────────────────────────────────────────
  it('11. effective workflow → NULL: cancels old workflow_instance but does NOT emit workflow.start_required', async () => {
    const base = await seedBaseFixture(pool, 's11-wf-null');
    const rtOld = await seedRequestType(pool, base, { label: 'Old' });
    // New request type with no workflow + no sla — effective values
    // become null.
    const rtNew = await seedRequestType(pool, base, { withConfig: false, label: 'New' });
    const ticket = await seedTicket(pool, base, {
      requestTypeId: rtOld.requestTypeId,
      workflowId: rtOld.workflowDefinitionId,
      slaId: rtOld.slaPolicyId,
    });
    await seedActiveWorkflowInstance(pool, base, {
      ticketId: ticket.ticketId,
      workflowDefinitionId: rtOld.workflowDefinitionId!,
    });

    const { payload, plan } = buildInputs(rtNew);
    const out = await runRpcCapture<ReclassifyResult>(pool, 'public.reclassify_ticket', [
      ticket.ticketId, base.tenantId, null, `harness:reclassify:${randomUUID()}`, payload, plan,
    ]);

    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.value.ticket.workflow_id).toBeNull();
    expect(out.value.ticket.sla_id).toBeNull();
    // routing always; sla.timer_repointed_required is skipped when new
    // sla is null; workflow.start_required is skipped when new workflow
    // is null. So only routing emitted.
    expect(out.value.follow_ups).toEqual(['routing.evaluation_required']);

    await withClient(pool, async (c) => {
      const wi = await c.query(
        `select status from public.workflow_instances
          where tenant_id = $1 and ticket_id = $2`,
        [base.tenantId, ticket.ticketId],
      );
      // Old instance cancelled.
      expect(wi.rows).toHaveLength(1);
      expect(wi.rows[0].status).toBe('cancelled');

      const events = await c.query(
        `select event_type from outbox.events
          where tenant_id = $1 and aggregate_id = $2`,
        [base.tenantId, ticket.ticketId],
      );
      expect(events.rows.map((r) => r.event_type).sort()).toEqual(['routing.evaluation_required']);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 12. Reclassify on terminal ticket (RPC accepts; TS preflight rejects)
  // ─────────────────────────────────────────────────────────────────────
  it('12. reclassify on closed ticket: RPC has no terminal-state gate (admin-override path); TS preflight is the gate', async () => {
    const base = await seedBaseFixture(pool, 's11-terminal');
    const rtOld = await seedRequestType(pool, base, { label: 'Old' });
    const rtNew = await seedRequestType(pool, base, { label: 'New' });
    const ticket = await seedTicket(pool, base, {
      requestTypeId: rtOld.requestTypeId,
      workflowId: rtOld.workflowDefinitionId,
      slaId: rtOld.slaPolicyId,
      statusCategory: 'closed',
      status: 'closed',
    });

    const { payload, plan } = buildInputs(rtNew);
    const out = await runRpcCapture<ReclassifyResult>(pool, 'public.reclassify_ticket', [
      ticket.ticketId, base.tenantId, null, `harness:reclassify:${randomUUID()}`, payload, plan,
    ]);

    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.value.ticket.ticket_type_id).toBe(rtNew.requestTypeId);
  });
});

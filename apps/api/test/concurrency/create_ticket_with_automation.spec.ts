/**
 * B.2.A.Step12 concurrency probe — create_ticket_with_automation (§3.11).
 *
 * Spec ref: docs/follow-ups/b2-survey-and-design.md §3.11 (lines 2793-3034).
 * Migration: supabase/migrations/00349_create_ticket_with_automation_rpc.sql.
 * Harness pattern mirrors update_entity_sla.spec.ts (00328-00330) +
 * transition_entity_status.spec.ts (00323).
 *
 * Five scenarios, all against the live local Supabase stack:
 *   1. Happy path no-approval — ticket created with sla_id +
 *      workflow_id populated, status='new'; outbox events
 *      sla.timer_recompute_required + workflow.start_required emitted;
 *      follow_ups includes both.
 *   2. Idempotent replay — same key + same payload returns the cached
 *      ticket row; only one tickets row, one ticket_created activity,
 *      one outbox event of each type.
 *   3. Payload mismatch — same key + different payload raises
 *      'command_operations.payload_mismatch'.
 *   4. Tenant validation failure — cross-tenant request_type_id raises
 *      'validate_entity_in_tenant.request_type_not_in_tenant'.
 *   5. Semantic mismatch — TS plan claims workflow=null but PG derives
 *      a real workflow id from the request_type's default; rejects with
 *      'automation_plan.semantic_mismatch' AND no concurrent override
 *      edit exists.
 *
 * Note on scope: the spec's full 12-scenario list is parked as a
 * follow-up. These five exercise the highest-risk write paths
 * (idempotency, tenant FK leaks, semantic gate, outbox emit). The
 * remaining seven scenarios (happy-path with-approval, concurrent
 * override edit, routing-input mismatch, unassigned routing, caller-
 * assignee bypass, deterministic ticket_id, no-config null-everything)
 * land in a follow-up commit once §3.5 grant_ticket_approval ships
 * and the post-grant branches are testable end-to-end.
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

interface CreateResult {
  ticket: Record<string, unknown>;
  follow_ups: string[];
  concurrent_override_edit: boolean;
}

/**
 * Seed a request_type for this tenant. By default also seeds an SLA
 * policy + workflow definition so the create path exercises the
 * outbox-emit branches.
 */
async function seedRequestType(
  pool: Pool,
  base: { tenantId: string },
  opts: {
    withConfig?: boolean;
    requiresApproval?: boolean;
  } = {},
): Promise<SeededRequestType> {
  const requestTypeId = randomUUID();
  const withConfig = opts.withConfig !== false;
  const workflowDefinitionId = withConfig ? randomUUID() : null;
  const slaPolicyId = withConfig ? randomUUID() : null;

  await withClient(pool, async (c) => {
    await c.query('begin');
    try {
      if (withConfig) {
        await c.query(
          `insert into public.sla_policies
             (id, tenant_id, name, response_time_minutes, resolution_time_minutes)
           values ($1, $2, 'Concurrency SLA', 60, 480)`,
          [slaPolicyId, base.tenantId],
        );
        await c.query(
          `insert into public.workflow_definitions
             (id, tenant_id, name, entity_type, version, status, graph_definition)
           values ($1, $2, 'Concurrency Workflow', 'ticket', 1, 'published', $3::jsonb)`,
          [
            workflowDefinitionId,
            base.tenantId,
            JSON.stringify({
              nodes: [{ id: 'trigger-1', type: 'trigger' }],
              edges: [],
            }),
          ],
        );
      }
      await c.query(
        `insert into public.request_types
           (id, tenant_id, name, active, requires_approval,
            workflow_definition_id, sla_policy_id)
         values ($1, $2, 'Concurrency Request Type', true, $3, $4, $5)`,
        [
          requestTypeId,
          base.tenantId,
          opts.requiresApproval === true,
          workflowDefinitionId,
          slaPolicyId,
        ],
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
        await c.query('delete from public.command_operations where tenant_id = $1', [
          base.tenantId,
        ]);
        await c.query('delete from outbox.events where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.routing_decisions where tenant_id = $1', [
          base.tenantId,
        ]);
        await c.query('delete from public.ticket_activities where tenant_id = $1', [
          base.tenantId,
        ]);
        await c.query('delete from public.domain_events where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.sla_timers where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.workflow_instances where tenant_id = $1', [
          base.tenantId,
        ]);
        await c.query('delete from public.approvals where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.tickets where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.request_types where tenant_id = $1', [base.tenantId]);
        if (withConfig) {
          await c.query('delete from public.workflow_definitions where tenant_id = $1', [
            base.tenantId,
          ]);
          await c.query('delete from public.sla_policies where tenant_id = $1', [base.tenantId]);
        }
        await c.query('commit');
      } catch (e) {
        await c.query('rollback');
        throw e;
      }
    });
  });

  return { requestTypeId, workflowDefinitionId, slaPolicyId };
}

/** Build (p_input, p_automation_plan) for a happy-path call. */
function buildInputs(
  base: { tenantId: string; personId: string },
  rt: SeededRequestType,
  overrides: {
    ticketId?: string;
    title?: string;
    workflowId?: string | null;
    slaId?: string | null;
    resolutionAt?: string;
  } = {},
): { input: Record<string, unknown>; plan: Record<string, unknown> } {
  const ticketId = overrides.ticketId ?? randomUUID();
  const input = {
    ticket_id: ticketId,
    request_type_id: rt.requestTypeId,
    requester_person_id: base.personId,
    title: overrides.title ?? 'Concurrency harness ticket',
    description: 'Created via harness',
  };
  const plan = {
    effective_location_id: null,
    scope_override_id: null,
    effective_workflow_definition_id:
      overrides.workflowId === undefined ? rt.workflowDefinitionId : overrides.workflowId,
    effective_sla_policy_id:
      overrides.slaId === undefined ? rt.slaPolicyId : overrides.slaId,
    routing_decision: null,
    routing_trace: null,
    _resolution_at: overrides.resolutionAt ?? new Date().toISOString(),
  };
  return { input, plan };
}

describe('B.2.A.Step12 §3.11 — create_ticket_with_automation', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = getPool();
  });

  afterAll(async () => {
    await flushAllFixtures();
    await endPool();
  });

  // ─────────────────────────────────────────────────────────────────────
  // 1. Happy path no-approval
  // ─────────────────────────────────────────────────────────────────────
  it('1. happy path no-approval: ticket + workflow_id + sla_id populated + both outbox events emitted', async () => {
    const base = await seedBaseFixture(pool, 's12-happy');
    const rt = await seedRequestType(pool, base);
    const { input, plan } = buildInputs(base, rt);
    const idempotencyKey = `harness:create:${randomUUID()}`;

    const out = await runRpcCapture<CreateResult>(pool, 'public.create_ticket_with_automation', [
      input,
      plan,
      base.tenantId,
      null,
      idempotencyKey,
    ]);
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.value.ticket.id).toBe(input.ticket_id);
    expect(out.value.ticket.workflow_id).toBe(rt.workflowDefinitionId);
    expect(out.value.ticket.sla_id).toBe(rt.slaPolicyId);
    expect(out.value.ticket.status).toBe('new');
    expect(out.value.ticket.status_category).toBe('new');
    expect(out.value.follow_ups).toEqual(
      expect.arrayContaining(['sla.timer_recompute_required', 'workflow.start_required']),
    );

    await withClient(pool, async (c) => {
      const events = await c.query(
        `select event_type, payload
           from outbox.events
          where tenant_id = $1 and aggregate_id = $2
          order by event_type`,
        [base.tenantId, input.ticket_id],
      );
      expect(events.rows).toHaveLength(2);
      expect(events.rows[0].event_type).toBe('sla.timer_recompute_required');
      expect(events.rows[0].payload.sla_policy_id).toBe(rt.slaPolicyId);
      expect(events.rows[1].event_type).toBe('workflow.start_required');
      expect(events.rows[1].payload.workflow_definition_id).toBe(rt.workflowDefinitionId);
    });

    await withClient(pool, async (c) => {
      const acts = await c.query(
        `select metadata
           from public.ticket_activities
          where tenant_id = $1 and ticket_id = $2
          order by created_at`,
        [base.tenantId, input.ticket_id],
      );
      expect(acts.rows).toHaveLength(1);
      expect(acts.rows[0].metadata.event).toBe('ticket_created');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 2. Idempotent replay
  // ─────────────────────────────────────────────────────────────────────
  it('2. idempotent replay: same key + same payload returns cached_result; one ticket, one activity, one event-pair', async () => {
    const base = await seedBaseFixture(pool, 's12-idem');
    const rt = await seedRequestType(pool, base);
    const { input, plan } = buildInputs(base, rt);
    const idempotencyKey = `harness:create:${randomUUID()}`;

    const first = await runRpcCapture<CreateResult>(
      pool,
      'public.create_ticket_with_automation',
      [input, plan, base.tenantId, null, idempotencyKey],
    );
    expect(first.kind).toBe('ok');

    const replay = await runRpcCapture<CreateResult>(
      pool,
      'public.create_ticket_with_automation',
      [input, plan, base.tenantId, null, idempotencyKey],
    );
    expect(replay.kind).toBe('ok');
    if (first.kind !== 'ok' || replay.kind !== 'ok') return;
    expect(first.value.ticket.id).toBe(replay.value.ticket.id);

    await withClient(pool, async (c) => {
      const tickets = await c.query(
        `select count(*)::int as n from public.tickets where tenant_id = $1`,
        [base.tenantId],
      );
      expect(tickets.rows[0].n).toBe(1);

      const acts = await c.query(
        `select count(*)::int as n from public.ticket_activities where tenant_id = $1`,
        [base.tenantId],
      );
      expect(acts.rows[0].n).toBe(1);

      const events = await c.query(
        `select count(*)::int as n from outbox.events where tenant_id = $1`,
        [base.tenantId],
      );
      expect(events.rows[0].n).toBe(2);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 3. Payload mismatch
  // ─────────────────────────────────────────────────────────────────────
  it("3. payload mismatch: same key + different title raises 'command_operations.payload_mismatch'", async () => {
    const base = await seedBaseFixture(pool, 's12-pmismatch');
    const rt = await seedRequestType(pool, base);
    const { input, plan } = buildInputs(base, rt, { title: 'First title' });
    const idempotencyKey = `harness:create:${randomUUID()}`;

    const first = await runRpcCapture<CreateResult>(
      pool,
      'public.create_ticket_with_automation',
      [input, plan, base.tenantId, null, idempotencyKey],
    );
    expect(first.kind).toBe('ok');

    const second = buildInputs(base, rt, {
      ticketId: input.ticket_id as string,
      title: 'DIFFERENT TITLE',
    });
    const collision = await runRpcCapture<CreateResult>(
      pool,
      'public.create_ticket_with_automation',
      [second.input, second.plan, base.tenantId, null, idempotencyKey],
    );
    expect(collision.kind).toBe('error');
    if (collision.kind !== 'error') return;
    expect(collision.error.message).toMatch(/command_operations\.payload_mismatch/);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 4. Tenant validation failure
  // ─────────────────────────────────────────────────────────────────────
  it("4. tenant validation failure: cross-tenant request_type_id raises 'request_type_not_in_tenant'", async () => {
    const tenantA = await seedBaseFixture(pool, 's12-tva');
    const tenantB = await seedBaseFixture(pool, 's12-tvb');
    const rtB = await seedRequestType(pool, tenantB);

    const { input, plan } = buildInputs(
      { tenantId: tenantA.tenantId, personId: tenantA.personId },
      rtB,
    );

    const out = await runRpcCapture<CreateResult>(pool, 'public.create_ticket_with_automation', [
      input,
      plan,
      tenantA.tenantId,
      null,
      `harness:create:${randomUUID()}`,
    ]);
    expect(out.kind).toBe('error');
    if (out.kind !== 'error') return;
    expect(out.error.message).toMatch(
      /validate_entity_in_tenant\.request_type_not_in_tenant/,
    );

    await withClient(pool, async (c) => {
      const tickets = await c.query(
        `select count(*)::int as n from public.tickets where tenant_id = $1`,
        [tenantA.tenantId],
      );
      expect(tickets.rows[0].n).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 5. Semantic mismatch (no concurrent override edit)
  // ─────────────────────────────────────────────────────────────────────
  it("5. semantic mismatch: TS plan says workflow=null but PG derives a real id → 'automation_plan.semantic_mismatch'", async () => {
    const base = await seedBaseFixture(pool, 's12-semantic');
    const rt = await seedRequestType(pool, base);
    const { input, plan } = buildInputs(base, rt, { workflowId: null });

    const out = await runRpcCapture<CreateResult>(pool, 'public.create_ticket_with_automation', [
      input,
      plan,
      base.tenantId,
      null,
      `harness:create:${randomUUID()}`,
    ]);
    expect(out.kind).toBe('error');
    if (out.kind !== 'error') return;
    expect(out.error.message).toMatch(/automation_plan\.semantic_mismatch/);

    await withClient(pool, async (c) => {
      const tickets = await c.query(
        `select count(*)::int as n from public.tickets where tenant_id = $1`,
        [base.tenantId],
      );
      expect(tickets.rows[0].n).toBe(0);
    });
  });
});

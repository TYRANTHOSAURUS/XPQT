/**
 * B.2.A.Step12 concurrency probe — create_ticket_with_automation (§3.11).
 *
 * Spec ref: docs/follow-ups/b2-survey-and-design.md §3.11 (lines 2793-3034).
 * Migrations:
 *   - supabase/migrations/00349_create_ticket_with_automation_rpc.sql (initial)
 *   - supabase/migrations/00350_create_ticket_with_automation_v2.sql
 *     (F-CRIT-1 actor users.id resolve + F-CRIT-2 force_workflow_definition_id)
 *
 * Harness pattern mirrors update_entity_sla.spec.ts (00328-00330) +
 * transition_entity_status.spec.ts (00323).
 *
 * Scenarios (all against live local Supabase):
 *   1. Happy path no-approval — ticket created with sla_id + workflow_id;
 *      outbox events emitted; follow_ups includes both.
 *   2. Idempotent replay — same key + same payload returns cached;
 *      one tickets row, one activity, one event-pair.
 *   3. Payload mismatch — same key + different payload → 'command_operations.payload_mismatch'.
 *   4. Tenant validation failure — cross-tenant request_type_id → 'request_type_not_in_tenant'.
 *   5. Semantic mismatch — TS plan claims workflow=null but PG derives a real
 *      workflow id from the request_type default → 'automation_plan.semantic_mismatch'.
 *
 *   F-CRIT-1 review remediation:
 *   6. Happy path WITH a real authenticated actor (auth_uid) — exercises the
 *      auth_uid → users.id resolution in step 9, asserts domain_events.actor_user_id
 *      is populated with users.id (NOT auth_uid) without 23503.
 *
 *   F-IMP-2 review remediation:
 *   7. Deterministic ticket_id — replay with SAME idempotency_key + SAME payload
 *      yields identical ticket id matching uuidv5(idempotency_key, NAMESPACE);
 *      only one tickets row exists.
 *
 *   F-IMP-3 review remediation:
 *   8. Concurrent override edit (v10 / C4) — stale plan pins workflow=X;
 *      admin edits the scope_override row at T+1 to workflow=Y; RPC re-derives
 *      Y, commits with workflow_id=Y, writes the breadcrumb activity row.
 *
 *   F-IMP-4 review remediation:
 *   9. Approval branch — requires_approval=true → status='awaiting_approval' /
 *      category='pending_approval'; approvals row inserted; 2 ticket_activities;
 *      2 domain_events; NO sla.timer_recompute_required / workflow.start_required
 *      outbox emits.
 *
 *   F-IMP-5 review remediation:
 *  10. Routing decision happy path — plan.routing_decision (team) → routing_decisions
 *      row inserted with chosen_by/chosen_team_id + tickets.assigned_team_id mirrors.
 *  11. Routing skipped when caller provides assignee — assigned_team_id in input
 *      bypasses the routing branch entirely → no routing_decisions row.
 *
 *   F-CRIT-2 review remediation:
 *  12. Force workflow override — force_workflow_definition_id != request_type
 *      default → tickets.workflow_id = forced; workflow.start_required emit
 *      carries forced id; workflow_forced_by_caller breadcrumb activity row.
 *
 *   codex-S12-I1 (v3) review remediation:
 *  13. Concurrent-edit narrowing — unrelated override row edit post-_resolution_at
 *      DOES NOT mask a stale plan elsewhere. Seed override A (winning, tenant)
 *      + B (unrelated, space_group). TS plan is stale (claims workflow=X but
 *      A pins Y). Touch B's updated_at to T+1. Assert: RPC raises
 *      'automation_plan.semantic_mismatch' (B's edit is unrelated, A is the
 *      resolver winner and was NOT edited).
 *
 *   codex-S12-I2 (00352 v2) review remediation:
 *  14. Persisted started_at — call start_sla_timers RPC directly with an
 *      explicit p_started_at; assert sla_timers.started_at matches the
 *      passed value (NOT now() at INSERT time). Defends against worker
 *      lag skewing at-risk percent (sla.service.ts:523).
 */

import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  buildCreateTicketId,
  buildCreateTicketIdempotencyKey,
} from '@prequest/shared';
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
  approverPersonId?: string | null;
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
  base: { tenantId: string; approverPersonId?: string },
  opts: {
    withConfig?: boolean;
    requiresApproval?: boolean;
  } = {},
): Promise<SeededRequestType> {
  const requestTypeId = randomUUID();
  const withConfig = opts.withConfig !== false;
  const workflowDefinitionId = withConfig ? randomUUID() : null;
  const slaPolicyId = withConfig ? randomUUID() : null;
  const requiresApproval = opts.requiresApproval === true;
  const approverPersonId = requiresApproval ? base.approverPersonId ?? null : null;

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
           values ($1, $2, 'Concurrency Workflow', 'case', 1, 'published', $3::jsonb)`,
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
            workflow_definition_id, sla_policy_id, approval_approver_person_id)
         values ($1, $2, 'Concurrency Request Type', true, $3, $4, $5, $6)`,
        [
          requestTypeId,
          base.tenantId,
          requiresApproval,
          workflowDefinitionId,
          slaPolicyId,
          approverPersonId,
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
        await c.query('delete from public.request_type_scope_overrides where tenant_id = $1', [
          base.tenantId,
        ]);
        await c.query('delete from public.space_groups where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.request_types where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.users where tenant_id = $1', [base.tenantId]);
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

  return { requestTypeId, workflowDefinitionId, slaPolicyId, approverPersonId };
}

/**
 * Seed a second, alternate workflow_definition for this tenant. Used by
 * the force-workflow + concurrent-override scenarios so the test asserts
 * that the chosen workflow_id is the OVERRIDDEN value, not the request_type
 * default.
 */
async function seedExtraWorkflow(
  pool: Pool,
  tenantId: string,
  label = 'Alt Workflow',
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `insert into public.workflow_definitions
       (id, tenant_id, name, entity_type, version, status, graph_definition)
     values ($1, $2, $3, 'case', 1, 'published', '{"nodes":[{"id":"trigger-1","type":"trigger"}],"edges":[]}'::jsonb)`,
    [id, tenantId, label],
  );
  return id;
}

/**
 * Seed a public.users row linked to a person + an explicit auth_uid.
 * Used by the F-CRIT-1 actor scenario to assert that the RPC resolves
 * auth_uid → users.id when writing domain_events.actor_user_id.
 */
async function seedAuthUser(
  pool: Pool,
  tenantId: string,
  personId: string,
): Promise<{ userId: string; authUid: string }> {
  const userId = randomUUID();
  const authUid = randomUUID();
  await pool.query(
    `insert into public.users
       (id, tenant_id, person_id, auth_uid, email, status)
     values ($1, $2, $3, $4, $5, 'active')`,
    [userId, tenantId, personId, authUid, `actor-${userId.slice(0, 8)}@concurrency.test`],
  );
  return { userId, authUid };
}

/**
 * Seed a tenant-scope `request_type_scope_overrides` row that pins a
 * specific workflow_definition_id. Used by the v10/C4 concurrent-edit
 * scenario.
 */
async function seedScopeOverride(
  pool: Pool,
  tenantId: string,
  requestTypeId: string,
  workflowDefinitionId: string,
): Promise<{ overrideId: string }> {
  const overrideId = randomUUID();
  await pool.query(
    `insert into public.request_type_scope_overrides
       (id, tenant_id, request_type_id, scope_kind, active, workflow_definition_id)
     values ($1, $2, $3, 'tenant', true, $4)`,
    [overrideId, tenantId, requestTypeId, workflowDefinitionId],
  );
  return { overrideId };
}

/**
 * Seed an UNRELATED `request_type_scope_overrides` row scoped to a freshly-
 * created `space_group` (different scope from the tenant-level override that
 * the v3 / codex-S12-I1 scenario uses for the resolver winner). Used to
 * verify the concurrent-edit gate ignores edits on unrelated rows.
 */
async function seedUnrelatedSpaceGroupOverride(
  pool: Pool,
  tenantId: string,
  requestTypeId: string,
  workflowDefinitionId: string,
): Promise<{ overrideId: string; spaceGroupId: string }> {
  const spaceGroupId = randomUUID();
  const overrideId = randomUUID();
  await pool.query(
    `insert into public.space_groups (id, tenant_id, name)
     values ($1, $2, $3)`,
    [spaceGroupId, tenantId, `Unrelated-${spaceGroupId.slice(0, 8)}`],
  );
  await pool.query(
    `insert into public.request_type_scope_overrides
       (id, tenant_id, request_type_id, scope_kind, space_group_id, active, workflow_definition_id)
     values ($1, $2, $3, 'space_group', $4, true, $5)`,
    [overrideId, tenantId, requestTypeId, spaceGroupId, workflowDefinitionId],
  );
  return { overrideId, spaceGroupId };
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
    scopeOverrideId?: string | null;
    routingDecision?: Record<string, unknown> | null;
    routingTrace?: Record<string, unknown> | null;
    assignedTeamId?: string;
    forceWorkflowDefinitionId?: string;
  } = {},
): { input: Record<string, unknown>; plan: Record<string, unknown> } {
  const ticketId = overrides.ticketId ?? randomUUID();
  const input: Record<string, unknown> = {
    ticket_id: ticketId,
    request_type_id: rt.requestTypeId,
    requester_person_id: base.personId,
    title: overrides.title ?? 'Concurrency harness ticket',
    description: 'Created via harness',
  };
  if (overrides.assignedTeamId !== undefined) {
    input.assigned_team_id = overrides.assignedTeamId;
  }
  if (overrides.forceWorkflowDefinitionId !== undefined) {
    input.force_workflow_definition_id = overrides.forceWorkflowDefinitionId;
  }
  const plan: Record<string, unknown> = {
    effective_location_id: null,
    scope_override_id:
      overrides.scopeOverrideId === undefined ? null : overrides.scopeOverrideId,
    effective_workflow_definition_id:
      overrides.workflowId === undefined ? rt.workflowDefinitionId : overrides.workflowId,
    effective_sla_policy_id:
      overrides.slaId === undefined ? rt.slaPolicyId : overrides.slaId,
    routing_decision: overrides.routingDecision ?? null,
    routing_trace: overrides.routingTrace ?? null,
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
    await flushAllFixtures(pool);
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

  // ─────────────────────────────────────────────────────────────────────
  // 6. F-CRIT-1 — actor auth_uid resolves to users.id (no 23503)
  // ─────────────────────────────────────────────────────────────────────
  it('6. authenticated actor: auth_uid → users.id resolution writes domain_events.actor_user_id without FK violation', async () => {
    const base = await seedBaseFixture(pool, 's12-actor');
    const rt = await seedRequestType(pool, base);
    const { userId, authUid } = await seedAuthUser(pool, base.tenantId, base.personId);
    const { input, plan } = buildInputs(base, rt);
    const idempotencyKey = `harness:create:${randomUUID()}`;

    const out = await runRpcCapture<CreateResult>(pool, 'public.create_ticket_with_automation', [
      input,
      plan,
      base.tenantId,
      authUid, // ← auth_uid, NOT users.id (this is the F-CRIT-1 input that broke 00349)
      idempotencyKey,
    ]);

    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.value.ticket.id).toBe(input.ticket_id);

    // domain_events.actor_user_id should hold users.id (PK), NOT auth_uid.
    await withClient(pool, async (c) => {
      const evts = await c.query(
        `select actor_user_id
           from public.domain_events
          where tenant_id = $1 and entity_id = $2
            and event_type = 'ticket_created'`,
        [base.tenantId, input.ticket_id],
      );
      expect(evts.rows).toHaveLength(1);
      expect(evts.rows[0].actor_user_id).toBe(userId);
      expect(evts.rows[0].actor_user_id).not.toBe(authUid);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 7. F-IMP-2 — Deterministic ticket_id from idempotency_key
  // ─────────────────────────────────────────────────────────────────────
  it('7. deterministic ticket_id: replay with same key + same payload yields uuidv5(key)', async () => {
    const base = await seedBaseFixture(pool, 's12-deterministic');
    const rt = await seedRequestType(pool, base);

    // Mirror the TS service: idempotencyKey is built from
    // (actor, clientRequestId); ticket_id is uuidv5 of that key.
    const actorAuthUid = randomUUID();
    const clientRequestId = randomUUID();
    const idempotencyKey = buildCreateTicketIdempotencyKey(actorAuthUid, clientRequestId);
    const expectedTicketId = buildCreateTicketId(idempotencyKey);

    const { input, plan } = buildInputs(base, rt, { ticketId: expectedTicketId });

    const first = await runRpcCapture<CreateResult>(
      pool,
      'public.create_ticket_with_automation',
      [input, plan, base.tenantId, null, idempotencyKey],
    );
    expect(first.kind).toBe('ok');
    if (first.kind !== 'ok') return;
    expect(first.value.ticket.id).toBe(expectedTicketId);

    const second = await runRpcCapture<CreateResult>(
      pool,
      'public.create_ticket_with_automation',
      [input, plan, base.tenantId, null, idempotencyKey],
    );
    expect(second.kind).toBe('ok');
    if (second.kind !== 'ok') return;
    expect(second.value.ticket.id).toBe(expectedTicketId);

    await withClient(pool, async (c) => {
      const r = await c.query(
        `select count(*)::int as n from public.tickets where tenant_id = $1`,
        [base.tenantId],
      );
      expect(r.rows[0].n).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 8. F-IMP-3 — Concurrent override edit (v10 / C4) — load-bearing
  // ─────────────────────────────────────────────────────────────────────
  it('8. concurrent override edit: stale plan rejected by gate normally; PG-derived value wins when override updated_at > _resolution_at', async () => {
    const base = await seedBaseFixture(pool, 's12-c4');
    const rt = await seedRequestType(pool, base);
    const altWorkflowId = await seedExtraWorkflow(pool, base.tenantId, 'Override target');

    // T0: build TS-equivalent plan pinning effective_workflow=X (rt default).
    const stalePlan = buildInputs(base, rt, {
      // Pin the plan to the rt default (X). _resolution_at is T0.
      resolutionAt: new Date().toISOString(),
    });

    // T0+1: admin creates a tenant-scope override pinning workflow=Y.
    //       updated_at is now() > _resolution_at.
    await new Promise((res) => setTimeout(res, 50));
    await seedScopeOverride(pool, base.tenantId, rt.requestTypeId, altWorkflowId);

    // Call RPC with the stale plan — PG derives Y; plan still says X;
    // v10/C4 says: updated_at > _resolution_at → PG wins, no rejection.
    const out = await runRpcCapture<CreateResult>(pool, 'public.create_ticket_with_automation', [
      stalePlan.input,
      stalePlan.plan,
      base.tenantId,
      null,
      `harness:create:${randomUUID()}`,
    ]);

    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.value.ticket.workflow_id).toBe(altWorkflowId); // PG-derived Y, not the stale X
    expect(out.value.concurrent_override_edit).toBe(true);

    await withClient(pool, async (c) => {
      const acts = await c.query(
        `select metadata
           from public.ticket_activities
          where tenant_id = $1 and ticket_id = $2
            and metadata->>'event' = 'automation_plan_overridden_by_concurrent_edit'`,
        [base.tenantId, stalePlan.input.ticket_id],
      );
      expect(acts.rows).toHaveLength(1);
      expect(acts.rows[0].metadata.plan_workflow_definition_id).toBe(
        rt.workflowDefinitionId,
      );
      expect(acts.rows[0].metadata.derived_workflow_definition_id).toBe(altWorkflowId);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 9. F-IMP-4 — Approval branch defers SLA + workflow
  // ─────────────────────────────────────────────────────────────────────
  it('9. approval branch: status=awaiting_approval; approvals row; 2 activities + 2 domain_events; NO sla/workflow outbox emits', async () => {
    const base = await seedBaseFixture(pool, 's12-approval');
    const rt = await seedRequestType(pool, base, { requiresApproval: true });
    const { input, plan } = buildInputs(base, rt);

    const out = await runRpcCapture<CreateResult>(pool, 'public.create_ticket_with_automation', [
      input,
      plan,
      base.tenantId,
      null,
      `harness:create:${randomUUID()}`,
    ]);

    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.value.ticket.status).toBe('awaiting_approval');
    expect(out.value.ticket.status_category).toBe('pending_approval');
    // No timer/workflow emits in the approval branch.
    expect(out.value.follow_ups).not.toContain('sla.timer_recompute_required');
    expect(out.value.follow_ups).not.toContain('workflow.start_required');
    expect(out.value.follow_ups).toContain('approval');

    await withClient(pool, async (c) => {
      const approvals = await c.query(
        `select target_entity_type, status, approver_person_id
           from public.approvals
          where tenant_id = $1 and target_entity_id = $2`,
        [base.tenantId, input.ticket_id],
      );
      expect(approvals.rows).toHaveLength(1);
      expect(approvals.rows[0].target_entity_type).toBe('ticket');
      expect(approvals.rows[0].status).toBe('pending');
      expect(approvals.rows[0].approver_person_id).toBe(base.approverPersonId);

      const acts = await c.query(
        `select metadata->>'event' as event
           from public.ticket_activities
          where tenant_id = $1 and ticket_id = $2
          order by created_at`,
        [base.tenantId, input.ticket_id],
      );
      expect(acts.rows.map((r) => r.event)).toEqual(['ticket_created', 'approval_requested']);

      const evts = await c.query(
        `select event_type
           from public.domain_events
          where tenant_id = $1 and entity_id = $2
          order by created_at`,
        [base.tenantId, input.ticket_id],
      );
      expect(evts.rows.map((r) => r.event_type)).toEqual([
        'ticket_created',
        'approval_requested',
      ]);

      const outbox = await c.query(
        `select count(*)::int as n
           from outbox.events
          where tenant_id = $1 and aggregate_id = $2`,
        [base.tenantId, input.ticket_id],
      );
      expect(outbox.rows[0].n).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 10. F-IMP-5 — Routing decision happy path
  // ─────────────────────────────────────────────────────────────────────
  it('10. routing decision: plan.routing_decision (team) → routing_decisions row + tickets.assigned_team_id', async () => {
    const base = await seedBaseFixture(pool, 's12-routing');
    const rt = await seedRequestType(pool, base);

    const routingDecision = {
      chosen_by: 'rule',
      strategy: 'team',
      team_id: base.teamId,
      user_id: null,
      vendor_id: null,
      rule_id: null,
    };
    const routingTrace = {
      input: {
        request_type_id: rt.requestTypeId,
        location_id: null,
        asset_id: null,
      },
      trace: [{ step: 'request_type_default_team', matched: true }],
    };
    const { input, plan } = buildInputs(base, rt, {
      routingDecision,
      routingTrace,
    });

    const out = await runRpcCapture<CreateResult>(pool, 'public.create_ticket_with_automation', [
      input,
      plan,
      base.tenantId,
      null,
      `harness:create:${randomUUID()}`,
    ]);

    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.value.ticket.assigned_team_id).toBe(base.teamId);

    await withClient(pool, async (c) => {
      const rd = await c.query(
        `select chosen_team_id, chosen_by, strategy
           from public.routing_decisions
          where tenant_id = $1 and ticket_id = $2`,
        [base.tenantId, input.ticket_id],
      );
      expect(rd.rows).toHaveLength(1);
      expect(rd.rows[0].chosen_team_id).toBe(base.teamId);
      expect(rd.rows[0].chosen_by).toBe('rule');
      expect(rd.rows[0].strategy).toBe('team');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 11. F-IMP-5 sibling — caller assignee bypasses routing
  // ─────────────────────────────────────────────────────────────────────
  it('11. caller assignee bypasses routing: assigned_team_id in input → no routing_decisions row', async () => {
    const base = await seedBaseFixture(pool, 's12-routing-skip');
    const rt = await seedRequestType(pool, base);

    const altTeamId = randomUUID();
    await pool.query(
      `insert into public.teams (id, tenant_id, name, active)
       values ($1, $2, 'Other Team', true)`,
      [altTeamId, base.tenantId],
    );

    // Routing decision is present in the plan — but caller assignee wins
    // and the gate at step 8 skips routing INSERT.
    const routingDecision = {
      chosen_by: 'rule',
      strategy: 'team',
      team_id: altTeamId, // would be picked if routing fired
      user_id: null,
      vendor_id: null,
      rule_id: null,
    };
    const { input, plan } = buildInputs(base, rt, {
      assignedTeamId: base.teamId, // caller forces a different team
      routingDecision,
      routingTrace: {
        input: {
          request_type_id: rt.requestTypeId,
          location_id: null,
          asset_id: null,
        },
        trace: [],
      },
    });

    const out = await runRpcCapture<CreateResult>(pool, 'public.create_ticket_with_automation', [
      input,
      plan,
      base.tenantId,
      null,
      `harness:create:${randomUUID()}`,
    ]);

    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.value.ticket.assigned_team_id).toBe(base.teamId);

    await withClient(pool, async (c) => {
      const rd = await c.query(
        `select count(*)::int as n
           from public.routing_decisions
          where tenant_id = $1 and ticket_id = $2`,
        [base.tenantId, input.ticket_id],
      );
      expect(rd.rows[0].n).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 12. F-CRIT-2 — Force workflow override path
  // ─────────────────────────────────────────────────────────────────────
  it('12. force_workflow_definition_id: bypasses semantic gate, writes forced id, breadcrumb + outbox carry forced value', async () => {
    const base = await seedBaseFixture(pool, 's12-force-wf');
    const rt = await seedRequestType(pool, base);
    const forcedWorkflowId = await seedExtraWorkflow(pool, base.tenantId, 'Webhook override target');

    // Plan still pins the rt default workflow — but force overrides it
    // post-gate. (The semantic gate is skipped for workflow under force.)
    const { input, plan } = buildInputs(base, rt, {
      forceWorkflowDefinitionId: forcedWorkflowId,
    });

    const out = await runRpcCapture<CreateResult>(pool, 'public.create_ticket_with_automation', [
      input,
      plan,
      base.tenantId,
      null,
      `harness:create:${randomUUID()}`,
    ]);

    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.value.ticket.workflow_id).toBe(forcedWorkflowId);
    expect(out.value.ticket.workflow_id).not.toBe(rt.workflowDefinitionId);

    await withClient(pool, async (c) => {
      // outbox.events.workflow.start_required payload carries forced id
      const evts = await c.query(
        `select payload
           from outbox.events
          where tenant_id = $1 and aggregate_id = $2
            and event_type = 'workflow.start_required'`,
        [base.tenantId, input.ticket_id],
      );
      expect(evts.rows).toHaveLength(1);
      expect(evts.rows[0].payload.workflow_definition_id).toBe(forcedWorkflowId);

      // breadcrumb activity row records both caller value + rt default
      const acts = await c.query(
        `select metadata
           from public.ticket_activities
          where tenant_id = $1 and ticket_id = $2
            and metadata->>'event' = 'workflow_forced_by_caller'`,
        [base.tenantId, input.ticket_id],
      );
      expect(acts.rows).toHaveLength(1);
      expect(acts.rows[0].metadata.caller_value).toBe(forcedWorkflowId);
      expect(acts.rows[0].metadata.request_type_default).toBe(rt.workflowDefinitionId);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 13. codex-S12-I1 (00351 v3) — Concurrent-edit narrowing: unrelated
  //     override edit must NOT mask a stale plan elsewhere.
  // ─────────────────────────────────────────────────────────────────────
  it('13. concurrent-edit narrowing: edit on unrelated space_group override does not mask stale plan on the (resolver-winner) tenant override', async () => {
    const base = await seedBaseFixture(pool, 's12-c4-narrow');
    const rt = await seedRequestType(pool, base);
    const altWorkflowId = await seedExtraWorkflow(pool, base.tenantId, 'C4-narrow target');

    // T-2: seed the resolver-winner tenant-scope override pinning Y.
    //      Its updated_at = wall-clock now() at insert time (no trigger
    //      bypass needed; we'll choose _resolution_at AFTER this insert
    //      so the winner row is OLDER than the stale plan).
    await seedScopeOverride(pool, base.tenantId, rt.requestTypeId, altWorkflowId);

    // T-1: seed an UNRELATED space_group override (different scope —
    //      space_group, not tenant). Its updated_at also = wall-clock now()
    //      at insert.
    const unrelated = await seedUnrelatedSpaceGroupOverride(
      pool,
      base.tenantId,
      rt.requestTypeId,
      altWorkflowId,
    );

    // Wait so wall-clock advances past both inserts before we pin t0.
    await new Promise((res) => setTimeout(res, 50));

    // T0: TS "would have" resolved at this instant. Both overrides above
    //     have updated_at < T0 — TS should have seen them. The plan we
    //     build below is stale on purpose (claims rt-default workflow X).
    const t0 = new Date().toISOString();

    await new Promise((res) => setTimeout(res, 50));

    // T+1: admin edits the UNRELATED space_group override row.
    //       Pre-v3 this would set v_concurrent_override_edit=true and PG
    //       would silently use Y. Post-v3 it does NOT — the resolver
    //       winner (tenant override) was unchanged → stale plan rejected.
    await pool.query(
      `update public.request_type_scope_overrides
         set inherit_to_descendants = not inherit_to_descendants
       where id = $1`,
      [unrelated.overrideId],
    );

    // TS plan still claims workflow = rt default (X). PG derives Y from the
    // tenant override (resolver winner, updated_at < T0). Mismatch + NOT
    // a concurrent edit on the winner → must raise semantic_mismatch.
    const stalePlan = buildInputs(base, rt, { resolutionAt: t0 });

    const out = await runRpcCapture<CreateResult>(pool, 'public.create_ticket_with_automation', [
      stalePlan.input,
      stalePlan.plan,
      base.tenantId,
      null,
      `harness:create:${randomUUID()}`,
    ]);

    expect(out.kind).toBe('error');
    if (out.kind !== 'error') return;
    expect(out.error.message).toMatch(/automation_plan\.semantic_mismatch/);

    // Defense-in-depth: no tickets row written (RPC raised mid-transaction).
    await withClient(pool, async (c) => {
      const r = await c.query(
        `select count(*)::int as n
           from public.tickets
          where tenant_id = $1 and id = $2`,
        [base.tenantId, stalePlan.input.ticket_id],
      );
      expect(r.rows[0].n).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 14. codex-S12-I2 (00352 v2) — start_sla_timers honours p_started_at.
  // ─────────────────────────────────────────────────────────────────────
  it('14. start_sla_timers v2: persists caller p_started_at (not now() at INSERT time)', async () => {
    const base = await seedBaseFixture(pool, 's12-sla-started-at');
    const rt = await seedRequestType(pool, base);
    if (!rt.slaPolicyId) throw new Error('seedRequestType must seed an SLA policy here');

    // Pre-mint a ticket (start_sla_timers requires the ticket row to exist;
    // it's enforced by step 2 of 00352).
    const ticketId = randomUUID();
    await pool.query(
      `insert into public.tickets
         (id, tenant_id, ticket_type_id, title, requester_person_id, sla_id,
          status, status_category, priority, source_channel, interaction_mode)
       values ($1, $2, $3, $4, $5, $6, 'new', 'new', 'medium', 'portal', 'internal')`,
      [ticketId, base.tenantId, rt.requestTypeId, 'Started-at harness', base.personId, rt.slaPolicyId],
    );

    // Caller picks a started_at that is meaningfully in the past — the
    // canonical "post-create" path uses ticket.created_at. The bug would
    // re-stamp this to now() (much later in real outbox runs).
    const callerStartedAt = new Date(Date.now() - 5 * 60_000); // 5min ago
    const dueAt = new Date(callerStartedAt.getTime() + 60 * 60_000); // +1h

    const out = await runRpcCapture<{
      ticket_id: string;
      sla_policy_id: string;
      timers_inserted: number;
    }>(pool, 'public.start_sla_timers', [
      base.tenantId,
      ticketId,
      rt.slaPolicyId,
      JSON.stringify([
        {
          timer_type: 'response',
          target_minutes: 60,
          due_at: dueAt.toISOString(),
          business_hours_calendar_id: null,
        },
      ]),
      callerStartedAt.toISOString(),
    ]);

    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.value.timers_inserted).toBe(1);

    // The persisted row's started_at must equal the value we passed in —
    // NOT the wall-clock at INSERT time.
    await withClient(pool, async (c) => {
      const r = await c.query(
        `select started_at, due_at
           from public.sla_timers
          where tenant_id = $1 and ticket_id = $2 and timer_type = 'response'`,
        [base.tenantId, ticketId],
      );
      expect(r.rows).toHaveLength(1);
      const persistedStartedAt = new Date(r.rows[0].started_at as string).getTime();
      const expectedStartedAt = callerStartedAt.getTime();
      // Same instant (timestamptz round-trip is exact to microseconds; allow
      // 5ms slack for driver / postgres serialization just in case).
      expect(Math.abs(persistedStartedAt - expectedStartedAt)).toBeLessThan(5);
      // And the due_at we passed survived unchanged.
      const persistedDueAt = new Date(r.rows[0].due_at as string).getTime();
      expect(Math.abs(persistedDueAt - dueAt.getTime())).toBeLessThan(5);
    });

    // Register cleanup so the sla_timers row + ticket get dropped.
    registerCleanup(async () => {
      await pool.query('delete from public.sla_timers where tenant_id = $1 and ticket_id = $2', [
        base.tenantId,
        ticketId,
      ]);
      await pool.query('delete from public.tickets where tenant_id = $1 and id = $2', [
        base.tenantId,
        ticketId,
      ]);
    });
  });
});

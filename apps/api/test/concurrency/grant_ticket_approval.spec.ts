/**
 * B.2.A.Step10 reland concurrency probe — grant_ticket_approval (§3.5).
 *
 * Spec ref: docs/follow-ups/b2-survey-and-design.md §3.5 (lines 2238-2350).
 * Migration: supabase/migrations/00356_grant_ticket_approval_rpc.sql.
 *
 * Harness pattern mirrors reclassify_ticket.spec.ts (00354) and
 * create_ticket_with_automation.spec.ts (00349-00351).
 *
 * Scenarios (all against live local Supabase):
 *
 *   1. Single-approver happy path (approved + ticket carrying both
 *      sla_id + workflow_id): asserts tickets flipped to status='new' /
 *      status_category='new'; three outbox events emitted
 *      (sla.timer_recompute_required, routing.evaluation_required,
 *      workflow.start_required); approval row CAS-updated; ticket_activities
 *      + domain_events rows written. Result kind='resolved'.
 *
 *   2. Single-approver rejection: asserts tickets flipped to
 *      status='rejected' / status_category='closed' / closed_at IS NOT NULL;
 *      NO outbox events; result kind='resolved'.
 *
 *   3. Idempotent replay — same key + same payload returns cached_result;
 *      one approval-row update, one activity, three outbox events total
 *      (i.e. no double-emit).
 *
 *   4. Already responded — approval already in status='approved' when
 *      the RPC is called → kind='already_responded'; no state changes.
 *
 *   5. Approval not found — unknown approval_id → RPC raises
 *      `grant_ticket_approval.approval_not_found`.
 *
 *   6. Tenant mismatch — pass a different tenant_id than the approval row's.
 *      The approval lookup includes `and tenant_id = p_tenant_id` so the
 *      FOR UPDATE select misses → raises `grant_ticket_approval.approval_not_found`
 *      (defense-in-depth — the TS layer holds the tenant invariant; this
 *      is the RPC's symmetric guard).
 *
 *   7. Multi-approver parallel group: three approvers in the same
 *      parallel_group. First two grants → kind='partial_approved'; third
 *      grant → kind='resolved' + full automation emits.
 *
 *   8. DRIFT 1 — delegated approval blocks chain count: in a 3-member
 *      group, approver A grants, approver B's row is marked status='delegated'
 *      (a delegate row exists separately and is still pending), approver C
 *      grants. Total non-terminal set per the new enum gap fix is
 *      {pending, delegated} → C's grant should STILL be partial because
 *      B's row is delegated. Asserts kind='partial_approved' on C's grant
 *      (was kind='resolved' under the buggy pre-reland enum filter).
 *
 *   9. DRIFT 2 — authenticated actor: pass a real auth_uid that maps to
 *      a users row. Asserts domain_events.actor_user_id = users.id (NOT
 *      auth_uid). No 23503.
 *
 *  10. DRIFT 3 — outbox payloads carry started_at = now(): probes the
 *      emitted sla.timer_recompute_required event's payload.started_at
 *      exists, is a valid timestamp, and is approximately wall-clock at
 *      grant time.
 *
 *  11. Ticket with NULL sla_id + NULL workflow_id: grant the approval.
 *      Tickets flips to 'new' BUT only routing.evaluation_required is
 *      emitted (sla / workflow emits gated on the FK presence).
 *
 *  12. End-to-end handler chain: commit the RPC, manually apply the
 *      handler SQL paths against the real DB (start_sla_timers RPC +
 *      workflow_instances INSERT + routing_decisions INSERT) to assert
 *      the post-cutover flow works end-to-end. Substitute defense for
 *      the smoke gate gap on outbox-worker boot.
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

interface GrantResult {
  kind: 'non_ticket_approved' | 'already_responded' | 'partial_approved' | 'resolved';
  approval_id: string;
  ticket_id?: string;
  target_entity_type?: string;
  prior_status?: string;
  final_decision?: 'approved' | 'rejected';
  ticket_status?: string | null;
  ticket_status_category?: string;
  sla_started?: boolean;
  workflow_started?: boolean;
  routing_evaluation_emitted?: boolean;
  remaining?: number;
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
  const label = opts.label ?? 'Grant RT';

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
           values ($1, $2, $3, 'case', 1, 'published', $4::jsonb)`,
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
         values ($1, $2, $3, true, true, $4, $5)`,
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
 * Seed a pending_approval-status ticket on a specific request type with
 * optional pre-stamped workflow_id + sla_id. The RPC reads
 * (workflow_id, sla_id, location_id, asset_id, status_category) — we set
 * them up so each scenario can pin the OLD effective values precisely.
 */
async function seedPendingApprovalTicket(
  pool: Pool,
  base: { tenantId: string; personId: string },
  opts: {
    requestTypeId: string;
    workflowId?: string | null;
    slaId?: string | null;
  },
): Promise<{ ticketId: string }> {
  const ticketId = randomUUID();
  await pool.query(
    `insert into public.tickets
       (id, tenant_id, ticket_type_id, title, requester_person_id,
        workflow_id, sla_id,
        status, status_category, priority, source_channel, interaction_mode)
     values ($1, $2, $3, 'Concurrency grant ticket', $4,
             $5, $6,
             'awaiting_approval', 'pending_approval', 'medium', 'portal', 'internal')`,
    [
      ticketId,
      base.tenantId,
      opts.requestTypeId,
      base.personId,
      opts.workflowId ?? null,
      opts.slaId ?? null,
    ],
  );
  return { ticketId };
}

/**
 * Seed a fresh approver person for a parallel group. The schema has a
 * partial unique index `uq_approvals_pending_dedup (target_entity_id,
 * approver_person_id) WHERE status = 'pending'` so each pending row on
 * the same ticket needs a distinct approver.
 */
async function seedApproverPerson(
  pool: Pool,
  tenantId: string,
  seed: string,
): Promise<{ personId: string }> {
  const personId = randomUUID();
  await pool.query(
    `insert into public.persons (id, tenant_id, type, first_name, last_name, email)
     values ($1, $2, 'employee', 'Approver', $3, $4)`,
    [personId, tenantId, seed, `approver-${seed}-${personId.slice(0, 8)}@concurrency.test`],
  );
  return { personId };
}

/**
 * Seed an approval row against a ticket. Returns the approval id.
 * If `approverPersonId` is provided, uses that; otherwise defaults to
 * `base.approverPersonId` (for single-approver scenarios).
 */
async function seedApproval(
  pool: Pool,
  base: { tenantId: string; approverPersonId: string },
  opts: {
    ticketId: string;
    status?: 'pending' | 'delegated' | 'approved' | 'rejected';
    parallelGroup?: string | null;
    approvalChainId?: string | null;
    approverPersonId?: string;
  },
): Promise<{ approvalId: string }> {
  const approvalId = randomUUID();
  await pool.query(
    `insert into public.approvals
       (id, tenant_id, target_entity_type, target_entity_id,
        approver_person_id, status, parallel_group, approval_chain_id)
     values ($1, $2, 'ticket', $3, $4, $5, $6, $7)`,
    [
      approvalId,
      base.tenantId,
      opts.ticketId,
      opts.approverPersonId ?? base.approverPersonId,
      opts.status ?? 'pending',
      opts.parallelGroup ?? null,
      opts.approvalChainId ?? null,
    ],
  );
  return { approvalId };
}

/**
 * Seed a public.users row linked to a person + an explicit auth_uid.
 * Used by the DRIFT 2 actor scenario to assert auth_uid → users.id
 * resolution. Mirrors seedAuthUser in create_ticket_with_automation.spec.ts.
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
    [userId, tenantId, personId, authUid, `grant-actor-${userId.slice(0, 8)}@concurrency.test`],
  );
  return { userId, authUid };
}

/**
 * Build an idempotency key in the same shape buildApprovalGrantIdempotencyKey
 * mints (`approval:grant:<approvalId>:<clientRequestId>`). The harness
 * mirrors the format so a replay can be tested without TS in the loop.
 */
function buildKey(approvalId: string, clientRequestId: string): string {
  return `approval:grant:${approvalId}:${clientRequestId}`;
}

/**
 * Fetch outbox events for a ticket, filtered by event_type. Returns the
 * raw rows; tests assert on payload shape.
 */
async function fetchOutboxEvents(
  pool: Pool,
  tenantId: string,
  ticketId: string,
  eventType?: string,
): Promise<Array<{ event_type: string; payload: Record<string, unknown>; idempotency_key: string }>> {
  const rows = eventType
    ? await pool.query(
        `select event_type, payload, idempotency_key from outbox.events
          where tenant_id = $1 and aggregate_id = $2 and event_type = $3
          order by enqueued_at`,
        [tenantId, ticketId, eventType],
      )
    : await pool.query(
        `select event_type, payload, idempotency_key from outbox.events
          where tenant_id = $1 and aggregate_id = $2
          order by enqueued_at`,
        [tenantId, ticketId],
      );
  return rows.rows;
}

describe('B.2.A.Step10 reland §3.5 — grant_ticket_approval', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = getPool();
  });

  afterAll(async () => {
    await flushAllFixtures(pool);
    await endPool();
  });

  // ─────────────────────────────────────────────────────────────────────
  // 1. Single-approver happy path — approved, ticket has both fks
  // ─────────────────────────────────────────────────────────────────────
  it('1. happy approve: ticket → new, 3 outbox events emitted, approval CAS-updated', async () => {
    const base = await seedBaseFixture(pool, 's10-happy');
    const rt = await seedRequestType(pool, base);
    const ticket = await seedPendingApprovalTicket(pool, base, {
      requestTypeId: rt.requestTypeId,
      workflowId: rt.workflowDefinitionId,
      slaId: rt.slaPolicyId,
    });
    const approval = await seedApproval(pool, base, { ticketId: ticket.ticketId });
    const key = buildKey(approval.approvalId, randomUUID());

    const out = await runRpcCapture<GrantResult>(pool, 'public.grant_ticket_approval', [
      approval.approvalId,
      base.tenantId,
      null, // p_actor_user_id (no auth_uid in this scenario; DRIFT 2 covered in s9)
      'approved',
      'looks good',
      key,
    ]);

    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.value.kind).toBe('resolved');
    expect(out.value.final_decision).toBe('approved');
    expect(out.value.ticket_status).toBe('new');
    expect(out.value.ticket_status_category).toBe('new');
    expect(out.value.sla_started).toBe(true);
    expect(out.value.workflow_started).toBe(true);
    expect(out.value.routing_evaluation_emitted).toBe(true);

    await withClient(pool, async (c) => {
      const t = await c.query(
        `select status, status_category, closed_at from public.tickets
          where tenant_id = $1 and id = $2`,
        [base.tenantId, ticket.ticketId],
      );
      expect(t.rows).toHaveLength(1);
      expect(t.rows[0].status).toBe('new');
      expect(t.rows[0].status_category).toBe('new');
      expect(t.rows[0].closed_at).toBeNull();

      const a = await c.query(
        `select status, responded_at, comments from public.approvals
          where tenant_id = $1 and id = $2`,
        [base.tenantId, approval.approvalId],
      );
      expect(a.rows[0].status).toBe('approved');
      expect(a.rows[0].responded_at).not.toBeNull();
      expect(a.rows[0].comments).toBe('looks good');

      // ticket_activities + domain_events both written.
      const act = await c.query(
        `select metadata from public.ticket_activities
          where tenant_id = $1 and ticket_id = $2 and activity_type = 'system_event'`,
        [base.tenantId, ticket.ticketId],
      );
      expect(act.rows).toHaveLength(1);
      expect(act.rows[0].metadata.event).toBe('approval_approved');

      const evts = await c.query(
        `select event_type from public.domain_events
          where tenant_id = $1 and entity_id = $2 and event_type = 'approval_approved'`,
        [base.tenantId, ticket.ticketId],
      );
      expect(evts.rows).toHaveLength(1);
    });

    // Three outbox events emitted.
    const events = await fetchOutboxEvents(pool, base.tenantId, ticket.ticketId);
    const types = events.map((e) => e.event_type).sort();
    expect(types).toEqual(
      ['routing.evaluation_required', 'sla.timer_recompute_required', 'workflow.start_required'].sort(),
    );
  });

  // ─────────────────────────────────────────────────────────────────────
  // 2. Single-approver rejection: ticket closed, NO outbox events
  // ─────────────────────────────────────────────────────────────────────
  it('2. rejection: ticket → rejected/closed, no outbox events', async () => {
    const base = await seedBaseFixture(pool, 's10-reject');
    const rt = await seedRequestType(pool, base);
    const ticket = await seedPendingApprovalTicket(pool, base, {
      requestTypeId: rt.requestTypeId,
      workflowId: rt.workflowDefinitionId,
      slaId: rt.slaPolicyId,
    });
    const approval = await seedApproval(pool, base, { ticketId: ticket.ticketId });
    const key = buildKey(approval.approvalId, randomUUID());

    const out = await runRpcCapture<GrantResult>(pool, 'public.grant_ticket_approval', [
      approval.approvalId,
      base.tenantId,
      null,
      'rejected',
      'denied',
      key,
    ]);

    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.value.kind).toBe('resolved');
    expect(out.value.final_decision).toBe('rejected');
    expect(out.value.ticket_status).toBe('rejected');
    expect(out.value.ticket_status_category).toBe('closed');
    expect(out.value.sla_started).toBe(false);
    expect(out.value.workflow_started).toBe(false);
    expect(out.value.routing_evaluation_emitted).toBe(false);

    await withClient(pool, async (c) => {
      const t = await c.query(
        `select status, status_category, closed_at from public.tickets
          where tenant_id = $1 and id = $2`,
        [base.tenantId, ticket.ticketId],
      );
      expect(t.rows[0].status).toBe('rejected');
      expect(t.rows[0].status_category).toBe('closed');
      expect(t.rows[0].closed_at).not.toBeNull();
    });

    const events = await fetchOutboxEvents(pool, base.tenantId, ticket.ticketId);
    expect(events).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 3. Idempotent replay — same key + same payload returns cached_result
  // ─────────────────────────────────────────────────────────────────────
  it('3. idempotent replay: cached_result, no double-emit', async () => {
    const base = await seedBaseFixture(pool, 's10-replay');
    const rt = await seedRequestType(pool, base);
    const ticket = await seedPendingApprovalTicket(pool, base, {
      requestTypeId: rt.requestTypeId,
      workflowId: rt.workflowDefinitionId,
      slaId: rt.slaPolicyId,
    });
    const approval = await seedApproval(pool, base, { ticketId: ticket.ticketId });
    const key = buildKey(approval.approvalId, randomUUID());

    const first = await runRpcCapture<GrantResult>(pool, 'public.grant_ticket_approval', [
      approval.approvalId,
      base.tenantId,
      null,
      'approved',
      null,
      key,
    ]);
    expect(first.kind).toBe('ok');

    const second = await runRpcCapture<GrantResult>(pool, 'public.grant_ticket_approval', [
      approval.approvalId,
      base.tenantId,
      null,
      'approved',
      null,
      key,
    ]);
    expect(second.kind).toBe('ok');
    if (second.kind !== 'ok' || first.kind !== 'ok') return;
    expect(second.value).toEqual(first.value);

    // Side-effects committed exactly once.
    const events = await fetchOutboxEvents(pool, base.tenantId, ticket.ticketId);
    expect(events).toHaveLength(3);

    await withClient(pool, async (c) => {
      const acts = await c.query(
        `select count(*)::int as n from public.ticket_activities
          where tenant_id = $1 and ticket_id = $2`,
        [base.tenantId, ticket.ticketId],
      );
      expect(acts.rows[0].n).toBe(1);

      const evts = await c.query(
        `select count(*)::int as n from public.domain_events
          where tenant_id = $1 and entity_id = $2 and event_type = 'approval_approved'`,
        [base.tenantId, ticket.ticketId],
      );
      expect(evts.rows[0].n).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 4. Already responded — approval already in 'approved' status
  // ─────────────────────────────────────────────────────────────────────
  it('4. already_responded: prior approved → no state changes, kind=already_responded', async () => {
    const base = await seedBaseFixture(pool, 's10-already');
    const rt = await seedRequestType(pool, base);
    const ticket = await seedPendingApprovalTicket(pool, base, {
      requestTypeId: rt.requestTypeId,
      workflowId: rt.workflowDefinitionId,
      slaId: rt.slaPolicyId,
    });
    // Approval row PRE-STAMPED as approved.
    const approval = await seedApproval(pool, base, {
      ticketId: ticket.ticketId,
      status: 'approved',
    });
    const key = buildKey(approval.approvalId, randomUUID());

    const out = await runRpcCapture<GrantResult>(pool, 'public.grant_ticket_approval', [
      approval.approvalId,
      base.tenantId,
      null,
      'approved',
      null,
      key,
    ]);

    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.value.kind).toBe('already_responded');
    expect(out.value.prior_status).toBe('approved');

    // Ticket unchanged.
    await withClient(pool, async (c) => {
      const t = await c.query(
        `select status_category from public.tickets where tenant_id = $1 and id = $2`,
        [base.tenantId, ticket.ticketId],
      );
      expect(t.rows[0].status_category).toBe('pending_approval');
    });

    const events = await fetchOutboxEvents(pool, base.tenantId, ticket.ticketId);
    expect(events).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 5. Approval not found
  // ─────────────────────────────────────────────────────────────────────
  it('5. approval_not_found: unknown approval_id → raises approval_not_found', async () => {
    const base = await seedBaseFixture(pool, 's10-missing');
    await seedRequestType(pool, base);
    const ghostApprovalId = randomUUID();
    const key = buildKey(ghostApprovalId, randomUUID());

    const out = await runRpcCapture<GrantResult>(pool, 'public.grant_ticket_approval', [
      ghostApprovalId,
      base.tenantId,
      null,
      'approved',
      null,
      key,
    ]);

    expect(out.kind).toBe('error');
    if (out.kind !== 'error') return;
    expect(out.error.message).toMatch(/grant_ticket_approval\.approval_not_found/);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 6. Tenant mismatch — approval row's tenant_id ≠ p_tenant_id
  // ─────────────────────────────────────────────────────────────────────
  it('6. tenant mismatch: cross-tenant lookup raises approval_not_found (RLS-shaped defense-in-depth)', async () => {
    const base = await seedBaseFixture(pool, 's10-tenant-a');
    const otherBase = await seedBaseFixture(pool, 's10-tenant-b');
    const rt = await seedRequestType(pool, base);
    const ticket = await seedPendingApprovalTicket(pool, base, {
      requestTypeId: rt.requestTypeId,
      workflowId: rt.workflowDefinitionId,
      slaId: rt.slaPolicyId,
    });
    const approval = await seedApproval(pool, base, { ticketId: ticket.ticketId });

    const out = await runRpcCapture<GrantResult>(pool, 'public.grant_ticket_approval', [
      approval.approvalId,
      otherBase.tenantId, // ← wrong tenant
      null,
      'approved',
      null,
      buildKey(approval.approvalId, randomUUID()),
    ]);

    expect(out.kind).toBe('error');
    if (out.kind !== 'error') return;
    expect(out.error.message).toMatch(/grant_ticket_approval\.approval_not_found/);

    // The original approval is untouched.
    await withClient(pool, async (c) => {
      const a = await c.query(
        `select status from public.approvals where tenant_id = $1 and id = $2`,
        [base.tenantId, approval.approvalId],
      );
      expect(a.rows[0].status).toBe('pending');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 7. Multi-approver parallel group: first two partial, third resolves
  // ─────────────────────────────────────────────────────────────────────
  it('7. parallel group of 3: first two grants → partial_approved, third → resolved + emits', async () => {
    const base = await seedBaseFixture(pool, 's10-parallel');
    const rt = await seedRequestType(pool, base);
    const ticket = await seedPendingApprovalTicket(pool, base, {
      requestTypeId: rt.requestTypeId,
      workflowId: rt.workflowDefinitionId,
      slaId: rt.slaPolicyId,
    });
    const groupId = `pg-${randomUUID()}`;
    // Each pending row needs a distinct approver_person_id per
    // uq_approvals_pending_dedup.
    const p1 = await seedApproverPerson(pool, base.tenantId, 'parallel-1');
    const p2 = await seedApproverPerson(pool, base.tenantId, 'parallel-2');
    const p3 = await seedApproverPerson(pool, base.tenantId, 'parallel-3');
    const a1 = await seedApproval(pool, base, {
      ticketId: ticket.ticketId,
      parallelGroup: groupId,
      approverPersonId: p1.personId,
    });
    const a2 = await seedApproval(pool, base, {
      ticketId: ticket.ticketId,
      parallelGroup: groupId,
      approverPersonId: p2.personId,
    });
    const a3 = await seedApproval(pool, base, {
      ticketId: ticket.ticketId,
      parallelGroup: groupId,
      approverPersonId: p3.personId,
    });

    // Approver 1.
    const r1 = await runRpcCapture<GrantResult>(pool, 'public.grant_ticket_approval', [
      a1.approvalId,
      base.tenantId,
      null,
      'approved',
      null,
      buildKey(a1.approvalId, randomUUID()),
    ]);
    expect(r1.kind).toBe('ok');
    if (r1.kind !== 'ok') return;
    expect(r1.value.kind).toBe('partial_approved');
    expect(r1.value.remaining).toBe(2);

    // Approver 2.
    const r2 = await runRpcCapture<GrantResult>(pool, 'public.grant_ticket_approval', [
      a2.approvalId,
      base.tenantId,
      null,
      'approved',
      null,
      buildKey(a2.approvalId, randomUUID()),
    ]);
    expect(r2.kind).toBe('ok');
    if (r2.kind !== 'ok') return;
    expect(r2.value.kind).toBe('partial_approved');
    expect(r2.value.remaining).toBe(1);

    // Approver 3 — fully resolves.
    const r3 = await runRpcCapture<GrantResult>(pool, 'public.grant_ticket_approval', [
      a3.approvalId,
      base.tenantId,
      null,
      'approved',
      null,
      buildKey(a3.approvalId, randomUUID()),
    ]);
    expect(r3.kind).toBe('ok');
    if (r3.kind !== 'ok') return;
    expect(r3.value.kind).toBe('resolved');
    expect(r3.value.sla_started).toBe(true);
    expect(r3.value.workflow_started).toBe(true);
    expect(r3.value.routing_evaluation_emitted).toBe(true);

    // Outbox emits ONLY fired on the resolving grant.
    const events = await fetchOutboxEvents(pool, base.tenantId, ticket.ticketId);
    expect(events).toHaveLength(3);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 8. DRIFT 1 — delegated approval blocks chain count
  // ─────────────────────────────────────────────────────────────────────
  it('8. DRIFT 1 (delegated): non-terminal set includes delegated; chain not resolved while one row is delegated', async () => {
    const base = await seedBaseFixture(pool, 's10-delegated');
    const rt = await seedRequestType(pool, base);
    const ticket = await seedPendingApprovalTicket(pool, base, {
      requestTypeId: rt.requestTypeId,
      workflowId: rt.workflowDefinitionId,
      slaId: rt.slaPolicyId,
    });
    const groupId = `pg-${randomUUID()}`;
    // Each row needs a distinct approver_person_id per
    // uq_approvals_pending_dedup. The dedup index is partial on
    // status='pending' so the delegated row could share the approver,
    // but using distinct persons keeps the seed obvious + future-proof.
    const pA = await seedApproverPerson(pool, base.tenantId, 'delegated-A');
    const pB = await seedApproverPerson(pool, base.tenantId, 'delegated-B');
    const pC = await seedApproverPerson(pool, base.tenantId, 'delegated-C');
    const aA = await seedApproval(pool, base, {
      ticketId: ticket.ticketId,
      parallelGroup: groupId,
      approverPersonId: pA.personId,
    });
    // Pre-seed B as delegated — i.e. a delegate row exists somewhere
    // separately (in real flow that's a sibling approvals row; the count
    // gate doesn't need it to exist for this test).
    const aB = await seedApproval(pool, base, {
      ticketId: ticket.ticketId,
      parallelGroup: groupId,
      status: 'delegated',
      approverPersonId: pB.personId,
    });
    const aC = await seedApproval(pool, base, {
      ticketId: ticket.ticketId,
      parallelGroup: groupId,
      approverPersonId: pC.personId,
    });

    // A grants → still partial because B (delegated) + C (pending) remain non-terminal.
    const r1 = await runRpcCapture<GrantResult>(pool, 'public.grant_ticket_approval', [
      aA.approvalId,
      base.tenantId,
      null,
      'approved',
      null,
      buildKey(aA.approvalId, randomUUID()),
    ]);
    expect(r1.kind).toBe('ok');
    if (r1.kind !== 'ok') return;
    expect(r1.value.kind).toBe('partial_approved');
    expect(r1.value.remaining).toBe(2);

    // C grants → STILL partial because B (delegated) is non-terminal.
    // Under the pre-reland enum filter (status <> 'pending'), this
    // would silently RESOLVE — proving the bug.
    const r2 = await runRpcCapture<GrantResult>(pool, 'public.grant_ticket_approval', [
      aC.approvalId,
      base.tenantId,
      null,
      'approved',
      null,
      buildKey(aC.approvalId, randomUUID()),
    ]);
    expect(r2.kind).toBe('ok');
    if (r2.kind !== 'ok') return;
    expect(r2.value.kind).toBe('partial_approved');
    expect(r2.value.remaining).toBe(1);

    // Ticket still pending_approval.
    await withClient(pool, async (c) => {
      const t = await c.query(
        `select status_category from public.tickets where tenant_id = $1 and id = $2`,
        [base.tenantId, ticket.ticketId],
      );
      expect(t.rows[0].status_category).toBe('pending_approval');
    });

    // Outbox events still empty.
    const events = await fetchOutboxEvents(pool, base.tenantId, ticket.ticketId);
    expect(events).toHaveLength(0);

    // For completeness — when B's delegated row flips back to 'approved'
    // (via the delegate's own grant), the chain would resolve. We don't
    // exercise that here because the path involves the delegate's
    // separate approvals row + the same RPC; the count-gate behaviour
    // is what's being asserted.
    void aB;
  });

  // ─────────────────────────────────────────────────────────────────────
  // 9. DRIFT 2 — actor auth_uid resolves to users.id
  // ─────────────────────────────────────────────────────────────────────
  it('9. DRIFT 2 (actor FK): auth_uid → users.id resolution writes domain_events.actor_user_id without 23503', async () => {
    const base = await seedBaseFixture(pool, 's10-actor');
    const rt = await seedRequestType(pool, base);
    const ticket = await seedPendingApprovalTicket(pool, base, {
      requestTypeId: rt.requestTypeId,
      workflowId: rt.workflowDefinitionId,
      slaId: rt.slaPolicyId,
    });
    const approval = await seedApproval(pool, base, { ticketId: ticket.ticketId });
    const { userId, authUid } = await seedAuthUser(pool, base.tenantId, base.approverPersonId);

    const out = await runRpcCapture<GrantResult>(pool, 'public.grant_ticket_approval', [
      approval.approvalId,
      base.tenantId,
      authUid, // ← auth_uid, NOT users.id. The RPC must resolve this.
      'approved',
      null,
      buildKey(approval.approvalId, randomUUID()),
    ]);

    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.value.kind).toBe('resolved');

    // domain_events.actor_user_id must hold users.id (PK), NOT auth_uid.
    await withClient(pool, async (c) => {
      const evts = await c.query(
        `select actor_user_id from public.domain_events
          where tenant_id = $1 and entity_id = $2 and event_type = 'approval_approved'`,
        [base.tenantId, ticket.ticketId],
      );
      expect(evts.rows).toHaveLength(1);
      expect(evts.rows[0].actor_user_id).toBe(userId);
      expect(evts.rows[0].actor_user_id).not.toBe(authUid);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 10. DRIFT 3 — outbox event carries started_at = now()
  // ─────────────────────────────────────────────────────────────────────
  it('10. DRIFT 3 (started_at): sla.timer_recompute_required payload.started_at ≈ wall clock at grant time', async () => {
    const base = await seedBaseFixture(pool, 's10-started-at');
    const rt = await seedRequestType(pool, base);
    const ticket = await seedPendingApprovalTicket(pool, base, {
      requestTypeId: rt.requestTypeId,
      workflowId: rt.workflowDefinitionId,
      slaId: rt.slaPolicyId,
    });
    const approval = await seedApproval(pool, base, { ticketId: ticket.ticketId });

    const before = Date.now();
    const out = await runRpcCapture<GrantResult>(pool, 'public.grant_ticket_approval', [
      approval.approvalId,
      base.tenantId,
      null,
      'approved',
      null,
      buildKey(approval.approvalId, randomUUID()),
    ]);
    const after = Date.now();

    expect(out.kind).toBe('ok');
    const slaEvents = await fetchOutboxEvents(pool, base.tenantId, ticket.ticketId, 'sla.timer_recompute_required');
    expect(slaEvents).toHaveLength(1);
    const startedAtRaw = slaEvents[0].payload.started_at as string | undefined;
    expect(startedAtRaw).toBeDefined();
    const startedAtMs = new Date(startedAtRaw!).getTime();
    // Within a generous window (~30s) of wall clock at grant time — DB
    // clock skew + harness jitter accommodated. The point is: it's
    // grant-time, not ticket-create-time (which would be in another
    // wall-clock window).
    expect(startedAtMs).toBeGreaterThanOrEqual(before - 5000);
    expect(startedAtMs).toBeLessThanOrEqual(after + 5000);

    // Sanity: sla_policy_id in payload matches the ticket's sla_id.
    expect(slaEvents[0].payload.sla_policy_id).toBe(rt.slaPolicyId);
    expect(slaEvents[0].payload.ticket_id).toBe(ticket.ticketId);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 11. Ticket NULL sla_id + NULL workflow_id — only routing emit
  // ─────────────────────────────────────────────────────────────────────
  it('11. ticket with NULL sla/workflow: only routing.evaluation_required emitted', async () => {
    const base = await seedBaseFixture(pool, 's10-no-fks');
    // Use a "no-config" request type so the seed doesn't FK-imply anything.
    const rt = await seedRequestType(pool, base, { withConfig: false });
    const ticket = await seedPendingApprovalTicket(pool, base, {
      requestTypeId: rt.requestTypeId,
      workflowId: null,
      slaId: null,
    });
    const approval = await seedApproval(pool, base, { ticketId: ticket.ticketId });

    const out = await runRpcCapture<GrantResult>(pool, 'public.grant_ticket_approval', [
      approval.approvalId,
      base.tenantId,
      null,
      'approved',
      null,
      buildKey(approval.approvalId, randomUUID()),
    ]);

    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.value.kind).toBe('resolved');
    expect(out.value.sla_started).toBe(false);
    expect(out.value.workflow_started).toBe(false);
    expect(out.value.routing_evaluation_emitted).toBe(true);

    const events = await fetchOutboxEvents(pool, base.tenantId, ticket.ticketId);
    expect(events.map((e) => e.event_type).sort()).toEqual(['routing.evaluation_required']);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 12. End-to-end handler chain (substitute defense for smoke gate)
  // ─────────────────────────────────────────────────────────────────────
  it('12. e2e handler chain: outbox events can be drained against the real DB to commit downstream state', async () => {
    const base = await seedBaseFixture(pool, 's10-e2e');
    const rt = await seedRequestType(pool, base);
    const ticket = await seedPendingApprovalTicket(pool, base, {
      requestTypeId: rt.requestTypeId,
      workflowId: rt.workflowDefinitionId,
      slaId: rt.slaPolicyId,
    });
    const approval = await seedApproval(pool, base, { ticketId: ticket.ticketId });

    const out = await runRpcCapture<GrantResult>(pool, 'public.grant_ticket_approval', [
      approval.approvalId,
      base.tenantId,
      null,
      'approved',
      null,
      buildKey(approval.approvalId, randomUUID()),
    ]);
    expect(out.kind).toBe('ok');

    // Simulate SlaTimerHandler — invoke start_sla_timers RPC with the
    // started_at the event payload carries (Step 12 v2 contract).
    const slaEvent = (await fetchOutboxEvents(pool, base.tenantId, ticket.ticketId, 'sla.timer_recompute_required'))[0];
    expect(slaEvent).toBeDefined();
    const startedAt = (slaEvent.payload as { started_at: string }).started_at;
    const slaPolicyId = (slaEvent.payload as { sla_policy_id: string }).sla_policy_id;

    // 00352 v2 signature: start_sla_timers(p_tenant_id, p_ticket_id,
    // p_sla_policy_id, p_timers, p_started_at). p_timers is jsonb[] with
    // computed due_at; use a minimal one-timer payload so the RPC
    // exercises the persist path.
    const dueAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await pool.query(
      `select public.start_sla_timers($1, $2, $3, $4::jsonb, $5::timestamptz)`,
      [
        base.tenantId,
        ticket.ticketId,
        slaPolicyId,
        // target_minutes is NOT NULL on sla_timers; the handler computes
        // it from policy + BusinessHoursService. Mirror that here so the
        // start_sla_timers RPC inserts cleanly.
        JSON.stringify([{ timer_type: 'response', target_minutes: 60, due_at: dueAt }]),
        startedAt,
      ],
    );

    await withClient(pool, async (c) => {
      const timers = await c.query(
        `select started_at, due_at, timer_type from public.sla_timers
          where tenant_id = $1 and case_id = $2`,
        [base.tenantId, ticket.ticketId],
      );
      expect(timers.rows).toHaveLength(1);
      // started_at persisted = the event payload's started_at (not now()
      // at handler-fire time). PG persists with microsecond precision
      // while jsonb roundtrips through Date → ms truncation; compare on
      // wall-clock ms (within 1 ms) rather than ISO strings.
      const persistedMs = new Date(timers.rows[0].started_at).getTime();
      const eventMs = new Date(startedAt).getTime();
      expect(Math.abs(persistedMs - eventMs)).toBeLessThanOrEqual(1);
    });

    // Simulate WorkflowStartHandler — INSERT workflow_instances row.
    // ON CONFLICT DO NOTHING per 00345 partial unique index.
    const wiId = randomUUID();
    await pool.query(
      `insert into public.workflow_instances
         (id, tenant_id, workflow_definition_id, workflow_version, ticket_id, status, current_node_id)
       values ($1, $2, $3, 1, $4, 'active', 'trigger-1')
       on conflict do nothing`,
      [wiId, base.tenantId, rt.workflowDefinitionId, ticket.ticketId],
    );

    // Simulate RoutingEvaluationHandler — write a routing_decisions row
    // marking the ticket as "evaluated, no rule matched". Schema per
    // 00027:57-71 — strategy + chosen_by are both required.
    const rdId = randomUUID();
    await pool.query(
      `insert into public.routing_decisions
         (id, tenant_id, ticket_id, strategy, chosen_by)
       values ($1, $2, $3, 'none', 'unassigned')`,
      [rdId, base.tenantId, ticket.ticketId],
    );

    // Asserts the chain converges — workflow_instance + sla_timer +
    // routing_decision all linked to the ticket.
    await withClient(pool, async (c) => {
      const wi = await c.query(
        `select status from public.workflow_instances
          where tenant_id = $1 and ticket_id = $2`,
        [base.tenantId, ticket.ticketId],
      );
      expect(wi.rows).toHaveLength(1);
      expect(wi.rows[0].status).toBe('active');

      const rd = await c.query(
        `select chosen_by from public.routing_decisions
          where tenant_id = $1 and ticket_id = $2`,
        [base.tenantId, ticket.ticketId],
      );
      expect(rd.rows).toHaveLength(1);
      expect(rd.rows[0].chosen_by).toBe('unassigned');
    });
  });
});

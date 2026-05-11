/**
 * B.2.A.Step10 concurrency probe — grant_ticket_approval.
 *
 * Spec ref: docs/follow-ups/b2-survey-and-design.md §3.5 (lines 2238-2326).
 * Migration: supabase/migrations/00343_grant_ticket_approval_rpc.sql.
 * Sibling reference: apps/api/test/concurrency/grant_booking_approval.spec.ts
 *   (same advisory-lock + FOR UPDATE-before-CAS structure).
 *
 * Eleven scenarios, all against the live local Supabase stack:
 *
 *   1.  Single-approver happy path — pending → approved → ticket flips to
 *       (status='new', status_category='new'), three outbox events
 *       emitted (sla / routing / workflow), one ticket_activities row, one
 *       domain_events row. Returns kind='resolved'.
 *   2.  Single-approver rejection — pending → rejected → ticket flips to
 *       (status='rejected', status_category='closed', closed_at=now()), no
 *       outbox emit.
 *   3.  Idempotent replay — same approval_id + same idempotency_key →
 *       cached_result returned, no extra outbox emits, no extra rows.
 *   4.  Already responded — approval already 'approved' → kind=
 *       'already_responded'; no state changes.
 *   5.  Approval not found — bogus uuid → raises
 *       grant_ticket_approval.approval_not_found.
 *   6.  Tenant mismatch (cross-tenant probe) — approval in TENANT_A,
 *       p_tenant_id=TENANT_B → raises approval_not_found (RLS hides it).
 *   7.  Multi-approver parallel group — 3 approvers; first two return
 *       kind='partial_approved' (no automation fires); third returns
 *       kind='resolved' + full automation.
 *   8.  Approval target is not a ticket (e.g. booking) → kind=
 *       'non_ticket_approved'; ticket-side state untouched.
 *   9.  Ticket already terminal — approval points to a closed ticket →
 *       approval is still resolved (CAS fires) but ticket stays terminal
 *       and no automation events emitted.
 *  10.  No workflow_id + no sla_id on ticket → automation runs but
 *       sla_started=false, workflow_started=false; only
 *       routing_evaluation_emitted=true.
 *  11.  Payload mismatch — same key + different payload →
 *       command_operations.payload_mismatch.
 *
 * Plus implicit verification within scenario 1 that the three outbox
 * payloads carry the expected shapes per spec §3.9.3.
 */

import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  callRpc,
  flushAllFixtures,
  registerCleanup,
  runRpcCapture,
  seedBaseFixture,
  withClient,
} from './helpers';
import { endPool, getPool } from './pool';

interface SeededTicketApproval {
  ticketId: string;
  approvalId: string;
  // Optional extras the test may need to flip on / off after creation.
  workflowDefinitionId?: string;
  slaPolicyId?: string;
}

/**
 * Insert a tickets row in pending_approval + an approvals row in pending.
 * Tickets and approvals here are deliberately minimal — no routing rules,
 * no SLA / workflow unless the test asks for them. Cleanup is registered
 * once per test invocation against the shared base tenant.
 */
async function seedTicketWithPendingApproval(
  pool: Pool,
  base: { tenantId: string; personId: string; approverPersonId: string },
  opts: {
    withWorkflow?: boolean;
    withSla?: boolean;
    parallelGroup?: string | null;
    approvalChainId?: string | null;
    approverPersonId?: string;
    ticketStatusCategory?: string;
    ticketStatus?: string;
  } = {},
): Promise<SeededTicketApproval> {
  const ticketId = randomUUID();
  const approvalId = randomUUID();
  let workflowDefinitionId: string | undefined;
  let slaPolicyId: string | undefined;

  await withClient(pool, async (c) => {
    await c.query('begin');
    try {
      // Optional seed of a workflow_definition + SLA policy so the
      // ticket can carry the FKs the post-grant automation checks for.
      if (opts.withWorkflow) {
        workflowDefinitionId = randomUUID();
        await c.query(
          `insert into public.workflow_definitions
             (id, tenant_id, name, entity_type, version, status, graph_definition)
           values ($1, $2, 'Concurrency probe workflow', 'ticket', 1, 'published',
                   '{}'::jsonb)`,
          [workflowDefinitionId, base.tenantId],
        );
      }
      if (opts.withSla) {
        slaPolicyId = randomUUID();
        await c.query(
          `insert into public.sla_policies
             (id, tenant_id, name, response_time_minutes, resolution_time_minutes, active)
           values ($1, $2, 'Concurrency probe SLA', 60, 240, true)`,
          [slaPolicyId, base.tenantId],
        );
      }

      await c.query(
        `insert into public.tickets
           (id, tenant_id, title, status, status_category,
            requester_person_id, source_channel,
            workflow_id, sla_id)
         values ($1, $2, 'Concurrency probe ticket', $3, $4, $5, 'portal', $6, $7)`,
        [
          ticketId,
          base.tenantId,
          opts.ticketStatus ?? 'new',
          opts.ticketStatusCategory ?? 'pending_approval',
          base.personId,
          workflowDefinitionId ?? null,
          slaPolicyId ?? null,
        ],
      );

      await c.query(
        `insert into public.approvals
           (id, tenant_id, target_entity_type, target_entity_id,
            approver_person_id, status, parallel_group, approval_chain_id)
         values ($1, $2, 'ticket', $3, $4, 'pending', $5, $6)`,
        [
          approvalId,
          base.tenantId,
          ticketId,
          opts.approverPersonId ?? base.approverPersonId,
          opts.parallelGroup ?? null,
          opts.approvalChainId ?? null,
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
        await c.query('delete from outbox.events_dead_letter where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.domain_events where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.ticket_activities where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.approvals where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.sla_timers where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.tickets where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.sla_policies where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.workflow_definitions where tenant_id = $1', [
          base.tenantId,
        ]);
        await c.query('commit');
      } catch (e) {
        await c.query('rollback');
        throw e;
      }
    });
  });

  return { ticketId, approvalId, workflowDefinitionId, slaPolicyId };
}

/** Insert a second pending approval on an existing ticket (parallel group). */
async function seedSecondTicketApprover(
  pool: Pool,
  tenantId: string,
  ticketId: string,
  parallelGroup: string,
): Promise<{ approvalId: string; approverPersonId: string }> {
  const approvalId = randomUUID();
  const approverPersonId = randomUUID();
  await pool.query(
    `insert into public.persons (id, tenant_id, type, first_name, last_name, email)
     values ($1, $2, 'employee', 'Approver-extra', 'Concurrency', $3)`,
    [approverPersonId, tenantId, `app-${approverPersonId.slice(0, 8)}@concurrency.test`],
  );
  await pool.query(
    `insert into public.approvals
       (id, tenant_id, target_entity_type, target_entity_id,
        approver_person_id, status, parallel_group)
     values ($1, $2, 'ticket', $3, $4, 'pending', $5)`,
    [approvalId, tenantId, ticketId, approverPersonId, parallelGroup],
  );
  return { approvalId, approverPersonId };
}

interface GrantTicketApprovalResult {
  kind: string;
  approval_id?: string;
  ticket_id?: string;
  prior_status?: string;
  target_entity_type?: string;
  final_decision?: string;
  ticket_status?: string | null;
  ticket_status_category?: string;
  sla_started?: boolean;
  workflow_started?: boolean;
  routing_evaluation_emitted?: boolean;
  remaining?: number;
}

describe('grant_ticket_approval — atomic ticket-approval grant', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = getPool();
  });

  afterAll(async () => {
    await flushAllFixtures(pool);
    await endPool();
  });

  it('scenario 1: single-approver happy path — approved → ticket=new + 3 outbox emits + activity + domain_event', async () => {
    const base = await seedBaseFixture(pool, `gta-happy-${Date.now()}`);
    const seeded = await seedTicketWithPendingApproval(pool, base, {
      withWorkflow: true,
      withSla: true,
    });

    const idem = `gta-happy-${seeded.approvalId}`;
    const result = await withClient(pool, (c) =>
      callRpc<GrantTicketApprovalResult>(
        c,
        'public.grant_ticket_approval',
        [seeded.approvalId, base.tenantId, null, 'approved', null, idem],
      ),
    );

    expect(result.kind).toBe('resolved');
    expect(result.final_decision).toBe('approved');
    expect(result.ticket_status).toBe('new');
    expect(result.ticket_status_category).toBe('new');
    expect(result.sla_started).toBe(true);
    expect(result.workflow_started).toBe(true);
    expect(result.routing_evaluation_emitted).toBe(true);

    // Ticket row should reflect the transition.
    const ticket = await pool.query(
      'select status, status_category from public.tickets where id = $1',
      [seeded.ticketId],
    );
    expect(ticket.rows[0].status).toBe('new');
    expect(ticket.rows[0].status_category).toBe('new');

    // Approval row should reflect the CAS.
    const approval = await pool.query(
      'select status, responded_at from public.approvals where id = $1',
      [seeded.approvalId],
    );
    expect(approval.rows[0].status).toBe('approved');
    expect(approval.rows[0].responded_at).not.toBeNull();

    // Three outbox events emitted with correct payload shapes.
    const events = await pool.query(
      `select event_type, payload
         from outbox.events
        where tenant_id = $1 and aggregate_id = $2
        order by event_type asc`,
      [base.tenantId, seeded.ticketId],
    );
    expect(events.rowCount).toBe(3);
    const byType = Object.fromEntries(
      events.rows.map((r) => [r.event_type, r.payload]),
    ) as Record<string, Record<string, unknown>>;
    expect(byType['sla.timer_recompute_required']).toBeDefined();
    expect(byType['sla.timer_recompute_required'].sla_policy_id).toBe(seeded.slaPolicyId);
    expect(byType['routing.evaluation_required']).toBeDefined();
    expect(byType['routing.evaluation_required'].ticket_id).toBe(seeded.ticketId);
    expect(byType['workflow.start_required']).toBeDefined();
    expect(byType['workflow.start_required'].workflow_definition_id).toBe(seeded.workflowDefinitionId);

    // One ticket_activities row + one domain_events row.
    const activities = await pool.query(
      `select metadata from public.ticket_activities
        where ticket_id = $1 and activity_type = 'system_event'`,
      [seeded.ticketId],
    );
    expect(activities.rowCount).toBe(1);
    expect(activities.rows[0].metadata.event).toBe('approval_approved');

    const domainEvents = await pool.query(
      `select event_type from public.domain_events
        where tenant_id = $1 and entity_type = 'approval' and entity_id = $2`,
      [base.tenantId, seeded.ticketId],
    );
    expect(domainEvents.rowCount).toBe(1);
    expect(domainEvents.rows[0].event_type).toBe('approval_approved');
  });

  it('scenario 2: rejection — ticket flips to closed + closed_at stamped, NO outbox emits', async () => {
    const base = await seedBaseFixture(pool, `gta-reject-${Date.now()}`);
    const seeded = await seedTicketWithPendingApproval(pool, base, {
      withWorkflow: true,
      withSla: true,
    });

    const idem = `gta-reject-${seeded.approvalId}`;
    const result = await withClient(pool, (c) =>
      callRpc<GrantTicketApprovalResult>(
        c,
        'public.grant_ticket_approval',
        [seeded.approvalId, base.tenantId, null, 'rejected', 'declined per policy', idem],
      ),
    );

    expect(result.kind).toBe('resolved');
    expect(result.final_decision).toBe('rejected');
    expect(result.ticket_status).toBe('rejected');
    expect(result.ticket_status_category).toBe('closed');
    expect(result.sla_started).toBe(false);
    expect(result.workflow_started).toBe(false);
    expect(result.routing_evaluation_emitted).toBe(false);

    const ticket = await pool.query(
      'select status, status_category, closed_at from public.tickets where id = $1',
      [seeded.ticketId],
    );
    expect(ticket.rows[0].status).toBe('rejected');
    expect(ticket.rows[0].status_category).toBe('closed');
    expect(ticket.rows[0].closed_at).not.toBeNull();

    // No automation outbox events; rejection short-circuits.
    const events = await pool.query(
      'select count(*)::int as n from outbox.events where tenant_id = $1 and aggregate_id = $2',
      [base.tenantId, seeded.ticketId],
    );
    expect(events.rows[0].n).toBe(0);
  });

  it('scenario 3: idempotent replay — same key + same payload returns cached_result; no extra writes', async () => {
    const base = await seedBaseFixture(pool, `gta-replay-${Date.now()}`);
    const seeded = await seedTicketWithPendingApproval(pool, base, {
      withWorkflow: true,
      withSla: true,
    });

    const idem = `gta-replay-${seeded.approvalId}`;
    const args = [seeded.approvalId, base.tenantId, null, 'approved', null, idem];

    const r1 = await withClient(pool, (c) =>
      callRpc<GrantTicketApprovalResult>(c, 'public.grant_ticket_approval', args),
    );
    const r2 = await withClient(pool, (c) =>
      callRpc<GrantTicketApprovalResult>(c, 'public.grant_ticket_approval', args),
    );

    expect(r1.kind).toBe('resolved');
    expect(r2.kind).toBe('resolved');
    // Cached result should be identical.
    expect(r2).toEqual(r1);

    // Only ONE activity row + ONE domain_event row, despite two RPC calls.
    const activities = await pool.query(
      'select count(*)::int as n from public.ticket_activities where ticket_id = $1',
      [seeded.ticketId],
    );
    expect(activities.rows[0].n).toBe(1);
    const domainEvents = await pool.query(
      `select count(*)::int as n from public.domain_events
        where tenant_id = $1 and entity_id = $2`,
      [base.tenantId, seeded.ticketId],
    );
    expect(domainEvents.rows[0].n).toBe(1);

    // Three outbox events total, not six.
    const events = await pool.query(
      'select count(*)::int as n from outbox.events where tenant_id = $1 and aggregate_id = $2',
      [base.tenantId, seeded.ticketId],
    );
    expect(events.rows[0].n).toBe(3);
  });

  it('scenario 4: already-responded — second grant returns kind=already_responded; no state changes', async () => {
    const base = await seedBaseFixture(pool, `gta-already-${Date.now()}`);
    const seeded = await seedTicketWithPendingApproval(pool, base, {
      withWorkflow: true,
      withSla: true,
    });

    // First grant resolves cleanly.
    await withClient(pool, (c) =>
      callRpc<GrantTicketApprovalResult>(
        c,
        'public.grant_ticket_approval',
        [seeded.approvalId, base.tenantId, null, 'approved', null, `gta-already-A-${seeded.approvalId}`],
      ),
    );

    // Second grant on the same approval (different idempotency key, so
    // command_operations doesn't short-circuit) — should hit the
    // state-machine guard and return already_responded WITHOUT mutating.
    const r2 = await withClient(pool, (c) =>
      callRpc<GrantTicketApprovalResult>(
        c,
        'public.grant_ticket_approval',
        [seeded.approvalId, base.tenantId, null, 'approved', null, `gta-already-B-${seeded.approvalId}`],
      ),
    );

    expect(r2.kind).toBe('already_responded');
    expect(r2.prior_status).toBe('approved');

    // Activity + domain_events counts stay at 1 each (no new mutations).
    const activities = await pool.query(
      'select count(*)::int as n from public.ticket_activities where ticket_id = $1',
      [seeded.ticketId],
    );
    expect(activities.rows[0].n).toBe(1);
  });

  it('scenario 5: approval_not_found — bogus uuid raises grant_ticket_approval.approval_not_found', async () => {
    const base = await seedBaseFixture(pool, `gta-missing-${Date.now()}`);
    // Register cleanup so command_operations rows from this scenario
    // get wiped at afterAll.
    registerCleanup(async () => {
      await pool.query('delete from public.command_operations where tenant_id = $1', [
        base.tenantId,
      ]);
    });
    const bogus = randomUUID();
    const outcome = await runRpcCapture<GrantTicketApprovalResult>(
      pool,
      'public.grant_ticket_approval',
      [bogus, base.tenantId, null, 'approved', null, `gta-missing-${bogus}`],
    );
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.error.message).toContain('grant_ticket_approval.approval_not_found');
    }
  });

  it('scenario 6: tenant mismatch — RPC raises approval_not_found (tenant filter on SELECT)', async () => {
    const baseA = await seedBaseFixture(pool, `gta-tenantA-${Date.now()}`);
    const baseB = await seedBaseFixture(pool, `gta-tenantB-${Date.now()}`);
    const seededInA = await seedTicketWithPendingApproval(pool, baseA);
    // Register a cleanup for command_operations on baseB (no
    // ticket/approval rows leak — we never insert into baseB).
    registerCleanup(async () => {
      await pool.query('delete from public.command_operations where tenant_id = $1', [
        baseB.tenantId,
      ]);
    });

    const outcome = await runRpcCapture<GrantTicketApprovalResult>(
      pool,
      'public.grant_ticket_approval',
      [
        seededInA.approvalId,
        baseB.tenantId, // wrong tenant
        null,
        'approved',
        null,
        `gta-cross-${seededInA.approvalId}`,
      ],
    );
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      // RPC's `select ... where id=$1 and tenant_id=$2 for update` returns
      // no row when the tenant doesn't match, so the not_found branch
      // fires. This is the canonical isolation behaviour.
      expect(outcome.error.message).toContain('grant_ticket_approval.approval_not_found');
    }
  });

  it('scenario 7: parallel group — first two return partial_approved, third returns resolved', async () => {
    const base = await seedBaseFixture(pool, `gta-parallel-${Date.now()}`);
    const groupName = 'gta-parallel';
    const seeded = await seedTicketWithPendingApproval(pool, base, {
      withWorkflow: true,
      withSla: true,
      parallelGroup: groupName,
    });
    const second = await seedSecondTicketApprover(
      pool,
      base.tenantId,
      seeded.ticketId,
      groupName,
    );
    const third = await seedSecondTicketApprover(
      pool,
      base.tenantId,
      seeded.ticketId,
      groupName,
    );

    // First approver: partial (two peers still pending).
    const r1 = await withClient(pool, (c) =>
      callRpc<GrantTicketApprovalResult>(
        c,
        'public.grant_ticket_approval',
        [seeded.approvalId, base.tenantId, null, 'approved', null, `gta-par-1-${seeded.approvalId}`],
      ),
    );
    expect(r1.kind).toBe('partial_approved');
    expect(r1.remaining).toBe(2);

    // Second approver: partial (one peer still pending).
    const r2 = await withClient(pool, (c) =>
      callRpc<GrantTicketApprovalResult>(
        c,
        'public.grant_ticket_approval',
        [second.approvalId, base.tenantId, null, 'approved', null, `gta-par-2-${second.approvalId}`],
      ),
    );
    expect(r2.kind).toBe('partial_approved');
    expect(r2.remaining).toBe(1);

    // Ticket still in pending_approval; no automation events.
    let ticket = await pool.query(
      'select status, status_category from public.tickets where id = $1',
      [seeded.ticketId],
    );
    expect(ticket.rows[0].status_category).toBe('pending_approval');
    let events = await pool.query(
      'select count(*)::int as n from outbox.events where tenant_id = $1 and aggregate_id = $2',
      [base.tenantId, seeded.ticketId],
    );
    expect(events.rows[0].n).toBe(0);

    // Third approver — finally resolves the group.
    const r3 = await withClient(pool, (c) =>
      callRpc<GrantTicketApprovalResult>(
        c,
        'public.grant_ticket_approval',
        [third.approvalId, base.tenantId, null, 'approved', null, `gta-par-3-${third.approvalId}`],
      ),
    );
    expect(r3.kind).toBe('resolved');
    expect(r3.sla_started).toBe(true);
    expect(r3.workflow_started).toBe(true);
    expect(r3.routing_evaluation_emitted).toBe(true);

    ticket = await pool.query(
      'select status, status_category from public.tickets where id = $1',
      [seeded.ticketId],
    );
    expect(ticket.rows[0].status_category).toBe('new');
    events = await pool.query(
      'select count(*)::int as n from outbox.events where tenant_id = $1 and aggregate_id = $2',
      [base.tenantId, seeded.ticketId],
    );
    expect(events.rows[0].n).toBe(3);
  });

  it('scenario 8: non-ticket target (booking approval) — RPC bails kind=non_ticket_approved', async () => {
    const base = await seedBaseFixture(pool, `gta-nonticket-${Date.now()}`);
    // Insert a booking-target approval row directly (no booking row
    // needed — the RPC bails at the target_entity_type guard BEFORE
    // touching tickets).
    const approvalId = randomUUID();
    const bookingId = randomUUID();
    await pool.query(
      `insert into public.approvals
         (id, tenant_id, target_entity_type, target_entity_id,
          approver_person_id, status)
       values ($1, $2, 'booking', $3, $4, 'pending')`,
      [approvalId, base.tenantId, bookingId, base.approverPersonId],
    );
    registerCleanup(async () => {
      await pool.query('delete from public.approvals where id = $1', [approvalId]);
      await pool.query('delete from public.command_operations where tenant_id = $1', [
        base.tenantId,
      ]);
    });

    const result = await withClient(pool, (c) =>
      callRpc<GrantTicketApprovalResult>(
        c,
        'public.grant_ticket_approval',
        [approvalId, base.tenantId, null, 'approved', null, `gta-nonticket-${approvalId}`],
      ),
    );
    expect(result.kind).toBe('non_ticket_approved');
    expect(result.target_entity_type).toBe('booking');

    // Approval row was NOT mutated.
    const approval = await pool.query(
      'select status, responded_at from public.approvals where id = $1',
      [approvalId],
    );
    expect(approval.rows[0].status).toBe('pending');
    expect(approval.rows[0].responded_at).toBeNull();
  });

  it('scenario 9: ticket already terminal — approval grant CAS fires but ticket stays terminal + NO automation emits', async () => {
    const base = await seedBaseFixture(pool, `gta-terminal-${Date.now()}`);
    // Seed ticket in `closed` state with a pending approval (anomalous
    // but possible — e.g. desk manually closed the ticket while
    // approval was outstanding).
    const seeded = await seedTicketWithPendingApproval(pool, base, {
      withWorkflow: true,
      withSla: true,
      ticketStatus: 'closed',
      ticketStatusCategory: 'closed',
    });

    const result = await withClient(pool, (c) =>
      callRpc<GrantTicketApprovalResult>(
        c,
        'public.grant_ticket_approval',
        [seeded.approvalId, base.tenantId, null, 'approved', null, `gta-term-${seeded.approvalId}`],
      ),
    );

    // CAS still fires — approval row gets marked approved.
    const approval = await pool.query(
      'select status from public.approvals where id = $1',
      [seeded.approvalId],
    );
    expect(approval.rows[0].status).toBe('approved');

    // Ticket stays closed; no automation events because the ticket was
    // not in pending_approval at grant time (skipped per spec §3.5).
    expect(result.kind).toBe('resolved');
    expect(result.ticket_status_category).toBe('closed');
    expect(result.sla_started).toBe(false);
    expect(result.workflow_started).toBe(false);
    expect(result.routing_evaluation_emitted).toBe(false);

    const events = await pool.query(
      'select count(*)::int as n from outbox.events where tenant_id = $1 and aggregate_id = $2',
      [base.tenantId, seeded.ticketId],
    );
    expect(events.rows[0].n).toBe(0);
  });

  it('scenario 10: ticket has no workflow_id + no sla_id — only routing event emitted', async () => {
    const base = await seedBaseFixture(pool, `gta-noauto-${Date.now()}`);
    const seeded = await seedTicketWithPendingApproval(pool, base, {
      // No withWorkflow / withSla — ticket has null workflow_id + null sla_id.
    });

    const result = await withClient(pool, (c) =>
      callRpc<GrantTicketApprovalResult>(
        c,
        'public.grant_ticket_approval',
        [seeded.approvalId, base.tenantId, null, 'approved', null, `gta-noauto-${seeded.approvalId}`],
      ),
    );

    expect(result.kind).toBe('resolved');
    expect(result.sla_started).toBe(false);
    expect(result.workflow_started).toBe(false);
    expect(result.routing_evaluation_emitted).toBe(true);

    // Exactly one outbox event — routing.evaluation_required.
    const events = await pool.query(
      `select event_type from outbox.events
        where tenant_id = $1 and aggregate_id = $2`,
      [base.tenantId, seeded.ticketId],
    );
    expect(events.rowCount).toBe(1);
    expect(events.rows[0].event_type).toBe('routing.evaluation_required');
  });

  it('scenario 11: payload mismatch — same key + different payload raises command_operations.payload_mismatch', async () => {
    const base = await seedBaseFixture(pool, `gta-paymismatch-${Date.now()}`);
    const seeded = await seedTicketWithPendingApproval(pool, base);

    const idem = `gta-paymismatch-${seeded.approvalId}`;

    // First call — approve, commits successfully.
    await withClient(pool, (c) =>
      callRpc<GrantTicketApprovalResult>(
        c,
        'public.grant_ticket_approval',
        [seeded.approvalId, base.tenantId, null, 'approved', null, idem],
      ),
    );

    // Second call — same idem key + DIFFERENT payload (rejected instead
    // of approved, and a different comments string). The
    // command_operations payload_hash diverges, raising the explicit
    // mismatch error.
    const outcome = await runRpcCapture<GrantTicketApprovalResult>(
      pool,
      'public.grant_ticket_approval',
      [seeded.approvalId, base.tenantId, null, 'rejected', 'second try', idem],
    );
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.error.message).toContain('command_operations.payload_mismatch');
    }
  });
});

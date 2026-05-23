/**
 * Phase 1.5 — Visual approval workflow — §7.5 real-DB concurrency probes.
 *
 * Plan: docs/superpowers/specs/phase-1.5-visual-approval-workflow-plan.md §7.5
 * Harness: docs/follow-ups/b0-real-db-concurrency-harness.md
 * Mirrors the shape of grant_booking_approval.spec.ts + edit_booking_scope
 * .spec.ts (BaseFixture + real pg.Pool + --runInBand + per-fixture cleanup).
 *
 * Five probes (plan §7.5):
 *
 *   1. 50 concurrent grants of the SAME approval id → exactly one
 *      succeeds with kind='resolved'; the rest 'already_responded'
 *      (per-approval advisory lock + state-machine guard).
 *   2. N concurrent workflow-instance starts for the SAME booking →
 *      exactly ONE row persists; the rest 23505 on
 *      workflow_instances_active_booking_unique_idx (no double-start).
 *   3. N concurrent cancel_workflow_instance_with_approvals on the same
 *      instance → exactly one effective claim; approvals expire ONCE
 *      (atomic claim inside the RPC).
 *   4. 5 concurrent grants of a chain_threshold='any' chain (distinct
 *      sibling approval ids) → exactly one wins under the booking ROW
 *      lock (kind='resolved'); the rest kind='already_resolved'; single
 *      approval.granted outbox row (BLOCKER 2 closure, 00407).
 *   5. 5 concurrent ensure_room_booking_rule_workflow_definition on the
 *      same rule → the rule ROW lock serialises; versions increase
 *      monotonically; the (tenant_id, source_rule_id, version) unique
 *      index never collides; rule FK ends at the last version (BLOCKER 1).
 *
 * Target DB: the harness pool defaults to local Supabase. This worktree's
 * 00407 grant_booking_approval v3 fix lives on REMOTE, so run against
 * remote by exporting the SUPABASE_DB_* overrides (see pool.ts) — e.g.
 *   SUPABASE_DB_HOST=db.iwbqnyrvycqgnatratrk.supabase.co \
 *   SUPABASE_DB_PORT=5432 SUPABASE_DB_USER=postgres \
 *   SUPABASE_DB_PASSWORD="$SUPABASE_DB_PASS" SUPABASE_DB_NAME=postgres \
 *   pnpm --filter @prequest/api test:concurrency
 */

import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  callRpc,
  flushAllFixtures,
  registerCleanup,
  runRpcCapture,
  seedBaseFixture,
  seedPendingApprovalBooking,
  withClient,
  type BaseFixture,
  type SeededBooking,
} from './helpers';
import { endPool, getPool } from './pool';

// A minimal published booking workflow_definition graph (trigger →
// approval_main → end_success/failure). Mirrors what the smoke script +
// RoomBookingRulesService.recompileApprovalWorkflow produce.
function graph(approverPersonIds: string[], threshold: 'all' | 'any') {
  return {
    nodes: [
      { id: 'trigger', type: 'trigger', config: {} },
      {
        id: 'approval_main',
        type: 'approval',
        config: {
          required_approvers: approverPersonIds.map((id) => ({ type: 'person', id })),
          threshold,
        },
      },
      { id: 'end_success', type: 'end', config: { outcome: 'approved' } },
      { id: 'end_failure', type: 'end', config: { outcome: 'rejected' } },
    ],
    edges: [
      { from: 'trigger', to: 'approval_main' },
      { from: 'approval_main', to: 'end_success', condition: 'approved' },
      { from: 'approval_main', to: 'end_failure', condition: 'rejected' },
    ],
  };
}

/**
 * Seed a published workflow_definition for a fresh room_booking_rule via
 * the production RPC (genuine lineage), then return its ids. Registers
 * cleanup for the rule + its definitions + any instances.
 */
async function seedRuleWithWorkflow(
  pool: Pool,
  base: BaseFixture,
  threshold: 'all' | 'any',
  approverPersonIds: string[],
): Promise<{ ruleId: string; definitionId: string }> {
  const ruleId = randomUUID();
  await withClient(pool, async (c) => {
    await c.query('begin');
    try {
      await c.query("set local session_replication_role = 'replica'");
      await c.query(
        `insert into public.room_booking_rules
           (id, tenant_id, name, target_scope, target_id, applies_when,
            effect, approval_config, priority, active)
         values ($1, $2, $3, 'room', $4::uuid,
                 jsonb_build_object('op','eq','left','$.space.id','right',$4::uuid::text),
                 'require_approval', $5::jsonb, 200, true)`,
        [
          ruleId,
          base.tenantId,
          `concurrency-p15-${ruleId.slice(0, 8)}`,
          base.spaceId,
          JSON.stringify({
            required_approvers: approverPersonIds.map((id) => ({ type: 'person', id })),
            threshold,
          }),
        ],
      );
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    }
  });

  // ensure_room_booking_rule_workflow_definition RETURNS TABLE(...). Via
  // `select fn(...) as result` pg collapses it to a composite text
  // "(uuid,1,0)"; query `select * from fn(...)` to get named columns.
  const ensureRes = await pool.query<{ definition_id: string }>(
    `select * from public.ensure_room_booking_rule_workflow_definition($1::uuid, $2::uuid, $3::jsonb, $4::text)`,
    [ruleId, base.tenantId, JSON.stringify(graph(approverPersonIds, threshold)), `concurrency-p15-${ruleId.slice(0, 8)}`],
  );
  const definitionId = ensureRes.rows[0]?.definition_id;
  if (!definitionId) throw new Error(`ensure RPC returned no definition_id: ${JSON.stringify(ensureRes.rows)}`);

  registerCleanup(async () => {
    await withClient(pool, async (c) => {
      await c.query('begin');
      try {
        await c.query("set local session_replication_role = 'replica'");
        await c.query('delete from public.workflow_instances where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.workflow_definitions where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.room_booking_rules where tenant_id = $1', [base.tenantId]);
        await c.query('commit');
      } catch (e) {
        await c.query('rollback');
        throw e;
      }
    });
  });

  return { ruleId, definitionId };
}

/**
 * Insert a workflow_instance for a booking + N pending approvals all
 * linked to it (workflow_instance_id + chain_threshold set — the Phase
 * 1.5 shape grant_booking_approval v3 needs to hit the resolve + outbox
 * path). Returns the instance id and the approval ids.
 */
async function seedWorkflowInstanceWithApprovals(
  pool: Pool,
  base: BaseFixture,
  seeded: SeededBooking,
  definitionId: string,
  threshold: 'all' | 'any',
  approverPersonIds: string[],
): Promise<{ instanceId: string; approvalIds: string[] }> {
  const instanceId = randomUUID();
  const approvalIds: string[] = [];
  await withClient(pool, async (c) => {
    await c.query('begin');
    try {
      const def = await c.query<{ version: number }>(
        'select version from public.workflow_definitions where id = $1',
        [definitionId],
      );
      await c.query(
        `insert into public.workflow_instances
           (id, tenant_id, workflow_definition_id, workflow_version,
            entity_kind, booking_id, current_node_id, status, context)
         values ($1, $2, $3, $4, 'booking', $5, 'approval_main', 'waiting', '{}'::jsonb)`,
        [instanceId, base.tenantId, definitionId, def.rows[0].version, seeded.bookingId],
      );
      const chainId = randomUUID();
      for (const personId of approverPersonIds) {
        const approvalId = randomUUID();
        approvalIds.push(approvalId);
        await c.query(
          `insert into public.approvals
             (id, tenant_id, target_entity_type, target_entity_id,
              approver_person_id, status, approval_chain_id, chain_threshold,
              parallel_group, workflow_instance_id, workflow_node_id)
           values ($1, $2, 'booking', $3, $4, 'pending', $5, $6, $7, $8, 'approval_main')`,
          [
            approvalId,
            base.tenantId,
            seeded.bookingId,
            personId,
            chainId,
            threshold,
            threshold === 'all' ? `wf-approval_main-${instanceId}` : null,
            instanceId,
          ],
        );
      }
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    }
  });
  return { instanceId, approvalIds };
}

describe('Phase 1.5 visual-approval — §7.5 real-DB concurrency', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = getPool();
    // Preflight (runnable guard): §7.5 needs the Phase 1.5 functions
    // (00400 ensure_room_booking_rule_workflow_definition, 00407
    // grant_booking_approval v3). The harness pool defaults to LOCAL
    // Supabase (pool.ts: SUPABASE_DB_HOST ?? '127.0.0.1'), which is
    // typically not migrated to 00400+. Fail fast with the exact fix
    // instead of 5 cryptic "function does not exist" errors buried in
    // fixture seeding.
    const required = [
      'ensure_room_booking_rule_workflow_definition',
      'grant_booking_approval',
    ];
    const { rows } = await pool.query<{ proname: string }>(
      `select proname from pg_proc where proname = any($1::text[])`,
      [required],
    );
    const have = new Set(rows.map((r) => r.proname));
    const missing = required.filter((p) => !have.has(p));
    if (missing.length > 0) {
      throw new Error(
        `[§7.5 preflight] target DB is missing Phase 1.5 function(s): ${missing.join(', ')}.\n` +
          `The concurrency pool defaults to LOCAL Supabase (127.0.0.1:54322), which is not\n` +
          `migrated to 00400+. Phase 1.5 lives on REMOTE — re-run against remote:\n` +
          `  SUPABASE_DB_HOST=db.iwbqnyrvycqgnatratrk.supabase.co SUPABASE_DB_PORT=5432 \\\n` +
          `  SUPABASE_DB_USER=postgres SUPABASE_DB_PASSWORD="$SUPABASE_DB_PASS" \\\n` +
          `  SUPABASE_DB_NAME=postgres pnpm --filter @prequest/api test:concurrency`,
      );
    }
  });

  afterAll(async () => {
    await flushAllFixtures(pool);
    await endPool();
  });

  // §7.5 #1
  it('50 concurrent grants of the SAME approval id → exactly one succeeds', async () => {
    const base = await seedBaseFixture(pool, `p15-1-${Date.now()}`);
    const seeded = await seedPendingApprovalBooking(pool, base);
    const { definitionId } = await seedRuleWithWorkflow(pool, base, 'all', [base.approverPersonId]);
    const { instanceId, approvalIds } = await seedWorkflowInstanceWithApprovals(
      pool,
      base,
      seeded,
      definitionId,
      'all',
      [base.approverPersonId],
    );
    const approvalId = approvalIds[0];

    const grants = Array.from({ length: 50 }, (_, i) =>
      runRpcCapture<{ kind: string }>(pool, 'public.grant_booking_approval', [
        approvalId,
        base.tenantId,
        null,
        'approved',
        null,
        `p15-1-${approvalId}-${i}`,
      ]),
    );
    const results = await Promise.all(grants);

    const ok = results.filter((r) => r.kind === 'ok');
    const resolved = ok.filter(
      (r) => (r as { value: { kind: string } }).value.kind === 'resolved',
    );
    const alreadyResponded = ok.filter(
      (r) => (r as { value: { kind: string } }).value.kind === 'already_responded',
    );

    // Exactly one winner; every other caller is a clean no-op
    // (already_responded). No caller may crash with a CAS/23505 error.
    expect(resolved.length).toBe(1);
    expect(alreadyResponded.length).toBe(results.length - 1);
    expect(results.every((r) => r.kind === 'ok')).toBe(true);

    const appr = await pool.query(
      'select status from public.approvals where id = $1',
      [approvalId],
    );
    expect(appr.rows[0].status).toBe('approved');
    const bk = await pool.query('select status from public.bookings where id = $1', [
      seeded.bookingId,
    ]);
    expect(bk.rows[0].status).toBe('confirmed');
    // Exactly one approval.granted outbox row for the instance.
    const ob = await pool.query(
      `select count(*)::int n from outbox.events
        where event_type = 'approval.granted'
          and payload->>'workflow_instance_id' = $1`,
      [instanceId],
    );
    expect(ob.rows[0].n).toBe(1);
  }, 60_000);

  // §7.5 #2
  it('N concurrent workflow-instance starts for the SAME booking → exactly one row (no double-start)', async () => {
    const base = await seedBaseFixture(pool, `p15-2-${Date.now()}`);
    const seeded = await seedPendingApprovalBooking(pool, base);
    const { definitionId } = await seedRuleWithWorkflow(pool, base, 'all', [base.approverPersonId]);
    const def = await pool.query<{ version: number }>(
      'select version from public.workflow_definitions where id = $1',
      [definitionId],
    );

    // 10 concurrent INSERTs racing the partial-unique
    // workflow_instances_active_booking_unique_idx. Exactly ONE persists;
    // the rest must fail with 23505 (no silent double-start).
    const inserts = Array.from({ length: 10 }, async () => {
      const c = await pool.connect();
      try {
        await c.query(
          `insert into public.workflow_instances
             (id, tenant_id, workflow_definition_id, workflow_version,
              entity_kind, booking_id, current_node_id, status, context)
           values ($1, $2, $3, $4, 'booking', $5, 'trigger', 'active', '{}'::jsonb)`,
          [randomUUID(), base.tenantId, definitionId, def.rows[0].version, seeded.bookingId],
        );
        return { ok: true as const };
      } catch (e) {
        return { ok: false as const, code: (e as { code?: string }).code };
      } finally {
        c.release();
      }
    });
    const results = await Promise.all(inserts);

    const succeeded = results.filter((r) => r.ok);
    const conflicts = results.filter((r) => !r.ok && r.code === '23505');
    expect(succeeded.length).toBe(1);
    expect(conflicts.length).toBe(results.length - 1);
    // Every failure is the unique-index conflict — nothing else.
    expect(results.filter((r) => !r.ok).every((r) => r.code === '23505')).toBe(true);

    const cnt = await pool.query<{ n: string }>(
      `select count(*)::int n from public.workflow_instances
        where tenant_id = $1 and booking_id = $2 and entity_kind = 'booking'`,
      [base.tenantId, seeded.bookingId],
    );
    expect(Number(cnt.rows[0].n)).toBe(1);
  }, 60_000);

  // §7.5 #3
  it('N concurrent cancel_workflow_instance_with_approvals → exactly one effective; approvals expire once', async () => {
    const base = await seedBaseFixture(pool, `p15-3-${Date.now()}`);
    const seeded = await seedPendingApprovalBooking(pool, base);
    const { definitionId } = await seedRuleWithWorkflow(pool, base, 'all', [base.approverPersonId]);
    const { instanceId } = await seedWorkflowInstanceWithApprovals(
      pool,
      base,
      seeded,
      definitionId,
      'all',
      [base.approverPersonId],
    );

    const cancels = Array.from({ length: 10 }, () =>
      runRpcCapture<unknown>(pool, 'public.cancel_workflow_instance_with_approvals', [
        instanceId,
        base.tenantId,
        'booking_cancelled',
      ]),
    );
    const results = await Promise.all(cancels);
    // No caller may crash — the atomic claim makes losers clean no-ops.
    expect(results.every((r) => r.kind === 'ok')).toBe(true);

    // Instance ends cancelled; approvals expired EXACTLY once (no double-
    // expire / no leftover pending).
    const inst = await pool.query<{ status: string }>(
      'select status from public.workflow_instances where id = $1',
      [instanceId],
    );
    expect(inst.rows[0].status).toBe('cancelled');
    const apprs = await pool.query<{ status: string }>(
      `select status from public.approvals where workflow_instance_id = $1`,
      [instanceId],
    );
    expect(apprs.rows.length).toBeGreaterThan(0);
    expect(apprs.rows.every((r) => r.status === 'expired')).toBe(true);
  }, 60_000);

  // §7.5 #4
  it("5 concurrent grants of a chain_threshold='any' chain → one wins, others already_resolved, single outbox row", async () => {
    const base = await seedBaseFixture(pool, `p15-4-${Date.now()}`);
    const seeded = await seedPendingApprovalBooking(pool, base);
    // 5 distinct approver persons for the 5 sibling approvals.
    const approverIds = Array.from({ length: 5 }, () => randomUUID());
    await withClient(pool, async (c) => {
      await c.query('begin');
      try {
        await c.query("set local session_replication_role = 'replica'");
        for (const pid of approverIds) {
          await c.query(
            `insert into public.persons (id, tenant_id, type, first_name, last_name, email)
             values ($1, $2, 'employee', 'AnyApprover', $3, $4)`,
            [pid, base.tenantId, pid.slice(0, 8), `any-${pid.slice(0, 8)}@concurrency.test`],
          );
        }
        await c.query('commit');
      } catch (e) {
        await c.query('rollback');
        throw e;
      }
    });
    const { definitionId } = await seedRuleWithWorkflow(pool, base, 'any', approverIds);
    const { instanceId, approvalIds } = await seedWorkflowInstanceWithApprovals(
      pool,
      base,
      seeded,
      definitionId,
      'any',
      approverIds,
    );

    // Race a grant on EACH distinct sibling approval id concurrently.
    const grants = approvalIds.map((aid, i) =>
      runRpcCapture<{ kind: string }>(pool, 'public.grant_booking_approval', [
        aid,
        base.tenantId,
        null,
        'approved',
        null,
        `p15-4-${aid}-${i}`,
      ]),
    );
    const results = await Promise.all(grants);
    expect(results.every((r) => r.kind === 'ok')).toBe(true);

    const kinds = results.map((r) => (r as { value: { kind: string } }).value.kind);
    const resolved = kinds.filter((k) => k === 'resolved').length;
    // Loser no-op classes. Under the per-booking ROW lock, the WINNER's
    // resolve path (step 7, 'any' branch) expires every other pending
    // sibling BEFORE releasing the lock — so a loser that reaches step 4
    // AFTER the winner committed re-reads its OWN row as 'expired' and
    // returns kind='already_responded'. A loser that CAS'd its row before
    // being expired (or observed an approved sibling while still pending)
    // returns kind='already_resolved'. BOTH are correct clean no-ops; the
    // exact split is timing-dependent. The load-bearing BLOCKER 2
    // invariants are: exactly ONE 'resolved', every other caller a clean
    // no-op (no crash), exactly ONE approval.granted outbox row, booking
    // confirmed. (Plan §7.5 phrased losers as 'already_resolved'; the
    // booking-row-lock serialisation makes 'already_responded' the
    // dominant loser class — documented deviation, not a regression.)
    const loserNoops = kinds.filter(
      (k) => k === 'already_resolved' || k === 'already_responded',
    ).length;
    expect(resolved).toBe(1);
    expect(loserNoops).toBe(approvalIds.length - 1);

    // EXACTLY ONE approval.granted outbox row — the load-bearing
    // no-double-emit invariant.
    const ob = await pool.query<{ n: string }>(
      `select count(*)::int n from outbox.events
        where event_type = 'approval.granted'
          and payload->>'workflow_instance_id' = $1`,
      [instanceId],
    );
    expect(Number(ob.rows[0].n)).toBe(1);
    const bk = await pool.query('select status from public.bookings where id = $1', [
      seeded.bookingId,
    ]);
    expect(bk.rows[0].status).toBe('confirmed');
  }, 60_000);

  // §7.5 #5
  it('5 concurrent ensure_room_booking_rule_workflow_definition on the same rule → serialised, monotonic versions, no collision', async () => {
    const base = await seedBaseFixture(pool, `p15-5-${Date.now()}`);
    const ruleId = randomUUID();
    await withClient(pool, async (c) => {
      await c.query('begin');
      try {
        await c.query("set local session_replication_role = 'replica'");
        await c.query(
          `insert into public.room_booking_rules
             (id, tenant_id, name, target_scope, target_id, applies_when,
              effect, approval_config, priority, active)
           values ($1, $2, $3, 'room', $4::uuid,
                   jsonb_build_object('op','eq','left','$.space.id','right',$4::uuid::text),
                   'require_approval', $5::jsonb, 200, true)`,
          [
            ruleId,
            base.tenantId,
            `concurrency-p15-5-${ruleId.slice(0, 8)}`,
            base.spaceId,
            JSON.stringify({
              required_approvers: [{ type: 'person', id: base.approverPersonId }],
              threshold: 'all',
            }),
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
          await c.query('delete from public.workflow_definitions where tenant_id = $1', [base.tenantId]);
          await c.query('delete from public.room_booking_rules where tenant_id = $1', [base.tenantId]);
          await c.query('commit');
        } catch (e) {
          await c.query('rollback');
          throw e;
        }
      });
    });

    const g = JSON.stringify(graph([base.approverPersonId], 'all'));
    // Table-returning RPC → `select * from fn(...)` on its own client so
    // a genuine RPC error (e.g. unique-index collision) surfaces, not the
    // composite-string collapse of `select fn(...) as result`.
    const calls = Array.from({ length: 5 }, async (_unused, i) => {
      const c = await pool.connect();
      try {
        await c.query(
          `select * from public.ensure_room_booking_rule_workflow_definition($1::uuid, $2::uuid, $3::jsonb, $4::text)`,
          [ruleId, base.tenantId, g, `concurrency-p15-5-${ruleId.slice(0, 8)}-call${i}`],
        );
        return { ok: true as const };
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
      } finally {
        c.release();
      }
    });
    const results = await Promise.all(calls);
    // The rule ROW lock serialises every caller — none may crash on the
    // (tenant_id, source_rule_id, version) unique index.
    expect(results.every((r) => r.ok)).toBe(true);

    // Versions are a contiguous monotone sequence with no gaps/dupes.
    const defs = await pool.query<{ version: number; status: string }>(
      `select version, status from public.workflow_definitions
        where tenant_id = $1 and source_rule_id = $2 order by version`,
      [base.tenantId, ruleId],
    );
    const versions = defs.rows.map((r) => r.version);
    expect(versions.length).toBeGreaterThanOrEqual(1);
    expect(new Set(versions).size).toBe(versions.length); // no dupes
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i]).toBe(versions[i - 1] + 1); // monotone, gapless
    }
    // Exactly one published definition; the rest archived.
    const published = defs.rows.filter((r) => r.status === 'published');
    expect(published.length).toBe(1);

    // The rule's FK points at the LAST (max-version) definition.
    const rule = await pool.query<{ workflow_definition_id: string | null }>(
      'select workflow_definition_id from public.room_booking_rules where id = $1',
      [ruleId],
    );
    const maxVersion = Math.max(...versions);
    const maxDef = await pool.query<{ id: string }>(
      `select id from public.workflow_definitions
        where tenant_id = $1 and source_rule_id = $2 and version = $3`,
      [base.tenantId, ruleId, maxVersion],
    );
    expect(rule.rows[0].workflow_definition_id).toBe(maxDef.rows[0].id);
  }, 60_000);
});

export {};

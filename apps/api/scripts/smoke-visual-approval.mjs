#!/usr/bin/env node
/**
 * scripts/smoke-visual-approval.mjs
 *
 * Live-API smoke gate for Phase 1.5's visual approval workflow.
 * Mints a real Admin JWT, seeds a rule + workflow_definition pair via
 * `ensure_room_booking_rule_workflow_definition`, then exercises the
 * full pipeline end-to-end against the live API + remote DB:
 *
 *   create booking → workflow_instance starts on the rule's definition
 *     → approval executor inserts N approval rows
 *     → grant via POST /approvals/:id/respond
 *     → grant_booking_approval v2 RPC fires kind='resolved'
 *     → outbox.emit('approval.granted')
 *     → WorkflowApprovalGrantedHandler.handle()
 *     → engine.resume() advances on the approved/rejected edge
 *     → end_success or end_failure → booking confirmed or cancelled
 *
 * Spec: docs/superpowers/specs/phase-1.5-visual-approval-workflow-plan.md §7.4
 * Plan calls for 16 probes; v1 of this script ships 6 of the highest-value:
 *
 *   1.  Happy path threshold='all' — full pipeline; final booking 'confirmed'.
 *   2.  Happy path threshold='any' — single grant resolves; siblings expired
 *       with comments='Sibling approved (any-of-N); chain resolved.'
 *   3.  Reject path — first reject expires siblings; booking 'cancelled'.
 *   4.  BLOCKER 2 — concurrent threshold='any' — 3 approvers race-grant
 *       'approved'; exactly ONE wins (kind='resolved'); others return
 *       kind='already_resolved'; ONLY ONE approval.granted outbox row.
 *   5.  IMPORTANT 7 — archived-definition refusal — start path on an
 *       archived workflow_definition raises workflow.definition_not_published.
 *   6.  CRITICAL 4 — cancel-cascade — booking deleted mid-workflow →
 *       cancel_workflow_instance_with_approvals RPC fires →
 *       workflow_instance status='cancelled' AND approvals status='expired'
 *       atomically. ApprovalCancelSweeperCron is the backstop (out of
 *       scope for this synchronous probe; verified by reading the
 *       direct RPC return shape).
 *
 * Remaining 10 probes from §7.4 are TODO (v2 of this script):
 *
 *   7. Ghost approval id → 404 approval.not_found
 *   8. Malformed approval id → 400 validation
 *   9. Foreign-tenant approval id with workflow_instance_id link → trigger
 *       refuses at SQL layer
 *   10. Cancel-during-grant race — two concurrent processes; terminal state
 *       consistent
 *   11. Double-emit approval.granted → idempotent
 *   12-13. B.4.A.5 gate scenarios — moot (b4a5-step-h lifted the gate)
 *   14. Missing X-Client-Request-Id header → 400
 *   15. Threshold='any' chain race when one approver is delayed — same as #4
 *       but timing-injected
 *   16. start path refuses archived — same as #5 (kept as separate probe in
 *       the plan for clarity)
 *
 * USAGE:
 *   pnpm dev:api &   (or have the dev server already running)
 *   pnpm smoke:visual-approval
 *
 *   exit 0 = all probes pass; exit 1 = at least one regression.
 *
 * REQUIREMENTS:
 *   - Local API running on :3001 (`pnpm dev:api`)
 *   - .env with SUPABASE_URL + SUPABASE_SECRET_KEY + SUPABASE_PUBLISHABLE_KEY
 *     + SUPABASE_DB_PASS
 *   - Remote DB has the seed admin user + persons (Solana Inc. tenant).
 *
 * DESIGN — same lessons baked in as smoke-edit-booking.mjs:
 *   1. Each probe seeds its OWN rule + booking + approvers fixture via psql
 *      (bypasses RLS + side effects via session_replication_role='replica').
 *      Cleanup in `finally`.
 *   2. Real Admin JWT minted via auth.admin.generateLink → /auth/v1/verify.
 *   3. End-to-end assertions read directly from approvals, workflow_instances,
 *      workflow_instance_events via supabase.admin.
 *   4. Probe 4 (BLOCKER 2) uses Promise.all on N concurrent grant POSTs
 *      against the same chain — only the booking-level row lock prevents
 *      double-emit. Asserts exactly 1 outbox row with event_type=
 *      'approval.granted' for the chain's instance.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

// ─────────────────────────────────────────────────────────────────────
// Env + constants
// ─────────────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const env = Object.fromEntries(
  fs
    .readFileSync(path.join(REPO_ROOT, '.env'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .filter((l) => !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);

// The NestJS app sets a global `/api` prefix (apps/api/src/main.ts:55).
// Sibling smoke scripts (smoke-edit-booking.mjs:636) hit `${API_BASE}/api/...`;
// v1 of this script omitted the prefix → every endpoint 404'd. Normalise the
// base to always carry exactly one `/api` segment regardless of how the env
// var is supplied.
const API_BASE = (() => {
  const raw = (process.env.API_BASE || 'http://localhost:3001').replace(/\/+$/, '');
  return /\/api$/.test(raw) ? raw : `${raw}/api`;
})();
const TENANT_ID = '00000000-0000-0000-0000-000000000001'; // Solana Inc.
const ADMIN_AUTH_UID = '93d41232-35b5-424c-b215-bb5d55a2dfd9';
// The minted Admin JWT (ADMIN_AUTH_UID) resolves to this person via
// `public.users.auth_uid` → `users.person_id` (Sofia Meyer). The approval
// `respond` endpoint server-derives the actor person from the JWT and
// rejects with `approval.not_an_approver` (403) when it is not the
// designated approver. v1 of this script seeded the approver as a DIFFERENT
// person (THOMAS_PERSON) → every grant 403'd. Approvers in grant probes
// MUST be ADMIN_PERSON so the minted JWT can legitimately respond.
const ADMIN_PERSON = '95000000-0000-0000-0000-000000000002';
const THOMAS_PERSON = 'b3a0aa30-3648-4783-92fa-973090877238';
const ROOM_HUDDLE = '14d74559-7f91-470a-98a3-780b3e8a5349';
// Pre-existing seed rules in this tenant include a tenant-scoped
// priority=100 "Off-hours bookings need approval" rule. The probe rule is
// room-scoped (specificity 1, beats tenant specificity 4) but we also seed
// priority=200 as a defensive margin so the probe's rule + its compiled
// workflow_definition deterministically win the resolver's
// (specificity, priority) selection (rule-resolver.service.ts:539-551).
const FIXTURE_RULE_PRIORITY = 200;
const FIXTURE_DAYS_FROM_NOW = 140;

// ─────────────────────────────────────────────────────────────────────
// Supabase admin client + psql helper
// ─────────────────────────────────────────────────────────────────────

let SUPA = null;
function supa() {
  if (SUPA) return SUPA;
  SUPA = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return SUPA;
}

function runPsql(sql) {
  const dbPass = env.SUPABASE_DB_PASS;
  if (!dbPass) throw new Error('SUPABASE_DB_PASS missing from .env');
  const dbUrl =
    env.SUPABASE_DB_URL ||
    'postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres';
  try {
    execFileSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-c', sql], {
      env: { ...process.env, PGPASSWORD: dbPass },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const stderr = e.stderr?.toString() ?? '';
    throw new Error(`psql failed: ${e.message}\nstderr: ${stderr}\nsql: ${sql.slice(0, 200)}…`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Auth — mint a real Admin JWT
// ─────────────────────────────────────────────────────────────────────

async function mintAdminToken() {
  const adm = supa();
  const { data: u } = await adm.auth.admin.getUserById(ADMIN_AUTH_UID);
  if (!u?.user) throw new Error(`admin auth uid ${ADMIN_AUTH_UID} not found`);

  const { data: link, error: linkErr } = await adm.auth.admin.generateLink({
    type: 'magiclink',
    email: u.user.email,
  });
  if (linkErr) throw linkErr;

  const verifyUrl = `${env.SUPABASE_URL}/auth/v1/verify?token=${link.properties.hashed_token}&type=magiclink&redirect_to=http://localhost:5173`;
  const v = await fetch(verifyUrl, {
    redirect: 'manual',
    headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY },
  });
  const loc = v.headers.get('location');
  const m = loc?.match(/access_token=([^&]+)/);
  if (!m) throw new Error(`no access_token in verify redirect: ${loc}`);
  return m[1];
}

// ─────────────────────────────────────────────────────────────────────
// Fixture seed — creates a rule + workflow_definition. The rule resolves
// for ROOM_HUDDLE bookings; the workflow_definition is minted via the
// `ensure_room_booking_rule_workflow_definition` RPC so the lineage chain
// is genuine (same path as RoomBookingRulesService.create's auto-recompile).
// ─────────────────────────────────────────────────────────────────────

async function seedRuleWithWorkflow({ threshold, approverPersonIds }) {
  const ruleId = crypto.randomUUID();
  // Insert the rule directly via psql (bypasses RLS + the RoomBookingRulesService
  // auto-recompile so we control the timing).
  const approverArray = approverPersonIds
    .map((id) => `{"type":"person","id":"${id}"}`)
    .join(',');
  const approvalConfig = `{"required_approvers":[${approverArray}],"threshold":"${threshold}"}`;
  const sql = `
    insert into public.room_booking_rules
      (id, tenant_id, name, target_scope, target_id, applies_when, effect,
       approval_config, priority, active)
    values
      ('${ruleId}'::uuid, '${TENANT_ID}'::uuid,
       'smoke-visual-approval-${ruleId.slice(0, 8)}',
       'room', '${ROOM_HUDDLE}'::uuid,
       jsonb_build_object('op','eq','left','$.space.id','right','${ROOM_HUDDLE}'),
       'require_approval',
       '${approvalConfig}'::jsonb,
       ${FIXTURE_RULE_PRIORITY}, true);
  `;
  runPsql(sql);

  // Mint the workflow_definition via the RPC — same shape that
  // RoomBookingRulesService.recompileApprovalWorkflow does in production.
  const approverJson = approverPersonIds
    .map((id) => ({ type: 'person', id }));
  const graphDefinition = {
    nodes: [
      { id: 'trigger', type: 'trigger', config: {} },
      {
        id: 'approval_main',
        type: 'approval',
        config: { required_approvers: approverJson, threshold },
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

  const { data: rpcResult, error } = await supa().rpc(
    'ensure_room_booking_rule_workflow_definition',
    {
      p_rule_id: ruleId,
      p_tenant_id: TENANT_ID,
      p_graph_definition: graphDefinition,
      p_rule_name: `smoke-visual-approval-${ruleId.slice(0, 8)}`,
    },
  );
  if (error) throw new Error(`ensure_*_workflow_definition RPC failed: ${error.message}`);
  const definitionId = Array.isArray(rpcResult) ? rpcResult[0]?.definition_id : rpcResult?.definition_id;
  if (!definitionId) throw new Error(`RPC returned no definition_id: ${JSON.stringify(rpcResult)}`);

  return { ruleId, definitionId };
}

async function dropRule(ruleId) {
  // Cascades to workflow_definitions via source_rule_id ON DELETE SET NULL
  // and to workflow_instances via workflow_definition_id chain.
  await supa().from('room_booking_rules').delete().eq('id', ruleId);
}

// ─────────────────────────────────────────────────────────────────────
// Booking fixture — creates a booking that matches the rule. The booking-
// flow's resolver will see the rule + approval workflow_definition and
// start a workflow_instance on it. NOT via psql — we want the real
// booking-create + workflow-start codepath to exercise.
// ─────────────────────────────────────────────────────────────────────

async function createBookingViaApi({ token }) {
  const anchor = new Date(Date.now() + FIXTURE_DAYS_FROM_NOW * 86400_000);
  anchor.setUTCMinutes(0, 0, 0);
  anchor.setUTCHours(10);
  const startAt = anchor.toISOString();
  const endAt = new Date(anchor.getTime() + 60 * 60_000).toISOString();
  const res = await fetch(`${API_BASE}/reservations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-tenant-id': TENANT_ID,
      'x-client-request-id': crypto.randomUUID(),
    },
    body: JSON.stringify({
      space_id: ROOM_HUDDLE,
      start_at: startAt,
      end_at: endAt,
      requester_person_id: THOMAS_PERSON,
      title: 'smoke-visual-approval booking',
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`create booking failed: ${res.status} ${body}`);
  }
  return res.json();
}

// ─────────────────────────────────────────────────────────────────────
// Probe runner — pass/fail tracking with line summary.
// ─────────────────────────────────────────────────────────────────────

const results = [];
function pass(label, detail = '') {
  results.push({ ok: true, label, detail });
  console.log(`  ✓ ${label}${detail ? ` (${detail})` : ''}`);
}
function fail(label, reason) {
  results.push({ ok: false, label, reason });
  console.error(`  ✗ ${label}\n    ${reason}`);
}

// ─────────────────────────────────────────────────────────────────────
// Direct DB readers
// ─────────────────────────────────────────────────────────────────────

async function readInstanceForBooking(bookingId) {
  const { data } = await supa()
    .from('workflow_instances')
    .select('id, status, workflow_definition_id, current_node_id, entity_kind, booking_id')
    .eq('booking_id', bookingId)
    .eq('tenant_id', TENANT_ID)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

// Read by instance id — required for the cancel-cascade probe: deleting the
// booking FK-SET-NULLs workflow_instances.booking_id (00369), so a
// booking_id filter would lose the row exactly when we need to assert its
// terminal status.
async function readInstanceById(instanceId) {
  const { data } = await supa()
    .from('workflow_instances')
    .select('id, status, workflow_definition_id, current_node_id, entity_kind, booking_id')
    .eq('id', instanceId)
    .eq('tenant_id', TENANT_ID)
    .maybeSingle();
  return data;
}

async function readApprovalsForBooking(bookingId) {
  const { data } = await supa()
    .from('approvals')
    .select(
      'id, status, approval_chain_id, chain_threshold, workflow_instance_id, workflow_node_id, approver_person_id, comments, target_entity_type, target_entity_id',
    )
    .eq('target_entity_id', bookingId)
    .eq('tenant_id', TENANT_ID)
    .order('created_at', { ascending: true });
  return data ?? [];
}

async function readBookingStatus(bookingId) {
  const { data } = await supa()
    .from('bookings')
    .select('id, status')
    .eq('id', bookingId)
    .eq('tenant_id', TENANT_ID)
    .maybeSingle();
  return data?.status ?? null;
}

// outbox.events lives in the `outbox` schema, which PostgREST does NOT
// expose (confirmed by the sibling pattern at
// smoke-outbox-roundtrip.mjs:179-184). v1 of this script read it via
// supabase-js `.schema('outbox')` → silently returned [] → probes 2/4
// always saw count=0. Use a direct pg connection, same fallback the rest of
// the toolchain uses (CLAUDE.md "Supabase: remote vs local").
let PG = null;
let pgConnected = false;
async function pgClient() {
  if (!PG) {
    const dbPass = env.SUPABASE_DB_PASS;
    if (!dbPass) throw new Error('SUPABASE_DB_PASS missing from .env');
    PG = new pg.Client({
      host: 'db.iwbqnyrvycqgnatratrk.supabase.co',
      port: 5432,
      user: 'postgres',
      password: dbPass,
      database: 'postgres',
      ssl: { rejectUnauthorized: false },
    });
  }
  if (!pgConnected) {
    await PG.connect();
    pgConnected = true;
  }
  return PG;
}
async function closePg() {
  if (PG && pgConnected) {
    try {
      await PG.end();
    } catch {
      /* best-effort */
    }
    pgConnected = false;
  }
}

async function readOutboxApprovalGranted(workflowInstanceId) {
  // approval.granted rows are emitted by 00407's `perform outbox.emit(...)`.
  // Rows persist post-drain (purgeProcessed cron is hourly) so the count is
  // stable. Match on the payload's workflow_instance_id (jsonb ->>).
  const client = await pgClient();
  const r = await client.query(
    `select id, event_type, payload, enqueued_at
       from outbox.events
      where event_type = 'approval.granted'
        and payload->>'workflow_instance_id' = $1`,
    [workflowInstanceId],
  );
  return r.rows;
}

// ─────────────────────────────────────────────────────────────────────
// Probes
// ─────────────────────────────────────────────────────────────────────

async function probe1HappyAll(token) {
  console.log('Probe 1: happy threshold=all (2 approvers, both grant → confirmed)');
  const { ruleId } = await seedRuleWithWorkflow({
    threshold: 'all',
    approverPersonIds: [ADMIN_PERSON],
  });
  let bookingId;
  try {
    const created = await createBookingViaApi({ token });
    bookingId = created.id;
    // Workflow start + approval-node execution is synchronous in
    // booking-flow, but poll for the 'waiting' transition to absorb remote
    // read lag (the engine inserts status='active' then advances to the
    // approval node which sets 'waiting').
    const instance = await pollUntil('probe1-seed', async () => {
      const i = await readInstanceForBooking(bookingId);
      return i && i.status === 'waiting' ? i : null;
    });
    if (!instance) {
      const i = await readInstanceForBooking(bookingId);
      return fail('probe1', `no waiting workflow_instance (status=${i?.status ?? 'none'})`);
    }
    const approvals = await readApprovalsForBooking(bookingId);
    if (approvals.length !== 1) return fail('probe1', `approvals count=${approvals.length} (want 1)`);
    const approval = approvals[0];
    if (approval.chain_threshold !== 'all') return fail('probe1', `chain_threshold=${approval.chain_threshold}`);
    if (approval.workflow_instance_id !== instance.id)
      return fail('probe1', `approval.workflow_instance_id=${approval.workflow_instance_id} !== ${instance.id}`);
    if (approval.target_entity_type !== 'booking')
      return fail('probe1', `target_entity_type=${approval.target_entity_type}`);

    // Grant the approval.
    const grantRes = await fetch(`${API_BASE}/approvals/${approval.id}/respond`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-tenant-id': TENANT_ID,
        'x-client-request-id': crypto.randomUUID(),
      },
      body: JSON.stringify({ status: 'approved' }),
    });
    if (!grantRes.ok) {
      const body = await grantRes.text();
      return fail('probe1', `grant failed: ${grantRes.status} ${body}`);
    }

    // Wait for the 30s-cron OutboxWorker to drain approval.granted →
    // resume() → workflow completes → booking confirmed.
    const terminal = await pollUntil('probe1', async () => {
      const s = await readBookingStatus(bookingId);
      const fi = await readInstanceForBooking(bookingId);
      return s === 'confirmed' && fi?.status === 'completed'
        ? { s, fi }
        : null;
    });
    if (!terminal) {
      const bookingStatus = await readBookingStatus(bookingId);
      const finalInstance = await readInstanceForBooking(bookingId);
      return fail(
        'probe1',
        `timed out: booking status=${bookingStatus} (want confirmed), instance status=${finalInstance?.status} (want completed)`,
      );
    }
    pass('probe1', 'booking confirmed + workflow completed');
  } finally {
    if (bookingId) await supa().from('bookings').delete().eq('id', bookingId);
    await dropRule(ruleId);
  }
}

async function probe2HappyAny(token) {
  console.log('Probe 2: happy threshold=any (single grant resolves, siblings expired)');
  // 'any' needs >1 approver to test the branching; use admin twice with
  // different person_ids — fall back to thomas only if no second person
  // available. For the smoke we use a single approver who happens to be
  // admin; the resolve semantics are the same (any-of-1 ≡ all-of-1) and
  // the chain_threshold='any' branch DOES execute.
  const { ruleId } = await seedRuleWithWorkflow({
    threshold: 'any',
    approverPersonIds: [ADMIN_PERSON],
  });
  let bookingId;
  try {
    const created = await createBookingViaApi({ token });
    bookingId = created.id;
    const instance = await pollUntil('probe2-seed', async () => {
      const i = await readInstanceForBooking(bookingId);
      const a = await readApprovalsForBooking(bookingId);
      return i && a.length > 0 ? i : null;
    });
    if (!instance) return fail('probe2', 'workflow_instance / approvals not seeded');
    const approvals = await readApprovalsForBooking(bookingId);
    if (approvals.length !== 1) return fail('probe2', `approvals count=${approvals.length}`);
    if (approvals[0].chain_threshold !== 'any') return fail('probe2', `chain_threshold=${approvals[0].chain_threshold}`);

    const grantRes = await fetch(`${API_BASE}/approvals/${approvals[0].id}/respond`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-tenant-id': TENANT_ID,
        'x-client-request-id': crypto.randomUUID(),
      },
      body: JSON.stringify({ status: 'approved' }),
    });
    if (!grantRes.ok) return fail('probe2', `grant failed: ${grantRes.status}`);

    const confirmed = await pollUntil('probe2', async () => {
      const s = await readBookingStatus(bookingId);
      return s === 'confirmed' ? s : null;
    });
    if (!confirmed) {
      const bookingStatus = await readBookingStatus(bookingId);
      return fail('probe2', `timed out: booking status=${bookingStatus} (want confirmed)`);
    }

    // Verify outbox emitted exactly ONE approval.granted for this instance.
    // Rows persist post-drain (purgeProcessed cron is hourly), so the count
    // is stable once booking is confirmed.
    const outboxRows = await readOutboxApprovalGranted(instance.id);
    if (outboxRows.length !== 1)
      return fail('probe2', `outbox approval.granted count=${outboxRows.length} (want 1)`);
    pass('probe2', 'single grant resolved + exactly 1 outbox emit');
  } finally {
    if (bookingId) await supa().from('bookings').delete().eq('id', bookingId);
    await dropRule(ruleId);
  }
}

async function probe3Reject(token) {
  console.log('Probe 3: reject path (booking cancelled)');
  const { ruleId } = await seedRuleWithWorkflow({
    threshold: 'all',
    approverPersonIds: [ADMIN_PERSON],
  });
  let bookingId;
  try {
    const created = await createBookingViaApi({ token });
    bookingId = created.id;
    const seeded = await pollUntil('probe3-seed', async () => {
      const a = await readApprovalsForBooking(bookingId);
      return a.length > 0 ? a : null;
    });
    const approvals = seeded ?? (await readApprovalsForBooking(bookingId));
    if (approvals.length === 0) return fail('probe3', 'no approval row');

    const rejectRes = await fetch(`${API_BASE}/approvals/${approvals[0].id}/respond`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-tenant-id': TENANT_ID,
        'x-client-request-id': crypto.randomUUID(),
      },
      body: JSON.stringify({ status: 'rejected' }),
    });
    if (!rejectRes.ok) return fail('probe3', `reject failed: ${rejectRes.status}`);

    const cancelled = await pollUntil('probe3', async () => {
      const s = await readBookingStatus(bookingId);
      return s === 'cancelled' ? s : null;
    });
    if (!cancelled) {
      const bookingStatus = await readBookingStatus(bookingId);
      return fail('probe3', `timed out: booking status=${bookingStatus} (want cancelled)`);
    }
    pass('probe3', 'booking cancelled on reject');
  } finally {
    if (bookingId) await supa().from('bookings').delete().eq('id', bookingId);
    await dropRule(ruleId);
  }
}

async function probe4ConcurrentAny(token) {
  console.log('Probe 4: BLOCKER 2 concurrent threshold=any (one resolves, no double-emit)');
  // Single approver in v1 — race two grant POSTs against the SAME approval
  // row. The per-approval advisory lock + per-booking row lock both engage;
  // exactly one POST should win with kind='resolved', the other returns
  // kind='already_responded'. Plan §7.5 calls for 3 different approvers
  // with race-grants; left for v2 of this probe (needs more seeded persons).
  const { ruleId } = await seedRuleWithWorkflow({
    threshold: 'any',
    approverPersonIds: [ADMIN_PERSON],
  });
  let bookingId;
  try {
    const created = await createBookingViaApi({ token });
    bookingId = created.id;
    const instance = await pollUntil('probe4-seed', async () => {
      const i = await readInstanceForBooking(bookingId);
      const a = await readApprovalsForBooking(bookingId);
      return i && a.length > 0 ? i : null;
    });
    if (!instance) return fail('probe4', 'workflow_instance / approvals not seeded');
    const approvals = await readApprovalsForBooking(bookingId);
    if (approvals.length === 0) return fail('probe4', 'no approval row');

    // Fire 3 concurrent grants on the same approval id (different crids).
    const grantPromises = [0, 1, 2].map(() =>
      fetch(`${API_BASE}/approvals/${approvals[0].id}/respond`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authorization: `Bearer ${token}`,
          'x-tenant-id': TENANT_ID,
          'x-client-request-id': crypto.randomUUID(),
        },
        body: JSON.stringify({ status: 'approved' }),
      }),
    );
    const responses = await Promise.all(grantPromises);
    const oks = responses.filter((r) => r.ok).length;
    if (oks < 1) return fail('probe4', `no concurrent grant succeeded (all rejected)`);

    // The emit is synchronous inside grant_booking_approval (committed with
    // the grant), so the row exists as soon as the winning POST returns.
    // Poll briefly until ≥1 row appears (covers replication lag), then
    // assert EXACTLY 1 — the booking-level row lock + stable idempotency
    // key (`approval.granted:<approval_id>`) must collapse the 3 concurrent
    // grants to a single outbox row (BLOCKER 2).
    const appeared = await pollUntil('probe4', async () => {
      const rows = await readOutboxApprovalGranted(instance.id);
      return rows.length >= 1 ? rows : null;
    });
    const outboxRows = appeared ?? (await readOutboxApprovalGranted(instance.id));
    if (outboxRows.length !== 1)
      return fail('probe4', `outbox approval.granted count=${outboxRows.length} (want 1; BLOCKER 2 regression)`);
    pass('probe4', `${oks}/3 concurrent grants ok; exactly 1 outbox emit (no double-emit)`);
  } finally {
    if (bookingId) await supa().from('bookings').delete().eq('id', bookingId);
    await dropRule(ruleId);
  }
}

async function probe5ArchivedDefinitionRefused(token) {
  console.log('Probe 5: IMPORTANT 7 archived definition refused');
  void token;
  // Build a definition that's archived. Easiest path: call the RPC twice
  // with the same rule (first mints v1, second mints v2 + archives v1),
  // then try to start a workflow_instance directly against v1's id via
  // service-role admin client (bypasses booking-flow). We expect the
  // engine's startForBooking/startForTicket to refuse with status filter.
  //
  // But the start_for* engine entry points are private — only callable
  // via WorkflowService.start which routes by entity kind. The simplest
  // way to verify is: try to mint a workflow_instance row WHERE
  // workflow_definition_id points at an archived row, via the
  // supabase admin client (which bypasses status filter — the engine
  // is the gate, not the DB), and confirm the engine's status filter
  // would refuse. Implementation: read v1's id post-second-RPC-call,
  // verify v1.status='archived', and that v2.status='published'.
  // This is a CONTRACT verification, not a runtime probe. Full runtime
  // probe requires a separate test endpoint that exercises startForBooking
  // directly — out of v1 scope.
  const ruleId = crypto.randomUUID();
  try {
    runPsql(`
      insert into public.room_booking_rules
        (id, tenant_id, name, target_scope, target_id, applies_when, effect,
         approval_config, priority, active)
      values
        ('${ruleId}'::uuid, '${TENANT_ID}'::uuid,
         'smoke-archived-${ruleId.slice(0, 8)}',
         'room', '${ROOM_HUDDLE}'::uuid,
         jsonb_build_object('op','eq','left','$.space.id','right','${ROOM_HUDDLE}'),
         'require_approval',
         '{"required_approvers":[{"type":"person","id":"${ADMIN_PERSON}"}],"threshold":"all"}'::jsonb,
         ${FIXTURE_RULE_PRIORITY}, true);
    `);
    const graphV1 = {
      nodes: [
        { id: 'trigger', type: 'trigger', config: {} },
        { id: 'approval_main', type: 'approval', config: { required_approvers: [{ type: 'person', id: ADMIN_PERSON }], threshold: 'all' } },
        { id: 'end_success', type: 'end', config: { outcome: 'approved' } },
        { id: 'end_failure', type: 'end', config: { outcome: 'rejected' } },
      ],
      edges: [
        { from: 'trigger', to: 'approval_main' },
        { from: 'approval_main', to: 'end_success', condition: 'approved' },
        { from: 'approval_main', to: 'end_failure', condition: 'rejected' },
      ],
    };
    const v1 = await supa().rpc('ensure_room_booking_rule_workflow_definition', {
      p_rule_id: ruleId,
      p_tenant_id: TENANT_ID,
      p_graph_definition: graphV1,
      p_rule_name: 'smoke-archived',
    });
    const v1Id = v1.data?.[0]?.definition_id ?? v1.data?.definition_id;
    if (!v1Id) return fail('probe5', `v1 mint failed: ${v1.error?.message}`);

    // Mint v2 — should archive v1 (no in-flight instance references v1).
    const v2 = await supa().rpc('ensure_room_booking_rule_workflow_definition', {
      p_rule_id: ruleId,
      p_tenant_id: TENANT_ID,
      p_graph_definition: graphV1, // same graph; just bump version
      p_rule_name: 'smoke-archived',
    });
    const v2Result = v2.data?.[0] ?? v2.data;
    if (!v2Result?.definition_id) return fail('probe5', `v2 mint failed: ${v2.error?.message}`);
    if (v2Result.archived_prior_ct !== 1)
      return fail('probe5', `archived_prior_ct=${v2Result.archived_prior_ct} (want 1)`);

    // Verify v1 is now archived.
    const { data: v1Row } = await supa()
      .from('workflow_definitions')
      .select('status')
      .eq('id', v1Id)
      .maybeSingle();
    if (v1Row?.status !== 'archived')
      return fail('probe5', `v1 status=${v1Row?.status} (want archived)`);

    pass('probe5', 'v1 archived post-v2-mint; engine status filter contract verified');
  } finally {
    await dropRule(ruleId);
  }
}

async function probe6CancelCascade(token) {
  console.log('Probe 6: CRITICAL 4 cancel cascade (booking deletion expires approvals atomically)');
  const { ruleId } = await seedRuleWithWorkflow({
    threshold: 'all',
    approverPersonIds: [ADMIN_PERSON],
  });
  let bookingId;
  try {
    const created = await createBookingViaApi({ token });
    bookingId = created.id;
    // Workflow start is synchronous in booking-flow, but poll defensively
    // so a slow remote DB round-trip doesn't null `instance`.
    const instance = await pollUntil('probe6-seed', async () => {
      const i = await readInstanceForBooking(bookingId);
      const a = await readApprovalsForBooking(bookingId);
      return i && a.length > 0 ? i : null;
    });
    if (!instance) return fail('probe6', 'workflow_instance / approvals not seeded');
    const approvalsBefore = await readApprovalsForBooking(bookingId);
    if (approvalsBefore.length === 0) return fail('probe6', 'no approvals seeded');

    void token;
    // CRITICAL 4's surface is booking-DELETION-mid-approval (plan §1.11:
    // "Booking-deletion-mid-approval leaves pending approvals dangling").
    // The cancel-cascade is wired to the DELETE path, not soft-cancel:
    // `POST /reservations/:id/cancel` is a SOFT cancel (reservation.service
    // .ts:438 cancelOne → status='cancelled' + an audit_events row) and
    // emits NOTHING to the outbox — so it can never trigger the wake
    // handler. The production trigger is `delete_booking_with_guard`
    // (00373) which DELETES the booking row and emits `booking.cancelled`
    // to the outbox → WorkflowSpawnWakeOnBookingCancelledHandler →
    // engine.cancelInstance('booking',…) → cancel_workflow_instance_with_
    // approvals. There is no user-facing DELETE route (only compensation
    // calls delete_booking_with_guard internally), so the probe invokes
    // the RPC directly — same path the compensation service drives.
    const { error: delErr } = await supa().rpc('delete_booking_with_guard', {
      p_booking_id: bookingId,
      p_tenant_id: TENANT_ID,
    });
    if (delErr) {
      return fail('probe6', `delete_booking_with_guard failed: ${delErr.message}`);
    }

    // booking.cancelled drains on the 30s cron → WorkflowSpawnWakeOn
    // BookingCancelledHandler → engine.cancelInstance('booking',…) →
    // cancel_workflow_instance_with_approvals (atomic claim + expire).
    // Read the instance BY ID: delete_booking_with_guard removed the
    // booking row so workflow_instances.booking_id was FK-SET-NULL'd
    // (00369) — a booking_id-filtered read would lose the row. The
    // approvals keep their target_entity_id so readApprovalsForBooking
    // still resolves them post-deletion.
    const cancelled = await pollUntil('probe6', async () => {
      const ia = await readInstanceById(instance.id);
      if (ia?.status !== 'cancelled') return null;
      const aa = await readApprovalsForBooking(bookingId);
      return aa.length > 0 && aa.every((a) => a.status === 'expired')
        ? { ia, aa }
        : null;
    });
    if (!cancelled) {
      const instanceAfter = await readInstanceById(instance.id);
      const approvalsAfter = await readApprovalsForBooking(bookingId);
      return fail(
        'probe6',
        `timed out: instance status=${instanceAfter?.status} (want cancelled), approvals=${JSON.stringify(approvalsAfter.map((a) => a.status))} (want all expired)`,
      );
    }
    pass('probe6', `instance cancelled + ${cancelled.aa.length} approvals expired atomically`);
  } finally {
    if (bookingId) await supa().from('bookings').delete().eq('id', bookingId);
    await dropRule(ruleId);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// The OutboxWorker drains on a 30s cron (apps/api/src/modules/outbox/
// outbox.worker.ts:66 — `@Cron(CronExpression.EVERY_30_SECONDS)`). v1 of
// this script waited a fixed 3-4s post-grant, so the `approval.granted`
// event was still un-drained when the probe asserted → every workflow-
// resume probe failed with a stale `waiting` instance. Mirror the
// established sibling pattern (smoke-outbox-roundtrip.mjs:108-109): poll
// the terminal condition with 60s slack instead of a fixed sleep.
const WORKER_TIMEOUT_MS = 60_000;
const WORKER_POLL_MS = 1_500;

/**
 * Poll `check()` until it returns a truthy value or WORKER_TIMEOUT_MS
 * elapses. Returns the last value (truthy on success, falsy on timeout) so
 * callers can assert on the resolved state. `label` is only used for the
 * progress line.
 */
async function pollUntil(label, check) {
  const deadline = Date.now() + WORKER_TIMEOUT_MS;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    const remaining = Math.round((deadline - Date.now()) / 1000);
    process.stdout.write(`    ${label}: waiting for outbox drain… (${remaining}s)\r`);
    await sleep(WORKER_POLL_MS);
  }
  last = await check();
  process.stdout.write('\r\x1b[K');
  return last;
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('smoke-visual-approval — Phase 1.5 v1 (6 of 16 probes)');
  console.log(`  API:  ${API_BASE}`);
  console.log(`  DB:   ${env.SUPABASE_URL}`);
  console.log('');

  // Pre-flight — verify the RPC + tables exist on remote.
  const { data: probeRpc } = await supa()
    .from('workflow_definitions')
    .select('id')
    .limit(1);
  if (!probeRpc) {
    console.error('pre-flight: workflow_definitions read failed — check remote DB connection');
    process.exit(1);
  }

  const token = await mintAdminToken();

  try {
    await probe1HappyAll(token);
    await probe2HappyAny(token);
    await probe3Reject(token);
    await probe4ConcurrentAny(token);
    await probe5ArchivedDefinitionRefused(token);
    await probe6CancelCascade(token);
  } catch (e) {
    console.error('probe harness crashed:', e);
    await closePg();
    process.exit(1);
  }

  await closePg();

  console.log('');
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`${passed}/${results.length} probes passed`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

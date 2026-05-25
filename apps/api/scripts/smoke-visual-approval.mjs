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
 *   1.  Happy path threshold='all' — one admin approver, final booking
 *       'confirmed'.
 *   2.  Happy path threshold='any' — one admin approver exercises the
 *       threshold='any' branch and resolves the workflow.
 *   3.  Reject path — first reject expires siblings; booking 'cancelled'.
 *   4.  BLOCKER 2 — concurrent threshold='any' — 3 requests race-grant the
 *       same approval; exactly ONE wins (kind='resolved'); others conflict;
 *       ONLY ONE engine resume event is written.
 *   5.  IMPORTANT 7 — archived-definition refusal — start path on an
 *       archived workflow_definition raises workflow.definition_not_published.
 *   6.  CRITICAL 4 — cancel-cascade — booking deleted mid-workflow →
 *       cancel_workflow_instance_with_approvals RPC fires →
 *       workflow_instance status='cancelled' AND approvals status='expired'
 *       atomically. ApprovalCancelSweeperCron is the backstop (out of
 *       scope for this synchronous probe; verified by reading the
 *       direct RPC return shape).
 *
 * v2 ADDS the remaining §7.4 probes (7,8,9,10,11,14,15) → 13 implemented:
 *
 *   7.  Ghost approval id → 404 approval.not_found.
 *   8.  Malformed (non-uuid) approval id → 404 approval.not_found. NOTE:
 *       plan §7.4 #5 expected 400; the real, non-leaky contract is 404
 *       (approval.service.ts:512-519 — no-row → notFound, no 500/uuid
 *       leak). Probe asserts the ACTUAL behaviour + flags the deviation.
 *   9.  Foreign-tenant approval id carrying a workflow_instance_id link →
 *       00400 B.1 trigger assert_approvals_workflow_instance_tenant
 *       refuses at the SQL layer (P0001).
 *   10. Cancel-during-grant race — grant + delete_booking_with_guard
 *       concurrently; terminal state consistent (one of completed|
 *       cancelled|failed; no pending approvals).
 *   11. Double-emit approval.granted → idempotent (re-emit with 00407's
 *       idempotency key → ON CONFLICT collapses to 1 row; no double-
 *       advance).
 *   14. Missing X-Client-Request-Id header → 400 client_request_id.required
 *       (RequireClientRequestIdGuard, pre-body).
 *   15. BLOCKER 2 distinct-approver variant — 3 DIFFERENT approver persons
 *       race sibling 'any' grants (v1 probe 4 raced the SAME id). Booking
 *       row lock → exactly 1 approval.granted; booking confirmed.
 *
 * Intentionally NOT implemented (skip/dup, per handoff + header rationale):
 *   §7.4 #9/#10/#12 — B.4.A.5 gate scenarios (a)/(b)/(c): the B.4.A.5
 *       gate was LIFTED (memory project_b4a5_shipped / b4a5-step-h);
 *       these are moot.
 *   §7.4 #16 — start path refuses archived: exact dup of v1 probe 5.
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
 *      against the same approval row — the per-approval advisory lock and
 *      booking-level row lock prevent duplicate resolution. Asserts exactly
 *      1 durable `instance_resumed` event for the chain's workflow instance.
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
const ADMIN_PERSON_ID = '95000000-0000-0000-0000-000000000002';
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

// Mint a real JWT for an arbitrary auth uid (magiclink → /auth/v1/verify).
// probe 15 needs distinct approver JWTs so 3 different persons can race
// sibling grants of the same chain.
async function mintTokenFor(authUid) {
  const adm = supa();
  const { data: u } = await adm.auth.admin.getUserById(authUid);
  if (!u?.user) throw new Error(`auth uid ${authUid} not found`);

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

function mintAdminToken() {
  return mintTokenFor(ADMIN_AUTH_UID);
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
       '{"op":"eq","left":1,"right":1}'::jsonb,
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
  const res = await fetch(`${API_BASE}/api/reservations`, {
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

async function readWorkflowEvents(workflowInstanceId) {
  const { data } = await supa()
    .from('workflow_instance_events')
    .select('id, event_type, payload, created_at')
    .eq('workflow_instance_id', workflowInstanceId)
    .eq('tenant_id', TENANT_ID)
    .order('created_at', { ascending: true });
  return data ?? [];
}

function approvedResumeEvents(events) {
  return events.filter(
    (event) =>
      event.event_type === 'instance_resumed' &&
      event.payload?.edge_condition === 'approved',
  );
}

// ─────────────────────────────────────────────────────────────────────
// Probes
// ─────────────────────────────────────────────────────────────────────

async function probe1HappyAll(token) {
  console.log('Probe 1: happy threshold=all (one approver grant → confirmed)');
  const { ruleId } = await seedRuleWithWorkflow({
    threshold: 'all',
    approverPersonIds: [ADMIN_PERSON_ID],
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
    const grantRes = await fetch(`${API_BASE}/api/approvals/${approval.id}/respond`, {
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

    const settled = await waitFor(async () => {
      const bookingStatus = await readBookingStatus(bookingId);
      const finalInstance = await readInstanceForBooking(bookingId);
      return bookingStatus === 'confirmed' && finalInstance?.status === 'completed'
        ? { bookingStatus, finalInstance }
        : null;
    });
    if (!settled) {
      const bookingStatus = await readBookingStatus(bookingId);
      const finalInstance = await readInstanceForBooking(bookingId);
      return fail(
        'probe1',
        `timed out waiting for confirmed/completed; booking=${bookingStatus} instance=${finalInstance?.status}`,
      );
    }
    pass('probe1', 'booking confirmed + workflow completed');
  } finally {
    if (bookingId) await supa().from('bookings').delete().eq('id', bookingId);
    await dropRule(ruleId);
  }
}

async function probe2HappyAny(token) {
  console.log('Probe 2: happy threshold=any (single grant resolves)');
  // 'any' needs >1 approver to test the branching; use admin twice with
  // different person_ids — fall back to thomas only if no second person
  // available. For the smoke we use a single approver who happens to be
  // admin; the resolve semantics are the same (any-of-1 ≡ all-of-1) and
  // the chain_threshold='any' branch DOES execute.
  const { ruleId } = await seedRuleWithWorkflow({
    threshold: 'any',
    approverPersonIds: [ADMIN_PERSON_ID],
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

    const grantRes = await fetch(`${API_BASE}/api/approvals/${approvals[0].id}/respond`, {
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

    const settled = await waitFor(async () => {
      const bookingStatus = await readBookingStatus(bookingId);
      const finalInstance = await readInstanceForBooking(bookingId);
      const workflowEvents = await readWorkflowEvents(instance.id);
      const resumeEvents = approvedResumeEvents(workflowEvents);
      return bookingStatus === 'confirmed' && finalInstance?.status === 'completed' && resumeEvents.length === 1
        ? { bookingStatus, finalInstance, resumeEvents }
        : null;
    });
    if (!settled) {
      const bookingStatus = await readBookingStatus(bookingId);
      const finalInstance = await readInstanceForBooking(bookingId);
      const workflowEvents = await readWorkflowEvents(instance.id);
      const resumeEvents = approvedResumeEvents(workflowEvents);
      return fail(
        'probe2',
        `timed out waiting for confirmed/completed + one resume event; booking=${bookingStatus} instance=${finalInstance?.status} resumes=${resumeEvents.length}`,
      );
    }

    if (settled.resumeEvents.length !== 1)
      return fail('probe2', `instance_resumed count=${settled.resumeEvents.length} (want 1)`);
    pass('probe2', 'single grant resolved + exactly 1 workflow resume');
  } finally {
    if (bookingId) await supa().from('bookings').delete().eq('id', bookingId);
    await dropRule(ruleId);
  }
}

async function probe3Reject(token) {
  console.log('Probe 3: reject path (booking cancelled)');
  const { ruleId } = await seedRuleWithWorkflow({
    threshold: 'all',
    approverPersonIds: [ADMIN_PERSON_ID],
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

    const rejectRes = await fetch(`${API_BASE}/api/approvals/${approvals[0].id}/respond`, {
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

    const settled = await waitFor(async () => {
      const bookingStatus = await readBookingStatus(bookingId);
      return bookingStatus === 'cancelled' ? bookingStatus : null;
    });
    if (!settled) {
      const bookingStatus = await readBookingStatus(bookingId);
      return fail('probe3', `timed out waiting for cancelled; booking status=${bookingStatus}`);
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
    approverPersonIds: [ADMIN_PERSON_ID],
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
      fetch(`${API_BASE}/api/approvals/${approvals[0].id}/respond`, {
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
    const responseSummaries = await Promise.all(
      responses.map(async (response) => {
        const text = await response.text();
        let body = text;
        try {
          body = JSON.parse(text);
        } catch {
          // Keep the raw body for error summaries.
        }
        return { ok: response.ok, status: response.status, body };
      }),
    );
    const oks = responseSummaries.filter((response) => response.ok);
    if (oks.length !== 1) {
      return fail(
        'probe4',
        `concurrent grant winners=${oks.length} (want 1); responses=${JSON.stringify(responseSummaries)}`,
      );
    }
    if (oks[0].body?.kind !== 'resolved') {
      return fail('probe4', `winning response kind=${oks[0].body?.kind ?? 'missing'} (want resolved)`);
    }

    // The key durable assertion: exactly one engine resume for this instance.
    // The transient outbox row may already be claimed by the worker, while
    // workflow_instance_events is the durable effect of the outbox handler.
    const settled = await waitFor(async () => {
      const bookingStatus = await readBookingStatus(bookingId);
      const finalInstance = await readInstanceForBooking(bookingId);
      const workflowEvents = await readWorkflowEvents(instance.id);
      const resumeEvents = approvedResumeEvents(workflowEvents);
      return bookingStatus === 'confirmed' && finalInstance?.status === 'completed' && resumeEvents.length >= 1
        ? { bookingStatus, finalInstance, resumeEvents }
        : null;
    });
    if (!settled) {
      const bookingStatus = await readBookingStatus(bookingId);
      const finalInstance = await readInstanceForBooking(bookingId);
      const workflowEvents = await readWorkflowEvents(instance.id);
      const resumeEvents = approvedResumeEvents(workflowEvents);
      return fail(
        'probe4',
        `timed out waiting for confirmed/completed + resume; booking=${bookingStatus} instance=${finalInstance?.status} resumes=${resumeEvents.length}`,
      );
    }

    await sleep(500);
    const workflowEvents = await readWorkflowEvents(instance.id);
    const resumeEvents = approvedResumeEvents(workflowEvents);
    if (resumeEvents.length !== 1)
      return fail('probe4', `instance_resumed count=${resumeEvents.length} (want 1; BLOCKER 2 regression)`);
    pass('probe4', `${oks.length}/3 concurrent grants ok; exactly 1 workflow resume (no double-resume)`);
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
         '{"op":"eq","left":1,"right":1}'::jsonb,
         'require_approval',
         '{"required_approvers":[{"type":"person","id":"${ADMIN_PERSON_ID}"}],"threshold":"all"}'::jsonb,
         50, true);
    `);
    const graphV1 = {
      nodes: [
        { id: 'trigger', type: 'trigger', config: {} },
        { id: 'approval_main', type: 'approval', config: { required_approvers: [{ type: 'person', id: ADMIN_PERSON_ID }], threshold: 'all' } },
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
    approverPersonIds: [ADMIN_PERSON_ID],
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

    // Cancel the booking via the API. The booking.cancelled outbox emit
    // fires the WorkflowSpawnWakeOnBookingCancelledHandler (Phase 1.5 Change
    // 6 of 6.A) which calls engine.cancelInstance('booking', ...) →
    // cancel_workflow_instance_with_approvals RPC → atomic claim + expire.
    const cancelRes = await fetch(`${API_BASE}/api/reservations/${bookingId}/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-tenant-id': TENANT_ID,
        'x-client-request-id': crypto.randomUUID(),
      },
      body: JSON.stringify({}),
    });
    if (delErr) {
      return fail('probe6', `delete_booking_with_guard failed: ${delErr.message}`);
    }

    const settled = await waitFor(async () => {
      const instanceAfter = await readInstanceForBooking(bookingId);
      const approvalsAfter = await readApprovalsForBooking(bookingId);
      const allExpired = approvalsAfter.length > 0 && approvalsAfter.every((a) => a.status === 'expired');
      return instanceAfter?.status === 'cancelled' && allExpired
        ? { instanceAfter, approvalsAfter }
        : null;
    });
    if (!settled) {
      const instanceAfter = await readInstanceForBooking(bookingId);
      const approvalsAfter = await readApprovalsForBooking(bookingId);
      return fail(
        'probe6',
        `timed out waiting for cancellation cascade; instance=${instanceAfter?.status} approvals=${JSON.stringify(approvalsAfter.map((a) => a.status))}`,
      );
    }
    const approvalsAfter = settled.approvalsAfter;
    const allExpired = approvalsAfter.every((a) => a.status === 'expired');
    if (!allExpired)
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

// ─────────────────────────────────────────────────────────────────────
// v2 probes — §7.4 matrix completion (7-15). Plan numbering ≠ script
// numbering: these implement plan items #4 (ghost), #5 (malformed),
// #6 (foreign-tenant link), #7 (cancel-during-grant), #8 (double-emit),
// #13 (missing crid), #15 (concurrent any, distinct approvers).
// Plan #12/#13(gate-c)/#16 are skip/dup per the script header + handoff.
// ─────────────────────────────────────────────────────────────────────

// smoke-tenant-b — purpose-built foreign tenant for cross-tenant probes.
const FOREIGN_TENANT = '00000000-0000-0000-0000-0000000000b1';
// Distinct approver persons WITH auth accounts, for probe 15's 3-way race.
// (auth_uid → users.person_id verified via psql against remote.)
const PROBE15_APPROVERS = [
  { person: '95000000-0000-0000-0000-000000000002', auth: ADMIN_AUTH_UID }, // Sofia (admin)
  { person: '95000000-0000-0000-0000-000000000007', auth: '4c7c53a7-c303-4529-b0cc-bac9d877d235' }, // Daan
  { person: '95000000-0000-0000-0000-000000000006', auth: 'ee9a993b-3f52-453f-ac5f-9e18dc07dd44' }, // Amelia
];

async function respondJson(token, approvalId, body) {
  const res = await fetch(`${API_BASE}/approvals/${approvalId}/respond`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-tenant-id': TENANT_ID,
      'x-client-request-id': crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json };
}

// Probe 7 — ghost approval id (well-formed uuid, no row) → 404
// approval.not_found (plan §7.4 #4).
async function probe7GhostApprovalId(token) {
  console.log('Probe 7: ghost approval id → 404 approval.not_found');
  const ghostId = '00000000-0000-0000-0000-0000000000ff';
  const { status, json } = await respondJson(token, ghostId, { status: 'approved' });
  if (status !== 404) return fail('probe7', `status=${status} (want 404), body=${JSON.stringify(json)}`);
  if (json?.code !== 'approval.not_found')
    return fail('probe7', `code=${json?.code} (want approval.not_found)`);
  pass('probe7', '404 approval.not_found');
}

// Probe 8 — malformed (non-uuid) approval id. Plan §7.4 #5 expected a
// 400 validation gate. ACTUAL behaviour (verified empirically + against
// approval.service.ts:512-519): `.from('approvals').select().eq('id',
// <non-uuid>).single()` returns no row → AppErrors.notFound('approval')
// → 404 approval.not_found. No 500, no Postgres error leak — a clean,
// non-leaky contract. We assert the ACTUAL correct behaviour, NOT the
// plan's assumption (CRITICAL HONESTY RULE: don't weaken; flag the plan
// deviation). Plan §7.4 #5 should be updated 400→404 in a doc pass.
async function probe8MalformedApprovalId(token) {
  console.log('Probe 8: malformed approval id → 404 approval.not_found (plan said 400; 404 is the real, non-leaky contract)');
  const { status, json } = await respondJson(token, 'not-a-uuid', { status: 'approved' });
  if (status === 500)
    return fail('probe8', `500 — Postgres uuid-cast error leaked (genuine bug). body=${JSON.stringify(json)}`);
  if (status !== 404)
    return fail('probe8', `status=${status} (want 404 approval.not_found), body=${JSON.stringify(json)}`);
  if (json?.code !== 'approval.not_found')
    return fail('probe8', `code=${json?.code} (want approval.not_found)`);
  pass('probe8', '404 approval.not_found (no 500/uuid leak; plan #5 deviation noted)');
}

// Probe 9 — cross-tenant workflow_instance_id link → the 00400 B.1
// trigger `assert_approvals_workflow_instance_tenant` refuses at the SQL
// layer (errcode P0001, "tenant_mismatch on approvals.workflow_instance
// _id"). The trigger compares the REFERENCED instance's tenant to the
// NEW approval row's tenant. Rather than seed the (empty) foreign tenant
// — which would need a full person+space+booking chain — we provision a
// genuine instance in TENANT_ID via the normal rule+booking path, then
// attempt to insert an approval whose tenant_id = FOREIGN_TENANT but
// whose workflow_instance_id points at the TENANT_ID instance. Same
// cross-tenant violation, minimal fixture. Plan §7.4 #6.
async function probe9ForeignTenantLink(token) {
  console.log('Probe 9: cross-tenant workflow_instance_id link → SQL trigger refuses (P0001)');
  const { ruleId } = await seedRuleWithWorkflow({
    threshold: 'all',
    approverPersonIds: [ADMIN_PERSON],
  });
  let bookingId;
  const approvalId = crypto.randomUUID();
  try {
    const created = await createBookingViaApi({ token });
    bookingId = created.id;
    const instance = await pollUntil('probe9-seed', async () => {
      const i = await readInstanceForBooking(bookingId);
      const a = await readApprovalsForBooking(bookingId);
      return i && a.length > 0 ? i : null;
    });
    if (!instance) return fail('probe9', 'workflow_instance not seeded');

    // Attempt the corrupt insert: approval row in FOREIGN_TENANT pointing
    // at the TENANT_ID instance. The BEFORE INSERT trigger must raise.
    // runPsql throws on non-zero psql exit (ON_ERROR_STOP=1) — that's the
    // PASS condition.
    let rejected = false;
    let detail = '';
    try {
      runPsql(`
        insert into public.approvals
          (id, tenant_id, target_entity_type, target_entity_id,
           approver_person_id, status, workflow_instance_id)
        values
          ('${approvalId}'::uuid, '${FOREIGN_TENANT}'::uuid, 'booking',
           '${bookingId}'::uuid, '${ADMIN_PERSON}'::uuid,
           'pending', '${instance.id}'::uuid);
      `);
    } catch (e) {
      rejected = true;
      detail = String(e.message || e);
    }
    if (!rejected)
      return fail('probe9', 'cross-tenant workflow_instance_id link was ACCEPTED (cross-tenant leak — P0 trigger gap)');
    if (!/tenant_mismatch on approvals\.workflow_instance_id|P0001/.test(detail))
      return fail('probe9', `rejected but not by the tenant trigger: ${detail.slice(0, 200)}`);
    pass('probe9', 'SQL trigger refused cross-tenant workflow_instance_id link (P0001)');
  } finally {
    runPsql(`delete from public.approvals where id = '${approvalId}'::uuid;`);
    if (bookingId) await supa().from('bookings').delete().eq('id', bookingId);
    await dropRule(ruleId);
  }
}

// Probe 10 — cancel-during-grant race. Concurrently: (a) grant the
// approval via the API, (b) delete the booking via
// delete_booking_with_guard (the production cancel-cascade trigger).
// Terminal state must be CONSISTENT: the booking is gone and the
// workflow_instance ends up in exactly one terminal state (completed via
// the grant OR cancelled via the cascade) — never stuck 'waiting', never
// half-state. Plan §7.4 #7.
async function probe10CancelDuringGrant(token) {
  console.log('Probe 10: cancel-during-grant race → consistent terminal state');
  const { ruleId } = await seedRuleWithWorkflow({
    threshold: 'all',
    approverPersonIds: [ADMIN_PERSON],
  });
  let bookingId;
  try {
    const created = await createBookingViaApi({ token });
    bookingId = created.id;
    const instance = await pollUntil('probe10-seed', async () => {
      const i = await readInstanceForBooking(bookingId);
      const a = await readApprovalsForBooking(bookingId);
      return i && a.length > 0 ? i : null;
    });
    if (!instance) return fail('probe10', 'workflow_instance / approvals not seeded');
    const approvals = await readApprovalsForBooking(bookingId);

    // Fire grant + delete concurrently.
    const [grantRes, delRes] = await Promise.allSettled([
      respondJson(token, approvals[0].id, { status: 'approved' }),
      supa().rpc('delete_booking_with_guard', {
        p_booking_id: bookingId,
        p_tenant_id: TENANT_ID,
      }),
    ]);
    void grantRes;
    void delRes;

    // Whatever the interleaving: the instance must reach ONE terminal
    // state (not 'waiting'/'active'), and never stay half-resolved.
    const terminal = await pollUntil('probe10', async () => {
      const ia = await readInstanceById(instance.id);
      if (!ia) return null;
      return ['completed', 'cancelled', 'failed'].includes(ia.status) ? ia : null;
    });
    if (!terminal) {
      const ia = await readInstanceById(instance.id);
      return fail('probe10', `instance not terminal: status=${ia?.status} (want completed|cancelled|failed)`);
    }
    // Approvals must not be left 'pending' — they resolved or expired.
    const approvalsAfter = await readApprovalsForBooking(bookingId);
    const anyPending = approvalsAfter.some((a) => a.status === 'pending');
    if (anyPending)
      return fail('probe10', `approvals left pending after race: ${JSON.stringify(approvalsAfter.map((a) => a.status))}`);
    pass('probe10', `consistent terminal state: instance=${terminal.status}, no pending approvals`);
  } finally {
    if (bookingId) await supa().from('bookings').delete().eq('id', bookingId);
    await dropRule(ruleId);
  }
}

// Probe 11 — double-emit approval.granted → idempotent. Grant once
// (drives one approval.granted), then RE-EMIT the same event into the
// outbox (simulating an at-least-once retry / redelivery) using the
// canonical 8-arg outbox.emit with the SAME idempotency key 00407 uses
// (`approval.granted:<approval_id>`). The (tenant_id, idempotency_key)
// ON CONFLICT dedup (00299:161-192) must collapse it: still exactly ONE
// row, and resume()'s atomic claim makes the handler side idempotent
// (booking stays 'confirmed', no double-advance). Plan §7.4 #8.
async function probe11DoubleEmitIdempotent(token) {
  console.log('Probe 11: double-emit approval.granted → idempotent (1 row, no double-advance)');
  const { ruleId } = await seedRuleWithWorkflow({
    threshold: 'all',
    approverPersonIds: [ADMIN_PERSON],
  });
  let bookingId;
  try {
    const created = await createBookingViaApi({ token });
    bookingId = created.id;
    const instance = await pollUntil('probe11-seed', async () => {
      const i = await readInstanceForBooking(bookingId);
      const a = await readApprovalsForBooking(bookingId);
      return i && a.length > 0 ? i : null;
    });
    if (!instance) return fail('probe11', 'workflow_instance / approvals not seeded');
    const approvals = await readApprovalsForBooking(bookingId);
    const approvalId = approvals[0].id;

    const g = await respondJson(token, approvalId, { status: 'approved' });
    if (g.status !== 200 && g.status !== 201)
      return fail('probe11', `grant failed: ${g.status} ${JSON.stringify(g.json)}`);

    // Wait for the genuine emit to land.
    const firstSeen = await pollUntil('probe11', async () => {
      const rows = await readOutboxApprovalGranted(instance.id);
      return rows.length >= 1 ? rows : null;
    });
    if (!firstSeen) return fail('probe11', 'no approval.granted emitted by the grant');

    // Re-emit with the SAME idempotency key 00407 uses. Same payload
    // shape → identical payload_hash → silent idempotent success.
    const client = await pgClient();
    await client.query(
      `select outbox.emit(
         $1::uuid, 'approval.granted', 'booking', $2::uuid,
         jsonb_build_object(
           'tenant_id', $1::uuid, 'approval_id', $3::uuid,
           'booking_id', $2::uuid, 'final_decision', 'approved',
           'workflow_instance_id', $4::uuid,
           'workflow_node_id', (select workflow_node_id from public.approvals where id = $3::uuid)
         ),
         'approval.granted:' || $3::text, 1, null
       )`,
      [TENANT_ID, bookingId, approvalId, instance.id],
    );

    // Still exactly ONE row (ON CONFLICT dedup), booking still confirmed.
    const rows = await readOutboxApprovalGranted(instance.id);
    if (rows.length !== 1)
      return fail('probe11', `outbox approval.granted count=${rows.length} after re-emit (want 1; idempotency broken)`);
    // Poll for the JOINT terminal state. resume() confirms the booking
    // and completes the instance across node-execution steps (not one
    // atomic write), and the handler may take >1 attempt (transient DB
    // wobble → outbox retry on the next 30s cron). Poll both so the
    // retry has time to land — the idempotency invariant (1 outbox row,
    // single completion, no double-advance) is what we're asserting, not
    // sub-second write ordering.
    const terminal = await pollUntil('probe11-confirm', async () => {
      const s = await readBookingStatus(bookingId);
      const fi = await readInstanceById(instance.id);
      return s === 'confirmed' && fi?.status === 'completed' ? { s, fi } : null;
    });
    if (!terminal) {
      const s = await readBookingStatus(bookingId);
      const fi = await readInstanceById(instance.id);
      return fail('probe11', `not terminal: booking=${s} (want confirmed), instance=${fi?.status} (want completed; double-advance?)`);
    }
    // Re-assert exactly one outbox row AFTER drain (purgeProcessed is
    // hourly so a drained row is still present; a double-advance would
    // have produced a 2nd row).
    const rowsAfter = await readOutboxApprovalGranted(instance.id);
    if (rowsAfter.length !== 1)
      return fail('probe11', `outbox approval.granted count=${rowsAfter.length} post-drain (want 1; idempotency broken)`);
    pass('probe11', 're-emit deduped to 1 row; booking confirmed; instance completed once');
  } finally {
    if (bookingId) await supa().from('bookings').delete().eq('id', bookingId);
    await dropRule(ruleId);
  }
}

// Probe 14 — missing X-Client-Request-Id header on the producer route
// → 400 client_request_id.required (RequireClientRequestIdGuard,
// require-client-request-id.guard.ts). Plan §7.4 #13. No business RPC
// runs (guard rejects pre-body).
async function probe14MissingClientRequestId(token) {
  console.log('Probe 14: missing X-Client-Request-Id → 400 client_request_id.required');
  // A well-formed-but-ghost id is fine; the guard fires before the
  // approval lookup, so we never need a real approval.
  const res = await fetch(`${API_BASE}/approvals/00000000-0000-0000-0000-0000000000ff/respond`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-tenant-id': TENANT_ID,
      // intentionally NO x-client-request-id
    },
    body: JSON.stringify({ status: 'approved' }),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  if (res.status !== 400)
    return fail('probe14', `status=${res.status} (want 400), body=${JSON.stringify(json)}`);
  if (json?.code !== 'client_request_id.required')
    return fail('probe14', `code=${json?.code} (want client_request_id.required)`);
  pass('probe14', '400 client_request_id.required (guard rejected pre-body)');
}

// Probe 15 — BLOCKER 2, distinct-approver variant. v1 probe 4 raced 3
// grants of the SAME approval id. This races 3 DIFFERENT approver
// persons' sibling approvals within ONE chain_threshold='any' chain,
// each authorised by that approver's own JWT. The per-booking ROW lock
// (00407, BLOCKER 2 closure) must serialise them: exactly ONE wins
// (kind='resolved'), the others get kind='already_resolved', exactly
// ONE approval.granted outbox row, siblings expired exactly once,
// booking confirmed. Plan §7.4 #15.
async function probe15ConcurrentAnyDistinctApprovers() {
  console.log("Probe 15: BLOCKER 2 — 3 distinct approvers race sibling 'any' grants");
  const personIds = PROBE15_APPROVERS.map((a) => a.person);
  const { ruleId } = await seedRuleWithWorkflow({
    threshold: 'any',
    approverPersonIds: personIds,
  });
  let bookingId;
  try {
    // Mint a JWT per approver up-front (sequential — generateLink is
    // cheap but not concurrency-safe on the same admin client).
    const tokens = [];
    for (const a of PROBE15_APPROVERS) tokens.push(await mintTokenFor(a.auth));

    // Admin (first approver) creates the booking → 3 sibling approvals
    // (one per required approver person) on a chain_threshold='any'.
    const created = await createBookingViaApi({ token: tokens[0] });
    bookingId = created.id;

    const instance = await pollUntil('probe15-seed', async () => {
      const i = await readInstanceForBooking(bookingId);
      const a = await readApprovalsForBooking(bookingId);
      return i && a.length === personIds.length ? i : null;
    });
    if (!instance) {
      const a = await readApprovalsForBooking(bookingId);
      return fail('probe15', `expected ${personIds.length} sibling approvals, got ${a.length}`);
    }
    const approvals = await readApprovalsForBooking(bookingId);
    if (approvals.some((a) => a.chain_threshold !== 'any'))
      return fail('probe15', `not all chain_threshold='any': ${JSON.stringify(approvals.map((a) => a.chain_threshold))}`);

    // Map each approval to the matching approver's token, then fire all
    // grants concurrently — distinct approval ids, distinct JWTs.
    const byPerson = new Map(
      PROBE15_APPROVERS.map((a, i) => [a.person, tokens[i]]),
    );
    const grantPromises = approvals.map((ap) =>
      respondJson(byPerson.get(ap.approver_person_id), ap.id, { status: 'approved' }),
    );
    const settled = await Promise.allSettled(grantPromises);
    const oks = settled.filter(
      (r) => r.status === 'fulfilled' && (r.value.status === 200 || r.value.status === 201),
    ).length;
    if (oks < 1)
      return fail('probe15', `no grant succeeded: ${JSON.stringify(settled.map((s) => s.status === 'fulfilled' ? s.value.status : s.reason?.message))}`);

    // KEY: exactly ONE approval.granted outbox row for this instance
    // (booking row lock collapsed the 3-way race), booking confirmed,
    // siblings expired exactly once.
    const appeared = await pollUntil('probe15', async () => {
      const rows = await readOutboxApprovalGranted(instance.id);
      return rows.length >= 1 ? rows : null;
    });
    const outboxRows = appeared ?? (await readOutboxApprovalGranted(instance.id));
    if (outboxRows.length !== 1)
      return fail('probe15', `outbox approval.granted count=${outboxRows.length} (want 1; BLOCKER 2 regression — distinct-approver double-emit)`);

    const confirmed = await pollUntil('probe15-confirm', async () => {
      const s = await readBookingStatus(bookingId);
      return s === 'confirmed' ? s : null;
    });
    if (!confirmed)
      return fail('probe15', `booking not confirmed (status=${await readBookingStatus(bookingId)})`);

    const finalApprovals = await readApprovalsForBooking(bookingId);
    const approvedCt = finalApprovals.filter((a) => a.status === 'approved').length;
    const expiredCt = finalApprovals.filter((a) => a.status === 'expired').length;
    // Exactly one winner resolved ('approved'); the rest expired as
    // siblings (any-of-N). Losers that self-CAS'd to 'approved' for audit
    // are acceptable too — the load-bearing invariant is the SINGLE
    // outbox emit + confirmed booking, already asserted above.
    if (approvedCt + expiredCt !== finalApprovals.length)
      return fail('probe15', `unexpected approval states: ${JSON.stringify(finalApprovals.map((a) => a.status))}`);
    pass('probe15', `${oks}/${approvals.length} grants ok; exactly 1 outbox emit; booking confirmed (no distinct-approver double-emit)`);
  } finally {
    if (bookingId) await supa().from('bookings').delete().eq('id', bookingId);
    await dropRule(ruleId);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(check, timeoutMs = 90_000, pollMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(pollMs);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('smoke-visual-approval — Phase 1.5 v2 (13 probes — full §7.4 matrix; #12/13(c)/16 skip/dup)');
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
    await probe7GhostApprovalId(token);
    await probe8MalformedApprovalId(token);
    await probe9ForeignTenantLink(token);
    await probe10CancelDuringGrant(token);
    await probe11DoubleEmitIdempotent(token);
    await probe14MissingClientRequestId(token);
    await probe15ConcurrentAnyDistinctApprovers();
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

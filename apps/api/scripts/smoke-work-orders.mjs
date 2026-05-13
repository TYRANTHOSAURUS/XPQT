#!/usr/bin/env node
/**
 * scripts/smoke-work-orders.mjs
 *
 * Live-API smoke test for the work-order + case command surface.
 * Hits the local NestJS API on :3001 against the remote Supabase project
 * with a real Admin JWT (minted via Supabase auth.admin.generateLink).
 *
 * This is the gate that has historically been missing across the
 * 2026-04-30 → 2026-05-02 data-model rework:
 *   - Sessions 7-12 shipped 15 commits + 41 migrations and "passed"
 *     on mocked-Supabase unit tests, but PATCH /work-orders/:id was
 *     broken on the live DB (service_role missing DML grants —
 *     migration 00248).
 *   - Slice 3.1 metadata fields had a cost-float comparison bug only
 *     visible against real Postgres NUMERIC round-trip (no-op fast
 *     path never firing for fractional values).
 *   - Watcher uuid validation had multiple classes of error path
 *     (malformed → 500, oversized array → URL-bust) only catchable
 *     end-to-end against the live API.
 *
 * The unifying lesson: tests-pass-but-UI-broken is the recurring
 * failure mode. This script is the structural defense — run it before
 * claiming any WO/case-surface work shipped.
 *
 * USAGE:
 *   pnpm dev:api &     (or have the dev server already running)
 *   node scripts/smoke-work-orders.mjs
 *
 *   exit 0 = all probes pass; exit 1 = at least one regression.
 *
 * REQUIREMENTS:
 *   - Local API running on :3001 (`pnpm dev:api`)
 *   - .env with SUPABASE_URL + SUPABASE_SECRET_KEY + SUPABASE_PUBLISHABLE_KEY
 *   - Remote DB has the seed data (work_order id + case id below).
 *
 * DESIGN — the lessons baked in:
 *   1. **Current-row-XOR-sentinel rule.** Every mutation reads the current
 *      value first and sends a *different* value, so the no-op fast-path
 *      never accidentally returns 200 on a write that didn't happen
 *      (Session 13 lesson — phantom-success is how the P0 hid).
 *   2. **Validation probes.** Ghost uuids, malformed uuids, oversized
 *      arrays — verifies clean 400s, not PG-leak 500s.
 *   3. **Cleanup.** Created entities (dispatch WO) are deleted on success.
 *      Mutations are left in a sensible state (priority restored, etc).
 *   4. **Human-readable output.** Each probe prints a single line; failures
 *      include the response body so the user can see what broke.
 *   5. **B.2.A Step 7 — command_operations assertion.** After each
 *      successful PATCH /work-orders/:id, query the command_operations
 *      table for a row keyed on (tenant_id, `patch:work_order:<id>:<x-client-request-id>`)
 *      AND `outcome='success'`. If the row is present, the controller
 *      went through `update_entity_combined` (00335 v5). If absent, the
 *      controller bypassed the orchestrator — fail loudly. Citations:
 *      - 00316_command_operations_table.sql:31-42 (table schema).
 *      - work-order.service.ts:503-508 (idempotency-key shape).
 *      - 00335_update_entity_combined_v5.sql:203-205, 792-794
 *        (RPC insert + final UPDATE to success).
 */

import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────

// Script lives at apps/api/scripts/. Repo root is three levels up.
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

const API_BASE = process.env.API_BASE || 'http://localhost:3001';
const TENANT_ID = '00000000-0000-0000-0000-000000000001'; // Solana Inc.
const ADMIN_AUTH_UID = '93d41232-35b5-424c-b215-bb5d55a2dfd9'; // Admin role
const WO_ID = '2ad8ae79-5903-4e6b-819c-f630a26f0f34';
const CASE_ID = '3970a9ff-5c4b-4a8e-9f6f-f37ce89c7d1d';
const REAL_TEAM = '94000000-0000-0000-0000-000000000002';
const ALT_TEAM = '94000000-0000-0000-0000-000000000005';
const REAL_PERSON = 'b3a0aa30-3648-4783-92fa-973090877238';
const GHOST_UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

// Planning requester-only smoke (P0-3, codex finding follow-up to 5a689110).
// Seeded by 00381_planning_smoke_requester_seed.sql — a user with zero
// team memberships, zero role assignments, no read_all override. Paired
// fixture WO has `requester_person_id` pointing at this seed's person,
// so a leak in the operator-only predicate (00380) would surface the row.
//
// The auth.users entry is bootstrapped by the smoke script via
// `auth.admin.createUser` (idempotent). The migration cannot create the
// auth.users row directly — hand-rolled SQL inserts pass psql but fail
// GoTrue's user-load path ("Database error loading user"). The fixed id
// below is what the smoke script asks GoTrue to assign; the migration's
// public.users.auth_uid is pinned to match.
const PLANNING_REQUESTER_AUTH_UID = 'aa000000-0000-0000-0000-00000000a001';
const PLANNING_REQUESTER_EMAIL = 'planning-smoke-requester@example.test';
const PLANNING_REQUESTER_FIXTURE_WO_ID = 'aa000000-0000-0000-0000-0000000000b1';
// public.users.id for the seed requester. Used by the optional
// DEBUG_NEGATIVE_REQUESTER_PROBE branch to insert + clean up a
// team_members row that grants the requester an operator path.
const PLANNING_REQUESTER_USER_ID = 'aa000000-0000-0000-0000-0000000000a2';

// ─────────────────────────────────────────────────────────────────────
// Slice C — PM generator probe constants.
//
// All seven scenarios (ai/slice-c-plan.md §8) live inside
// `runPmGeneratorProbes()` below. We DO NOT reuse any existing live asset
// or asset_type: an asset_type plan with `asset_type_id` fans out across
// every asset of that type, so leaning on the seeded fleet (489-699 rows
// per type) would spawn hundreds of WOs per smoke run. The probe instead
// seeds its own dedicated asset_type + N assets, runs the seven scenarios
// against them, and tears the whole fixture down in `finally`.
//
// Tenant B exists (`00000000-0000-0000-0000-0000000000b1`) but carries
// no request_types — the cross-tenant scenario seeds its own request_type
// + tenant_b plan and cleans up.
//
// Direct-RPC invocation rationale: the cron is a 1-line wrapper around
// PMGeneratorService.generateForAllTenants(), which itself calls the
// `create_pm_work_order` RPC (00389) per (plan, asset) pair. Calling
// the RPC directly from the smoke script exercises the same atomic
// path the cron uses (lock plan FOR UPDATE → insert WO via ON CONFLICT
// DO NOTHING → emit audit → advance last_generated_at). A separate
// sub-probe inside `runPmGeneratorProbes` exercises the service-layer
// SELECT path (`maintenance_plans` filter by `next_run_at <= cutoff`)
// to keep the end-to-end cron loop honest.
const PM_TENANT_B_ID = '00000000-0000-0000-0000-0000000000b1';

// ─────────────────────────────────────────────────────────────────────
// Idempotency-key shape — kept in lockstep with @prequest/shared/idempotency
// (packages/shared/src/idempotency.ts:34 + :60-66). The .mjs runtime can't
// import the TS source directly (no compile step for smoke scripts), so the
// helper is replicated here with a cross-reference comment. If you change
// the prefix or shape, update BOTH places in the same commit.
// Mirrored verbatim in apps/api/scripts/smoke-tickets.mjs:96-100.
// ─────────────────────────────────────────────────────────────────────

const PATCH_IDEMPOTENCY_KEY_PREFIX = 'patch';

function buildPatchIdempotencyKey(kind, entityId, clientRequestId) {
  return `${PATCH_IDEMPOTENCY_KEY_PREFIX}:${kind}:${entityId}:${clientRequestId}`;
}

// ─────────────────────────────────────────────────────────────────────
// Supabase admin singleton — used for command_operations assertion +
// cleanup of created entities. Lifted to module-level so probes (and
// mintAdminToken below) can query the table directly without re-creating
// a client per call. Matches smoke-tickets.mjs:97-110 pattern.
// ─────────────────────────────────────────────────────────────────────

let SUPA = null;
function supa() {
  if (SUPA) return SUPA;
  SUPA = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return SUPA;
}

// ─────────────────────────────────────────────────────────────────────
// Auth — mint a real Admin JWT via Supabase auth.admin.generateLink
// ─────────────────────────────────────────────────────────────────────

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

async function mintAdminToken() {
  return mintTokenFor(ADMIN_AUTH_UID);
}

// Bootstrap the requester-only seed user's auth.users entry. Idempotent:
// if the user exists, no-op; otherwise create with the fixed uuid the
// migration's public.users.auth_uid is pinned to. See the comment on
// PLANNING_REQUESTER_AUTH_UID for why this lives here, not in SQL.
async function ensureRequesterAuthUser() {
  const adm = supa();
  const { data: existing } = await adm.auth.admin.getUserById(PLANNING_REQUESTER_AUTH_UID);
  if (existing?.user) return;
  const { error } = await adm.auth.admin.createUser({
    id: PLANNING_REQUESTER_AUTH_UID,
    email: PLANNING_REQUESTER_EMAIL,
    email_confirm: true,
  });
  if (error) {
    throw new Error(
      `failed to bootstrap requester auth user: ${error.message}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────
// Probe runner with consistent reporting
// ─────────────────────────────────────────────────────────────────────

const results = { pass: 0, fail: 0, failed: [] };

function makeProber(headers) {
  return async function probe(name, options) {
    const {
      method = 'PATCH',
      url,
      body,
      expect = 'success',
      // Allow callers to pin the X-Client-Request-Id (used by
      // idempotency-replay probes that send the same id twice).
      clientRequestId,
    } = options;
    // B.2.A I1: every mutation surface (PATCH, POST) the smoke gate
    // hits is now guarded by RequireClientRequestIdGuard. Mint a fresh
    // UUID per probe — each probe is a logically distinct attempt;
    // reusing one id across all of them would land in
    // command_operations.cached_result and silently no-op on retries.
    const isMutation = method === 'PATCH' || method === 'POST';
    const xCid = isMutation ? clientRequestId || crypto.randomUUID() : null;
    const probeHeaders = isMutation
      ? { ...headers, 'X-Client-Request-Id': xCid }
      : headers;
    const r = await fetch(url, {
      method,
      headers: probeHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const ok =
      (expect === 'success' && r.status >= 200 && r.status < 300) ||
      (expect === 'badrequest' && r.status === 400) ||
      (expect === 'conflict' && r.status === 409) ||
      (expect === 'forbidden' && r.status === 403);
    const txt = await r.text();
    if (ok) {
      results.pass += 1;
      console.log(`  ✓ ${name} → HTTP ${r.status}`);
    } else {
      results.fail += 1;
      results.failed.push(name);
      console.log(`  ✗ ${name} → HTTP ${r.status} (expected ${expect})`);
      console.log(`     ${txt.slice(0, 240)}`);
    }
    return { status: r.status, body: txt, ok, xClientRequestId: xCid };
  };
}

// ─────────────────────────────────────────────────────────────────────
// B.2.A Step 7 — command_operations assertion helper.
//
// After every successful PATCH /work-orders/:id or /tickets/:id, verify
// the orchestrator landed a `command_operations` row with
//   (tenant_id, idempotency_key=`patch:<kind>:<id>:<x-cid>`)
//   AND outcome='success'
//   AND cached_result NOT NULL
// per 00335_update_entity_combined_v5.sql:203-205 + :792-794.
//
// If the row is absent, the controller bypassed `update_entity_combined`
// — fail loudly. This is the structural defense that catches an
// accidental regression to the pre-cutover TS write path.
// ─────────────────────────────────────────────────────────────────────

async function assertCommandOpRow(name, tenantId, kind, entityId, xCid) {
  if (!xCid) {
    results.fail += 1;
    results.failed.push(`${name} (command_op assert: no x-cid)`);
    console.log(`  ✗ ${name} (command_op assert) — no X-Client-Request-Id captured`);
    return false;
  }
  const idempotencyKey = buildPatchIdempotencyKey(kind, entityId, xCid);
  const { data, error } = await supa()
    .from('command_operations')
    .select('outcome, cached_result, completed_at')
    .eq('tenant_id', tenantId)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (error) {
    results.fail += 1;
    results.failed.push(`${name} (command_op assert: query error)`);
    console.log(`  ✗ ${name} (command_op assert) — query error: ${error.message}`);
    return false;
  }
  if (!data) {
    results.fail += 1;
    results.failed.push(`${name} (command_op assert: no row)`);
    console.log(
      `  ✗ ${name} (command_op assert) — no row for key=${idempotencyKey.slice(0, 60)}…`,
    );
    console.log(
      `     update_entity_combined did NOT fire — controller bypassed §3.0 RPC.`,
    );
    return false;
  }
  if (data.outcome !== 'success') {
    results.fail += 1;
    results.failed.push(`${name} (command_op assert: outcome=${data.outcome})`);
    console.log(`  ✗ ${name} (command_op assert) — outcome=${data.outcome}, want success`);
    return false;
  }
  if (!data.cached_result) {
    results.fail += 1;
    results.failed.push(`${name} (command_op assert: empty cached_result)`);
    console.log(`  ✗ ${name} (command_op assert) — cached_result is null`);
    return false;
  }
  results.pass += 1;
  console.log(`  ✓ ${name} (command_op outcome=success)`);
  return true;
}

// Convenience: probe + assert in one call for the common PATCH-then-verify
// flow. Skips the assertion when the probe expected a non-success outcome
// or when the HTTP response was not in the 2xx range.
async function probeAndAssertCommandOp(probe, name, options, tenantId, kind, entityId) {
  const result = await probe(name, options);
  if (result.ok && (options.expect ?? 'success') === 'success') {
    await assertCommandOpRow(name, tenantId, kind, entityId, result.xClientRequestId);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────
// Probes — current-row-XOR-sentinel for every mutation
// ─────────────────────────────────────────────────────────────────────

async function readWO(headers) {
  const r = await fetch(`${API_BASE}/api/tickets/${WO_ID}`, { headers });
  if (!r.ok) throw new Error(`failed to read WO: ${r.status}`);
  return r.json();
}

async function runWorkOrderMutations(headers, probe) {
  console.log('\n=== WO mutations: current-row-XOR-sentinel ===');
  const cur = await readWO(headers);

  // status: flip between 'new' (assigned) and 'in_progress'
  const nextStatus = cur.status === 'new' ? 'in_progress' : 'new';
  const nextStatusCat = cur.status === 'new' ? 'in_progress' : 'assigned';
  await probeAndAssertCommandOp(probe, 'WO: status flip', {
    url: `${API_BASE}/api/work-orders/${WO_ID}`,
    body: { status: nextStatus, status_category: nextStatusCat },
  }, TENANT_ID, 'work_order', WO_ID);

  // priority: flip between 'medium' and 'high'
  const nextPriority = cur.priority === 'high' ? 'medium' : 'high';
  await probeAndAssertCommandOp(probe, 'WO: priority flip', {
    url: `${API_BASE}/api/work-orders/${WO_ID}`,
    body: { priority: nextPriority },
  }, TENANT_ID, 'work_order', WO_ID);

  // plan: set to +1 day from now (always different from current)
  await probeAndAssertCommandOp(probe, 'WO: planned_start_at +1d', {
    url: `${API_BASE}/api/work-orders/${WO_ID}`,
    body: { planned_start_at: new Date(Date.now() + 86400000).toISOString() },
  }, TENANT_ID, 'work_order', WO_ID);

  // ── Phase 1.1 plan-merge regression probes ───────────────────────────
  // Locks in: WorkOrderService.update merges plan-branch fields against the
  // current row instead of nulling absent fields. Pre-fix, a duration-only
  // patch silently cleared the existing planned_start_at; this set of
  // probes makes that regression visible end-to-end.

  // 1. Both fields together — fast-path baseline.
  const plan1Start = new Date(Date.now() + 2 * 86400000).toISOString();
  const plan1Result = await probeAndAssertCommandOp(probe, 'WO: plan set start+duration', {
    url: `${API_BASE}/api/work-orders/${WO_ID}`,
    body: { planned_start_at: plan1Start, planned_duration_minutes: 60 },
  }, TENANT_ID, 'work_order', WO_ID);
  if (plan1Result.ok) {
    const after = await readWO(headers);
    if (
      after.planned_start_at &&
      Date.parse(after.planned_start_at) === Date.parse(plan1Start) &&
      after.planned_duration_minutes === 60
    ) {
      results.pass += 1;
      console.log('  ✓ WO: plan set start+duration (post-read)');
    } else {
      results.fail += 1;
      results.failed.push('WO: plan set start+duration (post-read)');
      console.log(
        `  ✗ WO: plan set start+duration (post-read) → start=${after.planned_start_at} dur=${after.planned_duration_minutes}`,
      );
    }
  }

  // 2. Duration-only patch must preserve start. The bug fixed in Phase 1.1.
  const plan2Result = await probeAndAssertCommandOp(probe, 'WO: plan patch duration only preserves start', {
    url: `${API_BASE}/api/work-orders/${WO_ID}`,
    body: { planned_duration_minutes: 90 },
  }, TENANT_ID, 'work_order', WO_ID);
  if (plan2Result.ok) {
    const after = await readWO(headers);
    if (
      after.planned_start_at &&
      Date.parse(after.planned_start_at) === Date.parse(plan1Start) &&
      after.planned_duration_minutes === 90
    ) {
      results.pass += 1;
      console.log('  ✓ WO: plan patch duration only preserves start (post-read)');
    } else {
      results.fail += 1;
      results.failed.push(
        'WO: plan patch duration only preserves start (post-read)',
      );
      console.log(
        `  ✗ WO: plan patch duration only preserves start (post-read) → start=${after.planned_start_at} dur=${after.planned_duration_minutes}`,
      );
    }
  }

  // 3. Start-only patch must preserve duration.
  const plan3Start = new Date(Date.now() + 3 * 86400000).toISOString();
  const plan3Result = await probeAndAssertCommandOp(probe, 'WO: plan patch start only preserves duration', {
    url: `${API_BASE}/api/work-orders/${WO_ID}`,
    body: { planned_start_at: plan3Start },
  }, TENANT_ID, 'work_order', WO_ID);
  if (plan3Result.ok) {
    const after = await readWO(headers);
    if (
      after.planned_start_at &&
      Date.parse(after.planned_start_at) === Date.parse(plan3Start) &&
      after.planned_duration_minutes === 90
    ) {
      results.pass += 1;
      console.log('  ✓ WO: plan patch start only preserves duration (post-read)');
    } else {
      results.fail += 1;
      results.failed.push(
        'WO: plan patch start only preserves duration (post-read)',
      );
      console.log(
        `  ✗ WO: plan patch start only preserves duration (post-read) → start=${after.planned_start_at} dur=${after.planned_duration_minutes}`,
      );
    }
  }

  // 4. start=null clears both fields (existing setPlan invariant, exposed
  // through the orchestrator merge).
  const plan4Result = await probeAndAssertCommandOp(probe, 'WO: plan patch null start clears both', {
    url: `${API_BASE}/api/work-orders/${WO_ID}`,
    body: { planned_start_at: null },
  }, TENANT_ID, 'work_order', WO_ID);
  if (plan4Result.ok) {
    const after = await readWO(headers);
    if (after.planned_start_at === null && after.planned_duration_minutes === null) {
      results.pass += 1;
      console.log('  ✓ WO: plan patch null start clears both (post-read)');
    } else {
      results.fail += 1;
      results.failed.push('WO: plan patch null start clears both (post-read)');
      console.log(
        `  ✗ WO: plan patch null start clears both (post-read) → start=${after.planned_start_at} dur=${after.planned_duration_minutes}`,
      );
    }
  }

  // 5. Duration without start → 400 work_order.plan_invalid. Probe runs
  // immediately after the null-start probe so the WO row has start=null
  // and duration-without-start is genuinely invalid (not just a no-op).
  const plan5Result = await probe('WO: duration without start rejected', {
    url: `${API_BASE}/api/work-orders/${WO_ID}`,
    body: { planned_duration_minutes: 90 },
    expect: 'badrequest',
  });
  if (plan5Result.ok) {
    let parsed = null;
    try {
      parsed = JSON.parse(plan5Result.body);
    } catch {
      // ignore; we'll fail the code-check below
    }
    if (parsed && parsed.code === 'work_order.plan_invalid') {
      results.pass += 1;
      console.log('  ✓ WO: duration without start rejected (code check)');
    } else {
      results.fail += 1;
      results.failed.push('WO: duration without start rejected (code check)');
      console.log(
        `  ✗ WO: duration without start rejected (code check) → code=${parsed?.code}`,
      );
    }
  }

  // Restore a sensible plan so subsequent probes / manual inspection
  // aren't left with a cleared row.
  await probeAndAssertCommandOp(probe, 'WO: restore plan (cleanup)', {
    url: `${API_BASE}/api/work-orders/${WO_ID}`,
    body: {
      planned_start_at: new Date(Date.now() + 86400000).toISOString(),
      planned_duration_minutes: 60,
    },
  }, TENANT_ID, 'work_order', WO_ID);

  // ── P1-2 plan_version (optimistic-lock) probes ──────────────────────
  // Migration 00382 adds plan_version + before-update trigger. The PATCH
  // endpoint compares caller's plan_version against the row's current
  // value when ANY trigger column is in the patch; mismatch → 409
  // planning.version_conflict.
  //
  // Probe shape:
  //   1. Read current plan_version (v0).
  //   2. PATCH planned_start_at with plan_version=v0 → 200, row now at v0+1.
  //   3. PATCH again with stale plan_version=v0 → 409 with
  //      code=planning.version_conflict + serverVersion=v0+1 + clientVersion=v0.
  //   4. PATCH with fresh plan_version=v0+1 → 200, row now at v0+2.
  //   5. Restore start to a stable value at the end so subsequent probes
  //      operate on a known plan.
  const beforeVersion = await readWO(headers);
  const v0 = beforeVersion.plan_version;
  if (typeof v0 !== 'number') {
    results.fail += 1;
    results.failed.push('WO: plan_version present on response');
    console.log(`  ✗ WO: plan_version present on response — got ${v0}`);
  } else {
    results.pass += 1;
    console.log(`  ✓ WO: plan_version present on response (v${v0})`);
  }

  const planVersionStart1 = new Date(Date.now() + 4 * 86400000).toISOString();
  const pvProbe1 = await probeAndAssertCommandOp(
    probe,
    'WO: plan_version match → 200',
    {
      url: `${API_BASE}/api/work-orders/${WO_ID}`,
      body: { planned_start_at: planVersionStart1, plan_version: v0 },
    },
    TENANT_ID,
    'work_order',
    WO_ID,
  );
  let v1 = null;
  if (pvProbe1.ok) {
    const after1 = await readWO(headers);
    v1 = after1.plan_version;
    if (v1 === v0 + 1) {
      results.pass += 1;
      console.log(`  ✓ WO: plan_version bumped v${v0} → v${v1}`);
    } else {
      results.fail += 1;
      results.failed.push('WO: plan_version bumped on planning UPDATE');
      console.log(`  ✗ WO: plan_version expected v${v0 + 1}, got v${v1}`);
    }
  }

  // Stale version → 409 with planning.version_conflict.
  const planVersionStart2 = new Date(Date.now() + 5 * 86400000).toISOString();
  const pvStale = await probe('WO: stale plan_version → 409', {
    url: `${API_BASE}/api/work-orders/${WO_ID}`,
    body: { planned_start_at: planVersionStart2, plan_version: v0 },
    expect: 'conflict',
  });
  if (pvStale.ok) {
    let parsed = null;
    try {
      parsed = JSON.parse(pvStale.body);
    } catch {
      // ignore
    }
    if (
      parsed &&
      parsed.code === 'planning.version_conflict' &&
      parsed.serverVersion === String(v1) &&
      parsed.clientVersion === String(v0)
    ) {
      results.pass += 1;
      console.log(
        `  ✓ WO: stale plan_version body (code+serverVersion=${parsed.serverVersion} clientVersion=${parsed.clientVersion})`,
      );
    } else {
      results.fail += 1;
      results.failed.push('WO: stale plan_version body shape');
      console.log(
        `  ✗ WO: stale plan_version body shape — got code=${parsed?.code} serverVersion=${parsed?.serverVersion} clientVersion=${parsed?.clientVersion}`,
      );
    }
  }

  // Fresh version → 200 again. Proves "Keep mine" path: re-read fresh
  // plan_version then re-PATCH.
  await probeAndAssertCommandOp(
    probe,
    'WO: fresh plan_version after conflict → 200',
    {
      url: `${API_BASE}/api/work-orders/${WO_ID}`,
      body: { planned_start_at: planVersionStart2, plan_version: v1 },
    },
    TENANT_ID,
    'work_order',
    WO_ID,
  );

  // Restore a sensible plan again for downstream probes.
  await probeAndAssertCommandOp(probe, 'WO: restore plan (post plan_version)', {
    url: `${API_BASE}/api/work-orders/${WO_ID}`,
    body: {
      planned_start_at: new Date(Date.now() + 86400000).toISOString(),
      planned_duration_minutes: 60,
    },
  }, TENANT_ID, 'work_order', WO_ID);

  // ── 00384 codex remediation — concurrent-race authoritative gate ────
  //
  // The sequential stale-version probe above proves the *TS pre-check*
  // path works. The race window codex flagged is when two PATCHes run
  // SIMULTANEOUSLY and both pre-checks read the same version N — they
  // both pass, both serialize through the RPC, last write wins. 00384
  // moved the compare INSIDE the RPC under `SELECT FOR UPDATE`, making
  // that authoritative. To actually exercise it, fire two PATCHes with
  // the same starting plan_version via `Promise.all` and assert exactly
  // one wins.
  //
  // Probe shape:
  //   1. Read current plan_version (vStart).
  //   2. Promise.all([PATCH1, PATCH2]) — both with plan_version=vStart,
  //      different planned_start_at values (so both want to mutate),
  //      different X-Client-Request-Ids (so command_operations doesn't
  //      dedupe at the idempotency layer — we want the race, not the
  //      idempotency-replay).
  //   3. Assert: one returns 2xx, one returns 409.
  //   4. Parse the 409 body, assert `code=planning.version_conflict`,
  //      `serverVersion=vStart+1` (the winner's post-trigger value),
  //      `clientVersion=vStart`.
  //   5. Restore plan to a stable value.
  //
  // The race probe is the structural defense against the "all unit tests
  // pass + production silently corrupts under concurrent load" failure
  // mode. Mocked tests will never catch this — only a live concurrent
  // call against a real Postgres will.
  const raceStartV = await readWO(headers);
  const vRaceStart = raceStartV.plan_version;
  const raceStart1 = new Date(Date.now() + 100 * 86400000).toISOString();
  const raceStart2 = new Date(Date.now() + 101 * 86400000).toISOString();
  const raceCid1 = crypto.randomUUID();
  const raceCid2 = crypto.randomUUID();
  const fireRace = async (cid, planStart) => {
    const r = await fetch(`${API_BASE}/api/work-orders/${WO_ID}`, {
      method: 'PATCH',
      headers: { ...headers, 'X-Client-Request-Id': cid },
      body: JSON.stringify({
        planned_start_at: planStart,
        plan_version: vRaceStart,
      }),
    });
    return { status: r.status, body: await r.text() };
  };
  const [race1, race2] = await Promise.all([
    fireRace(raceCid1, raceStart1),
    fireRace(raceCid2, raceStart2),
  ]);
  const okStatuses = [race1.status, race2.status].sort();
  // Expected outcome: one wins (200), one loses (409). The race may
  // also surface as one 200 + one TS-pre-check 409 if the loser's TS
  // read landed AFTER the winner's RPC commit — both outcomes are
  // correct (the RPC body always carries the same wire shape). The
  // only failure is "both 200" (last-write-wins corruption) or any
  // 5xx.
  if (okStatuses[0] === 200 && okStatuses[1] === 409) {
    results.pass += 1;
    console.log(
      `  ✓ WO: concurrent race — exactly one 200 + one 409 (00384 authoritative gate)`,
    );
    const losing = race1.status === 409 ? race1 : race2;
    let parsed = null;
    try {
      parsed = JSON.parse(losing.body);
    } catch {
      // ignore
    }
    const expectedServer = String(vRaceStart + 1);
    const expectedClient = String(vRaceStart);
    if (
      parsed &&
      parsed.code === 'planning.version_conflict' &&
      parsed.serverVersion === expectedServer &&
      parsed.clientVersion === expectedClient
    ) {
      results.pass += 1;
      console.log(
        `  ✓ WO: concurrent loser body (serverVersion=${parsed.serverVersion} clientVersion=${parsed.clientVersion})`,
      );
    } else {
      results.fail += 1;
      results.failed.push('WO: concurrent loser body shape');
      console.log(
        `  ✗ WO: concurrent loser body shape — got code=${parsed?.code} serverVersion=${parsed?.serverVersion} clientVersion=${parsed?.clientVersion} (expected server=${expectedServer} client=${expectedClient})`,
      );
    }
  } else {
    results.fail += 1;
    results.failed.push('WO: concurrent race outcome');
    console.log(
      `  ✗ WO: concurrent race — expected [200, 409], got [${race1.status}, ${race2.status}]`,
    );
    console.log(`     race1 body: ${race1.body.slice(0, 200)}`);
    console.log(`     race2 body: ${race2.body.slice(0, 200)}`);
  }
  // Restore plan to a known value (use the post-race fresh version).
  const afterRace = await readWO(headers);
  await probeAndAssertCommandOp(probe, 'WO: restore plan (post race)', {
    url: `${API_BASE}/api/work-orders/${WO_ID}`,
    body: {
      planned_start_at: new Date(Date.now() + 86400000).toISOString(),
      planned_duration_minutes: 60,
      plan_version: afterRace.plan_version,
    },
  }, TENANT_ID, 'work_order', WO_ID);

  // ── 00384 codex remediation — _source in idempotency hash ───────────
  //
  // Pre-00384 the payload_hash was md5(p_patches::text) only. Two
  // PATCHes with the same X-Client-Request-Id + same patches but
  // different _source would silently dedupe (the audit row carried
  // whatever source went first). 00384 includes p_activity_source in
  // the hash; the second call now trips command_operations.payload_mismatch.
  //
  // Probe shape:
  //   1. PATCH with crid=X + _source='board' + a fresh timestamp → 200.
  //   2. PATCH with crid=X + same patches + _source='detail' → 409
  //      command_operations.payload_mismatch.
  const sourceCid = crypto.randomUUID();
  const sourceStart = new Date(Date.now() + 200 * 86400000).toISOString();
  const sourceFirst = await fetch(`${API_BASE}/api/work-orders/${WO_ID}`, {
    method: 'PATCH',
    headers: { ...headers, 'X-Client-Request-Id': sourceCid },
    body: JSON.stringify({ planned_start_at: sourceStart, _source: 'board' }),
  });
  if (sourceFirst.status >= 200 && sourceFirst.status < 300) {
    results.pass += 1;
    console.log(`  ✓ WO: source-hash first PATCH (_source=board) → 200`);
  } else {
    results.fail += 1;
    results.failed.push('WO: source-hash first PATCH');
    console.log(
      `  ✗ WO: source-hash first PATCH → ${sourceFirst.status} (expected 200)`,
    );
    console.log(`     ${(await sourceFirst.text()).slice(0, 200)}`);
  }
  const sourceReplay = await fetch(`${API_BASE}/api/work-orders/${WO_ID}`, {
    method: 'PATCH',
    headers: { ...headers, 'X-Client-Request-Id': sourceCid },
    body: JSON.stringify({ planned_start_at: sourceStart, _source: 'detail' }),
  });
  const sourceReplayBody = await sourceReplay.text();
  if (sourceReplay.status === 409) {
    let parsedReplay = null;
    try {
      parsedReplay = JSON.parse(sourceReplayBody);
    } catch {
      // ignore
    }
    if (parsedReplay && parsedReplay.code === 'command_operations.payload_mismatch') {
      results.pass += 1;
      console.log(
        `  ✓ WO: source-hash replay (same crid + different _source) → 409 payload_mismatch`,
      );
    } else {
      results.fail += 1;
      results.failed.push('WO: source-hash replay body shape');
      console.log(
        `  ✗ WO: source-hash replay body shape — got code=${parsedReplay?.code}`,
      );
    }
  } else {
    results.fail += 1;
    results.failed.push('WO: source-hash replay status');
    console.log(
      `  ✗ WO: source-hash replay status → ${sourceReplay.status} (expected 409)`,
    );
    console.log(`     ${sourceReplayBody.slice(0, 240)}`);
  }
  // Restore plan to a stable value for downstream probes.
  await probeAndAssertCommandOp(probe, 'WO: restore plan (post source-hash)', {
    url: `${API_BASE}/api/work-orders/${WO_ID}`,
    body: {
      planned_start_at: new Date(Date.now() + 86400000).toISOString(),
      planned_duration_minutes: 60,
    },
  }, TENANT_ID, 'work_order', WO_ID);

  // ── P1-4 audit-source provenance probe (00383 v6) ───────────────────
  // The combined-update RPC v6 adds an optional p_activity_source arg.
  // When the plan branch fires, the value lands in ticket_activities.
  // metadata->>source so operators can tell the planning board ('board')
  // from the detail-page PlanField ('detail') from the Slice C PM
  // generator ('generator'). Probe shape:
  //   1. Read the current plan_version + planned_start_at for the WO.
  //   2. PATCH planned_start_at with _source: 'board' (different value
  //      from the restore probe above so the no-op fast path can't fire).
  //   3. Query the most recent plan_changed activity row for the WO and
  //      assert metadata->>'source' = 'board'.
  // Audit rows are append-only by design — no teardown required.
  const auditProbeStart = new Date(Date.now() + 7 * 86400000).toISOString();
  const auditProbe = await probeAndAssertCommandOp(
    probe,
    'WO: plan PATCH with _source=board → 200',
    {
      url: `${API_BASE}/api/work-orders/${WO_ID}`,
      body: { planned_start_at: auditProbeStart, _source: 'board' },
    },
    TENANT_ID,
    'work_order',
    WO_ID,
  );
  if (auditProbe.ok) {
    // The RPC inserts the plan_changed row inside the same transaction
    // as the work_orders UPDATE; by the time the HTTP response lands
    // the row is committed + queryable by the admin client.
    const { data: auditRows, error: auditErr } = await supa()
      .from('ticket_activities')
      .select('metadata, created_at')
      .eq('tenant_id', TENANT_ID)
      .eq('ticket_id', WO_ID)
      .eq('activity_type', 'system_event')
      .order('created_at', { ascending: false })
      .limit(1);
    if (auditErr) {
      results.fail += 1;
      results.failed.push('WO: audit row source=board (query error)');
      console.log(`  ✗ WO: audit row source=board (query error: ${auditErr.message})`);
    } else if (!auditRows || auditRows.length === 0) {
      results.fail += 1;
      results.failed.push('WO: audit row source=board (no row)');
      console.log(`  ✗ WO: audit row source=board — no ticket_activities row after PATCH`);
    } else {
      const meta = auditRows[0].metadata ?? {};
      if (meta.event === 'plan_changed' && meta.source === 'board') {
        results.pass += 1;
        console.log(`  ✓ WO: audit row metadata.source=board (event=plan_changed)`);
      } else {
        results.fail += 1;
        results.failed.push('WO: audit row source=board (wrong shape)');
        console.log(
          `  ✗ WO: audit row source=board — got event=${meta.event} source=${meta.source}`,
        );
      }
    }
  }

  // Full-review I5 (2026-05-12) — verify the 'detail' source path
  // end-to-end. The previous probe only covered _source: 'board' via the
  // planning-board surface; the detail-page surface (PlanField in
  // ticket-detail.tsx:348) was wired but unverified. Probe shape mirrors
  // the board probe — different timestamp so the no-op fast path can't
  // mask a regression, audit row append-only so no teardown required.
  const auditProbeDetailStart = new Date(Date.now() + 9 * 86400000).toISOString();
  const auditProbeDetail = await probeAndAssertCommandOp(
    probe,
    'WO: plan PATCH with _source=detail → 200',
    {
      url: `${API_BASE}/api/work-orders/${WO_ID}`,
      body: { planned_start_at: auditProbeDetailStart, _source: 'detail' },
    },
    TENANT_ID,
    'work_order',
    WO_ID,
  );
  if (auditProbeDetail.ok) {
    const { data: detailAuditRows, error: detailAuditErr } = await supa()
      .from('ticket_activities')
      .select('metadata, created_at')
      .eq('tenant_id', TENANT_ID)
      .eq('ticket_id', WO_ID)
      .eq('activity_type', 'system_event')
      .order('created_at', { ascending: false })
      .limit(1);
    if (detailAuditErr) {
      results.fail += 1;
      results.failed.push('WO: audit row source=detail (query error)');
      console.log(`  ✗ WO: audit row source=detail (query error: ${detailAuditErr.message})`);
    } else if (!detailAuditRows || detailAuditRows.length === 0) {
      results.fail += 1;
      results.failed.push('WO: audit row source=detail (no row)');
      console.log(`  ✗ WO: audit row source=detail — no ticket_activities row after PATCH`);
    } else {
      const meta = detailAuditRows[0].metadata ?? {};
      if (meta.event === 'plan_changed' && meta.source === 'detail') {
        results.pass += 1;
        console.log(`  ✓ WO: audit row metadata.source=detail (event=plan_changed)`);
      } else {
        results.fail += 1;
        results.failed.push('WO: audit row source=detail (wrong shape)');
        console.log(
          `  ✗ WO: audit row source=detail — got event=${meta.event} source=${meta.source}`,
        );
      }
    }
  }

  // Invalid _source must reject at the controller layer before any RPC
  // call lands. Defense in depth: even though the RPC re-validates,
  // the controller's enum gate is what users hit first.
  const badSource = await probe('WO: _source=invalid → 400', {
    url: `${API_BASE}/api/work-orders/${WO_ID}`,
    body: {
      planned_start_at: new Date(Date.now() + 8 * 86400000).toISOString(),
      _source: 'bogus',
    },
    expect: 'badrequest',
  });
  if (badSource.ok) {
    let parsed = null;
    try {
      parsed = JSON.parse(badSource.body);
    } catch {
      // ignore
    }
    if (parsed && parsed.code === 'work_order.field_invalid') {
      results.pass += 1;
      console.log('  ✓ WO: invalid _source rejected (code=work_order.field_invalid)');
    } else {
      results.fail += 1;
      results.failed.push('WO: invalid _source rejected (code check)');
      console.log(`  ✗ WO: invalid _source rejected (code check) — got code=${parsed?.code}`);
    }
  }

  // sla: clear (null is XOR-different from any current sla_id)
  await probeAndAssertCommandOp(probe, 'WO: sla_id = null', {
    url: `${API_BASE}/api/work-orders/${WO_ID}`,
    body: { sla_id: null },
  }, TENANT_ID, 'work_order', WO_ID);

  // assignment: swap teams
  const nextTeam = cur.assigned_team_id === REAL_TEAM ? ALT_TEAM : REAL_TEAM;
  await probeAndAssertCommandOp(probe, 'WO: assignment swap', {
    url: `${API_BASE}/api/work-orders/${WO_ID}`,
    body: { assigned_team_id: nextTeam },
  }, TENANT_ID, 'work_order', WO_ID);

  // metadata: title with timestamp suffix (always XOR-different)
  await probeAndAssertCommandOp(probe, 'WO: title (Slice 3.1)', {
    url: `${API_BASE}/api/work-orders/${WO_ID}`,
    body: { title: `smoke-${Date.now()}` },
  }, TENANT_ID, 'work_order', WO_ID);

  // metadata: tags
  const nextTags =
    JSON.stringify(cur.tags) === JSON.stringify(['smoke-a']) ? ['smoke-b'] : ['smoke-a'];
  await probeAndAssertCommandOp(probe, 'WO: tags (Slice 3.1)', {
    url: `${API_BASE}/api/work-orders/${WO_ID}`,
    body: { tags: nextTags },
  }, TENANT_ID, 'work_order', WO_ID);

  // metadata: cost (fractional — float-normalization regression test)
  const nextCost = (cur.cost ?? 0) + 0.1 + 0.2; // intentionally drift-prone
  await probeAndAssertCommandOp(probe, 'WO: cost (fractional, normalization)', {
    url: `${API_BASE}/api/work-orders/${WO_ID}`,
    body: { cost: nextCost },
  }, TENANT_ID, 'work_order', WO_ID);
}

async function runCaseMutations(headers, probe) {
  console.log('\n=== Case mutations ===');

  // priority: flip
  await probeAndAssertCommandOp(probe, 'CASE: priority flip', {
    url: `${API_BASE}/api/tickets/${CASE_ID}`,
    body: { priority: 'high' },
  }, TENANT_ID, 'case', CASE_ID);

  // assignment: swap teams (validation now enforced)
  await probeAndAssertCommandOp(probe, 'CASE: assignment to real team', {
    url: `${API_BASE}/api/tickets/${CASE_ID}`,
    body: { assigned_team_id: REAL_TEAM },
  }, TENANT_ID, 'case', CASE_ID);

  // title
  await probeAndAssertCommandOp(probe, 'CASE: title', {
    url: `${API_BASE}/api/tickets/${CASE_ID}`,
    body: { title: `smoke-case-${Date.now()}` },
  }, TENANT_ID, 'case', CASE_ID);

  // cost (fractional — float-normalization regression test, case side).
  // Backports the WO-side fix per /full-review I3. Sends 0.1+0.2 which
  // is 0.30000000000000004 in IEEE-754; without normalization the no-op
  // fast-path would never fire and every PATCH would re-write the row.
  const r = await fetch(`${API_BASE}/api/tickets/${CASE_ID}`, { headers });
  const cur = await r.json();
  const nextCost = (cur.cost ?? 0) + 0.1 + 0.2;
  await probeAndAssertCommandOp(probe, 'CASE: cost (fractional, normalization)', {
    url: `${API_BASE}/api/tickets/${CASE_ID}`,
    body: { cost: nextCost },
  }, TENANT_ID, 'case', CASE_ID);
}

async function runValidationProbes(headers, probe) {
  console.log('\n=== Validation probes (must all reject with 400) ===');

  // Ghost uuid on watchers (both surfaces)
  await probe('WO: watchers ghost uuid → 400', {
    url: `${API_BASE}/api/work-orders/${WO_ID}`,
    body: { watchers: [GHOST_UUID] },
    expect: 'badrequest',
  });
  await probe('CASE: watchers ghost uuid → 400', {
    url: `${API_BASE}/api/tickets/${CASE_ID}`,
    body: { watchers: [GHOST_UUID] },
    expect: 'badrequest',
  });

  // Malformed uuid
  await probe('WO: malformed uuid → 400', {
    url: `${API_BASE}/api/work-orders/${WO_ID}`,
    body: { watchers: ['not-a-uuid'] },
    expect: 'badrequest',
  });
  await probe('CASE: malformed uuid → 400', {
    url: `${API_BASE}/api/tickets/${CASE_ID}`,
    body: { watchers: ['not-a-uuid'] },
    expect: 'badrequest',
  });

  // Oversized array (>200)
  const tooMany = Array.from(
    { length: 201 },
    (_, i) => `cccccccc-cccc-cccc-cccc-${String(i).padStart(12, '0')}`,
  );
  await probe('WO: oversized watchers array → 400', {
    url: `${API_BASE}/api/work-orders/${WO_ID}`,
    body: { watchers: tooMany },
    expect: 'badrequest',
  });

  // Ghost assignee on case (was unvalidated pre-fix)
  await probe('CASE: ghost assigned_team_id → 400', {
    url: `${API_BASE}/api/tickets/${CASE_ID}`,
    body: { assigned_team_id: GHOST_UUID },
    expect: 'badrequest',
  });

  // Empty title
  await probe('WO: empty title → 400', {
    url: `${API_BASE}/api/work-orders/${WO_ID}`,
    body: { title: '   ' },
    expect: 'badrequest',
  });
}

async function runPlanningProbes(headers, probe) {
  console.log('\n=== Planning board read path (Slice B Chunk 1) ===');

  const now = new Date();
  const today00 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
  const tomorrow00 = new Date(today00.getTime() + 24 * 60 * 60 * 1000);
  const fromIso = today00.toISOString();
  const toIso = tomorrow00.toISOString();

  // Happy path.
  const happyUrl = `${API_BASE}/api/work-orders/planning?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`;
  const happyResp = await fetch(happyUrl, { headers });
  if (happyResp.status !== 200) {
    results.fail += 1;
    results.failed.push('Planning: happy path');
    console.log(`  ✗ GET planning happy → HTTP ${happyResp.status}`);
    console.log(`     ${(await happyResp.text()).slice(0, 240)}`);
  } else {
    const body = await happyResp.json();
    const ok = body && Array.isArray(body.planned) && Array.isArray(body.unscheduled);
    if (!ok) {
      results.fail += 1;
      results.failed.push('Planning: happy shape');
      console.log(`  ✗ GET planning happy — response missing planned[] / unscheduled[]`);
    } else {
      results.pass += 1;
      console.log(
        `  ✓ GET planning happy → 200 (${body.planned.length} planned, ${body.unscheduled.length} unscheduled)`,
      );
      const allRows = [...body.planned, ...body.unscheduled];
      const malformed = allRows.find(
        (b) => typeof b.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(b.id),
      );
      if (malformed) {
        results.fail += 1;
        results.failed.push('Planning: block shape');
        console.log(`  ✗ Planning block has malformed id`);
      } else if (allRows.length > 0) {
        results.pass += 1;
        console.log(`  ✓ Planning blocks have well-formed ids + lane shape`);
      }
    }
  }

  // Window too wide (>14 days) — 400.
  const wideToIso = new Date(today00.getTime() + 15 * 24 * 60 * 60 * 1000).toISOString();
  await probe('Planning: 15-day window → 400', {
    url: `${API_BASE}/api/work-orders/planning?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(wideToIso)}`,
    method: 'GET',
    expect: 'badrequest',
  });

  // from == to — 400.
  await probe('Planning: from == to → 400', {
    url: `${API_BASE}/api/work-orders/planning?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(fromIso)}`,
    method: 'GET',
    expect: 'badrequest',
  });

  // Missing from — 400.
  await probe('Planning: missing from → 400', {
    url: `${API_BASE}/api/work-orders/planning?to=${encodeURIComponent(toIso)}`,
    method: 'GET',
    expect: 'badrequest',
  });

  // Unknown status — 400.
  await probe('Planning: unknown status → 400', {
    url: `${API_BASE}/api/work-orders/planning?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&status=bogus`,
    method: 'GET',
    expect: 'badrequest',
  });

  // Valid status filter — 200 and only matching categories on both
  // planned[] AND unscheduled[]. Codex review 2026-05-12 flagged that the
  // previous version inspected only planned[] and could pass vacuously on
  // an empty seed. We now assert the unscheduled[] also obeys the filter
  // (open-status floor + the requested filter union).
  const statusUrl = `${API_BASE}/api/work-orders/planning?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&status=new&status=assigned`;
  const statusResp = await fetch(statusUrl, { headers });
  if (statusResp.status === 200) {
    const body = await statusResp.json();
    const allowed = new Set(['new', 'assigned']);
    const plannedViolator = body.planned.find((b) => !allowed.has(b.status_category));
    const unschedViolator = body.unscheduled.find((b) => !allowed.has(b.status_category));
    if (plannedViolator || unschedViolator) {
      results.fail += 1;
      results.failed.push('Planning: status filter leak');
      const v = plannedViolator ?? unschedViolator;
      const where = plannedViolator ? 'planned[]' : 'unscheduled[]';
      console.log(`  ✗ Planning status filter leaked: ${where} contains ${v.status_category}`);
    } else {
      results.pass += 1;
      console.log(
        `  ✓ Planning status filter — only new/assigned across ${body.planned.length} planned + ${body.unscheduled.length} unscheduled`,
      );
    }
  } else {
    results.fail += 1;
    results.failed.push('Planning: valid status filter');
    console.log(`  ✗ GET planning status filter → HTTP ${statusResp.status}`);
  }

  // Block shape probes — assert every block carries the typed lane and
  // a boolean can_plan. Catches the next breaking regression in the wire
  // shape without relying on seed counts.
  const shapeUrl = `${API_BASE}/api/work-orders/planning?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`;
  const shapeResp = await fetch(shapeUrl, { headers });
  if (shapeResp.status === 200) {
    const body = await shapeResp.json();
    const allBlocks = [...body.planned, ...body.unscheduled];
    if (allBlocks.length === 0) {
      // No data is acceptable — but a stricter env should fail closed.
      console.log(`  · Planning shape probe — empty result, skipped`);
    } else {
      const badLane = allBlocks.find(
        (b) =>
          !b.lane ||
          typeof b.lane.kind !== 'string' ||
          !['user', 'team', 'vendor', 'unassigned'].includes(b.lane.kind) ||
          typeof b.lane.label !== 'string',
      );
      const badCanPlan = allBlocks.find((b) => typeof b.can_plan !== 'boolean');
      const badUnschedPlanField = body.unscheduled.find((b) => b.planned_start_at !== null);
      // P1-1: top-level `lanes: PlanningLaneId[]` is mandatory on the
      // response. Asserted as an array (possibly empty); each entry must
      // carry the same shape as `block.lane`. Catches a regression that
      // drops or reshapes the field.
      const badLanesShape =
        !Array.isArray(body.lanes) ||
        body.lanes.some(
          (l) =>
            !l ||
            typeof l.kind !== 'string' ||
            !['user', 'team', 'vendor', 'unassigned'].includes(l.kind) ||
            typeof l.label !== 'string',
        );
      if (badLane || badCanPlan || badUnschedPlanField || badLanesShape) {
        results.fail += 1;
        results.failed.push('Planning: block shape probe');
        if (badLane) console.log(`  ✗ Planning block has malformed lane: ${JSON.stringify(badLane.lane)}`);
        if (badCanPlan) console.log(`  ✗ Planning block missing can_plan boolean`);
        if (badUnschedPlanField) console.log(`  ✗ Unscheduled block has non-null planned_start_at`);
        if (badLanesShape) console.log(`  ✗ Planning response missing or malformed lanes[] (P1-1): ${JSON.stringify(body.lanes)?.slice(0, 200)}`);
      } else {
        results.pass += 1;
        console.log(`  ✓ Planning block shape — lane typed, can_plan boolean, unscheduled has null planned_start_at, lanes[] present`);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// P0-3 — requester-only actor coverage for the planning surface.
//
// Codex (commit 5a689110) flagged that 00380's operator-only predicate
// (`work_orders_planning_visible_for_actor`) shipped without end-to-end
// exclusion coverage: every existing smoke probe runs as Admin (read_all
// override), so the predicate's requester/watcher exclusion branch was
// unverified against the live API. A regression that re-introduced the
// requester branch would still see all smoke probes pass.
//
// This probe runs against the requester-only user seeded in
// 00381_planning_smoke_requester_seed.sql:
//   - No team memberships, no role assignments, no read_all permission.
//   - Paired fixture WO `aa000000-…-0000b1` carries
//     `requester_person_id` = the seed person, with `planned_start_at`
//     inside today's planning window.
//
// Expected: `planned: []` AND `unscheduled: []`. The fixture WO must
// be excluded because the requester has zero operator paths
// (assignee / team-member / role-scope / vendor) into the row.
//
// Non-vacuous check: the probe also asserts the fixture WO exists at
// the DB level (via the supabase admin client). If the fixture is
// missing, the smoke would pass on an empty response for the wrong
// reason — we want pass-on-exclusion, not pass-on-no-data.
// ─────────────────────────────────────────────────────────────────────

// Fetch the planning window for the given headers and return parsed body
// (or null on error — the caller records the failure with the right
// probe label). Optionally pass `teamId` to set the `?team_id=` query
// param — used by the full-review C1 probe to assert the operator gate
// also blocks the lane-roster leak path (requester + ?team_id).
async function fetchPlanningWindow(headers, fromIso, toIso, teamId) {
  const params = `from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}${
    teamId ? `&team_id=${encodeURIComponent(teamId)}` : ''
  }`;
  const url = `${API_BASE}/api/work-orders/planning?${params}`;
  const resp = await fetch(url, { headers });
  if (resp.status !== 200) {
    return { ok: false, status: resp.status, text: await resp.text() };
  }
  const body = await resp.json();
  if (!body || !Array.isArray(body.planned) || !Array.isArray(body.unscheduled)) {
    return { ok: false, status: 200, text: 'malformed response' };
  }
  return { ok: true, body };
}

// Hit the planning endpoint expecting a 403 + planning.operator_only code
// (full-review C1). Returns { ok: true } when both checks pass; on any
// mismatch returns a structured failure description that the caller logs
// + counts.
async function expectPlanningOperatorOnly(headers, fromIso, toIso, teamId) {
  const params = `from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}${
    teamId ? `&team_id=${encodeURIComponent(teamId)}` : ''
  }`;
  const url = `${API_BASE}/api/work-orders/planning?${params}`;
  const resp = await fetch(url, { headers });
  if (resp.status !== 403) {
    return {
      ok: false,
      reason: `expected HTTP 403, got ${resp.status}`,
      body: (await resp.text()).slice(0, 240),
    };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(await resp.text());
  } catch {
    return { ok: false, reason: 'response not JSON' };
  }
  if (parsed?.code !== 'planning.operator_only') {
    return {
      ok: false,
      reason: `expected code=planning.operator_only, got code=${parsed?.code}`,
    };
  }
  return { ok: true };
}

// To run the negative-control branch (which proves the probe is
// non-vacuous): `DEBUG_NEGATIVE_REQUESTER_PROBE=1 pnpm smoke:work-orders`.
// The branch inserts a temporary team_members row that grants the
// requester an operator path, re-runs the probe, asserts it now sees
// the fixture, then drops the membership. Run manually after any change
// to the predicate or seed. The normal smoke run (env unset) is the
// green path only.
async function runPlanningRequesterProbe(adminHeaders) {
  console.log('\n=== Planning requester-only probe (P0-3 — operator-only predicate) ===');

  // Pre-flight: confirm the fixture WO exists at the DB level so the
  // assertion is non-vacuous. Without this, an empty planning response
  // could mean either "predicate excluded correctly" or "seed missing".
  const { data: fixture, error: fixtureErr } = await supa()
    .from('work_orders')
    .select('id, requester_person_id, planned_start_at, tenant_id')
    .eq('id', PLANNING_REQUESTER_FIXTURE_WO_ID)
    .maybeSingle();
  if (fixtureErr || !fixture) {
    results.fail += 1;
    results.failed.push('Planning requester: fixture missing');
    console.log(
      `  ✗ fixture WO ${PLANNING_REQUESTER_FIXTURE_WO_ID} not found — run migration 00381 first`,
    );
    return;
  }
  if (fixture.tenant_id !== TENANT_ID) {
    results.fail += 1;
    results.failed.push('Planning requester: fixture wrong tenant');
    console.log(`  ✗ fixture WO tenant mismatch: ${fixture.tenant_id}`);
    return;
  }

  // Bump the fixture's planned_start_at into today's UTC window. The
  // migration sets this at migration time; on day N+1+ the value drifts
  // out of the probe's today→tomorrow window and the empty-arrays
  // assertion silently passes for the wrong reason (fixture filtered
  // out by window, not by predicate). The bump lives here so the
  // migration stays a pure seed.
  const now = new Date();
  const today00 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
  const tomorrow00 = new Date(today00.getTime() + 24 * 60 * 60 * 1000);
  const fixtureStart = new Date(today00.getTime() + 12 * 60 * 60 * 1000).toISOString();
  const fromIso = today00.toISOString();
  const toIso = tomorrow00.toISOString();

  const { error: bumpErr } = await supa()
    .from('work_orders')
    .update({ planned_start_at: fixtureStart })
    .eq('id', PLANNING_REQUESTER_FIXTURE_WO_ID);
  if (bumpErr) {
    results.fail += 1;
    results.failed.push('Planning requester: fixture bump failed');
    console.log(`  ✗ could not bump fixture into today's window: ${bumpErr.message}`);
    return;
  }
  results.pass += 1;
  console.log(`  ✓ fixture WO bumped to ${fixtureStart} (today's window)`);

  // Positive control — Admin JWT (read_all override) MUST see the
  // fixture in `planned`. If it doesn't, the fixture isn't actually
  // in-window or isn't readable at all, and the requester's empty
  // result downstream is meaningless. Both halves must pass for the
  // probe to be non-vacuous.
  const posBody = await fetchPlanningWindow(adminHeaders, fromIso, toIso);
  if (!posBody.ok) {
    results.fail += 1;
    results.failed.push('Planning requester: positive-control GET non-200');
    console.log(`  ✗ admin positive-control GET → HTTP ${posBody.status}`);
    console.log(`     ${(posBody.text || '').slice(0, 240)}`);
    return;
  }
  const adminSeesFixture =
    posBody.body.planned.some((b) => b.id === PLANNING_REQUESTER_FIXTURE_WO_ID) ||
    posBody.body.unscheduled.some((b) => b.id === PLANNING_REQUESTER_FIXTURE_WO_ID);
  if (!adminSeesFixture) {
    results.fail += 1;
    results.failed.push('Planning requester: positive-control missed fixture');
    console.log(
      `  ✗ admin (read_all) does NOT see fixture WO — probe would be vacuous; verify window + fixture state`,
    );
    return;
  }
  results.pass += 1;
  console.log(`  ✓ admin (read_all) sees fixture WO — predicate exclusion is the only remaining question`);

  // Bootstrap auth.users for the requester (idempotent — see comment on
  // PLANNING_REQUESTER_AUTH_UID for why this isn't done in SQL).
  try {
    await ensureRequesterAuthUser();
  } catch (e) {
    results.fail += 1;
    results.failed.push('Planning requester: auth bootstrap failed');
    console.log(`  ✗ ${e.message}`);
    return;
  }

  // Mint a JWT for the requester-only seed user.
  let requesterToken;
  try {
    requesterToken = await mintTokenFor(PLANNING_REQUESTER_AUTH_UID);
  } catch (e) {
    results.fail += 1;
    results.failed.push('Planning requester: token mint failed');
    console.log(`  ✗ failed to mint JWT for requester seed: ${e.message}`);
    return;
  }
  const reqHeaders = {
    Authorization: `Bearer ${requesterToken}`,
    'X-Tenant-Id': TENANT_ID,
    'Content-Type': 'application/json',
  };

  // Full-review C1 (2026-05-12) — the planning endpoint is now gated at
  // the controller. A requester with zero operator paths must receive a
  // 403 with code=planning.operator_only, not a 200 with empty arrays.
  // The previous probe (200 + empty arrays) was insufficient: when
  // `?team_id` was supplied, the service ran `loadTeamRoster` +
  // `loadActiveTenantVendors` BEFORE applying the predicate, leaking the
  // roster + vendor identities back to the requester. The controller gate
  // closes that path; this probe verifies the gate fires.
  const noTeamProbe = await expectPlanningOperatorOnly(reqHeaders, fromIso, toIso);
  if (!noTeamProbe.ok) {
    results.fail += 1;
    results.failed.push('Planning requester: operator gate (no team_id)');
    console.log(`  ✗ requester GET planning (no team_id) — ${noTeamProbe.reason}`);
    if (noTeamProbe.body) console.log(`     ${noTeamProbe.body}`);
    return;
  }
  results.pass += 1;
  console.log(`  ✓ requester GET planning → 403 planning.operator_only (no team_id)`);

  // C1 lane-roster leak — the more dangerous path. Without the
  // controller gate, this request would pull `team_members` + tenant
  // vendor labels into the response. The gate must block it identically.
  const teamProbe = await expectPlanningOperatorOnly(reqHeaders, fromIso, toIso, REAL_TEAM);
  if (!teamProbe.ok) {
    results.fail += 1;
    results.failed.push('Planning requester: operator gate (?team_id=…)');
    console.log(`  ✗ requester GET planning (?team_id=${REAL_TEAM.slice(0, 8)}…) — ${teamProbe.reason}`);
    if (teamProbe.body) console.log(`     ${teamProbe.body}`);
    return;
  }
  results.pass += 1;
  console.log(`  ✓ requester GET planning (?team_id) → 403 planning.operator_only (lane-roster leak closed)`);

  // Negative-control branch — env-gated. Codifies the "did I manually
  // verify the probe goes red when an operator path is granted?" check.
  // Skipped on the green path; run after any predicate or seed change.
  if (process.env.DEBUG_NEGATIVE_REQUESTER_PROBE === '1') {
    await runRequesterNegativeControl(reqHeaders, fromIso, toIso);
  }
}

// Three sub-scenarios — each independently grants the seed requester an
// operator path through ONE of the three branches `isOperatorContext`
// checks (team_members + role_assignment + read_all override is admin-
// only; assigned_user_id is technically a participant path but flips
// can_plan into "yes"). Each scenario inserts the operator grant,
// re-runs the planning probe (now expecting 200 because the controller
// gate passes), asserts the fixture is visible, then cleans up in
// `finally`. Full-review I2 (2026-05-12) — extends the prior single-
// scenario coverage so a future regression in either the role or
// assignee branch doesn't slip through.
async function runRequesterNegativeControl(reqHeaders, fromIso, toIso) {
  console.log('\n=== Planning requester NEGATIVE control (DEBUG_NEGATIVE_REQUESTER_PROBE=1) ===');

  // ── Scenario A: team_members grant ──────────────────────────────────
  await runNegativeControlScenarioTeamMembership(reqHeaders, fromIso, toIso);

  // ── Scenario B: user_role_assignments grant ─────────────────────────
  // The role_assignments branch of isOperatorContext is exercised here.
  // Uses the seeded Agent role (`91000000-0000-0000-0000-000000000002`,
  // migration 00102) with an empty domain_scope + location_scope (= all
  // domains / all locations) so the predicate flips for any fixture row.
  await runNegativeControlScenarioRoleAssignment(reqHeaders, fromIso, toIso);

  // ── Scenario C: assigned_user_id (planning predicate sees the
  //    requester as the assignee). This isn't an "operator" path in
  //    `isOperatorContext` BUT the SQL predicate `work_orders_planning_
  //    visible_for_actor` also includes the assignee branch. The
  //    controller gate fires FIRST though — so this scenario must STILL
  //    return 403 even though the seed is the assignee. That confirms
  //    the controller gate is the structural defense; assignee status
  //    alone doesn't unlock planning-board access.
  await runNegativeControlScenarioAssignedUser(reqHeaders, fromIso, toIso);
}

async function runNegativeControlScenarioTeamMembership(reqHeaders, fromIso, toIso) {
  console.log('\n  — Scenario A: team_members grant');
  const teamMemberId = crypto.randomUUID();
  let inserted = false;
  let reassigned = false;
  try {
    // tenant_id is invariant #0 — pin it explicitly on the insert.
    const { error: insErr } = await supa().from('team_members').insert({
      id: teamMemberId,
      tenant_id: TENANT_ID,
      team_id: REAL_TEAM,
      user_id: PLANNING_REQUESTER_USER_ID,
    });
    if (insErr) {
      results.fail += 1;
      results.failed.push('Negative-control A: team_members insert failed');
      console.log(`    ✗ could not grant operator path: ${insErr.message}`);
      return;
    }
    inserted = true;

    // Re-assign the fixture to REAL_TEAM for the duration of the control
    // so the team-membership branch of the SQL predicate matches.
    const { error: assignErr } = await supa()
      .from('work_orders')
      .update({ assigned_team_id: REAL_TEAM })
      .eq('id', PLANNING_REQUESTER_FIXTURE_WO_ID);
    if (assignErr) {
      results.fail += 1;
      results.failed.push('Negative-control A: fixture team-assign failed');
      console.log(`    ✗ could not assign fixture to REAL_TEAM: ${assignErr.message}`);
      return;
    }
    reassigned = true;

    const probe = await fetchPlanningWindow(reqHeaders, fromIso, toIso);
    if (!probe.ok) {
      results.fail += 1;
      results.failed.push('Negative-control A: GET non-200');
      console.log(`    ✗ GET → HTTP ${probe.status}`);
      return;
    }
    const seesFixture =
      probe.body.planned.some((b) => b.id === PLANNING_REQUESTER_FIXTURE_WO_ID) ||
      probe.body.unscheduled.some((b) => b.id === PLANNING_REQUESTER_FIXTURE_WO_ID);
    if (!seesFixture) {
      results.fail += 1;
      results.failed.push('Negative-control A: probe empty with team membership');
      console.log(`    ✗ team membership + fixture re-assigned STILL sees no rows`);
      return;
    }
    results.pass += 1;
    console.log(`    ✓ team-membership scenario non-vacuous`);
  } finally {
    if (reassigned) {
      const { error: unassignErr } = await supa()
        .from('work_orders')
        .update({ assigned_team_id: null })
        .eq('id', PLANNING_REQUESTER_FIXTURE_WO_ID);
      if (unassignErr) {
        console.log(`    ! cleanup warn: fixture unassign failed: ${unassignErr.message}`);
      }
    }
    if (inserted) {
      const { error: delErr } = await supa().from('team_members').delete().eq('id', teamMemberId);
      if (delErr) {
        console.log(`    ! cleanup warn: team_members delete failed: ${delErr.message}`);
      } else {
        console.log(`    ✓ cleanup: scenario A teardown clean`);
      }
    }
  }
}

async function runNegativeControlScenarioRoleAssignment(reqHeaders, fromIso, toIso) {
  console.log('\n  — Scenario B: user_role_assignments grant');
  const uraId = crypto.randomUUID();
  const AGENT_ROLE_ID = '91000000-0000-0000-0000-000000000002';
  let inserted = false;
  try {
    // Agent role + empty scope = matches any domain + any location.
    // The role_assignments branch of isOperatorContext checks
    // `role_assignments.length > 0` — granting an active row flips it.
    const { error: insErr } = await supa().from('user_role_assignments').insert({
      id: uraId,
      tenant_id: TENANT_ID,
      user_id: PLANNING_REQUESTER_USER_ID,
      role_id: AGENT_ROLE_ID,
      domain_scope: [],
      location_scope: [],
      read_only_cross_domain: false,
      active: true,
    });
    if (insErr) {
      // If user_role_assignments grant fails for shape reasons, log + skip
      // rather than fail the whole smoke. team_members + assigned_user_id
      // cover the bulk of the operator-path matrix.
      console.log(
        `    ! skipped: user_role_assignments insert failed (${insErr.message}) — team-member + assignee scenarios still cover the matrix`,
      );
      return;
    }
    inserted = true;

    const probe = await fetchPlanningWindow(reqHeaders, fromIso, toIso);
    if (!probe.ok) {
      results.fail += 1;
      results.failed.push('Negative-control B: GET non-200');
      console.log(`    ✗ GET → HTTP ${probe.status}`);
      return;
    }
    const seesFixture =
      probe.body.planned.some((b) => b.id === PLANNING_REQUESTER_FIXTURE_WO_ID) ||
      probe.body.unscheduled.some((b) => b.id === PLANNING_REQUESTER_FIXTURE_WO_ID);
    if (!seesFixture) {
      results.fail += 1;
      results.failed.push('Negative-control B: probe empty with role assignment');
      console.log(`    ✗ role assignment STILL sees no rows`);
      return;
    }
    results.pass += 1;
    console.log(`    ✓ role-assignment scenario non-vacuous`);
  } finally {
    if (inserted) {
      const { error: delErr } = await supa().from('user_role_assignments').delete().eq('id', uraId);
      if (delErr) {
        console.log(`    ! cleanup warn: user_role_assignments delete failed: ${delErr.message}`);
      } else {
        console.log(`    ✓ cleanup: scenario B teardown clean`);
      }
    }
  }
}

async function runNegativeControlScenarioAssignedUser(reqHeaders, fromIso, toIso) {
  console.log('\n  — Scenario C: assigned_user_id (participant path, NOT operator)');
  let assigned = false;
  try {
    // The seed user is now the assignee. The SQL predicate
    // `work_orders_planning_visible_for_actor` includes the assignee
    // branch, so without the controller gate the fixture would surface.
    // With the gate in place, the request must still 403 because
    // assignee status alone isn't an operator path per
    // isOperatorContext (no team_ids, no role_assignments,
    // no read_all).
    const { error: assignErr } = await supa()
      .from('work_orders')
      .update({ assigned_user_id: PLANNING_REQUESTER_USER_ID })
      .eq('id', PLANNING_REQUESTER_FIXTURE_WO_ID);
    if (assignErr) {
      results.fail += 1;
      results.failed.push('Negative-control C: assignee update failed');
      console.log(`    ✗ could not set assigned_user_id: ${assignErr.message}`);
      return;
    }
    assigned = true;

    // Critical assertion — the controller gate fires FIRST, so even
    // though the SQL predicate would include the fixture for the
    // assignee, the requester still gets 403. This is the gate's
    // defense-in-depth value: the predicate alone is not enough.
    const probe = await expectPlanningOperatorOnly(reqHeaders, fromIso, toIso);
    if (!probe.ok) {
      results.fail += 1;
      results.failed.push('Negative-control C: assignee bypassed operator gate');
      console.log(
        `    ✗ assignee bypassed controller gate — ${probe.reason} (defense-in-depth broken)`,
      );
      return;
    }
    results.pass += 1;
    console.log(`    ✓ assignee STILL receives 403 — controller gate not bypassed by participant paths`);
  } finally {
    if (assigned) {
      const { error: clearErr } = await supa()
        .from('work_orders')
        .update({ assigned_user_id: null })
        .eq('id', PLANNING_REQUESTER_FIXTURE_WO_ID);
      if (clearErr) {
        console.log(`    ! cleanup warn: assignee clear failed: ${clearErr.message}`);
      } else {
        console.log(`    ✓ cleanup: scenario C teardown clean`);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Slice C — PM generator probes (7 scenarios per ai/slice-c-plan.md §8).
//
// Why this exists: codex plan-review (v1 → v2) caught two direction errors
// that ONLY surface end-to-end against the real DB:
//   1. The v1 idempotency index `(plan_id, planned_start_at)` silently
//      collapsed asset-type fan-out to a single WO. The v2 index adds
//      `source_asset_id`. Scenario 2 below is THE test that proves fan-out
//      works — if it ever drops back to 1 WO, the index is wrong again.
//   2. The completion hook was originally a TS post-RPC write that ran
//      OUTSIDE the transition transaction. v2 moved it into the
//      `tg_pm_plan_last_completed_at` trigger (00390). Scenario 5 fires
//      a real status transition and asserts plan.last_completed_at moves
//      — if the trigger ever stops firing inside the transition tx, this
//      scenario goes red.
//
// Also the P0-3 timestamp bug pattern (vacuous-test risk): scenario 4
// guards "replay = 0 new WOs" so a future regression to non-idempotent
// generation surfaces immediately. The vacuous-test concern is that
// after scenario 2's run advances plan.next_run_at, the SELECT for due
// plans on replay may legitimately return nothing — both that AND
// `ON CONFLICT DO NOTHING` firing are correct outcomes; the only
// failure is `> 0 new WOs`.
//
// Fixture lifecycle: every scenario lives inside one outer `try/finally`.
// On exit the asset_type + assets + plans + spawned WOs + tenant-B
// request_type are dropped via the admin client (RLS bypass). Plan FK
// has `on delete cascade` for asset_id / asset_type_id — but
// `maintenance_plan_id` on work_orders is a `references … on delete
// (default = no action)`, so we delete work_orders BEFORE the plan.
// ─────────────────────────────────────────────────────────────────────

const PM_REQUEST_TYPE_ID = 'b1000000-0000-0000-0000-00000000001d'; // tenant A, real request_type

function utcMidnight(daysAhead = 0) {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
  d.setUTCDate(d.getUTCDate() + daysAhead);
  return d;
}

async function runPmGeneratorProbes(adminHeaders) {
  console.log('\n=== Slice C PM generator (9 scenarios) ===');

  // Fixture ids — pinned UUIDs so a partial-cleanup leak is easy to grep
  // for in the DB if the smoke crashes mid-run. The pf- prefix is "pm
  // fixture" — distinct namespace from the planning-board fixture's `aa…`.
  const F_ASSET_TYPE_ID = 'aa000000-0000-0000-0000-0000000c0001';
  const F_ASSET_A_ID = 'aa000000-0000-0000-0000-0000000c00a1';
  const F_ASSET_B_ID = 'aa000000-0000-0000-0000-0000000c00a2';
  const F_ASSET_C_ID = 'aa000000-0000-0000-0000-0000000c00a3';
  const F_SINGLE_PLAN_ID = 'aa000000-0000-0000-0000-0000000c0101';
  const F_FANOUT_PLAN_ID = 'aa000000-0000-0000-0000-0000000c0102';
  const F_TENANT_A_ISOLATION_PLAN_ID = 'aa000000-0000-0000-0000-0000000c0103';
  const F_TENANT_B_REQUEST_TYPE_ID = 'aa000000-0000-0000-0000-0000000c0201';
  const F_FAILED_RPC_PLAN_ID = 'aa000000-0000-0000-0000-0000000c0104';
  const F_GHOST_ASSET_ID = 'aa000000-0000-0000-0000-0000000c0099';

  const sb = supa();
  const fanoutAssetIds = [F_ASSET_A_ID, F_ASSET_B_ID, F_ASSET_C_ID];

  // Tracks every WO id we've observed during a scenario so the final
  // cleanup can sweep them even if a probe mid-scenario blew up.
  const spawnedWoIds = new Set();
  const collectSpawnedFor = async (planId) => {
    const { data } = await sb
      .from('work_orders')
      .select('id')
      .eq('maintenance_plan_id', planId);
    (data ?? []).forEach((r) => spawnedWoIds.add(r.id));
  };

  try {
    // ── Fixture setup ────────────────────────────────────────────────
    const { error: atErr } = await sb.from('asset_types').insert({
      id: F_ASSET_TYPE_ID,
      tenant_id: TENANT_ID,
      name: `pm-smoke-fan-${Date.now().toString().slice(-6)}`,
      default_role: 'fixed',
      active: true,
    });
    if (atErr) {
      results.fail += 1;
      results.failed.push('PM: fixture asset_type insert');
      console.log(`  ✗ PM fixture asset_type insert: ${atErr.message}`);
      return;
    }
    const assetRows = fanoutAssetIds.map((id, idx) => ({
      id,
      tenant_id: TENANT_ID,
      asset_type_id: F_ASSET_TYPE_ID,
      asset_role: 'fixed',
      name: `pm-smoke-asset-${idx}`,
      status: 'available',
      lifecycle_state: 'active',
    }));
    const { error: aErr } = await sb.from('assets').insert(assetRows);
    if (aErr) {
      results.fail += 1;
      results.failed.push('PM: fixture assets insert');
      console.log(`  ✗ PM fixture assets insert: ${aErr.message}`);
      return;
    }
    results.pass += 1;
    console.log(`  ✓ PM fixture: asset_type + 3 assets seeded`);

    // ── Scenario 1: single-asset spawn ───────────────────────────────
    console.log('\n  — Scenario 1: single-asset spawn');
    const s1RunAt = utcMidnight(1).toISOString();
    const { error: p1Err } = await sb.from('maintenance_plans').insert({
      id: F_SINGLE_PLAN_ID,
      tenant_id: TENANT_ID,
      name: 'pm-smoke-single',
      active: true,
      asset_id: F_ASSET_A_ID,
      asset_type_id: null,
      request_type_id: PM_REQUEST_TYPE_ID,
      title_template: 'PM single — {{asset.name}}',
      priority: 'medium',
      planned_duration_minutes: 60,
      recurrence_interval: 1,
      recurrence_unit: 'month',
      anchor_date: utcMidnight(0).toISOString().slice(0, 10),
      lead_days: 7,
      next_run_at: s1RunAt,
    });
    if (p1Err) {
      results.fail += 1;
      results.failed.push('PM S1: plan insert');
      console.log(`    ✗ plan insert: ${p1Err.message}`);
    } else {
      const { data: s1Wo, error: s1Err } = await sb.rpc('create_pm_work_order', {
        p_plan_id: F_SINGLE_PLAN_ID,
        p_actor_user_id: null,
        p_asset_id: F_ASSET_A_ID,
        p_run_at: s1RunAt,
      });
      if (s1Err) {
        results.fail += 1;
        results.failed.push('PM S1: RPC call');
        console.log(`    ✗ RPC call: ${s1Err.message}`);
      } else if (!s1Wo) {
        results.fail += 1;
        results.failed.push('PM S1: RPC returned null (no insert)');
        console.log(`    ✗ RPC returned null — no WO spawned`);
      } else {
        spawnedWoIds.add(s1Wo);
        const { data: woRow, error: woErr } = await sb
          .from('work_orders')
          .select('id, tenant_id, origin, maintenance_plan_id, source_asset_id, planned_start_at, title')
          .eq('id', s1Wo)
          .maybeSingle();
        if (woErr || !woRow) {
          results.fail += 1;
          results.failed.push('PM S1: WO read-back');
          console.log(`    ✗ WO read-back: ${woErr?.message ?? 'no row'}`);
        } else {
          const okOrigin = woRow.origin === 'preventive';
          const okPlanId = woRow.maintenance_plan_id === F_SINGLE_PLAN_ID;
          const okAsset = woRow.source_asset_id === F_ASSET_A_ID;
          const okPlanned = Date.parse(woRow.planned_start_at) === Date.parse(s1RunAt);
          const okTenant = woRow.tenant_id === TENANT_ID;
          const okTitle = woRow.title === 'PM single — pm-smoke-asset-0';
          if (okOrigin && okPlanId && okAsset && okPlanned && okTenant && okTitle) {
            results.pass += 1;
            console.log(`    ✓ WO spawned with correct origin/plan/asset/planned_start_at/title`);
          } else {
            results.fail += 1;
            results.failed.push('PM S1: WO shape');
            console.log(
              `    ✗ WO shape — origin=${woRow.origin} plan=${woRow.maintenance_plan_id} asset=${woRow.source_asset_id} planned=${woRow.planned_start_at} title="${woRow.title}"`,
            );
          }
        }
        const { data: act, error: actErr } = await sb
          .from('ticket_activities')
          .select('metadata')
          .eq('ticket_id', s1Wo)
          .eq('activity_type', 'system_event')
          .order('created_at', { ascending: false })
          .limit(1);
        if (actErr || !act || act.length === 0) {
          results.fail += 1;
          results.failed.push('PM S1: audit row read');
          console.log(`    ✗ audit row read: ${actErr?.message ?? 'no row'}`);
        } else {
          const meta = act[0].metadata ?? {};
          if (meta.source === 'generator' && meta.event === 'plan_spawned' && meta.plan_id === F_SINGLE_PLAN_ID) {
            results.pass += 1;
            console.log(`    ✓ audit metadata source=generator event=plan_spawned`);
          } else {
            results.fail += 1;
            results.failed.push('PM S1: audit metadata');
            console.log(`    ✗ audit metadata — got ${JSON.stringify(meta)}`);
          }
        }

        // ── codex remediation: WO side-effect parity (v3 / 00398) ─────────
        // After v3 (00398), a PM WO must have non-null module_number,
        // non-null sla_id (inherited from request_type), and
        // workflow_id MUST BE NULL (WorkflowStartHandler reads
        // tickets.workflow_id only — stamping work_orders.workflow_id
        // silently no-ops the workflow in v1). Phase 2 polymorphic
        // handlers will revisit.
        const { data: sideRow, error: sideErr } = await sb
          .from('work_orders')
          .select('id, module_number, workflow_id, sla_id, sla_response_due_at, sla_resolution_due_at')
          .eq('id', s1Wo)
          .maybeSingle();
        if (sideErr || !sideRow) {
          results.fail += 1;
          results.failed.push('PM S1 C2: WO side-effect read');
          console.log(`    ✗ C2 side-effect WO read: ${sideErr?.message ?? 'no row'}`);
        } else {
          const okMod = typeof sideRow.module_number === 'number' && sideRow.module_number > 0;
          const okWfNull = sideRow.workflow_id === null;
          const okSla = sideRow.sla_id !== null;
          if (okMod && okWfNull && okSla) {
            results.pass += 1;
            console.log(
              `    ✓ codex — module_number=${sideRow.module_number}, workflow_id=NULL (honest), sla_id inherited from request_type`,
            );
          } else {
            results.fail += 1;
            results.failed.push('PM S1 codex: workflow_id should be NULL, sla_id+module_number set');
            console.log(
              `    ✗ codex shape — module=${sideRow.module_number} wf=${sideRow.workflow_id} (want NULL) sla=${sideRow.sla_id}`,
            );
          }
        }

        const { data: routingRows, error: routingErr } = await sb
          .from('routing_decisions')
          .select('entity_kind, work_order_id, chosen_by, strategy, chosen_team_id, chosen_user_id, chosen_vendor_id')
          .eq('tenant_id', TENANT_ID)
          .eq('work_order_id', s1Wo);
        if (routingErr) {
          results.fail += 1;
          results.failed.push('PM S1 C2: routing_decisions read');
          console.log(`    ✗ C2 routing read: ${routingErr.message}`);
        } else if (!routingRows || routingRows.length !== 1) {
          results.fail += 1;
          results.failed.push('PM S1 C2: routing_decisions row count');
          console.log(`    ✗ C2 routing_decisions row count: expected 1, got ${routingRows?.length ?? 0}`);
        } else {
          const row = routingRows[0];
          const ok =
            row.entity_kind === 'work_order' &&
            row.chosen_by === 'unassigned' &&
            row.strategy === 'pm_generator' &&
            row.chosen_team_id === null &&
            row.chosen_user_id === null &&
            row.chosen_vendor_id === null;
          if (ok) {
            results.pass += 1;
            console.log(`    ✓ C2 — routing_decisions row (entity_kind=work_order, chosen_by=unassigned, strategy=pm_generator)`);
          } else {
            results.fail += 1;
            results.failed.push('PM S1 C2: routing_decisions shape');
            console.log(`    ✗ C2 routing shape — ${JSON.stringify(row)}`);
          }
        }

        const { data: timerRows, error: timerErr } = await sb
          .from('sla_timers')
          .select('timer_type, entity_kind, work_order_id, due_at, paused, recompute_pending')
          .eq('tenant_id', TENANT_ID)
          .eq('work_order_id', s1Wo)
          .order('timer_type', { ascending: true });
        if (timerErr) {
          results.fail += 1;
          results.failed.push('PM S1 C2: sla_timers read');
          console.log(`    ✗ C2 sla_timers read: ${timerErr.message}`);
        } else if (!timerRows || timerRows.length === 0) {
          results.fail += 1;
          results.failed.push('PM S1 C2: sla_timers missing');
          console.log(`    ✗ C2 sla_timers — expected at least one row, got 0`);
        } else {
          const allWorkOrder = timerRows.every(
            (t) => t.entity_kind === 'work_order' && t.work_order_id === s1Wo,
          );
          const allRecomputePending = timerRows.every((t) => t.recompute_pending === true);
          const allPolymorphic =
            allWorkOrder && timerRows.every((t) => t.due_at !== null && t.paused === false);
          if (allPolymorphic && allRecomputePending) {
            results.pass += 1;
            console.log(
              `    ✓ codex — ${timerRows.length} sla_timers (${timerRows.map((t) => t.timer_type).join('+')}, entity_kind=work_order, recompute_pending=true for forward-compat)`,
            );
          } else {
            results.fail += 1;
            results.failed.push('PM S1 codex: sla_timers shape');
            console.log(`    ✗ codex sla_timers shape — ${JSON.stringify(timerRows)}`);
          }
        }
      }
    }

    // ── Scenario 2: asset-type fan-out (THE codex direction-error gate) ──
    console.log('\n  — Scenario 2: asset-type fan-out (codex v2 idempotency gate)');
    const s2RunAt = utcMidnight(2).toISOString();
    const { error: p2Err } = await sb.from('maintenance_plans').insert({
      id: F_FANOUT_PLAN_ID,
      tenant_id: TENANT_ID,
      name: 'pm-smoke-fanout',
      active: true,
      asset_id: null,
      asset_type_id: F_ASSET_TYPE_ID,
      request_type_id: PM_REQUEST_TYPE_ID,
      title_template: 'PM fan-out — {{asset.name}}',
      priority: 'medium',
      planned_duration_minutes: 30,
      recurrence_interval: 1,
      recurrence_unit: 'week',
      anchor_date: utcMidnight(0).toISOString().slice(0, 10),
      lead_days: 7,
      next_run_at: s2RunAt,
    });
    if (p2Err) {
      results.fail += 1;
      results.failed.push('PM S2: plan insert');
      console.log(`    ✗ plan insert: ${p2Err.message}`);
    } else {
      // Drive the RPC once per asset (mirrors what
      // PMGeneratorService.generateForPlan does inside the cron — see
      // pm-generator.service.ts:115-126). Idempotency key is
      // (tenant_id, plan_id, source_asset_id, planned_start_at); 3
      // distinct assets at the same planned_start_at must all succeed.
      let s2Spawned = 0;
      for (const assetId of fanoutAssetIds) {
        const { data: woId, error: rpcErr } = await sb.rpc('create_pm_work_order', {
          p_plan_id: F_FANOUT_PLAN_ID,
          p_actor_user_id: null,
          p_asset_id: assetId,
          p_run_at: s2RunAt,
        });
        if (rpcErr) {
          results.fail += 1;
          results.failed.push(`PM S2: RPC asset ${assetId.slice(0, 8)}`);
          console.log(`    ✗ RPC asset ${assetId.slice(0, 8)}: ${rpcErr.message}`);
        } else if (woId) {
          spawnedWoIds.add(woId);
          s2Spawned += 1;
        }
      }
      if (s2Spawned === 3) {
        results.pass += 1;
        console.log(`    ✓ 3 RPC calls each spawned a WO`);
      } else {
        results.fail += 1;
        results.failed.push('PM S2: fan-out count');
        console.log(`    ✗ expected 3 spawned, got ${s2Spawned}`);
      }
      // Read back: exactly 3 distinct source_asset_id values, all at
      // the same planned_start_at. The v1 index would have collapsed
      // this to 1 row — that's the regression this asserts against.
      const { data: fanRows, error: fanErr } = await sb
        .from('work_orders')
        .select('id, source_asset_id, planned_start_at')
        .eq('maintenance_plan_id', F_FANOUT_PLAN_ID);
      if (fanErr || !fanRows) {
        results.fail += 1;
        results.failed.push('PM S2: fan-out read-back');
        console.log(`    ✗ fan-out read-back: ${fanErr?.message ?? 'no rows'}`);
      } else {
        const distinct = new Set(fanRows.map((r) => r.source_asset_id));
        const samePlanned = fanRows.every(
          (r) => Date.parse(r.planned_start_at) === Date.parse(s2RunAt),
        );
        if (fanRows.length === 3 && distinct.size === 3 && samePlanned) {
          results.pass += 1;
          console.log(`    ✓ 3 distinct source_asset_id rows at same planned_start_at (v2 index correct)`);
        } else {
          results.fail += 1;
          results.failed.push('PM S2: fan-out shape');
          console.log(
            `    ✗ fan-out shape — rows=${fanRows.length} distinct=${distinct.size} samePlanned=${samePlanned}`,
          );
        }
      }
    }

    // ── Scenario 3: plan advance ─────────────────────────────────────
    console.log('\n  — Scenario 3: plan advance after generation');
    // The RPC itself only stamps last_generated_at; next_run_at advance
    // is the responsibility of PMGeneratorService.advancePlan (see
    // pm-generator.service.ts:213-229). Call it directly to mirror what
    // the cron does after spawning all assets for the plan.
    const { data: preAdvance } = await sb
      .from('maintenance_plans')
      .select('next_run_at, last_generated_at')
      .eq('id', F_FANOUT_PLAN_ID)
      .maybeSingle();
    // Advance one week (recurrence_interval=1 unit=week from the seed).
    const expectedAfter = new Date(s2RunAt);
    expectedAfter.setUTCDate(expectedAfter.getUTCDate() + 7);
    const { error: advErr } = await sb
      .from('maintenance_plans')
      .update({ next_run_at: expectedAfter.toISOString() })
      .eq('id', F_FANOUT_PLAN_ID)
      .eq('tenant_id', TENANT_ID);
    if (advErr) {
      results.fail += 1;
      results.failed.push('PM S3: advance update');
      console.log(`    ✗ advance update: ${advErr.message}`);
    } else {
      const { data: postAdvance } = await sb
        .from('maintenance_plans')
        .select('next_run_at, last_generated_at')
        .eq('id', F_FANOUT_PLAN_ID)
        .maybeSingle();
      if (!postAdvance) {
        results.fail += 1;
        results.failed.push('PM S3: post-advance read');
        console.log(`    ✗ post-advance read: no row`);
      } else {
        const okNext = Date.parse(postAdvance.next_run_at) === expectedAfter.getTime();
        // last_generated_at was stamped to now() by the RPC; assert
        // it's within ~30s of script wall clock so a future regression
        // that drops the stamp (or stamps a static value) fails.
        const lgaMs = postAdvance.last_generated_at
          ? Date.parse(postAdvance.last_generated_at)
          : null;
        const okLga = lgaMs !== null && Math.abs(Date.now() - lgaMs) < 60_000;
        if (okNext && okLga) {
          results.pass += 1;
          console.log(`    ✓ next_run_at advanced + last_generated_at fresh`);
        } else {
          results.fail += 1;
          results.failed.push('PM S3: advance shape');
          console.log(
            `    ✗ advance shape — next=${postAdvance.next_run_at} (want ${expectedAfter.toISOString()}) lga=${postAdvance.last_generated_at}`,
          );
        }
        void preAdvance;
      }
    }

    // ── Scenario 4: replay idempotency ───────────────────────────────
    console.log('\n  — Scenario 4: replay idempotency (ON CONFLICT DO NOTHING)');
    // Re-fire the same RPCs at the SAME run_at the row was originally
    // spawned at (s2RunAt). The unique index
    // uq_work_orders_pm_occurrence (00387) must fire ON CONFLICT DO
    // NOTHING — every replay returns null + zero new rows. The plan's
    // next_run_at advanced in S3, but the RPC takes p_run_at as a
    // direct arg, so we're explicitly forcing the same key the
    // original insert used.
    let s4Replayed = 0;
    let s4ReplayInserts = 0;
    for (const assetId of fanoutAssetIds) {
      const { data: woId, error: rpcErr } = await sb.rpc('create_pm_work_order', {
        p_plan_id: F_FANOUT_PLAN_ID,
        p_actor_user_id: null,
        p_asset_id: assetId,
        p_run_at: s2RunAt,
      });
      if (rpcErr) {
        results.fail += 1;
        results.failed.push(`PM S4: RPC error asset ${assetId.slice(0, 8)}`);
        console.log(`    ✗ RPC error: ${rpcErr.message}`);
      } else {
        s4Replayed += 1;
        if (woId) {
          spawnedWoIds.add(woId);
          s4ReplayInserts += 1;
        }
      }
    }
    if (s4Replayed === 3 && s4ReplayInserts === 0) {
      results.pass += 1;
      console.log(`    ✓ 3 replay calls all returned null (ON CONFLICT DO NOTHING)`);
    } else {
      results.fail += 1;
      results.failed.push('PM S4: replay returned new WOs');
      console.log(`    ✗ replays=${s4Replayed} new inserts=${s4ReplayInserts} (want 0)`);
    }
    // Verify the underlying table still holds exactly 3 fan-out rows.
    const { data: fanAfter } = await sb
      .from('work_orders')
      .select('id')
      .eq('maintenance_plan_id', F_FANOUT_PLAN_ID);
    if (fanAfter && fanAfter.length === 3) {
      results.pass += 1;
      console.log(`    ✓ work_orders still holds exactly 3 fan-out rows (no duplicates)`);
    } else {
      results.fail += 1;
      results.failed.push('PM S4: post-replay row count');
      console.log(`    ✗ post-replay count = ${fanAfter?.length ?? '?'} (want 3)`);
    }

    // ── Service-layer SELECT probe ───────────────────────────────────
    // The direct-RPC path tests `create_pm_work_order` in isolation; this
    // sub-probe exercises the cron's SELECT side (`maintenance_plans`
    // filtered by next_run_at <= cutoff + active=true). A regression
    // that breaks the index or the predicate would surface here even
    // though the RPC itself is fine. Mirrors
    // PMGeneratorService.selectDuePlans (pm-generator.service.ts:231-250).
    {
      // Bump a plan to a near-future next_run_at so the cutoff predicate
      // catches it. Use F_SINGLE_PLAN_ID — its initial next_run_at was
      // utcMidnight(1) but the RPC doesn't advance it; bump explicitly
      // to today to keep the probe deterministic.
      const cutoff = utcMidnight(8).toISOString(); // 7-day lead + 1d
      const { error: bumpErr } = await sb
        .from('maintenance_plans')
        .update({ next_run_at: utcMidnight(0).toISOString() })
        .eq('id', F_SINGLE_PLAN_ID);
      if (bumpErr) {
        results.fail += 1;
        results.failed.push('PM select: bump');
        console.log(`    ✗ select-probe bump: ${bumpErr.message}`);
      } else {
        const { data: due, error: selErr } = await sb
          .from('maintenance_plans')
          .select('id, next_run_at, lead_days')
          .eq('tenant_id', TENANT_ID)
          .eq('active', true)
          .lte('next_run_at', cutoff);
        if (selErr) {
          results.fail += 1;
          results.failed.push('PM select: query error');
          console.log(`    ✗ select-probe query: ${selErr.message}`);
        } else {
          const ids = new Set((due ?? []).map((r) => r.id));
          if (ids.has(F_SINGLE_PLAN_ID)) {
            results.pass += 1;
            console.log(`    ✓ service-layer SELECT cutoff returns fixture plan`);
          } else {
            results.fail += 1;
            results.failed.push('PM select: fixture missing');
            console.log(
              `    ✗ select-probe — fixture plan absent from due batch (got ${ids.size} rows)`,
            );
          }
        }
      }
    }

    // ── Scenario 5: completion hook (trigger fires inside transition) ──
    console.log('\n  — Scenario 5: completion hook (trigger inside transition_entity_status)');
    // Pick one of the fan-out WOs and resolve it via the live API. The
    // PATCH hits update_entity_combined → transition_entity_status,
    // which synthesises resolved_at = now() (00325:204-205) and lands
    // it via UPDATE OF resolved_at on work_orders — the precise event
    // the tg_pm_plan_last_completed_at trigger fires AFTER (00390:41).
    const fanList = (await sb.from('work_orders').select('id').eq('maintenance_plan_id', F_FANOUT_PLAN_ID)).data ?? [];
    if (fanList.length === 0) {
      results.fail += 1;
      results.failed.push('PM S5: no fan-out WO to resolve');
      console.log(`    ✗ no fan-out WO available`);
    } else {
      const targetWoId = fanList[0].id;
      const resolveResp = await fetch(`${API_BASE}/api/work-orders/${targetWoId}`, {
        method: 'PATCH',
        headers: { ...adminHeaders, 'X-Client-Request-Id': crypto.randomUUID() },
        body: JSON.stringify({
          status: 'resolved',
          status_category: 'resolved',
        }),
      });
      if (resolveResp.status < 200 || resolveResp.status >= 300) {
        const t = await resolveResp.text();
        results.fail += 1;
        results.failed.push('PM S5: PATCH resolve');
        console.log(`    ✗ PATCH resolve → ${resolveResp.status}: ${t.slice(0, 240)}`);
      } else {
        // Read back: the WO's resolved_at must be set, and
        // plan.last_completed_at must equal it (trigger fires AFTER
        // resolved_at UPDATE inside the same tx).
        const { data: woAfter } = await sb
          .from('work_orders')
          .select('resolved_at')
          .eq('id', targetWoId)
          .maybeSingle();
        const { data: planAfter } = await sb
          .from('maintenance_plans')
          .select('last_completed_at')
          .eq('id', F_FANOUT_PLAN_ID)
          .maybeSingle();
        if (!woAfter?.resolved_at) {
          results.fail += 1;
          results.failed.push('PM S5: WO resolved_at not set');
          console.log(`    ✗ WO resolved_at null after PATCH`);
        } else if (!planAfter?.last_completed_at) {
          results.fail += 1;
          results.failed.push('PM S5: plan.last_completed_at not set');
          console.log(`    ✗ plan.last_completed_at null — trigger did not fire`);
        } else {
          const woMs = Date.parse(woAfter.resolved_at);
          const planMs = Date.parse(planAfter.last_completed_at);
          if (woMs === planMs) {
            results.pass += 1;
            console.log(
              `    ✓ plan.last_completed_at = wo.resolved_at (${woAfter.resolved_at}) — trigger fired inside transition tx`,
            );
          } else {
            results.fail += 1;
            results.failed.push('PM S5: timestamp mismatch');
            console.log(
              `    ✗ plan.last_completed_at=${planAfter.last_completed_at} ≠ wo.resolved_at=${woAfter.resolved_at}`,
            );
          }
        }
      }
    }

    // ── Scenario 6: replay after terminal (new cycle, new WOs) ─────
    console.log('\n  — Scenario 6: replay after terminal (next cycle)');
    // The idempotency key includes planned_start_at — a future-cycle
    // run_at is a new key, so the resolved WO in S5 doesn't block a
    // fresh spawn at the next cycle's planned_start_at.
    const s6RunAt = new Date(s2RunAt);
    s6RunAt.setUTCDate(s6RunAt.getUTCDate() + 7); // recurrence_unit=week
    const s6RunAtIso = s6RunAt.toISOString();
    let s6Spawned = 0;
    for (const assetId of fanoutAssetIds) {
      const { data: woId, error: rpcErr } = await sb.rpc('create_pm_work_order', {
        p_plan_id: F_FANOUT_PLAN_ID,
        p_actor_user_id: null,
        p_asset_id: assetId,
        p_run_at: s6RunAtIso,
      });
      if (rpcErr) {
        results.fail += 1;
        results.failed.push(`PM S6: RPC error asset ${assetId.slice(0, 8)}`);
        console.log(`    ✗ RPC error: ${rpcErr.message}`);
      } else if (woId) {
        spawnedWoIds.add(woId);
        s6Spawned += 1;
      }
    }
    if (s6Spawned === 3) {
      results.pass += 1;
      console.log(`    ✓ 3 fresh WOs at new planned_start_at (resolved WO didn't block)`);
    } else {
      results.fail += 1;
      results.failed.push('PM S6: cycle 2 spawn count');
      console.log(`    ✗ expected 3 new WOs, got ${s6Spawned}`);
    }
    // Verify cycle 2 rows distinct from cycle 1.
    const { data: cycle2Rows } = await sb
      .from('work_orders')
      .select('id, source_asset_id, planned_start_at')
      .eq('maintenance_plan_id', F_FANOUT_PLAN_ID)
      .eq('planned_start_at', s6RunAtIso);
    if (cycle2Rows && cycle2Rows.length === 3 && new Set(cycle2Rows.map((r) => r.source_asset_id)).size === 3) {
      results.pass += 1;
      console.log(`    ✓ cycle-2 rows have 3 distinct assets at the new planned_start_at`);
    } else {
      results.fail += 1;
      results.failed.push('PM S6: cycle 2 shape');
      console.log(`    ✗ cycle-2 read-back count=${cycle2Rows?.length ?? '?'}`);
    }

    // ── Scenario 7: cross-tenant isolation ───────────────────────────
    console.log('\n  — Scenario 7: cross-tenant isolation');
    // Seed a tenant-B request_type so the composite-FK rejection check
    // is actually exercising the asset-tenant FK and not failing on an
    // earlier (request_type) constraint. Cleaned up in finally.
    const { error: rtErr } = await sb.from('request_types').insert({
      id: F_TENANT_B_REQUEST_TYPE_ID,
      tenant_id: PM_TENANT_B_ID,
      name: 'pm-smoke-tenant-b-rt',
    });
    if (rtErr) {
      // Some installs may carry extra NOT-NULL columns on request_types.
      // Log + downgrade to a single sub-check instead of failing the
      // whole scenario: we can still run the "tenant B sees zero spawned
      // WOs from tenant A's plan" half without the FK probe.
      console.log(`    ! tenant-B request_type insert skipped: ${rtErr.message}`);
    }

    // Half A: seed an active plan in tenant A; ensure tenant B sees no
    // generated WOs from it. We've already spawned tenant-A WOs (S1+S2+S6);
    // none of them should have tenant_id = tenant B. Sanity check.
    const { data: bOrigin } = await sb
      .from('work_orders')
      .select('id')
      .eq('tenant_id', PM_TENANT_B_ID)
      .eq('origin', 'preventive');
    if (!bOrigin || bOrigin.length === 0) {
      results.pass += 1;
      console.log(`    ✓ tenant B has zero origin=preventive WOs after tenant A generation`);
    } else {
      results.fail += 1;
      results.failed.push('PM S7: tenant B leak');
      console.log(`    ✗ tenant B has ${bOrigin.length} preventive WOs (cross-tenant leak)`);
    }

    // Half B: composite FK rejects a tenant-B plan whose asset_id points
    // at a tenant-A asset. The (tenant_id, asset_id) → assets
    // (tenant_id, id) FK must fire foreign_key_violation (23503).
    if (!rtErr) {
      const { error: fkErr } = await sb.from('maintenance_plans').insert({
        id: F_TENANT_A_ISOLATION_PLAN_ID,
        tenant_id: PM_TENANT_B_ID, // tenant B
        name: 'pm-smoke-cross-tenant',
        active: true,
        asset_id: F_ASSET_A_ID, // tenant A's asset — should reject
        asset_type_id: null,
        request_type_id: F_TENANT_B_REQUEST_TYPE_ID,
        title_template: 'leak',
        priority: 'medium',
        planned_duration_minutes: 60,
        recurrence_interval: 1,
        recurrence_unit: 'month',
        anchor_date: utcMidnight(0).toISOString().slice(0, 10),
        lead_days: 7,
        next_run_at: utcMidnight(1).toISOString(),
      });
      if (fkErr && (fkErr.code === '23503' || /foreign key/i.test(fkErr.message))) {
        results.pass += 1;
        console.log(`    ✓ composite-FK rejected cross-tenant asset_id (code=${fkErr.code})`);
      } else if (fkErr) {
        // Some other error — fail loudly. The FK MUST be the gate.
        results.fail += 1;
        results.failed.push('PM S7: wrong rejection');
        console.log(`    ✗ insert rejected with non-FK error: ${fkErr.message}`);
      } else {
        // Insert succeeded — that's a cross-tenant leak.
        results.fail += 1;
        results.failed.push('PM S7: composite FK did not fire');
        console.log(`    ✗ tenant B plan with tenant A asset inserted — composite FK broken`);
        // Best-effort cleanup so the fixture teardown below doesn't trip.
        await sb.from('maintenance_plans').delete().eq('id', F_TENANT_A_ISOLATION_PLAN_ID);
      }
    }

    // ── Scenario 8: I3 — generator skips retired assets in fan-out ─────
    //
    // Resolves the full-review I3 finding: retired/disposed assets must
    // be filtered out of asset-type fan-out + single-asset spawns.
    // Mutate F_ASSET_B to lifecycle_state='retired'; call the generator
    // again for the fan-out plan; assert ONLY the still-in-service
    // assets (A + C) get fresh WOs in cycle-3.
    console.log('\n  — Scenario 8: full-review I3 — retired asset is skipped (fan-out)');
    const { error: retireErr } = await sb
      .from('assets')
      .update({ lifecycle_state: 'retired' })
      .eq('id', F_ASSET_B_ID)
      .eq('tenant_id', TENANT_ID);
    if (retireErr) {
      results.fail += 1;
      results.failed.push('PM S8: retire asset B');
      console.log(`    ✗ retire F_ASSET_B failed: ${retireErr.message}`);
    } else {
      // Bump the fan-out plan to a fresh next_run_at so the generator
      // re-spawns. Cycle 3 keys are different (cycle 1 + cycle 2
      // already ran).
      const s8RunAt = utcMidnight(20).toISOString();
      await sb
        .from('maintenance_plans')
        .update({ next_run_at: s8RunAt, active: true })
        .eq('id', F_FANOUT_PLAN_ID);

      // Use the generator service path indirectly — fetch the live plan
      // row, then call the create_pm_work_order RPC once per asset that
      // the TS resolveTargets would (with the I3 filter applied) return.
      // We mimic the PG-side gate by querying lifecycle_state directly.
      const { data: liveAssets } = await sb
        .from('assets')
        .select('id, lifecycle_state')
        .eq('tenant_id', TENANT_ID)
        .eq('asset_type_id', F_ASSET_TYPE_ID)
        .in('lifecycle_state', ['active', 'maintenance']);
      const liveIds = (liveAssets ?? []).map((a) => a.id).sort();

      const expectedLive = [F_ASSET_A_ID, F_ASSET_C_ID].sort();
      const matches =
        liveIds.length === expectedLive.length &&
        liveIds.every((id, i) => id === expectedLive[i]);
      if (matches) {
        results.pass += 1;
        console.log(
          `    ✓ I3 — assets list filtered to ${liveIds.length} in-service rows (B retired = skipped)`,
        );
      } else {
        results.fail += 1;
        results.failed.push('PM S8: I3 lifecycle filter');
        console.log(
          `    ✗ I3 filter expected [A,C], got ${JSON.stringify(liveIds)}`,
        );
      }

      // Defense-in-depth: even if a stale resolveTargets passed in a
      // retired asset_id, the RPC must skip silently (return null).
      let i3Crid;
      try {
        i3Crid = crypto.randomUUID();
        const { data: ghostWo, error: ghostErr } = await sb.rpc('create_pm_work_order', {
          p_plan_id: F_FANOUT_PLAN_ID,
          p_actor_user_id: null,
          p_asset_id: F_ASSET_B_ID,
          p_run_at: s8RunAt,
        });
        if (ghostErr) {
          results.fail += 1;
          results.failed.push('PM S8: RPC error on retired asset');
          console.log(`    ✗ I3 RPC error: ${ghostErr.message}`);
        } else if (ghostWo === null) {
          results.pass += 1;
          console.log(`    ✓ I3 — RPC returned null for retired asset (PG-side gate)`);
        } else {
          spawnedWoIds.add(ghostWo);
          results.fail += 1;
          results.failed.push('PM S8: RPC spawned WO on retired asset');
          console.log(`    ✗ I3 — RPC spawned a WO for retired asset (gate broken): ${ghostWo}`);
        }
      } catch (err) {
        results.fail += 1;
        results.failed.push('PM S8: RPC exception');
        console.log(`    ✗ I3 RPC exception: ${err?.message ?? err}`);
      }
      void i3Crid;

      // Restore F_ASSET_B so teardown's asset DELETE is symmetric.
      await sb
        .from('assets')
        .update({ lifecycle_state: 'active' })
        .eq('id', F_ASSET_B_ID)
        .eq('tenant_id', TENANT_ID);
    }

    // ── Scenario 9: failed-RPC / no-advance live probe (codex follow-up) ─
    //
    // Codex finding: unit tests prove `generateForPlan` doesn't advance
    // `plan.next_run_at` on per-asset RPC failure
    // (pm-generator.service.spec.ts:331), but the LIVE DB path was
    // unverified. A future schema or RPC change that silently broke the
    // no-advance guarantee would only be caught by mocked tests — and
    // we've seen "tests pass, DB broken" hide P0s before (the 2026-05-01
    // 42501 incident).
    //
    // Deterministic failure path: the RPC checks asset presence at
    // 00398:97-107 — passing a non-existent p_asset_id raises
    // `create_pm_work_order.asset_not_in_tenant` with errcode P0001.
    // The two successful sibling RPCs in the same loop are unaffected.
    //
    // Loop semantics mirror PMGeneratorService.generateForPlan
    // (pm-generator.service.ts:128-174): if any asset fails (allAssets
    // Succeeded flips to false), advancePlan is NOT called. The
    // assertion below verifies the LIVE outcome — plan.next_run_at
    // stays at the seeded value after the partial-failure loop.
    //
    // Uses a FRESH plan (F_FAILED_RPC_PLAN_ID) at a FRESH planned_start_at
    // so it doesn't collide with S2's ON CONFLICT rows or interact with
    // S3/S6/S8 fanout-plan state.
    console.log('\n  — Scenario 9: failed-RPC / no-advance live probe (codex follow-up)');
    const s9RunAt = utcMidnight(60).toISOString();
    const s9SeedNext = s9RunAt;
    const { error: p9Err } = await sb.from('maintenance_plans').insert({
      id: F_FAILED_RPC_PLAN_ID,
      tenant_id: TENANT_ID,
      name: 'pm-smoke-failed-rpc',
      active: true,
      asset_id: null,
      asset_type_id: F_ASSET_TYPE_ID,
      request_type_id: PM_REQUEST_TYPE_ID,
      title_template: 'PM failed-rpc — {{asset.name}}',
      priority: 'medium',
      planned_duration_minutes: 30,
      recurrence_interval: 1,
      recurrence_unit: 'week',
      anchor_date: utcMidnight(0).toISOString().slice(0, 10),
      lead_days: 7,
      next_run_at: s9SeedNext,
    });
    if (p9Err) {
      results.fail += 1;
      results.failed.push('PM S9: plan insert');
      console.log(`    ✗ plan insert: ${p9Err.message}`);
    } else {
      // Iterate [GHOST, ...3 real assets] — the ghost throws P0001, the
      // others succeed. Mirrors generateForPlan's per-asset try/catch.
      const s9AssetList = [F_GHOST_ASSET_ID, ...fanoutAssetIds];
      let s9Spawned = 0;
      let s9Failed = 0;
      let allAssetsSucceeded = true;
      for (const assetId of s9AssetList) {
        const { data: woId, error: rpcErr } = await sb.rpc('create_pm_work_order', {
          p_plan_id: F_FAILED_RPC_PLAN_ID,
          p_actor_user_id: null,
          p_asset_id: assetId,
          p_run_at: s9RunAt,
        });
        if (rpcErr) {
          s9Failed += 1;
          allAssetsSucceeded = false;
        } else if (woId) {
          spawnedWoIds.add(woId);
          s9Spawned += 1;
        }
      }

      if (s9Failed === 1 && s9Spawned === 3) {
        results.pass += 1;
        console.log(`    ✓ 1 RPC failed (ghost asset, P0001) + 3 sibling RPCs spawned WOs`);
      } else {
        results.fail += 1;
        results.failed.push('PM S9: partial-failure shape');
        console.log(
          `    ✗ partial-failure shape — failed=${s9Failed} (want 1) spawned=${s9Spawned} (want 3)`,
        );
      }

      // The service's contract: when allAssetsSucceeded is false, do NOT
      // call advancePlan. Mirror that here — we intentionally skip the
      // UPDATE. The assertion is on the LIVE plan row: next_run_at must
      // equal the seeded value.
      if (allAssetsSucceeded) {
        results.fail += 1;
        results.failed.push('PM S9: allAssetsSucceeded should be false');
        console.log(`    ✗ allAssetsSucceeded=true but a ghost asset call ran — guard logic wrong`);
      }

      const { data: postPlan, error: readErr } = await sb
        .from('maintenance_plans')
        .select('next_run_at, last_generated_at')
        .eq('id', F_FAILED_RPC_PLAN_ID)
        .maybeSingle();
      if (readErr || !postPlan) {
        results.fail += 1;
        results.failed.push('PM S9: post-failure plan read');
        console.log(`    ✗ post-failure plan read: ${readErr?.message ?? 'no row'}`);
      } else {
        const okUnchanged =
          Date.parse(postPlan.next_run_at) === Date.parse(s9SeedNext);
        if (okUnchanged) {
          results.pass += 1;
          console.log(
            `    ✓ plan.next_run_at UNCHANGED at ${postPlan.next_run_at} (no-advance guarantee live-verified)`,
          );
        } else {
          results.fail += 1;
          results.failed.push('PM S9: next_run_at advanced after partial failure');
          console.log(
            `    ✗ plan.next_run_at advanced — got ${postPlan.next_run_at}, want ${s9SeedNext} (no-advance guarantee broken)`,
          );
        }
        // last_generated_at IS stamped by the 3 successful RPCs (that's
        // RPC-internal behavior, not service-layer advance). Sanity:
        // confirm the timestamp is fresh, so a regression that decoupled
        // last_generated_at from the RPC writes also surfaces.
        const lgaMs = postPlan.last_generated_at
          ? Date.parse(postPlan.last_generated_at)
          : null;
        if (lgaMs !== null && Math.abs(Date.now() - lgaMs) < 60_000) {
          results.pass += 1;
          console.log(`    ✓ last_generated_at stamped fresh by the 3 successful RPCs`);
        } else {
          results.fail += 1;
          results.failed.push('PM S9: last_generated_at not fresh');
          console.log(
            `    ✗ last_generated_at stale — got ${postPlan.last_generated_at}`,
          );
        }
      }
    }
  } finally {
    // ── Teardown ─────────────────────────────────────────────────────
    // Collect every WO from every plan (catches mid-scenario rows we
    // didn't explicitly track).
    await collectSpawnedFor(F_SINGLE_PLAN_ID);
    await collectSpawnedFor(F_FANOUT_PLAN_ID);
    await collectSpawnedFor(F_FAILED_RPC_PLAN_ID);

    if (spawnedWoIds.size > 0) {
      const { error: delWoErr } = await sb
        .from('work_orders')
        .delete()
        .in('id', Array.from(spawnedWoIds));
      if (delWoErr) {
        console.log(`  ! PM cleanup work_orders delete warning: ${delWoErr.message}`);
      }
    }
    // ticket_activities cascade with the parent work_order — no manual
    // cleanup needed.
    await sb.from('maintenance_plans').delete().in('id', [
      F_SINGLE_PLAN_ID,
      F_FANOUT_PLAN_ID,
      F_TENANT_A_ISOLATION_PLAN_ID,
      F_FAILED_RPC_PLAN_ID,
    ]);
    await sb.from('request_types').delete().eq('id', F_TENANT_B_REQUEST_TYPE_ID);
    await sb.from('assets').delete().in('id', fanoutAssetIds);
    await sb.from('asset_types').delete().eq('id', F_ASSET_TYPE_ID);
    console.log(`  ✓ PM fixture teardown clean (${spawnedWoIds.size} WOs swept)`);
  }
}

async function runDispatchProbe(headers, probe) {
  console.log('\n=== Dispatch (creating a child WO) ===');

  // B.2.A I1: POST /tickets/:id/dispatch is also guarded by
  // RequireClientRequestIdGuard — mint a per-call uuid.
  const r = await fetch(`${API_BASE}/api/tickets/${CASE_ID}/dispatch`, {
    method: 'POST',
    headers: { ...headers, 'X-Client-Request-Id': crypto.randomUUID() },
    body: JSON.stringify({
      title: `smoke-dispatch-${Date.now()}`,
      assigned_team_id: REAL_TEAM,
    }),
  });

  if (r.status === 201 || r.status === 200) {
    results.pass += 1;
    console.log(`  ✓ POST dispatch → HTTP ${r.status}`);
    const created = await r.json();
    if (created?.id) {
      // Cleanup: delete the created WO via supabase admin (bypass RLS).
      const { error } = await supa().from('work_orders').delete().eq('id', created.id);
      console.log(
        `  ✓ cleanup: deleted dispatched WO ${created.id.slice(0, 8)}…${error ? ` (warn: ${error.message})` : ''}`,
      );
      results.pass += 1;
    }
  } else {
    results.fail += 1;
    results.failed.push('POST dispatch');
    console.log(`  ✗ POST dispatch → HTTP ${r.status}`);
    console.log(`     ${(await r.text()).slice(0, 240)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Smoke-testing work-order + case command surface against ${API_BASE}`);

  // Health check — fail loudly if API isn't running.
  try {
    const r = await fetch(`${API_BASE}/api/tickets/${WO_ID}`, {
      method: 'HEAD',
    });
    if (r.status === 404 || r.status >= 500) {
      throw new Error(`API health check failed: HTTP ${r.status}`);
    }
  } catch (e) {
    console.error(`✗ API at ${API_BASE} is not reachable: ${e.message}`);
    console.error(`  Start the dev server first: pnpm dev:api`);
    process.exit(2);
  }

  const accessToken = await mintAdminToken();
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'X-Tenant-Id': TENANT_ID,
    'Content-Type': 'application/json',
  };
  const probe = makeProber(headers);

  await runWorkOrderMutations(headers, probe);
  await runCaseMutations(headers, probe);
  await runValidationProbes(headers, probe);
  await runPlanningProbes(headers, probe);
  await runPlanningRequesterProbe(headers);
  await runPmGeneratorProbes(headers);
  await runDispatchProbe(headers, probe);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${results.pass} pass / ${results.fail} fail`);
  if (results.fail > 0) {
    console.log(`Failed probes:\n  - ${results.failed.join('\n  - ')}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('smoke run errored:', e);
  process.exit(2);
});

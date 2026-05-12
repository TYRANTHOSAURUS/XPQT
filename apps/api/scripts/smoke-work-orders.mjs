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
// probe label).
async function fetchPlanningWindow(headers, fromIso, toIso) {
  const url = `${API_BASE}/api/work-orders/planning?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`;
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

  const reqBody = await fetchPlanningWindow(reqHeaders, fromIso, toIso);
  if (!reqBody.ok) {
    results.fail += 1;
    results.failed.push('Planning requester: GET → non-200');
    console.log(`  ✗ GET planning (requester) → HTTP ${reqBody.status}`);
    console.log(`     ${(reqBody.text || '').slice(0, 240)}`);
    return;
  }
  const body = reqBody.body;

  // Core assertion — operator-only predicate must exclude the fixture
  // (and every other row in the tenant, since the requester has zero
  // operator paths).
  const leakedPlanned = body.planned.find((b) => b.id === PLANNING_REQUESTER_FIXTURE_WO_ID);
  const leakedUnsched = body.unscheduled.find((b) => b.id === PLANNING_REQUESTER_FIXTURE_WO_ID);
  if (leakedPlanned || leakedUnsched) {
    results.fail += 1;
    results.failed.push('Planning requester: fixture WO leaked');
    const where = leakedPlanned ? 'planned[]' : 'unscheduled[]';
    console.log(
      `  ✗ operator-only predicate LEAKED requester fixture in ${where} — 00380 broken`,
    );
    return;
  }

  // Stronger assertion — requester has no operator paths at all, so
  // both arrays should be empty. A non-empty array implies the predicate
  // is matching some non-operator branch (requester / watcher / unknown).
  if (body.planned.length > 0 || body.unscheduled.length > 0) {
    results.fail += 1;
    results.failed.push('Planning requester: non-empty arrays');
    console.log(
      `  ✗ requester sees ${body.planned.length} planned + ${body.unscheduled.length} unscheduled — predicate leaks beyond fixture`,
    );
    return;
  }

  results.pass += 1;
  console.log(`  ✓ requester sees planned: [] / unscheduled: [] — operator-only predicate excludes requester branch`);

  // P1-1: top-level lanes must also be empty for the requester. The
  // lane derivation skips when team_id is unfiltered (and the predicate
  // already excluded every block), so this should always be [].
  if (!Array.isArray(body.lanes)) {
    results.fail += 1;
    results.failed.push('Planning requester: missing lanes[]');
    console.log(`  ✗ requester response missing lanes[] (P1-1 shape requirement)`);
  } else if (body.lanes.length > 0) {
    results.fail += 1;
    results.failed.push('Planning requester: non-empty lanes');
    console.log(`  ✗ requester sees ${body.lanes.length} lanes — predicate leaks via lanes`);
  } else {
    results.pass += 1;
    console.log(`  ✓ requester sees lanes: [] (P1-1 operator-only invariant)`);
  }

  // Negative-control branch — env-gated. Codifies the "did I manually
  // verify the probe goes red when an operator path is granted?" check.
  // Skipped on the green path; run after any predicate or seed change.
  if (process.env.DEBUG_NEGATIVE_REQUESTER_PROBE === '1') {
    await runRequesterNegativeControl(reqHeaders, fromIso, toIso);
  }
}

// Insert a team_members row that grants the seed requester an operator
// path (team-membership branch of the operator predicate), re-assign
// the fixture to that team, re-run the probe, assert it now sees the
// fixture (proving the probe is non-vacuous), then clean up.
async function runRequesterNegativeControl(reqHeaders, fromIso, toIso) {
  console.log('\n=== Planning requester NEGATIVE control (DEBUG_NEGATIVE_REQUESTER_PROBE=1) ===');
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
      results.failed.push('Negative-control: team_members insert failed');
      console.log(`  ✗ could not grant operator path: ${insErr.message}`);
      return;
    }
    inserted = true;
    console.log(`  ✓ inserted team_members row ${teamMemberId.slice(0, 8)}… on ${REAL_TEAM.slice(0, 8)}…`);

    // The fixture's `assigned_team_id` is null by default, so team
    // membership alone doesn't flip the predicate. Re-assign the
    // fixture to REAL_TEAM for the duration of the control. Restored
    // in `finally`.
    const { error: assignErr } = await supa()
      .from('work_orders')
      .update({ assigned_team_id: REAL_TEAM })
      .eq('id', PLANNING_REQUESTER_FIXTURE_WO_ID);
    if (assignErr) {
      results.fail += 1;
      results.failed.push('Negative-control: fixture team-assign failed');
      console.log(`  ✗ could not assign fixture to REAL_TEAM: ${assignErr.message}`);
      return;
    }
    reassigned = true;

    const probe = await fetchPlanningWindow(reqHeaders, fromIso, toIso);
    if (!probe.ok) {
      results.fail += 1;
      results.failed.push('Negative-control: GET non-200');
      console.log(`  ✗ negative-control GET → HTTP ${probe.status}`);
      return;
    }
    const seesFixture =
      probe.body.planned.some((b) => b.id === PLANNING_REQUESTER_FIXTURE_WO_ID) ||
      probe.body.unscheduled.some((b) => b.id === PLANNING_REQUESTER_FIXTURE_WO_ID);
    if (!seesFixture) {
      // Probe stays green with team-membership granted → the green-path
      // probe is vacuous: even adding a real operator path doesn't flip
      // the predicate, so its empty-arrays assertion proves nothing.
      results.fail += 1;
      results.failed.push('Negative-control: probe still empty with operator path');
      console.log(
        `  ✗ requester with team membership + fixture re-assigned to team STILL sees no rows — probe is vacuous`,
      );
      return;
    }
    results.pass += 1;
    console.log(`  ✓ negative-control passed: probe is non-vacuous (requester with operator path sees fixture)`);
  } finally {
    if (reassigned) {
      const { error: unassignErr } = await supa()
        .from('work_orders')
        .update({ assigned_team_id: null })
        .eq('id', PLANNING_REQUESTER_FIXTURE_WO_ID);
      if (unassignErr) {
        console.log(`  ! cleanup warn: fixture unassign failed: ${unassignErr.message}`);
      }
    }
    if (inserted) {
      const { error: delErr } = await supa().from('team_members').delete().eq('id', teamMemberId);
      if (delErr) {
        console.log(`  ! cleanup warn: team_members delete failed: ${delErr.message}`);
      } else {
        console.log(`  ✓ cleanup: team_members row removed, fixture unassigned`);
      }
    }
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

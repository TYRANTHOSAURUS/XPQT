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

  // Valid status filter — 200 and only matching categories.
  const statusUrl = `${API_BASE}/api/work-orders/planning?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&status=new&status=assigned`;
  const statusResp = await fetch(statusUrl, { headers });
  if (statusResp.status === 200) {
    const body = await statusResp.json();
    const allowed = new Set(['new', 'assigned']);
    const violator = body.planned.find((b) => !allowed.has(b.status_category));
    if (violator) {
      results.fail += 1;
      results.failed.push('Planning: status filter leak');
      console.log(`  ✗ Planning status filter leaked: got ${violator.status_category}`);
    } else {
      results.pass += 1;
      console.log(`  ✓ Planning status filter — only new/assigned in planned[]`);
    }
  } else {
    results.fail += 1;
    results.failed.push('Planning: valid status filter');
    console.log(`  ✗ GET planning status filter → HTTP ${statusResp.status}`);
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

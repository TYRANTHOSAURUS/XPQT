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
 */

import { createClient } from '@supabase/supabase-js';
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
// Auth — mint a real Admin JWT via Supabase auth.admin.generateLink
// ─────────────────────────────────────────────────────────────────────

async function mintAdminToken() {
  const supa = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: u } = await supa.auth.admin.getUserById(ADMIN_AUTH_UID);
  if (!u?.user) throw new Error(`admin auth uid ${ADMIN_AUTH_UID} not found`);

  const { data: link, error: linkErr } = await supa.auth.admin.generateLink({
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
    const { method = 'PATCH', url, body, expect = 'success' } = options;
    const r = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const ok =
      (expect === 'success' && r.status >= 200 && r.status < 300) ||
      (expect === 'badrequest' && r.status === 400) ||
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
    return { status: r.status, body: txt, ok };
  };
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
  await probe('WO: status flip', {
    url: `${API_BASE}/api/work-orders/${WO_ID}`,
    body: { status: nextStatus, status_category: nextStatusCat },
  });

  // priority: flip between 'medium' and 'high'
  const nextPriority = cur.priority === 'high' ? 'medium' : 'high';
  await probe('WO: priority flip', {
    url: `${API_BASE}/api/work-orders/${WO_ID}`,
    body: { priority: nextPriority },
  });

  // plan: set to +1 day from now (always different from current)
  await probe('WO: planned_start_at +1d', {
    url: `${API_BASE}/api/work-orders/${WO_ID}`,
    body: { planned_start_at: new Date(Date.now() + 86400000).toISOString() },
  });

  // ── Phase 1.1 plan-merge regression probes ───────────────────────────
  // Locks in: WorkOrderService.update merges plan-branch fields against the
  // current row instead of nulling absent fields. Pre-fix, a duration-only
  // patch silently cleared the existing planned_start_at; this set of
  // probes makes that regression visible end-to-end.

  // 1. Both fields together — fast-path baseline.
  const plan1Start = new Date(Date.now() + 2 * 86400000).toISOString();
  const plan1Result = await probe('WO: plan set start+duration', {
    url: `${API_BASE}/api/work-orders/${WO_ID}`,
    body: { planned_start_at: plan1Start, planned_duration_minutes: 60 },
  });
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
  const plan2Result = await probe('WO: plan patch duration only preserves start', {
    url: `${API_BASE}/api/work-orders/${WO_ID}`,
    body: { planned_duration_minutes: 90 },
  });
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
  const plan3Result = await probe('WO: plan patch start only preserves duration', {
    url: `${API_BASE}/api/work-orders/${WO_ID}`,
    body: { planned_start_at: plan3Start },
  });
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
  const plan4Result = await probe('WO: plan patch null start clears both', {
    url: `${API_BASE}/api/work-orders/${WO_ID}`,
    body: { planned_start_at: null },
  });
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
  await probe('WO: restore plan (cleanup)', {
    url: `${API_BASE}/api/work-orders/${WO_ID}`,
    body: {
      planned_start_at: new Date(Date.now() + 86400000).toISOString(),
      planned_duration_minutes: 60,
    },
  });

  // sla: clear (null is XOR-different from any current sla_id)
  await probe('WO: sla_id = null', {
    url: `${API_BASE}/api/work-orders/${WO_ID}`,
    body: { sla_id: null },
  });

  // assignment: swap teams
  const nextTeam = cur.assigned_team_id === REAL_TEAM ? ALT_TEAM : REAL_TEAM;
  await probe('WO: assignment swap', {
    url: `${API_BASE}/api/work-orders/${WO_ID}`,
    body: { assigned_team_id: nextTeam },
  });

  // metadata: title with timestamp suffix (always XOR-different)
  await probe('WO: title (Slice 3.1)', {
    url: `${API_BASE}/api/work-orders/${WO_ID}`,
    body: { title: `smoke-${Date.now()}` },
  });

  // metadata: tags
  const nextTags =
    JSON.stringify(cur.tags) === JSON.stringify(['smoke-a']) ? ['smoke-b'] : ['smoke-a'];
  await probe('WO: tags (Slice 3.1)', {
    url: `${API_BASE}/api/work-orders/${WO_ID}`,
    body: { tags: nextTags },
  });

  // metadata: cost (fractional — float-normalization regression test)
  const nextCost = (cur.cost ?? 0) + 0.1 + 0.2; // intentionally drift-prone
  await probe('WO: cost (fractional, normalization)', {
    url: `${API_BASE}/api/work-orders/${WO_ID}`,
    body: { cost: nextCost },
  });
}

async function runCaseMutations(headers, probe) {
  console.log('\n=== Case mutations ===');

  // priority: flip
  await probe('CASE: priority flip', {
    url: `${API_BASE}/api/tickets/${CASE_ID}`,
    body: { priority: 'high' },
  });

  // assignment: swap teams (validation now enforced)
  await probe('CASE: assignment to real team', {
    url: `${API_BASE}/api/tickets/${CASE_ID}`,
    body: { assigned_team_id: REAL_TEAM },
  });

  // title
  await probe('CASE: title', {
    url: `${API_BASE}/api/tickets/${CASE_ID}`,
    body: { title: `smoke-case-${Date.now()}` },
  });

  // cost (fractional — float-normalization regression test, case side).
  // Backports the WO-side fix per /full-review I3. Sends 0.1+0.2 which
  // is 0.30000000000000004 in IEEE-754; without normalization the no-op
  // fast-path would never fire and every PATCH would re-write the row.
  const r = await fetch(`${API_BASE}/api/tickets/${CASE_ID}`, { headers });
  const cur = await r.json();
  const nextCost = (cur.cost ?? 0) + 0.1 + 0.2;
  await probe('CASE: cost (fractional, normalization)', {
    url: `${API_BASE}/api/tickets/${CASE_ID}`,
    body: { cost: nextCost },
  });
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

async function runDispatchProbe(headers, probe) {
  console.log('\n=== Dispatch (creating a child WO) ===');

  const r = await fetch(`${API_BASE}/api/tickets/${CASE_ID}/dispatch`, {
    method: 'POST',
    headers,
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
      const supa = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { error } = await supa.from('work_orders').delete().eq('id', created.id);
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

#!/usr/bin/env node
/**
 * scripts/smoke-tickets.mjs
 *
 * Live-API smoke test for the CASE-side command surface
 * (`PATCH /api/tickets/:id`). Sibling to `smoke-work-orders.mjs`.
 *
 * Coverage:
 *   1. Mutation matrix — status_category / waiting_reason set+clear /
 *      priority / assignment (team set+clear) / metadata (title, cost,
 *      tags, watchers). Each successful mutation asserts that the
 *      `update_entity_combined` orchestrator (00335 v5) actually fired
 *      by querying `command_operations` for a matching success row.
 *   2. Concurrency / idempotency probes — same X-Client-Request-Id
 *      twice (idempotent replay hits outer cache; no new audit row),
 *      different payload + same key (409 payload_mismatch), missing
 *      X-Client-Request-Id header (400 client_request_id.required).
 *   3. Cross-tenant boundary probes — ghost watcher uuid (400
 *      update_entity_combined.invalid_watcher), ghost assignee team
 *      (400 invalid_team / invalid_assignee).
 *   4. Empty-patches boundary — PATCH /tickets/:id with `{}` returns
 *      200 with current row unchanged and does NOT create a
 *      command_operations row (TicketService.update short-circuits per
 *      ticket.service.ts:1116-1123).
 *
 * Citations:
 *   - 00316_command_operations_table.sql:31-42 (table schema).
 *   - 00335_update_entity_combined_v5.sql:203-205, :792-794
 *     (insert in_progress + final UPDATE to success).
 *   - apps/api/src/modules/ticket/ticket.service.ts:1274-1280
 *     (idempotency-key shape `patch:case:<id>:<x-cid>`).
 *   - apps/api/src/common/guards/require-client-request-id.guard.ts:45
 *     (controller-level guard returns 400 `client_request_id.required`).
 *
 * USAGE:
 *   pnpm dev:api &     (or have the dev server already running)
 *   node apps/api/scripts/smoke-tickets.mjs
 *
 *   exit 0 = all probes pass; exit 1 = at least one regression.
 */

import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─────────────────────────────────────────────────────────────────────
// Config
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

const API_BASE = process.env.API_BASE || 'http://localhost:3001';
const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const ADMIN_AUTH_UID = '93d41232-35b5-424c-b215-bb5d55a2dfd9';
const CASE_ID = '3970a9ff-5c4b-4a8e-9f6f-f37ce89c7d1d';
const REAL_TEAM = '94000000-0000-0000-0000-000000000002';
const ALT_TEAM = '94000000-0000-0000-0000-000000000005';
const REAL_PERSON = 'b3a0aa30-3648-4783-92fa-973090877238';
const GHOST_UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

// ─────────────────────────────────────────────────────────────────────
// Supabase admin singleton (for command_operations assertions).
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
// Auth — mint a real Admin JWT via Supabase auth.admin.generateLink.
// Mirrors smoke-work-orders.mjs:93-115.
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
// Probe runner — shared shape with smoke-work-orders.mjs.
// ─────────────────────────────────────────────────────────────────────

const results = { pass: 0, fail: 0, failed: [] };

function makeProber(headers) {
  return async function probe(name, options) {
    const {
      method = 'PATCH',
      url,
      body,
      expect = 'success',
      clientRequestId,
      // omitClientRequestId: send the PATCH without a header (used by
      // the controller-guard probe). Default behaviour mints a uuid.
      omitClientRequestId = false,
    } = options;
    const isMutation = method === 'PATCH' || method === 'POST';
    const xCid =
      isMutation && !omitClientRequestId
        ? clientRequestId || crypto.randomUUID()
        : null;
    const probeHeaders = xCid
      ? { ...headers, 'X-Client-Request-Id': xCid }
      : { ...headers };
    const r = await fetch(url, {
      method,
      headers: probeHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const ok =
      (expect === 'success' && r.status >= 200 && r.status < 300) ||
      (expect === 'badrequest' && r.status === 400) ||
      (expect === 'conflict' && r.status === 409) ||
      (expect === 'forbidden' && r.status === 403) ||
      (expect === 'notfound' && r.status === 404);
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
// command_operations assertion — verify the orchestrator landed a
// success row keyed on (tenant_id, `patch:case:<id>:<x-cid>`).
// Per 00335_update_entity_combined_v5.sql:203-205 + :792-794.
// ─────────────────────────────────────────────────────────────────────

async function assertCommandOpRow(name, tenantId, entityId, xCid) {
  if (!xCid) {
    results.fail += 1;
    results.failed.push(`${name} (command_op assert: no x-cid)`);
    console.log(`  ✗ ${name} (command_op assert) — no X-Client-Request-Id captured`);
    return null;
  }
  const idempotencyKey = `patch:case:${entityId}:${xCid}`;
  const { data, error } = await supa()
    .from('command_operations')
    .select('outcome, cached_result, completed_at, payload_hash')
    .eq('tenant_id', tenantId)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (error) {
    results.fail += 1;
    results.failed.push(`${name} (command_op assert: query error)`);
    console.log(`  ✗ ${name} (command_op assert) — query error: ${error.message}`);
    return null;
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
    return null;
  }
  if (data.outcome !== 'success') {
    results.fail += 1;
    results.failed.push(`${name} (command_op assert: outcome=${data.outcome})`);
    console.log(`  ✗ ${name} (command_op assert) — outcome=${data.outcome}, want success`);
    return data;
  }
  if (!data.cached_result) {
    results.fail += 1;
    results.failed.push(`${name} (command_op assert: empty cached_result)`);
    console.log(`  ✗ ${name} (command_op assert) — cached_result is null`);
    return data;
  }
  results.pass += 1;
  console.log(`  ✓ ${name} (command_op outcome=success)`);
  return data;
}

async function assertNoCommandOpRow(name, tenantId, entityId, xCid) {
  if (!xCid) {
    // No cid means probe never minted one (e.g. omitted-header probe) —
    // a 'no row' assertion against a non-existent key is trivially true.
    results.pass += 1;
    console.log(`  ✓ ${name} (no command_op row, no key minted)`);
    return;
  }
  const idempotencyKey = `patch:case:${entityId}:${xCid}`;
  const { data, error } = await supa()
    .from('command_operations')
    .select('outcome')
    .eq('tenant_id', tenantId)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (error) {
    results.fail += 1;
    results.failed.push(`${name} (no-row assert query error)`);
    console.log(`  ✗ ${name} (no-row assert) — query error: ${error.message}`);
    return;
  }
  if (data) {
    results.fail += 1;
    results.failed.push(`${name} (no-row assert: row present)`);
    console.log(`  ✗ ${name} (no-row assert) — row present, outcome=${data.outcome}`);
    return;
  }
  results.pass += 1;
  console.log(`  ✓ ${name} (no command_op row)`);
}

async function probeAndAssertCommandOp(probe, name, options) {
  const result = await probe(name, options);
  if (result.ok && (options.expect ?? 'success') === 'success') {
    await assertCommandOpRow(name, TENANT_ID, CASE_ID, result.xClientRequestId);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────
// Probes — current-row-XOR-sentinel for every mutation
// ─────────────────────────────────────────────────────────────────────

async function readCase(headers) {
  const r = await fetch(`${API_BASE}/api/tickets/${CASE_ID}`, { headers });
  if (!r.ok) throw new Error(`failed to read case: ${r.status}`);
  return r.json();
}

async function runMutationMatrix(headers, probe) {
  console.log('\n=== CASE mutations: current-row-XOR-sentinel ===');
  const cur = await readCase(headers);

  // ── status_category — flip between 'in_progress' and 'waiting'.
  // 'waiting' requires a non-null waiting_reason; pair them in one
  // patch to match the transition_entity_status contract
  // (00325:271-273). Allowed waiting_reason values per 00011_tickets.sql:12:
  // ('requester', 'vendor', 'approval', 'scheduled_work', 'other').
  const targetWaiting = cur.status_category !== 'waiting';
  await probeAndAssertCommandOp(probe, 'CASE: status_category flip', {
    url: `${API_BASE}/api/tickets/${CASE_ID}`,
    body: targetWaiting
      ? {
          status: 'waiting',
          status_category: 'waiting',
          waiting_reason: 'requester',
        }
      : {
          status: 'in_progress',
          status_category: 'in_progress',
          waiting_reason: null,
        },
  });

  // ── waiting_reason flip while staying in waiting (only meaningful
  // if we just landed in waiting). Otherwise skip the second flip and
  // exit waiting to keep the seed row close to its starting shape.
  const afterFirstFlip = await readCase(headers);
  if (afterFirstFlip.status_category === 'waiting') {
    await probeAndAssertCommandOp(probe, 'CASE: waiting_reason flip', {
      url: `${API_BASE}/api/tickets/${CASE_ID}`,
      body: {
        waiting_reason:
          afterFirstFlip.waiting_reason === 'vendor' ? 'requester' : 'vendor',
      },
    });
    // Restore to in_progress so subsequent runs land on the same path.
    await probeAndAssertCommandOp(probe, 'CASE: status restore in_progress', {
      url: `${API_BASE}/api/tickets/${CASE_ID}`,
      body: {
        status: 'in_progress',
        status_category: 'in_progress',
        waiting_reason: null,
      },
    });
  }

  // ── priority flip ──────────────────────────────────────────────────
  const nextPriority = cur.priority === 'high' ? 'medium' : 'high';
  await probeAndAssertCommandOp(probe, 'CASE: priority flip', {
    url: `${API_BASE}/api/tickets/${CASE_ID}`,
    body: { priority: nextPriority },
  });

  // ── assignment: swap teams (XOR with current). ─────────────────────
  const nextTeam = cur.assigned_team_id === REAL_TEAM ? ALT_TEAM : REAL_TEAM;
  await probeAndAssertCommandOp(probe, 'CASE: assignment team swap', {
    url: `${API_BASE}/api/tickets/${CASE_ID}`,
    body: { assigned_team_id: nextTeam },
  });

  // Clear assigned_user (was set in seed) so the next runs land deterministically.
  await probeAndAssertCommandOp(probe, 'CASE: clear assigned_user', {
    url: `${API_BASE}/api/tickets/${CASE_ID}`,
    body: { assigned_user_id: null },
  });

  // Restore assigned_user so other tests don't see a perpetually-cleared row.
  await probeAndAssertCommandOp(probe, 'CASE: restore assigned_user (cleanup)', {
    url: `${API_BASE}/api/tickets/${CASE_ID}`,
    body: { assigned_user_id: 'd62cc844-b1eb-42fe-9e82-bf1e91f1b11c' },
  });

  // ── metadata: title (timestamp suffix, always XOR-different) ───────
  await probeAndAssertCommandOp(probe, 'CASE: title', {
    url: `${API_BASE}/api/tickets/${CASE_ID}`,
    body: { title: `smoke-case-${Date.now()}` },
  });

  // ── metadata: tags ─────────────────────────────────────────────────
  const nextTags =
    JSON.stringify(cur.tags) === JSON.stringify(['case-smoke-a'])
      ? ['case-smoke-b']
      : ['case-smoke-a'];
  await probeAndAssertCommandOp(probe, 'CASE: tags', {
    url: `${API_BASE}/api/tickets/${CASE_ID}`,
    body: { tags: nextTags },
  });

  // ── metadata: cost (fractional, normalization regression) ──────────
  const nextCost = (cur.cost ?? 0) + 0.1 + 0.2;
  await probeAndAssertCommandOp(probe, 'CASE: cost (fractional)', {
    url: `${API_BASE}/api/tickets/${CASE_ID}`,
    body: { cost: nextCost },
  });

  // ── metadata: watchers set + clear ─────────────────────────────────
  await probeAndAssertCommandOp(probe, 'CASE: watchers add', {
    url: `${API_BASE}/api/tickets/${CASE_ID}`,
    body: { watchers: [REAL_PERSON] },
  });
  await probeAndAssertCommandOp(probe, 'CASE: watchers clear', {
    url: `${API_BASE}/api/tickets/${CASE_ID}`,
    body: { watchers: [] },
  });
}

// ─────────────────────────────────────────────────────────────────────
// Concurrency / idempotency probes — same X-Client-Request-Id replay,
// payload mismatch, missing header.
// ─────────────────────────────────────────────────────────────────────

async function runConcurrencyProbes(headers, probe) {
  console.log('\n=== CASE concurrency / idempotency ===');

  // 1. Idempotent replay — same X-Client-Request-Id twice, same body.
  //    Second call must return 200 and hit the outer command_operations
  //    cache (00335:188-190). After both calls, exactly ONE row should
  //    exist for the key.
  const sharedCid = crypto.randomUUID();
  const replayBody = { title: `smoke-replay-${Date.now()}` };
  const first = await probeAndAssertCommandOp(probe, 'CASE: idempotent replay #1', {
    url: `${API_BASE}/api/tickets/${CASE_ID}`,
    body: replayBody,
    clientRequestId: sharedCid,
  });

  const second = await probe('CASE: idempotent replay #2 (cache hit)', {
    url: `${API_BASE}/api/tickets/${CASE_ID}`,
    body: replayBody,
    clientRequestId: sharedCid,
  });
  // Verify the replay also went through the orchestrator + cached
  // result row is still present (one row, idempotent).
  if (second.ok) {
    await assertCommandOpRow(
      'CASE: idempotent replay #2 (cache hit)',
      TENANT_ID,
      CASE_ID,
      sharedCid,
    );
  }
  // Sanity: both calls used the same idempotency key.
  if (first.xClientRequestId !== second.xClientRequestId) {
    results.fail += 1;
    results.failed.push('CASE: idempotent replay key mismatch');
    console.log('  ✗ idempotent replay: key mismatch between calls');
  } else {
    results.pass += 1;
    console.log('  ✓ idempotent replay: same key used twice');
  }

  // 2. Payload mismatch — same X-Client-Request-Id, different body.
  //    Must reject with 409 command_operations.payload_mismatch
  //    (00335:191-194).
  const mismatchCid = crypto.randomUUID();
  await probeAndAssertCommandOp(probe, 'CASE: payload-mismatch setup', {
    url: `${API_BASE}/api/tickets/${CASE_ID}`,
    body: { title: `smoke-mismatch-${Date.now()}` },
    clientRequestId: mismatchCid,
  });
  const mismatchResult = await probe('CASE: payload mismatch → 409', {
    url: `${API_BASE}/api/tickets/${CASE_ID}`,
    body: { title: `smoke-mismatch-different-${Date.now()}` },
    clientRequestId: mismatchCid,
    expect: 'conflict',
  });
  if (mismatchResult.ok) {
    try {
      const parsed = JSON.parse(mismatchResult.body);
      if (parsed.code === 'command_operations.payload_mismatch') {
        results.pass += 1;
        console.log('  ✓ CASE: payload mismatch code=command_operations.payload_mismatch');
      } else {
        results.fail += 1;
        results.failed.push('CASE: payload mismatch (wrong code)');
        console.log(`  ✗ CASE: payload mismatch (wrong code) → code=${parsed.code}`);
      }
    } catch {
      results.fail += 1;
      results.failed.push('CASE: payload mismatch (body parse)');
      console.log('  ✗ CASE: payload mismatch — could not parse body');
    }
  }

  // 3. Missing X-Client-Request-Id — controller guard returns 400
  //    `client_request_id.required` (require-client-request-id.guard.ts:45).
  const missingResult = await probe('CASE: missing X-Client-Request-Id → 400', {
    url: `${API_BASE}/api/tickets/${CASE_ID}`,
    body: { title: `smoke-missing-${Date.now()}` },
    omitClientRequestId: true,
    expect: 'badrequest',
  });
  if (missingResult.ok) {
    try {
      const parsed = JSON.parse(missingResult.body);
      if (parsed.code === 'client_request_id.required') {
        results.pass += 1;
        console.log('  ✓ CASE: missing header code=client_request_id.required');
      } else {
        results.fail += 1;
        results.failed.push('CASE: missing header (wrong code)');
        console.log(`  ✗ CASE: missing header (wrong code) → code=${parsed.code}`);
      }
    } catch {
      results.fail += 1;
      results.failed.push('CASE: missing header (body parse)');
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Cross-tenant / validation probes — invalid uuids must reject cleanly
// (no PG-leak 500s, no cross-tenant ID smuggling).
// ─────────────────────────────────────────────────────────────────────

async function runCrossTenantProbes(headers, probe) {
  console.log('\n=== CASE cross-tenant / validation probes ===');

  // Ghost watcher uuid — TS preflight rejects via validateWatcherIdsInTenant
  // (ticket.service.ts:1005-1009) BEFORE the RPC. Either way the result
  // must be a 400.
  await probe('CASE: ghost watcher uuid → 400', {
    url: `${API_BASE}/api/tickets/${CASE_ID}`,
    body: { watchers: [GHOST_UUID] },
    expect: 'badrequest',
  });

  // Ghost team id — TS preflight rejects via validateAssigneesInTenant
  // (ticket.service.ts:1010-1025). Closes the cross-tenant assignee
  // smuggling vector documented at ticket.service.ts:998-1004.
  await probe('CASE: ghost assigned_team_id → 400', {
    url: `${API_BASE}/api/tickets/${CASE_ID}`,
    body: { assigned_team_id: GHOST_UUID },
    expect: 'badrequest',
  });

  // Malformed watcher uuid — must reject with 400, never reach the DB.
  await probe('CASE: malformed watcher uuid → 400', {
    url: `${API_BASE}/api/tickets/${CASE_ID}`,
    body: { watchers: ['not-a-uuid'] },
    expect: 'badrequest',
  });

  // Empty title — RPC rejects via update_entity_combined.invalid_metadata
  // (00335:498-503). Note the RPC checks `length(v_new_title) = 0` —
  // whitespace-only titles slip through on the case path because the
  // case TS layer has no trim check (gap vs WO side, which trims at
  // work-order.service.ts:594). Documented in b2-followups.md;
  // probe sends a zero-length string to exercise the RPC gate.
  await probe('CASE: empty title (zero-length) → 400', {
    url: `${API_BASE}/api/tickets/${CASE_ID}`,
    body: { title: '' },
    expect: 'badrequest',
  });
}

// ─────────────────────────────────────────────────────────────────────
// Boundary probes — empty patches body (case service short-circuits;
// no command_op row should appear), sla_id immutability on case.
// ─────────────────────────────────────────────────────────────────────

async function runBoundaryProbes(headers, probe) {
  console.log('\n=== CASE boundary probes ===');

  // Empty patches body — ticket.service.ts:1116-1123 short-circuits
  // and returns the current row WITHOUT calling the RPC. So:
  //   - Response 200.
  //   - NO command_operations row appears for this X-Client-Request-Id.
  const emptyResult = await probe('CASE: empty patches body (short-circuit)', {
    url: `${API_BASE}/api/tickets/${CASE_ID}`,
    body: {},
  });
  if (emptyResult.ok) {
    await assertNoCommandOpRow(
      'CASE: empty patches body (short-circuit)',
      TENANT_ID,
      CASE_ID,
      emptyResult.xClientRequestId,
    );
  }

  // sla_id on case — locked per step 1c.10c (case parent SLA is
  // immutable). ticket.service.ts:1052-1056 throws
  // `ticket.case_sla_immutable` (400) before the RPC is invoked.
  const slaResult = await probe('CASE: sla_id immutable → 400', {
    url: `${API_BASE}/api/tickets/${CASE_ID}`,
    body: { sla_id: null },
    expect: 'badrequest',
  });
  if (slaResult.ok) {
    try {
      const parsed = JSON.parse(slaResult.body);
      if (parsed.code === 'ticket.case_sla_immutable') {
        results.pass += 1;
        console.log('  ✓ CASE: sla_id immutable code=ticket.case_sla_immutable');
      } else {
        results.fail += 1;
        results.failed.push('CASE: sla_id immutable (wrong code)');
        console.log(`  ✗ CASE: sla_id immutable (wrong code) → code=${parsed.code}`);
      }
    } catch {
      results.fail += 1;
      results.failed.push('CASE: sla_id immutable (body parse)');
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Smoke-testing CASE command surface against ${API_BASE}`);

  // Health check — fail loudly if API isn't running.
  try {
    const r = await fetch(`${API_BASE}/api/tickets/${CASE_ID}`, { method: 'HEAD' });
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

  await runMutationMatrix(headers, probe);
  await runConcurrencyProbes(headers, probe);
  await runCrossTenantProbes(headers, probe);
  await runBoundaryProbes(headers, probe);

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

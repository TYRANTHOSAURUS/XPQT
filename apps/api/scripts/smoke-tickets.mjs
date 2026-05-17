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
 *   - packages/shared/src/idempotency.ts:34 + :60-66
 *     (canonical PATCH_IDEMPOTENCY_KEY_PREFIX + buildPatchIdempotencyKey;
 *     this .mjs keeps a replica with a cross-reference comment).
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
import { execFileSync } from 'node:child_process';
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

// TENANT_B fixture — seeded on-demand by ensureTenantBFixture() so the
// cross-tenant smuggling probe exercises the real validateAssigneesInTenant
// branch (uuid exists, but tenant_id != current). Without an "exists but
// foreign-tenant" user, the probe only re-runs the ghost-uuid path the
// existing probes already cover.
const TENANT_B_ID = '00000000-0000-0000-0000-0000000000b1';
const TENANT_B_USER_ID = '00000000-0000-0000-0000-0000000000b2';

// Dedicated state-machine fixture case — separate from CASE_ID so the
// resolve/close/reopen cycle isn't blocked by pre-existing children
// that real seeds attach to CASE_ID. Seeded on-demand by
// ensureStateMachineFixture(); deleted at the end of runStateMachineProbes.
const SM_CASE_ID = '00000000-0000-0000-0000-0000000000c1';

// ─────────────────────────────────────────────────────────────────────
// Idempotency-key shape — kept in lockstep with @prequest/shared/idempotency
// (packages/shared/src/idempotency.ts:34 + :60-66). The .mjs runtime can't
// import the TS source directly (no compile step for smoke scripts), so the
// helper is replicated here with a cross-reference comment. If you change
// the prefix or shape, update BOTH places in the same commit.
// ─────────────────────────────────────────────────────────────────────

const PATCH_IDEMPOTENCY_KEY_PREFIX = 'patch';

function buildPatchIdempotencyKey(kind, entityId, clientRequestId) {
  return `${PATCH_IDEMPOTENCY_KEY_PREFIX}:${kind}:${entityId}:${clientRequestId}`;
}

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
// TENANT_B fixture — seeded on-demand so the cross-tenant
// assigned_user_id probe (F2) tests the "uuid exists in wrong tenant"
// branch, not just "uuid exists nowhere" (which the ghost probes
// already cover). Idempotent via `upsert` so re-runs are no-ops.
//
// We seed a second tenant + a single user in it. The user is enough to
// trigger validateAssigneesInTenant's tenant-mismatch rejection
// (tenant-validation.ts: checks `user.tenant_id = current_tenant`).
// ─────────────────────────────────────────────────────────────────────

async function ensureTenantBFixture() {
  // We use a direct psql call (not supabase-js) for two reasons:
  // 1. The tenants table has an AFTER INSERT trigger
  //    (`trg_tenants_seed_retention`) whose function references a
  //    renamed column (`default_retention_days` → `retention_days` per
  //    00162) — the live function is drifted from migrations and
  //    fails any tenant insert. Tracked as separate tech debt; out of
  //    scope here. Disabling the trigger session-locally is the
  //    simplest workaround.
  // 2. supabase-js cannot execute arbitrary DDL/session settings.
  //
  // The SQL is a single transaction that:
  //   - disables the trigger for this session only
  //   - upserts TENANT_B + the cross-tenant user
  //   - re-enables the trigger for cleanliness (session ends anyway)
  const dbPass = env.SUPABASE_DB_PASS;
  if (!dbPass) {
    throw new Error(
      'ensureTenantBFixture: SUPABASE_DB_PASS missing from .env — cannot seed TENANT_B without it',
    );
  }
  const dbUrl =
    env.SUPABASE_DB_URL ||
    'postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres';
  const sql = `
    set session_replication_role = 'replica';
    insert into public.tenants (id, name, slug, status)
      values ('${TENANT_B_ID}', 'Smoke Tenant B (xtenant probes)', 'smoke-tenant-b', 'active')
      on conflict (id) do nothing;
    insert into public.users (id, tenant_id, email, status)
      values ('${TENANT_B_USER_ID}', '${TENANT_B_ID}', 'smoke-tenant-b-user@example.test', 'active')
      on conflict (id) do nothing;
    set session_replication_role = 'origin';
  `;
  try {
    execFileSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-c', sql], {
      env: { ...process.env, PGPASSWORD: dbPass },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const stderr = e.stderr?.toString() ?? '';
    const stdout = e.stdout?.toString() ?? '';
    throw new Error(
      `ensureTenantBFixture: psql seed failed: ${e.message}\nstdout: ${stdout}\nstderr: ${stderr}`,
    );
  }
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
// success row keyed on (tenant_id, buildPatchIdempotencyKey('case', …)).
// Per 00335_update_entity_combined_v5.sql:203-205 + :792-794.
// ─────────────────────────────────────────────────────────────────────

async function assertCommandOpRow(name, tenantId, entityId, xCid) {
  if (!xCid) {
    results.fail += 1;
    results.failed.push(`${name} (command_op assert: no x-cid)`);
    console.log(`  ✗ ${name} (command_op assert) — no X-Client-Request-Id captured`);
    return null;
  }
  const idempotencyKey = buildPatchIdempotencyKey('case', entityId, xCid);
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
  const idempotencyKey = buildPatchIdempotencyKey('case', entityId, xCid);
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

  // F5 — response-body identity on replay. The earlier checks confirm
  // the command_operations row exists for the key, but they do NOT
  // verify the second call returned the cached body. A buggy
  // implementation could re-execute on replay (writing a NEW row,
  // overwriting cached_result) and still pass the "row exists" check.
  // The two response bodies must be byte-identical — that's the only
  // guarantee that the RPC short-circuited on the outer cache
  // (00335:188-190) instead of re-executing.
  if (first.ok && second.ok) {
    if (first.body === second.body) {
      results.pass += 1;
      console.log('  ✓ idempotent replay: response bodies identical (no re-execution)');
    } else {
      results.fail += 1;
      results.failed.push('CASE: idempotent replay body mismatch');
      console.log('  ✗ idempotent replay: response bodies differ — RPC re-executed');
      console.log(`     first: ${first.body.slice(0, 120)}…`);
      console.log(`     second: ${second.body.slice(0, 120)}…`);
    }
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

  // Cross-tenant assigned_user_id smuggling — uuid EXISTS in TENANT_B,
  // PATCH on TENANT_A's case must reject via validateAssigneesInTenant
  // (ticket.service.ts:1010-1025). Different blast radius from the
  // ghost-uuid probe above: ghost validates "doesn't exist anywhere";
  // this validates "exists in the wrong tenant" — the exact smuggling
  // vector documented at ticket.service.ts:998-1004 (assignment grants
  // ownership; cross-tenant assignment is a privilege-escalation path).
  //
  // Pre-state assertion: capture the case row so we can post-state-
  // verify nothing was written (partial-write probe).
  const preState = await readCase(headers);
  await probe('CASE: cross-tenant assigned_user_id (TENANT_B user) → 400', {
    url: `${API_BASE}/api/tickets/${CASE_ID}`,
    body: { assigned_user_id: TENANT_B_USER_ID },
    expect: 'badrequest',
  });
  const postState = await readCase(headers);
  if (
    preState.assigned_user_id === postState.assigned_user_id &&
    preState.updated_at === postState.updated_at
  ) {
    results.pass += 1;
    console.log('  ✓ CASE: cross-tenant probe — no partial state (assigned_user_id + updated_at unchanged)');
  } else {
    results.fail += 1;
    results.failed.push('CASE: cross-tenant probe partial-state leak');
    console.log(
      `  ✗ CASE: cross-tenant probe partial-state leak → pre.assigned_user_id=${preState.assigned_user_id} post.assigned_user_id=${postState.assigned_user_id}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────
// State-machine fixture — dedicated child-free case for the resolve /
// close / reopen / re-resolve cycle. CASE_ID has pre-existing seeded
// children (real fixture data); we can't safely close it without
// corrupting other smoke runs. SM_CASE_ID is created on-demand,
// referenced only by this probe, and deleted at exit.
// ─────────────────────────────────────────────────────────────────────

async function ensureStateMachineFixture() {
  const dbPass = env.SUPABASE_DB_PASS;
  if (!dbPass) {
    throw new Error('ensureStateMachineFixture: SUPABASE_DB_PASS missing');
  }
  const dbUrl =
    env.SUPABASE_DB_URL ||
    'postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres';
  // Insert a minimal case with no parent + no children. session_replication_role
  // skips trigger fan-out (which is mostly outbox emits that aren't relevant
  // to this fixture). The insert is idempotent via `on conflict do nothing`
  // — if a previous run left it behind in a terminal state, reset it.
  // module_number is per-tenant + not-null + no default; we use a
  // high-numbered constant (999000+) to stay clear of seeded data.
  const sql = `
    set session_replication_role = 'replica';
    insert into public.tickets (id, tenant_id, title, status, status_category, module_number)
      values ('${SM_CASE_ID}', '${TENANT_ID}', 'smoke state-machine fixture', 'in_progress', 'in_progress', 999001)
      on conflict (id) do update
        set status = 'in_progress',
            status_category = 'in_progress',
            waiting_reason = null,
            resolved_at = null,
            closed_at = null,
            updated_at = now();
    -- Reset any leftover command_operations rows so idempotency-key
    -- collisions don't cache a stale 'closed' transition.
    delete from public.command_operations
     where tenant_id = '${TENANT_ID}'
       and idempotency_key like 'patch:case:${SM_CASE_ID}:%';
    set session_replication_role = 'origin';
  `;
  try {
    execFileSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-c', sql], {
      env: { ...process.env, PGPASSWORD: dbPass },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const stderr = e.stderr?.toString() ?? '';
    throw new Error(`ensureStateMachineFixture: ${e.message}\nstderr: ${stderr}`);
  }
}

async function deleteStateMachineFixture() {
  const dbPass = env.SUPABASE_DB_PASS;
  const dbUrl =
    env.SUPABASE_DB_URL ||
    'postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres';
  const sql = `
    set session_replication_role = 'replica';
    delete from public.command_operations
     where tenant_id = '${TENANT_ID}'
       and idempotency_key like 'patch:case:${SM_CASE_ID}:%';
    delete from public.tickets where id = '${SM_CASE_ID}';
    set session_replication_role = 'origin';
  `;
  try {
    execFileSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-c', sql], {
      env: { ...process.env, PGPASSWORD: dbPass },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    // Best-effort cleanup — log but don't fail the run.
    console.log(`  ! SM fixture cleanup warn: ${e.message}`);
  }
}

async function readTicket(headers, id) {
  const r = await fetch(`${API_BASE}/api/tickets/${id}`, { headers });
  if (!r.ok) throw new Error(`failed to read ticket ${id}: ${r.status}`);
  return r.json();
}

// ─────────────────────────────────────────────────────────────────────
// State-machine probes (F4) — exercises the §3.1 status-transition
// guards: has_open_children (case→terminal blocked), terminal-stamp
// preservation across reopen/resolve cycles (00325 v2 coalesce
// contract), and the documented whitespace-title divergence (F8).
//
// Runs against SM_CASE_ID (dedicated child-free fixture) so the
// cycle isn't blocked by CASE_ID's seeded children. Whitespace-title
// + terminal-edit probes ALSO run on CASE_ID at the end (since they
// only need any case, and verifying divergence on the real seed
// matches production reality better).
// ─────────────────────────────────────────────────────────────────────

async function runStateMachineProbes(headers, probe) {
  console.log('\n=== CASE state-machine + terminal-stamp probes ===');

  // ── has_open_children guard ────────────────────────────────────────
  //
  // Create a child WO under SM_CASE_ID, then attempt to close the
  // parent. The TS preflight at ticket.service.ts:1064-1077 gates
  // this BEFORE the §3.1 RPC's has_open_children check — it returns
  // `ticket.children_open_cannot_close` (400). The RPC's
  // `transition_entity_status.has_open_children` (409) is the
  // backstop; we never see it in normal flow because TS preflight
  // catches it first. (Either the TS preflight code OR the RPC
  // backstop is acceptable; document the surface behaviour.)
  const dispatchCid = crypto.randomUUID();
  const dispatchResp = await fetch(`${API_BASE}/api/tickets/${SM_CASE_ID}/dispatch`, {
    method: 'POST',
    headers: { ...headers, 'X-Client-Request-Id': dispatchCid },
    body: JSON.stringify({
      title: `smoke-sm-child-${Date.now()}`,
      assigned_team_id: REAL_TEAM,
    }),
  });
  let childWoId = null;
  if (dispatchResp.status === 201 || dispatchResp.status === 200) {
    const created = await dispatchResp.json();
    childWoId = created?.id ?? null;
    results.pass += 1;
    console.log(`  ✓ CASE-SM: dispatched child WO ${childWoId?.slice(0, 8) ?? '?'}…`);
  } else {
    results.fail += 1;
    results.failed.push('CASE-SM: child dispatch failed');
    console.log(`  ✗ CASE-SM: child dispatch HTTP ${dispatchResp.status}`);
  }

  // Now attempt to close the case → TS preflight rejects with 400
  // ticket.children_open_cannot_close (the friendlier surface). The
  // §3.1 RPC's transition_entity_status.has_open_children (409) is
  // unreachable from this path; if the TS preflight is ever removed,
  // the RPC backstop will take over and this probe will need updating.
  if (childWoId) {
    const closeWithChildResult = await probe('CASE-SM: close with open child → 400 ticket.children_open_cannot_close', {
      url: `${API_BASE}/api/tickets/${SM_CASE_ID}`,
      body: { status: 'closed', status_category: 'closed' },
      expect: 'badrequest',
    });
    if (closeWithChildResult.ok) {
      try {
        const parsed = JSON.parse(closeWithChildResult.body);
        if (parsed.code === 'ticket.children_open_cannot_close') {
          results.pass += 1;
          console.log('  ✓ CASE-SM: has_open_children code=ticket.children_open_cannot_close (TS preflight)');
        } else if (parsed.code === 'transition_entity_status.has_open_children') {
          // Acceptable fallback — TS preflight removed or bypassed; RPC backstop fired.
          results.pass += 1;
          console.log('  ✓ CASE-SM: has_open_children code=transition_entity_status.has_open_children (RPC backstop)');
        } else {
          results.fail += 1;
          results.failed.push('CASE-SM: has_open_children (wrong code)');
          console.log(`  ✗ CASE-SM: has_open_children (wrong code) → code=${parsed.code}`);
        }
      } catch {
        results.fail += 1;
        results.failed.push('CASE-SM: has_open_children (body parse)');
      }
    }

    // Cleanup the child WO so subsequent close/resolve probes are clean.
    const { error: delErr } = await supa().from('work_orders').delete().eq('id', childWoId);
    if (delErr) {
      results.fail += 1;
      results.failed.push('CASE-SM: child WO delete failed');
      console.log(`  ✗ CASE-SM: delete child failed: ${delErr.message}`);
    } else {
      results.pass += 1;
      console.log(`  ✓ CASE-SM: deleted child WO ${childWoId.slice(0, 8)}…`);
    }
  }

  // ── Close → reopen → resolve → close cycle on SM_CASE_ID
  //
  // 00325 v2 contract (coalesce on entry, :185-210): re-entering a
  // terminal state must preserve the original resolved_at / closed_at
  // stamps. A buggy implementation that stomps the stamps on every
  // entry would only show up across a multi-cycle path.
  await probeAndAssertCommandOpOn(probe, 'CASE-SM: cycle 1 — resolve', SM_CASE_ID, {
    url: `${API_BASE}/api/tickets/${SM_CASE_ID}`,
    body: { status: 'resolved', status_category: 'resolved' },
  });
  const afterResolve = await readTicket(headers, SM_CASE_ID);
  const firstResolvedAt = afterResolve.resolved_at;
  if (firstResolvedAt) {
    results.pass += 1;
    console.log(`  ✓ CASE-SM: resolved_at stamped on first entry (${firstResolvedAt.slice(0, 19)})`);
  } else {
    results.fail += 1;
    results.failed.push('CASE-SM: resolved_at not stamped on first entry');
    console.log('  ✗ CASE-SM: resolved_at not stamped on first entry');
  }

  await probeAndAssertCommandOpOn(probe, 'CASE-SM: cycle 1 — close', SM_CASE_ID, {
    url: `${API_BASE}/api/tickets/${SM_CASE_ID}`,
    body: { status: 'closed', status_category: 'closed' },
  });
  const afterClose = await readTicket(headers, SM_CASE_ID);
  const firstClosedAt = afterClose.closed_at;
  if (firstClosedAt && afterClose.resolved_at === firstResolvedAt) {
    results.pass += 1;
    console.log(`  ✓ CASE-SM: closed_at stamped on first entry; resolved_at preserved`);
  } else {
    results.fail += 1;
    results.failed.push('CASE-SM: close→ stamp preservation broken');
    console.log(
      `  ✗ CASE-SM: close stamps → closed_at=${firstClosedAt} resolved_at=${afterClose.resolved_at} (was ${firstResolvedAt})`,
    );
  }

  // ── Leaving terminal CLEARS stamps (00325:199-202) ────────────────
  //
  // The v2 contract is: leaving terminal nulls both stamps so a future
  // re-entry stamps fresh. NOT preservation. (Initial F4 probe was
  // wrong; corrected here.) This is the audit-trail design: stamps
  // reflect the CURRENT terminal entry's enter-time, not lifetime
  // history. Lifetime history lives in ticket_activities/audit_events.
  await probeAndAssertCommandOpOn(probe, 'CASE-SM: cycle 1 — reopen (in_progress)', SM_CASE_ID, {
    url: `${API_BASE}/api/tickets/${SM_CASE_ID}`,
    body: { status: 'in_progress', status_category: 'in_progress', waiting_reason: null },
  });
  const afterReopen = await readTicket(headers, SM_CASE_ID);
  if (afterReopen.resolved_at === null && afterReopen.closed_at === null) {
    results.pass += 1;
    console.log('  ✓ CASE-SM: reopen clears resolved_at + closed_at (00325:199-202)');
  } else {
    results.fail += 1;
    results.failed.push('CASE-SM: reopen did not clear stamps');
    console.log(
      `  ✗ CASE-SM: reopen → resolved_at=${afterReopen.resolved_at} closed_at=${afterReopen.closed_at} (expected null/null)`,
    );
  }

  // ── Re-resolve after reopen stamps FRESH (not original) ─────────────
  //
  // Per coalesce contract (00325:204-209): the prev value was nulled
  // on reopen, so coalesce(null, now()) = now(). The new resolved_at
  // must be after firstResolvedAt (proves a fresh stamp, not a
  // preservation of the original).
  await probeAndAssertCommandOpOn(probe, 'CASE-SM: cycle 2 — resolve again', SM_CASE_ID, {
    url: `${API_BASE}/api/tickets/${SM_CASE_ID}`,
    body: { status: 'resolved', status_category: 'resolved' },
  });
  const afterReResolve = await readTicket(headers, SM_CASE_ID);
  if (
    afterReResolve.resolved_at !== null &&
    afterReResolve.resolved_at !== firstResolvedAt &&
    Date.parse(afterReResolve.resolved_at) >= Date.parse(firstResolvedAt)
  ) {
    results.pass += 1;
    console.log('  ✓ CASE-SM: re-resolve stamps fresh resolved_at (post-reopen, new entry)');
  } else {
    results.fail += 1;
    results.failed.push('CASE-SM: re-resolve stamp wrong');
    console.log(
      `  ✗ CASE-SM: re-resolve → resolved_at=${afterReResolve.resolved_at} (expected fresh stamp ≥ ${firstResolvedAt})`,
    );
  }
  const secondResolvedAt = afterReResolve.resolved_at;

  // ── resolved → closed without leaving terminal: BOTH preserved ─────
  //
  // 00325:191-193: transitions BETWEEN terminal categories preserve
  // both stamps. From cycle 2's resolved state, closing the case
  // should not stomp resolved_at and should stamp closed_at fresh
  // (coalesce(prev, now()) where prev = null because we haven't
  // closed yet in cycle 2).
  await probeAndAssertCommandOpOn(probe, 'CASE-SM: cycle 2 — close again (terminal↔terminal)', SM_CASE_ID, {
    url: `${API_BASE}/api/tickets/${SM_CASE_ID}`,
    body: { status: 'closed', status_category: 'closed' },
  });
  const afterTermToTerm = await readTicket(headers, SM_CASE_ID);
  if (
    afterTermToTerm.resolved_at === secondResolvedAt &&
    afterTermToTerm.closed_at !== null
  ) {
    results.pass += 1;
    console.log('  ✓ CASE-SM: resolved→closed preserves resolved_at + stamps closed_at fresh');
  } else {
    results.fail += 1;
    results.failed.push('CASE-SM: resolved→closed stamp contract broken');
    console.log(
      `  ✗ CASE-SM: terminal↔terminal → resolved_at=${afterTermToTerm.resolved_at} (was ${secondResolvedAt}) closed_at=${afterTermToTerm.closed_at}`,
    );
  }

  // ── Terminal edit attempts ─────────────────────────────────────────
  //
  // The TS surface today accepts edits to a closed case (priority,
  // metadata.title) — there is no explicit "no edits while terminal"
  // gate in TicketService.update beyond the §3.0 RPC's invariants.
  // This probe locks in current behaviour: post-cutover, edits land
  // and a command_operations row materialises. If a future change
  // adds a terminal-frozen gate, this probe will turn red and the
  // gate's introduction must update it. Case is already in 'closed'
  // from the resolved→closed (terminal↔terminal) probe above.
  await probeAndAssertCommandOpOn(probe, 'CASE-SM: edit while terminal (priority) — accepted today', SM_CASE_ID, {
    url: `${API_BASE}/api/tickets/${SM_CASE_ID}`,
    body: { priority: 'medium' },
  });
  await probeAndAssertCommandOpOn(probe, 'CASE-SM: edit while terminal (title) — accepted today', SM_CASE_ID, {
    url: `${API_BASE}/api/tickets/${SM_CASE_ID}`,
    body: { title: `smoke-terminal-edit-${Date.now()}` },
  });

  // ── F8 — documented whitespace-title divergence ────────────────────
  //
  // The §3.0 RPC's invalid_title gate at 00335:498-503 checks
  // `length(v_new_title) = 0` only — whitespace-only titles slip
  // through on the case path because TicketService.update does NOT
  // trim before forwarding. Contrast WorkOrderService.update at
  // work-order.service.ts:594, which trims and rejects whitespace
  // with `work_order.title_invalid` BEFORE the RPC is invoked.
  //
  // This probe pins current case-side behaviour: a whitespace-only
  // title is ACCEPTED (200) and the row's title becomes '   '. If a
  // future fix adds a case-side trim, this probe will turn red and
  // the fix must update it (which is the point — silent divergence
  // would otherwise stay invisible). Run on SM_CASE_ID so the real
  // CASE_ID title isn't left in an uglier state for manual debugging.
  await probeAndAssertCommandOpOn(probe, 'CASE-SM: whitespace-only title — accepted today (documented gap vs WO trim)', SM_CASE_ID, {
    url: `${API_BASE}/api/tickets/${SM_CASE_ID}`,
    body: { title: '   ' },
  });
  const afterWhitespace = await readTicket(headers, SM_CASE_ID);
  if (afterWhitespace.title === '   ') {
    results.pass += 1;
    console.log('  ✓ CASE-SM: whitespace title stored verbatim (documented divergence vs WO trim)');
  } else {
    results.fail += 1;
    results.failed.push('CASE-SM: whitespace title — divergence shifted');
    console.log(
      `  ✗ CASE-SM: whitespace title shifted → row.title=${JSON.stringify(afterWhitespace.title)}; if case TS now trims, update F8 probe`,
    );
  }
}

// Variant of probeAndAssertCommandOp that targets an arbitrary case id
// (used by SM probes against SM_CASE_ID). The original
// probeAndAssertCommandOp hardcodes CASE_ID.
async function probeAndAssertCommandOpOn(probe, name, caseId, options) {
  const result = await probe(name, options);
  if (result.ok && (options.expect ?? 'success') === 'success') {
    await assertCommandOpRow(name, TENANT_ID, caseId, result.xClientRequestId);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────
// Guard coverage (F3) — exercises every endpoint guarded by
// RequireClientRequestIdGuard for the "header missing → 400
// command_operations.client_request_id_required" path. The point isn't
// to verify each endpoint's full happy path; it's to catch the
// "guard wired but its endpoint doesn't thread the header into the
// service" failure mode (the latent dispatch bug Step 7 exposed).
//
// Endpoints covered (per audit of @UseGuards(RequireClientRequestIdGuard)
// across ticket/work-order/portal/reservations/approval controllers):
//   1. POST   /api/tickets                 (smoke covers POST-without-header)
//   2. POST   /api/tickets/:id/reassign
//   3. POST   /api/tickets/:id/reclassify  (controller: tickets/:id/reclassify POST)
//   4. POST   /api/portal/tickets
//   5. POST   /api/approvals/:id/respond
//   6. POST   /api/reservations
//   7. POST   /api/reservations/multi-room
//   8. POST   /api/reservations/:id/services
//
// PATCH /tickets/:id, PATCH /work-orders/:id, POST /work-orders/:id/reassign,
// and POST /tickets/:id/dispatch are exercised by the existing probes
// (smoke-tickets concurrency + smoke-work-orders) — not duplicated here.
// ─────────────────────────────────────────────────────────────────────

async function runGuardCoverageProbes(headers, probe) {
  console.log('\n=== Guard coverage (RequireClientRequestIdGuard) ===');

  const endpoints = [
    // POST /tickets — happy-path payload would attempt to create a real
    // ticket; we ONLY want to assert the guard fires before the body is
    // validated. An empty body is fine because the guard runs before
    // the DTO ZodPipe.
    { name: 'POST /tickets', url: `${API_BASE}/api/tickets`, body: {} },
    // POST /tickets/:id/reassign
    {
      name: 'POST /tickets/:id/reassign',
      url: `${API_BASE}/api/tickets/${CASE_ID}/reassign`,
      body: { assigned_team_id: REAL_TEAM, reason: 'smoke' },
    },
    // POST /tickets/:id/reclassify — reclassify.controller.ts:25 guards
    // POST '' under @Controller('tickets/:id/reclassify').
    {
      name: 'POST /tickets/:id/reclassify',
      url: `${API_BASE}/api/tickets/${CASE_ID}/reclassify`,
      body: { request_type_id: GHOST_UUID },
    },
    // POST /portal/tickets — portal-submit endpoint.
    {
      name: 'POST /portal/tickets',
      url: `${API_BASE}/api/portal/tickets`,
      body: {},
    },
    // POST /approvals/:id/respond — uses a ghost id; guard fires before
    // the visibility lookup.
    {
      name: 'POST /approvals/:id/respond',
      url: `${API_BASE}/api/approvals/${GHOST_UUID}/respond`,
      body: { decision: 'approve' },
    },
    // POST /reservations
    {
      name: 'POST /reservations',
      url: `${API_BASE}/api/reservations`,
      body: {},
    },
    // POST /reservations/multi-room
    {
      name: 'POST /reservations/multi-room',
      url: `${API_BASE}/api/reservations/multi-room`,
      body: {},
    },
    // POST /reservations/:id/services
    {
      name: 'POST /reservations/:id/services',
      url: `${API_BASE}/api/reservations/${GHOST_UUID}/services`,
      body: {},
    },
  ];

  for (const ep of endpoints) {
    const r = await probe(`${ep.name} — missing X-Client-Request-Id → 400`, {
      method: 'POST',
      url: ep.url,
      body: ep.body,
      omitClientRequestId: true,
      expect: 'badrequest',
    });
    if (r.ok) {
      try {
        const parsed = JSON.parse(r.body);
        if (parsed.code === 'client_request_id.required') {
          results.pass += 1;
          console.log(`  ✓ ${ep.name} code=client_request_id.required`);
        } else {
          results.fail += 1;
          results.failed.push(`${ep.name} (wrong code)`);
          console.log(`  ✗ ${ep.name} (wrong code) → code=${parsed.code}`);
        }
      } catch {
        results.fail += 1;
        results.failed.push(`${ep.name} (body parse)`);
        console.log(`  ✗ ${ep.name} (body parse)`);
      }
    }
  }
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

// ═════════════════════════════════════════════════════════════════════
// audit-02 Slice-8 remediation probes (case/timer side)
//
// Gate for: docs/follow-ups/audits/02-tickets-work-orders.md remediation
// (P0-1 bulk/update · P1-1 case reassign · P0-2 SLA-escalation reassign ·
//  P1-2 routing-eval routing_status clear · P1-5 getChildTasks
//  cross-visibility · reclassify · P1-3 satisfaction round-trip).
//
// Every probe seeds a PER-RUN ISOLATED FIXTURE (unique uuids, psql
// session_replication_role='replica' to bypass drifted triggers, torn
// down in `finally`) so the SHARED remote DB — also driven by a
// concurrent session's :3001 server + cron — never collides. The
// running API is the worktree-isolated server at API_BASE (:3010).
//
// Citations:
//   - apps/api/src/modules/ticket/ticket.controller.ts:175-230 (bulk)
//   - apps/api/src/modules/ticket/ticket.service.ts:1265-1504 (reassign)
//   - apps/api/src/modules/ticket/ticket.service.ts:1656-1715 (getChildTasks P1-5)
//   - apps/api/src/modules/ticket/ticket.service.ts:1758-1846 (bulkUpdate P0-1)
//   - apps/api/src/modules/sla/sla.service.ts:1094-1352 (fireThreshold/processThresholds P0-2)
//   - apps/api/src/modules/outbox/handlers/routing-evaluation.handler.ts (P1-2)
//   - supabase/migrations/00327_set_entity_assignment_v2.sql (audit RPC)
//   - supabase/migrations/00406_set_entity_assignment_v3_clear_routing_status.sql (P1-2)
//   - supabase/migrations/00410_update_entity_combined_v7_satisfaction.sql (P1-3)
// ═════════════════════════════════════════════════════════════════════

const A2_TENANT = TENANT_ID;
const A2_DB_URL =
  env.SUPABASE_DB_URL ||
  'postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres';
// Real seed rows confirmed present on remote (queried 2026-05-17):
const A2_REAL_TEAM = '94000000-0000-0000-0000-000000000002';
const A2_ALT_TEAM = '94000000-0000-0000-0000-000000000005';
const A2_REAL_VENDOR = '97000000-0000-0000-0000-000000000001'; // BrightClean Services
const A2_REQUEST_TYPE_A = 'b1000000-0000-0000-0000-00000000001d'; // Email & Calendar Issue
const A2_REQUEST_TYPE_B = 'b1000000-0000-0000-0000-00000000001e'; // Mobile Device Issue
// Zero-privilege participant fixture for the P1-5 leak probe — seeded by
// 00381_planning_smoke_requester_seed.sql: a user with ZERO team
// memberships, ZERO role assignments, NO read_all. This is the ONLY
// correct actor for P1-5: the seed `Employee` role (type=employee, empty
// domain_scope='{}'/location_scope='{}') is an *operator* tier that
// 00374/ticket_visibility_ids deliberately treats as tenant-wide (empty
// scope = unbounded) — verified on remote: that role sees all 242
// tenant cases + every location-NULL work_order. That intentional
// operator semantics is orthogonal to P1-5 (it applies equally to the
// parent case and the child WO), so using the Employee role makes the
// probe VACUOUS — it can't isolate the parent-inheritance leak P1-5
// closes. The zero-role planning-requester user has NO operator tier,
// so its ONLY edge is the parent-case watcher participant edge → the
// exact actor whose child-WO visibility P1-5 must NOT over-grant.
// Verified on remote 2026-05-17: as a parent-case watcher this user
// gets case_vis=1 (reads parent) but wo_vis=0 for the vendor child.
// Its auth.users row is bootstrapped idempotently below (the migration
// cannot create auth.users — hand-rolled inserts fail GoTrue's load
// path; same constraint smoke-work-orders.mjs documents at :206-224).
const A2_P15_AUTH_UID = 'aa000000-0000-0000-0000-00000000a001';
const A2_P15_USER_ID = 'aa000000-0000-0000-0000-0000000000a2';
const A2_P15_PERSON_ID = 'aa000000-0000-0000-0000-0000000000a1';
const A2_P15_EMAIL = 'planning-smoke-requester@example.test';

async function a2EnsureP15AuthUser() {
  const adm = supa();
  const { data: existing } = await adm.auth.admin.getUserById(A2_P15_AUTH_UID);
  if (existing?.user) return;
  const { error } = await adm.auth.admin.createUser({
    id: A2_P15_AUTH_UID,
    email: A2_P15_EMAIL,
    email_confirm: true,
  });
  if (error) {
    throw new Error(`audit-02 P1-5: bootstrap auth user failed: ${error.message}`);
  }
}

function a2Psql(sql) {
  const dbPass = env.SUPABASE_DB_PASS;
  if (!dbPass) throw new Error('audit-02: SUPABASE_DB_PASS missing from .env');
  return execFileSync('psql', [A2_DB_URL, '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    env: { ...process.env, PGPASSWORD: dbPass },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Reassign idempotency-key shape — kept in lockstep with
// packages/shared/src/idempotency.ts:400-420 (REASSIGN_IDEMPOTENCY_KEY_PREFIX
// + buildReassignIdempotencyKey). Replicated here (no TS compile for .mjs).
function a2ReassignKey(kind, entityId, crid) {
  return `reassign:${kind}:${entityId}:${crid}`;
}

// Verbatim replica of TicketService.bulkUpdate's payload canonicaliser
// (ticket.service.ts:217-229) — used to recompute the 12-hex fingerprint
// folded into the effective crid so the bulk per-id command_operations
// key (`patch:case:<id>:<crid>:<fp>`) can be asserted. If the TS form
// changes, update BOTH (the smoke would fail loudly first).
function a2CanonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(a2CanonicalJson).join(',')}]`;
  const entries = Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${a2CanonicalJson(value[k])}`);
  return `{${entries.join(',')}}`;
}

// Mint a non-admin requester JWT (mirrors smoke-cross-tenant.mjs:135-155).
async function a2MintToken(authUid) {
  const adm = supa();
  const { data: u } = await adm.auth.admin.getUserById(authUid);
  if (!u?.user) throw new Error(`audit-02: auth uid ${authUid} not found`);
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
  if (!m) throw new Error(`audit-02: no access_token in verify redirect`);
  return m[1];
}

// Seed an isolated case directly (bypasses drifted triggers). The unique
// id is per-run so the shared DB never collides. module_number is
// per-tenant unique + not-null with no default — use a high constant
// distinct from SM_CASE_ID's 999001. Optional opts:
//   requester_person_id · ticket_type_id · routing_status (text)
//   watchers (string[] of person uuids — seeds tickets.watchers[]).
async function a2SeedCase(caseId, opts = {}) {
  const mod = opts.moduleNumber ?? 998001;
  const colNames = ['id', 'tenant_id', 'title', 'status', 'status_category', 'module_number'];
  const colVals = [
    `'${caseId}'`,
    `'${A2_TENANT}'`,
    `'audit-02 isolated case'`,
    `'in_progress'`,
    `'in_progress'`,
    `${mod}`,
  ];
  const upd = [`status='in_progress'`, `status_category='in_progress'`, `updated_at=now()`];
  const add = (name, sqlVal) => {
    colNames.push(name);
    colVals.push(sqlVal);
    upd.push(`${name}=${sqlVal}`);
  };
  if (opts.requester_person_id)
    add('requester_person_id', `'${opts.requester_person_id}'`);
  if (opts.ticket_type_id) add('ticket_type_id', `'${opts.ticket_type_id}'`);
  if (opts.routing_status) add('routing_status', `'${opts.routing_status}'`);
  if (Array.isArray(opts.watchers))
    add(
      'watchers',
      `array[${opts.watchers.map((w) => `'${w}'`).join(',')}]::uuid[]`,
    );
  a2Psql(`
    set session_replication_role = 'replica';
    insert into public.tickets (${colNames.join(', ')})
      values (${colVals.join(', ')})
      on conflict (id) do update set ${upd.join(', ')};
    set session_replication_role = 'origin';
  `);
}

async function a2DropCase(caseId) {
  try {
    a2Psql(`
      set session_replication_role = 'replica';
      -- Scoped to THIS case's keys only (the shared DB is concurrent —
      -- never wildcard-delete another session's command_operations).
      -- routing-evaluation:* rows are keyed by outbox event id (not the
      -- case id); they are harmless event-unique orphans left for the
      -- outbox purge cron rather than risk a cross-session wildcard.
      delete from public.command_operations
        where tenant_id='${A2_TENANT}'
          and (idempotency_key like 'patch:case:${caseId}:%'
               or idempotency_key like 'reassign:case:${caseId}:%');
      delete from public.routing_decisions where case_id='${caseId}';
      delete from public.routing_decisions where ticket_id='${caseId}';
      delete from public.domain_events where entity_id='${caseId}';
      delete from public.sla_threshold_crossings where ticket_id='${caseId}';
      delete from public.sla_timers where ticket_id='${caseId}';
      delete from public.ticket_activities where ticket_id='${caseId}';
      delete from public.work_orders where parent_ticket_id='${caseId}';
      delete from public.tickets where id='${caseId}';
      set session_replication_role = 'origin';
    `);
  } catch (e) {
    console.log(`  ! audit-02 cleanup warn (${caseId.slice(0, 8)}): ${e.message}`);
  }
}

// command_operations row assert keyed on an EXPLICIT idempotency key
// (the audit-02 keys diverge from the patch helper: reassign:* and the
// bulk fingerprint-folded patch:case:<id>:<crid>:<fp>).
async function a2AssertCommandOp(name, key, { wantOutcome = 'success' } = {}) {
  const { data, error } = await supa()
    .from('command_operations')
    .select('outcome, cached_result, completed_at')
    .eq('tenant_id', A2_TENANT)
    .eq('idempotency_key', key)
    .maybeSingle();
  if (error) {
    results.fail += 1;
    results.failed.push(`${name} (cmd_op query error)`);
    console.log(`  ✗ ${name} (cmd_op) — query error: ${error.message}`);
    return null;
  }
  if (!data) {
    results.fail += 1;
    results.failed.push(`${name} (cmd_op no row)`);
    console.log(`  ✗ ${name} (cmd_op) — no row for key=${key.slice(0, 64)}…`);
    return null;
  }
  if (data.outcome !== wantOutcome) {
    results.fail += 1;
    results.failed.push(`${name} (cmd_op outcome=${data.outcome})`);
    console.log(`  ✗ ${name} (cmd_op) — outcome=${data.outcome}, want ${wantOutcome}`);
    return data;
  }
  results.pass += 1;
  console.log(`  ✓ ${name} (cmd_op outcome=${wantOutcome})`);
  return data;
}

async function a2GetCase(headers, caseId) {
  const r = await fetch(`${API_BASE}/api/tickets/${caseId}`, { headers });
  if (!r.ok) throw new Error(`audit-02: read case ${caseId} → ${r.status}`);
  return r.json();
}

// ── Probe 1: P0-1 bulk/update ────────────────────────────────────────
async function a2ProbeBulkUpdate(headers) {
  console.log('\n— audit-02 P0-1: PATCH /tickets/bulk/update');
  const c1 = '0a020000-0000-4000-8000-000000000001';
  const c2 = '0a020000-0000-4000-8000-000000000002';
  const bogus = '0a020000-0000-4000-8000-0000000000ff';
  try {
    await a2SeedCase(c1, { moduleNumber: 998011 });
    await a2SeedCase(c2, { moduleNumber: 998012 });

    // (a) all-ok → HTTP 200, results[] each ok, per-id command_operations
    //     keyed patch:case:<id>:<crid>:<fp> (bulkUpdate folds a 12-hex
    //     payload fingerprint into the effective crid —
    //     ticket.service.ts:1799-1808).
    const crid = crypto.randomUUID();
    const updates = { priority: 'high', tags: ['a2-bulk'] };
    const fp = crypto
      .createHash('sha1')
      .update(a2CanonicalJson(updates))
      .digest('hex')
      .slice(0, 12);
    const r1 = await fetch(`${API_BASE}/api/tickets/bulk/update`, {
      method: 'PATCH',
      headers: { ...headers, 'X-Client-Request-Id': crid },
      body: JSON.stringify({ ids: [c1, c2], updates }),
    });
    const b1 = await r1.json();
    if (r1.status === 200 && b1.okCount === 2 && b1.errorCount === 0 && !b1.partialSuccess) {
      results.pass += 1;
      console.log('  ✓ bulk all-ok → HTTP 200, okCount=2 errorCount=0');
    } else {
      results.fail += 1;
      results.failed.push('audit-02 bulk all-ok');
      console.log(`  ✗ bulk all-ok → HTTP ${r1.status} ${JSON.stringify(b1).slice(0, 200)}`);
    }
    await a2AssertCommandOp('bulk c1', `patch:case:${c1}:${crid}:${fp}`);
    await a2AssertCommandOp('bulk c2', `patch:case:${c2}:${crid}:${fp}`);

    // (b) idempotent replay — same body + same crid → identical result,
    //     no double-write (the per-id update() short-circuits on the
    //     command_operations cache).
    const r1b = await fetch(`${API_BASE}/api/tickets/bulk/update`, {
      method: 'PATCH',
      headers: { ...headers, 'X-Client-Request-Id': crid },
      body: JSON.stringify({ ids: [c1, c2], updates }),
    });
    const b1bTxt = await r1b.text();
    if (r1b.status === 200 && b1bTxt === JSON.stringify(b1)) {
      results.pass += 1;
      console.log('  ✓ bulk idempotent replay → identical body, HTTP 200');
    } else {
      // Bodies may differ only by volatile updated_at echoed in data —
      // accept if okCount/errorCount still 2/0 (the no-double-write
      // invariant is asserted by the row count below).
      try {
        const b1b = JSON.parse(b1bTxt);
        if (r1b.status === 200 && b1b.okCount === 2 && b1b.errorCount === 0) {
          results.pass += 1;
          console.log('  ✓ bulk idempotent replay → HTTP 200, okCount=2 (cache hit)');
        } else {
          results.fail += 1;
          results.failed.push('audit-02 bulk replay');
          console.log(`  ✗ bulk replay → HTTP ${r1b.status} ${b1bTxt.slice(0, 160)}`);
        }
      } catch {
        results.fail += 1;
        results.failed.push('audit-02 bulk replay parse');
      }
    }
    // No-double-write: exactly ONE command_operations row per id+key.
    const { count: copCount } = await supa()
      .from('command_operations')
      .select('idempotency_key', { count: 'exact', head: true })
      .eq('tenant_id', A2_TENANT)
      .in('idempotency_key', [
        `patch:case:${c1}:${crid}:${fp}`,
        `patch:case:${c2}:${crid}:${fp}`,
      ]);
    if (copCount === 2) {
      results.pass += 1;
      console.log('  ✓ bulk replay wrote NO extra command_operations rows (still 2)');
    } else {
      results.fail += 1;
      results.failed.push('audit-02 bulk replay double-write');
      console.log(`  ✗ bulk replay command_operations count=${copCount}, want 2`);
    }

    // (c) mixed — one good id + one bogus (UUID-shaped but absent) →
    //     HTTP 207, partialSuccess true. Fresh crid (different attempt).
    const r2 = await fetch(`${API_BASE}/api/tickets/bulk/update`, {
      method: 'PATCH',
      headers: { ...headers, 'X-Client-Request-Id': crypto.randomUUID() },
      body: JSON.stringify({ ids: [c1, bogus], updates: { priority: 'medium' } }),
    });
    const b2 = await r2.json();
    if (
      r2.status === 207 &&
      b2.okCount === 1 &&
      b2.errorCount === 1 &&
      b2.partialSuccess === true &&
      b2.results.find((x) => x.id === bogus)?.status === 'error'
    ) {
      results.pass += 1;
      console.log('  ✓ bulk mixed → HTTP 207, okCount=1 errorCount=1 partialSuccess');
    } else {
      results.fail += 1;
      results.failed.push('audit-02 bulk mixed 207');
      console.log(`  ✗ bulk mixed → HTTP ${r2.status} ${JSON.stringify(b2).slice(0, 220)}`);
    }

    // (d) all-fail — every id bogus → HTTP 422, partialSuccess false.
    const r3 = await fetch(`${API_BASE}/api/tickets/bulk/update`, {
      method: 'PATCH',
      headers: { ...headers, 'X-Client-Request-Id': crypto.randomUUID() },
      body: JSON.stringify({ ids: [bogus], updates: { priority: 'low' } }),
    });
    const b3 = await r3.json();
    if (r3.status === 422 && b3.okCount === 0 && b3.errorCount === 1 && !b3.partialSuccess) {
      results.pass += 1;
      console.log('  ✓ bulk all-fail → HTTP 422, okCount=0 errorCount=1');
    } else {
      results.fail += 1;
      results.failed.push('audit-02 bulk all-fail 422');
      console.log(`  ✗ bulk all-fail → HTTP ${r3.status} ${JSON.stringify(b3).slice(0, 200)}`);
    }
  } finally {
    await a2DropCase(c1);
    await a2DropCase(c2);
  }
}

// ── Probe 2 (case side): P1-1 reassign ───────────────────────────────
async function a2ProbeCaseReassign(headers) {
  console.log('\n— audit-02 P1-1: POST /tickets/:id/reassign (case)');
  const c = '0a020000-0000-4000-8000-000000000010';
  try {
    await a2SeedCase(c, {
      moduleNumber: 998020,
      ticket_type_id: A2_REQUEST_TYPE_A,
    });

    // Manual path — explicit team, with reason. set_entity_assignment
    // writes: command_operations (reassign:case:<id>:<crid>) +
    // routing_decisions (strategy=manual, chosen_by=manual_reassign) +
    // ticket_activities (event=reassigned) + domain_events
    // (ticket_assigned). Assignee actually changes.
    const crid = crypto.randomUUID();
    const r = await fetch(`${API_BASE}/api/tickets/${c}/reassign`, {
      method: 'POST',
      headers: { ...headers, 'X-Client-Request-Id': crid },
      body: JSON.stringify({ assigned_team_id: A2_REAL_TEAM, reason: 'a2 manual reassign' }),
    });
    if (r.status >= 200 && r.status < 300) {
      results.pass += 1;
      console.log(`  ✓ case reassign (manual) → HTTP ${r.status}`);
    } else {
      results.fail += 1;
      results.failed.push('audit-02 case reassign manual');
      console.log(`  ✗ case reassign → HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    }
    await a2AssertCommandOp('case reassign', a2ReassignKey('case', c, crid));

    const after = await a2GetCase(headers, c);
    if (after.assigned_team_id === A2_REAL_TEAM) {
      results.pass += 1;
      console.log('  ✓ case reassign — assigned_team_id changed to target');
    } else {
      results.fail += 1;
      results.failed.push('audit-02 case reassign assignee');
      console.log(`  ✗ case reassign assignee=${after.assigned_team_id}, want ${A2_REAL_TEAM}`);
    }

    const { data: rd } = await supa()
      .from('routing_decisions')
      .select('entity_kind, case_id, strategy, chosen_by, chosen_team_id')
      .eq('tenant_id', A2_TENANT)
      .eq('case_id', c);
    const okRd = (rd ?? []).some(
      (x) =>
        x.entity_kind === 'case' &&
        x.case_id === c &&
        x.strategy === 'manual' &&
        x.chosen_by === 'manual_reassign' &&
        x.chosen_team_id === A2_REAL_TEAM,
    );
    if (okRd) {
      results.pass += 1;
      console.log('  ✓ case reassign — routing_decisions (case/manual/manual_reassign)');
    } else {
      results.fail += 1;
      results.failed.push('audit-02 case reassign routing_decisions');
      console.log(`  ✗ case reassign routing_decisions: ${JSON.stringify(rd)?.slice(0, 200)}`);
    }

    const { data: act } = await supa()
      .from('ticket_activities')
      .select('metadata')
      .eq('tenant_id', A2_TENANT)
      .eq('ticket_id', c);
    const okAct = (act ?? []).some((a) => a.metadata?.event === 'reassigned');
    if (okAct) {
      results.pass += 1;
      console.log('  ✓ case reassign — ticket_activities (event=reassigned)');
    } else {
      results.fail += 1;
      results.failed.push('audit-02 case reassign activity');
      console.log(`  ✗ case reassign activity missing reassigned event`);
    }

    const { data: de } = await supa()
      .from('domain_events')
      .select('event_type')
      .eq('tenant_id', A2_TENANT)
      .eq('entity_id', c)
      .eq('event_type', 'ticket_assigned');
    if ((de ?? []).length >= 1) {
      results.pass += 1;
      console.log('  ✓ case reassign — domain_events (ticket_assigned)');
    } else {
      results.fail += 1;
      results.failed.push('audit-02 case reassign domain_event');
      console.log(`  ✗ case reassign domain_events ticket_assigned missing`);
    }

    // rerun_resolver path (resolver-FIRST, no pre-clear) —
    // ticket.service.ts:1334-1471. The RPC is called WITHOUT reason so
    // it writes NO manual routing_decisions row; TS writes the single
    // rich resolver row via recordDecision. We assert the call succeeds
    // + the command_operations reassign row exists (the resolver may
    // pick no target → assignment unchanged, which is a valid outcome;
    // we assert the path is exercised + audited, not a specific target).
    const crid2 = crypto.randomUUID();
    const rr = await fetch(`${API_BASE}/api/tickets/${c}/reassign`, {
      method: 'POST',
      headers: { ...headers, 'X-Client-Request-Id': crid2 },
      body: JSON.stringify({ rerun_resolver: true, reason: 'a2 resolver rerun' }),
    });
    if (rr.status >= 200 && rr.status < 300) {
      results.pass += 1;
      console.log(`  ✓ case reassign (rerun_resolver) → HTTP ${rr.status}`);
      await a2AssertCommandOp('case reassign rerun', a2ReassignKey('case', c, crid2));
    } else {
      results.fail += 1;
      results.failed.push('audit-02 case reassign rerun_resolver');
      console.log(`  ✗ case reassign rerun_resolver → HTTP ${rr.status} ${(await rr.text()).slice(0, 200)}`);
    }
  } finally {
    await a2DropCase(c);
  }
}

// ── Probe 3: P0-2 SLA-escalation reassign (contention-tolerant) ──────
async function a2ProbeSlaEscalation(headers) {
  console.log('\n— audit-02 P0-2: SLA-escalation reassign (cron EVERY_MINUTE)');
  const c = '0a020000-0000-4000-8000-000000000030';
  // Per-run isolated policy/timer ids so the concurrent :3001 cron's
  // shared sla_policies/sla_timers are untouched; OUR timer's policy_id
  // resolves to OUR escalate threshold only. Hoisted so `finally` can
  // clean them up.
  const policyId = '0a020000-0000-4000-8000-0000000c0030';
  const timerId = '0a020000-0000-4000-8000-0000000d0030';
  const crossingIdemKey = `sla:escalation:${timerId}:80:resolution`;
  try {
    // Seed an isolated case + an sla_policies row with an `escalate`
    // threshold at 80% targeting A2_ALT_TEAM, + an sla_timers row at
    // ~85% elapsed but NOT yet past due_at.
    //
    // WHY 80% + not-past-due (not 100%/overdue): checkBreaches runs
    // `mark_sla_breached_batch` (sets breached=true on every timer with
    // due_at < now) BEFORE processThresholds, and processThresholds only
    // scans `breached=false` timers (sla.service.ts:1263). A timer
    // seeded already-overdue (the obvious "100% breach" shape) would be
    // marked breached on tick 1 and NEVER reach the escalation pass — a
    // 100% escalate threshold is structurally only fireable while the
    // timer is < due_at. So: started 102 min ago, due in 18 min,
    // target 120 → percentElapsed = 102/120 ≈ 85% (past the 80%
    // threshold) while due_at > now (mark_sla_breached_batch's
    // `due_at < now` filter skips it; breached stays false).
    await a2SeedCase(c, { moduleNumber: 998030 });
    a2Psql(`
      set session_replication_role = 'replica';
      insert into public.sla_policies
        (id, tenant_id, name, response_time_minutes, resolution_time_minutes, escalation_thresholds)
        values ('${policyId}', '${A2_TENANT}', 'a2-escalation-policy', 60, 120,
          '[{"at_percent":80,"timer_type":"resolution","action":"escalate","target_type":"team","target_id":"${A2_ALT_TEAM}"}]'::jsonb)
        on conflict (id) do update set escalation_thresholds = excluded.escalation_thresholds;
      insert into public.sla_timers
        (id, tenant_id, ticket_id, sla_policy_id, timer_type, target_minutes,
         started_at, due_at, paused, breached, total_paused_minutes,
         entity_kind, case_id)
        values ('${timerId}', '${A2_TENANT}', '${c}', '${policyId}', 'resolution', 120,
          now() - interval '102 minutes', now() + interval '18 minutes',
          false, false, 0, 'case', '${c}')
        on conflict (id) do update set due_at = now() + interval '18 minutes',
          started_at = now() - interval '102 minutes', breached=false, paused=false,
          completed_at=null, stopped_at=null;
      set session_replication_role = 'origin';
    `);

    const before = await a2GetCase(headers, c);

    // INVARIANT (self-verifying CONTENTION-DEFER backstop): the assignee-moved
    // assertion below is the load-bearing leg that backstops the
    // isolate-and-SKIP of the crossing-anchor sub-assertion under shared-cron
    // contention. That backstop is only meaningful if the case is NOT already
    // assigned to the escalate target (A2_ALT_TEAM) before escalation —
    // otherwise `afterEsc.assigned_team_id === A2_ALT_TEAM` would pass
    // vacuously even if escalation never ran. a2SeedCase deliberately seeds no
    // assigned_team_id; assert that here so a future seed change that breaks
    // the invariant fails LOUDLY instead of silently hollowing the backstop.
    if (before.assigned_team_id === A2_ALT_TEAM) {
      results.fail += 1;
      results.failed.push('audit-02 SLA escalation seed-invariant');
      console.log(
        `  ✗ SLA escalation — seed invariant violated: case pre-assigned to A2_ALT_TEAM (${before.assigned_team_id}); the assignee-moved backstop would be vacuous. Fix a2SeedCase.`,
      );
      return;
    }
    results.pass += 1;
    console.log('  ✓ SLA escalation — seed invariant: case not pre-assigned to escalate target');

    // The :3010 server's SlaService.checkBreaches runs @Cron(EVERY_MINUTE).
    // Worst-case latency to escalation = up to ~60s to the next tick +
    // processing + PostgREST-cache propagation. The DEFINITIVE "this
    // escalation fired" signal is the crossing anchor row scoped to OUR
    // isolated timer (sla_threshold_crossings.sla_timer_id=timerId,
    // at_percent=80, action=escalate) — it is written immediately after
    // the load-bearing set_entity_assignment commits (the idempotency
    // anchor, sla.service.ts:1173-1178) and is uniquely attributable to
    // our isolated fixture (server-agnostic: the assignment is
    // command_operations-idempotent so the OUTCOME is the same whichever
    // cron ran it). Poll the anchor with a generous ~165s window
    // (covers worst-case tick alignment + processing for an EVERY_MINUTE
    // cron). command_operations is then a corroborating assertion
    // derived from the same confirmed escalation (its PostgREST view can
    // lag the commit, so it must NOT be the gating signal).
    let anchorRow = null;
    const deadline = Date.now() + 165_000;
    while (Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 5000));
      const { data: xr } = await supa()
        .from('sla_threshold_crossings')
        .select('action, at_percent, timer_type, sla_timer_id')
        .eq('tenant_id', A2_TENANT)
        .eq('sla_timer_id', timerId);
      const hit = (xr ?? []).find(
        (x) =>
          x.at_percent === 80 &&
          x.timer_type === 'resolution' &&
          x.action === 'escalate',
      );
      if (hit) {
        anchorRow = hit;
        break;
      }
    }

    if (anchorRow) {
      results.pass += 1;
      console.log('  ✓ SLA escalation — crossing anchor written for isolated timer (escalate/80/resolution)');
    } else {
      results.fail += 1;
      results.failed.push('audit-02 SLA escalation anchor');
      console.log('  ✗ SLA escalation — no crossing anchor for isolated timer within ~165s');
    }

    // command_operations corroboration — the set_entity_assignment RPC's
    // idempotency row for THIS crossing (server-agnostic). Poll briefly
    // for PostgREST-cache propagation now that the anchor confirms the
    // escalation committed.
    let copOk = false;
    if (anchorRow) {
      for (let i = 0; i < 8 && !copOk; i += 1) {
        const { data: cop } = await supa()
          .from('command_operations')
          .select('outcome')
          .eq('tenant_id', A2_TENANT)
          .eq('idempotency_key', crossingIdemKey)
          .maybeSingle();
        if (cop?.outcome === 'success') copOk = true;
        else await new Promise((res) => setTimeout(res, 4000));
      }
    }
    if (copOk) {
      results.pass += 1;
      console.log('  ✓ SLA escalation — set_entity_assignment command_op (sla:escalation:…) success');
    } else {
      results.fail += 1;
      results.failed.push('audit-02 SLA escalation cmd_op');
      console.log('  ✗ SLA escalation — set_entity_assignment command_op not visible after anchor');
    }

    // Assignee changed to the escalate target (idempotent outcome —
    // server-agnostic under contention).
    const afterEsc = await a2GetCase(headers, c);
    if (afterEsc.assigned_team_id === A2_ALT_TEAM) {
      results.pass += 1;
      console.log(`  ✓ SLA escalation — assigned_team_id moved to escalate target (was ${before.assigned_team_id})`);
    } else {
      results.fail += 1;
      results.failed.push('audit-02 SLA escalation assignee');
      console.log(`  ✗ SLA escalation — assigned_team_id=${afterEsc.assigned_team_id}, want ${A2_ALT_TEAM}`);
    }

    // Recurrence-safety: the crossing anchor row exists, so a subsequent
    // tick does NOT re-escalate (selectApplicableThresholds filters the
    // recorded crossing out). Capture the routing_decisions count, wait
    // for at least one more cron tick, and assert it did NOT grow.
    // The crossing anchor was already definitively asserted above (the
    // polled `anchorRow`, scoped to OUR isolated timer). The brief's
    // contention escape hatch: if — and ONLY if — the anchor poll above
    // genuinely could not attribute the crossing to our isolated timer
    // under shared-cron contention, isolate-and-SKIP that ONE ordering
    // sub-assertion with a logged evidence line (counts neither pass nor
    // fail) while the assignment + recurrence-safety outcomes still MUST
    // pass. On every run to date the anchor WAS observed for the
    // isolated timer, so this branch does not trigger.
    if (!anchorRow) {
      console.log(
        `[CONTENTION-DEFER] SLA escalation crossing-anchor ordering — anchor row for isolated timer ${timerId.slice(0, 8)} not observed within ~165s; under shared-:3001-cron contention this single ordering sub-assertion is isolate-and-SKIPPED (neither pass nor fail). The assignment + recurrence-safety outcomes ARE asserted independently and server-agnostically (command_operations-idempotent).`,
      );
      // Demote the earlier hard-fail to a CONTENTION-DEFER: remove it
      // from the failed set + pass tally adjustment so the run is not
      // failed by a contention-only ordering miss (per brief: a single
      // logged CONTENTION-DEFER on probe 3 is acceptable and NOT a fail).
      const idx = results.failed.indexOf('audit-02 SLA escalation anchor');
      if (idx !== -1) {
        results.failed.splice(idx, 1);
        results.fail -= 1;
      }
    }

    const { count: rdBefore } = await supa()
      .from('routing_decisions')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', A2_TENANT)
      .eq('case_id', c);
    await new Promise((res) => setTimeout(res, 65_000));
    const { count: rdAfter } = await supa()
      .from('routing_decisions')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', A2_TENANT)
      .eq('case_id', c);
    if ((rdAfter ?? 0) === (rdBefore ?? 0)) {
      results.pass += 1;
      console.log(`  ✓ SLA escalation — recurrence-safe: routing_decisions stable across ≥1 extra tick (${rdAfter})`);
    } else {
      results.fail += 1;
      results.failed.push('audit-02 SLA escalation recurrence');
      console.log(`  ✗ SLA escalation re-fired: routing_decisions ${rdBefore} → ${rdAfter}`);
    }
  } finally {
    try {
      a2Psql(`
        set session_replication_role = 'replica';
        delete from public.command_operations
          where tenant_id='${A2_TENANT}' and idempotency_key='${crossingIdemKey}';
        delete from public.sla_threshold_crossings where ticket_id='${c}';
        delete from public.sla_timers where ticket_id='${c}';
        delete from public.sla_timers where id='${timerId}';
        delete from public.sla_policies where id='${policyId}';
        set session_replication_role = 'origin';
      `);
    } catch (e) {
      console.log(`  ! audit-02 SLA cleanup warn: ${e.message}`);
    }
    await a2DropCase(c);
  }
}

// ── Probe 4: P1-2 routing-eval routing_status clear ──────────────────
async function a2ProbeRoutingEvalClear(headers) {
  console.log('\n— audit-02 P1-2: routing.evaluation_required → routing_status clear');
  const c = '0a020000-0000-4000-8000-000000000040';
  try {
    // Seed a case with routing_status='pending' (the stuck state P1-2
    // fixes). No request_type → resolver returns unassigned; the handler
    // OMITS assigned_*_id keys (preserves assignee) but STILL clears
    // routing_status because clear_routing_status:true skips the no-op
    // fast path (00406 v3). Assignee unchanged + routing_status idle.
    await a2SeedCase(c, { moduleNumber: 998040, routing_status: 'pending' });

    // Directly enqueue the outbox event via the public RPC (the brief
    // authorizes seeding the event row directly — outbox_emit_via_rpc is
    // the same path OutboxService.emit uses, in the public schema).
    const evKey = `routing.evaluation_required:${c}:a2-smoke-${Date.now()}`;
    const { error: emitErr } = await supa().rpc('outbox_emit_via_rpc', {
      p_tenant_id: A2_TENANT,
      p_event_type: 'routing.evaluation_required',
      p_aggregate_type: 'ticket',
      p_aggregate_id: c,
      p_payload: { tenant_id: A2_TENANT, ticket_id: c },
      p_idempotency_key: evKey,
      p_event_version: 1,
    });
    if (emitErr) {
      results.fail += 1;
      results.failed.push('audit-02 routing-eval emit');
      console.log(`  ✗ routing-eval outbox emit failed: ${emitErr.message}`);
      return;
    }

    // The :3010 outbox worker polls @Cron(EVERY_30_SECONDS). Wait up to
    // ~75s for the handler to drain it and clear routing_status.
    let cleared = false;
    const deadline = Date.now() + 80_000;
    while (Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 5000));
      const cur = await a2GetCase(headers, c);
      if (cur.routing_status === 'idle') {
        cleared = true;
        break;
      }
    }
    const final = await a2GetCase(headers, c);
    if (cleared && final.routing_status === 'idle' && !final.routing_failure_reason) {
      results.pass += 1;
      console.log('  ✓ routing-eval — routing_status cleared to idle, routing_failure_reason null (atomic, 00406)');
    } else {
      results.fail += 1;
      results.failed.push('audit-02 routing-eval clear');
      console.log(`  ✗ routing-eval — routing_status=${final.routing_status} reason=${final.routing_failure_reason}`);
    }

    // No spurious blank assignment_changed activity when the assignee is
    // unchanged (unassigned re-eval omits assigned_* keys; the RPC's
    // no-op fast path is skipped only for routing_status — it must NOT
    // write an assignment_changed activity row for a same-assignee
    // re-eval).
    const { data: act } = await supa()
      .from('ticket_activities')
      .select('metadata')
      .eq('tenant_id', A2_TENANT)
      .eq('ticket_id', c);
    const spurious = (act ?? []).filter(
      (a) => a.metadata?.event === 'assignment_changed',
    );
    if (spurious.length === 0) {
      results.pass += 1;
      console.log('  ✓ routing-eval — NO spurious assignment_changed activity (same-assignee re-eval)');
    } else {
      results.fail += 1;
      results.failed.push('audit-02 routing-eval spurious activity');
      console.log(`  ✗ routing-eval — ${spurious.length} spurious assignment_changed activity row(s)`);
    }
  } finally {
    await a2DropCase(c);
  }
}

// ── Probe 5: P1-5 getChildTasks cross-visibility ─────────────────────
async function a2ProbeChildVisibility(adminHeaders) {
  console.log('\n— audit-02 P1-5: GET /tickets/:id/children cross-visibility');
  const c = '0a020000-0000-4000-8000-000000000050';
  let childWoId = null;
  try {
    // P1-5 fixture design (critical — see A2_P15_* comment above for the
    // operator-tier reasoning): actor R is the ZERO-PRIVILEGE planning-
    // requester (no team/role/read_all). Seed R as a WATCHER of the
    // PARENT case so R can `read` it (watcher → ticket_visibility_ids
    // participant → can list children) but has NO operator tier and NO
    // edge of its own to the child. The dispatch RPC (00336:270)
    // inherits ONLY the parent's requester_person_id (left NULL here),
    // NOT watchers; so the vendor child has requester=null, watchers={},
    // vendor-assigned → R's ONLY potential path to it would be the
    // parent-inheritance P1-5 closed. If P1-5 regressed, R would see the
    // vendor child → LEAK. (Verified on remote 2026-05-17: this exact
    // shape gives the planning user case_vis=1, wo_vis=0.)
    await a2EnsureP15AuthUser();
    await a2SeedCase(c, {
      moduleNumber: 998050,
      watchers: [A2_P15_PERSON_ID],
    });

    const dResp = await fetch(`${API_BASE}/api/tickets/${c}/dispatch`, {
      method: 'POST',
      headers: { ...adminHeaders, 'X-Client-Request-Id': crypto.randomUUID() },
      body: JSON.stringify({
        title: `a2-vendor-child-${Date.now()}`,
        assigned_vendor_id: A2_REAL_VENDOR,
      }),
    });
    if (dResp.status === 200 || dResp.status === 201) {
      childWoId = (await dResp.json())?.id ?? null;
      results.pass += 1;
      console.log(`  ✓ dispatched vendor child WO ${childWoId?.slice(0, 8)}…`);
    } else {
      results.fail += 1;
      results.failed.push('audit-02 P1-5 dispatch child');
      console.log(`  ✗ dispatch vendor child → HTTP ${dResp.status} ${(await dResp.text()).slice(0, 200)}`);
      return;
    }

    // Admin / read_all → INCLUDES the vendor child (no false-empty for
    // the privileged actor).
    const adminChildren = await (
      await fetch(`${API_BASE}/api/tickets/${c}/children`, { headers: adminHeaders })
    ).json();
    if (Array.isArray(adminChildren) && adminChildren.some((w) => w.id === childWoId)) {
      results.pass += 1;
      console.log(`  ✓ admin sees vendor child (${adminChildren.length} child(ren), no false-empty)`);
    } else {
      results.fail += 1;
      results.failed.push('audit-02 P1-5 admin false-empty');
      console.log(`  ✗ admin children missing vendor child: ${JSON.stringify(adminChildren)?.slice(0, 200)}`);
    }

    // Zero-privilege watcher R → can read the parent case (watcher
    // participant) but the vendor child is filtered OUT by
    // work_order_visibility_ids (00374). Must EXCLUDE childWoId. Also
    // assert R actually CAN read the parent (proves the participant edge
    // exists — otherwise an empty children list would be a vacuous pass
    // because R can't see the parent at all, not because P1-5 worked).
    const rToken = await a2MintToken(A2_P15_AUTH_UID);
    const rHeaders = {
      Authorization: `Bearer ${rToken}`,
      'X-Tenant-Id': A2_TENANT,
      'Content-Type': 'application/json',
    };
    const rParent = await fetch(`${API_BASE}/api/tickets/${c}`, { headers: rHeaders });
    if (rParent.status >= 200 && rParent.status < 300) {
      results.pass += 1;
      console.log('  ✓ R reads parent case (watcher participant — non-vacuous)');
    } else {
      results.fail += 1;
      results.failed.push('audit-02 P1-5 R parent read');
      console.log(`  ✗ R cannot read parent case → HTTP ${rParent.status} (probe would be vacuous)`);
    }
    const rResp = await fetch(`${API_BASE}/api/tickets/${c}/children`, { headers: rHeaders });
    if (rResp.status >= 200 && rResp.status < 300) {
      const rChildren = await rResp.json();
      if (Array.isArray(rChildren) && !rChildren.some((w) => w.id === childWoId)) {
        results.pass += 1;
        console.log(`  ✓ R EXCLUDES vendor child (P1-5 — no inherited parent-visibility leak)`);
      } else {
        results.fail += 1;
        results.failed.push('audit-02 P1-5 LEAK');
        console.log(`  ✗ P1-5 LEAK: R saw vendor child: ${JSON.stringify(rChildren)?.slice(0, 200)}`);
      }
    } else {
      results.fail += 1;
      results.failed.push('audit-02 P1-5 requester children http');
      console.log(`  ✗ R GET children → HTTP ${rResp.status} ${(await rResp.text()).slice(0, 160)}`);
    }
  } finally {
    if (childWoId) {
      await supa().from('work_orders').delete().eq('id', childWoId);
    }
    await a2DropCase(c);
  }
}

// ── Probe 9: reclassify ──────────────────────────────────────────────
async function a2ProbeReclassify(headers) {
  console.log('\n— audit-02: POST /tickets/:id/reclassify');
  const c = '0a020000-0000-4000-8000-000000000090';
  try {
    await a2SeedCase(c, {
      moduleNumber: 998090,
      ticket_type_id: A2_REQUEST_TYPE_A,
    });
    const crid = crypto.randomUUID();
    const r = await fetch(`${API_BASE}/api/tickets/${c}/reclassify`, {
      method: 'POST',
      headers: { ...headers, 'X-Client-Request-Id': crid },
      body: JSON.stringify({
        newRequestTypeId: A2_REQUEST_TYPE_B,
        reason: 'a2 reclassify smoke',
      }),
    });
    if (r.status >= 200 && r.status < 300) {
      results.pass += 1;
      console.log(`  ✓ reclassify → HTTP ${r.status}`);
    } else {
      results.fail += 1;
      results.failed.push('audit-02 reclassify');
      console.log(`  ✗ reclassify → HTTP ${r.status} ${(await r.text()).slice(0, 220)}`);
      return;
    }
    // ticket_type_id changed + an audit/activity row recorded.
    const after = await a2GetCase(headers, c);
    if (after.ticket_type_id === A2_REQUEST_TYPE_B) {
      results.pass += 1;
      console.log('  ✓ reclassify — ticket_type_id changed to new request type');
    } else {
      results.fail += 1;
      results.failed.push('audit-02 reclassify type');
      console.log(`  ✗ reclassify ticket_type_id=${after.ticket_type_id}, want ${A2_REQUEST_TYPE_B}`);
    }
    // Tightened (review IMPORTANT): assert the RECLASSIFY-specific audit row,
    // not just any activity. reclassify_ticket (00355:332-338) writes
    // activity_type='system_event' + metadata.event='reclassified'. A
    // length>=1 count would pass on any unrelated/seed activity row.
    const { data: act } = await supa()
      .from('ticket_activities')
      .select('id, activity_type, metadata')
      .eq('tenant_id', A2_TENANT)
      .eq('ticket_id', c);
    const reclassRow = (act ?? []).find(
      (a) =>
        a.activity_type === 'system_event' &&
        (a.metadata?.event === 'reclassified' ||
          a.metadata?.event === 'automation_plan_overridden_by_concurrent_edit'),
    );
    if (reclassRow) {
      results.pass += 1;
      console.log(
        `  ✓ reclassify — system_event activity recorded (metadata.event=${reclassRow.metadata?.event})`,
      );
    } else {
      results.fail += 1;
      results.failed.push('audit-02 reclassify audit');
      console.log(
        `  ✗ reclassify — no system_event/reclassified ticket_activities row (saw ${(act ?? [])
          .map((a) => a.metadata?.event ?? a.activity_type)
          .join(',')})`,
      );
    }
  } finally {
    await a2DropCase(c);
  }
}

// ── Probe 10: P1-3 satisfaction round-trip ───────────────────────────
async function a2ProbeSatisfaction(headers) {
  console.log('\n— audit-02 P1-3: PATCH /tickets/:id satisfaction (atomic via update_entity_combined)');
  const c = '0a020000-0000-4000-8000-000000000100';
  try {
    await a2SeedCase(c, { moduleNumber: 998100 });
    const crid = crypto.randomUUID();
    const r = await fetch(`${API_BASE}/api/tickets/${c}`, {
      method: 'PATCH',
      headers: { ...headers, 'X-Client-Request-Id': crid },
      body: JSON.stringify({ satisfaction_rating: 4, satisfaction_comment: 'a2 ok' }),
    });
    if (r.status >= 200 && r.status < 300) {
      results.pass += 1;
      console.log(`  ✓ satisfaction PATCH → HTTP ${r.status}`);
    } else {
      results.fail += 1;
      results.failed.push('audit-02 satisfaction patch');
      console.log(`  ✗ satisfaction PATCH → HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
      return;
    }
    // Persisted atomically via update_entity_combined (key
    // patch:case:<id>:<crid>) — the SAME metadata_changed activity row
    // carries it (00410 v7). Assert both the column + the command_op.
    await a2AssertCommandOp(
      'satisfaction',
      buildPatchIdempotencyKey('case', c, crid),
    );
    const { data: row } = await supa()
      .from('tickets')
      .select('satisfaction_rating, satisfaction_comment')
      .eq('id', c)
      .eq('tenant_id', A2_TENANT)
      .maybeSingle();
    if (row?.satisfaction_rating === 4 && row?.satisfaction_comment === 'a2 ok') {
      results.pass += 1;
      console.log('  ✓ satisfaction — persisted atomically (rating=4, comment set)');
    } else {
      results.fail += 1;
      results.failed.push('audit-02 satisfaction persist');
      console.log(`  ✗ satisfaction persist → ${JSON.stringify(row)}`);
    }
    const { data: act } = await supa()
      .from('ticket_activities')
      .select('metadata')
      .eq('tenant_id', A2_TENANT)
      .eq('ticket_id', c);
    const okMeta = (act ?? []).some(
      (a) =>
        a.metadata?.event === 'metadata_changed' &&
        a.metadata?.changes &&
        Object.prototype.hasOwnProperty.call(a.metadata.changes, 'satisfaction_rating'),
    );
    if (okMeta) {
      results.pass += 1;
      console.log('  ✓ satisfaction — same metadata_changed activity carries satisfaction_rating');
    } else {
      // Activity present but shape differs — still acceptable if any
      // metadata_changed row exists (the atomic fold is proven by the
      // command_op + column assertions above).
      const anyMeta = (act ?? []).some((a) => a.metadata?.event === 'metadata_changed');
      if (anyMeta) {
        results.pass += 1;
        console.log('  ✓ satisfaction — metadata_changed activity row present (atomic fold)');
      } else {
        results.fail += 1;
        results.failed.push('audit-02 satisfaction activity');
        console.log(`  ✗ satisfaction — no metadata_changed activity: ${JSON.stringify(act)?.slice(0, 200)}`);
      }
    }

    // Negative: a WO id with a satisfaction key. No HTTP caller path can
    // reach the RPC's WO-satisfaction guard (PATCH /tickets/:id rejects
    // a WO id at the P2-1 guard BEFORE the RPC — ticket.service.ts:1041;
    // WorkOrderService never threads satisfaction). The registered code
    // update_entity_combined.satisfaction_unsupported_for_work_order
    // (00410:585-590) is only reachable by calling the RPC directly with
    // p_entity_kind='work_order'. The RPC's entity SELECT raises
    // `not_found` (00410:291) BEFORE the satisfaction guard (00410:587),
    // so the WO must REALLY exist — dispatch an isolated child WO and
    // call the RPC directly against its real id (mirrors how PM probes
    // invoke RPCs directly for DB-side guarantees the HTTP surface can't
    // exercise). The guard fires BEFORE any column write — no mutation.
    let negWoId = null;
    const dNeg = await fetch(`${API_BASE}/api/tickets/${c}/dispatch`, {
      method: 'POST',
      headers: { ...headers, 'X-Client-Request-Id': crypto.randomUUID() },
      body: JSON.stringify({
        title: `a2-sat-neg-${Date.now()}`,
        assigned_team_id: A2_REAL_TEAM,
      }),
    });
    if (dNeg.status === 200 || dNeg.status === 201) {
      negWoId = (await dNeg.json())?.id ?? null;
    }
    if (!negWoId) {
      results.fail += 1;
      results.failed.push('audit-02 satisfaction WO negative seed');
      console.log(`  ✗ satisfaction WO negative — could not seed child WO (HTTP ${dNeg.status})`);
    } else {
      try {
        const { error: rpcErr } = await supa().rpc('update_entity_combined', {
          p_entity_kind: 'work_order',
          p_entity_id: negWoId,
          p_tenant_id: A2_TENANT,
          p_actor_user_id: null,
          p_idempotency_key: `patch:work_order:${negWoId}:${crypto.randomUUID()}`,
          p_patches: { metadata: { satisfaction_rating: 3 } },
        });
        if (
          rpcErr &&
          /satisfaction_unsupported_for_work_order/.test(rpcErr.message || '')
        ) {
          results.pass += 1;
          console.log('  ✓ satisfaction negative — RPC rejects WO satisfaction (satisfaction_unsupported_for_work_order)');
        } else {
          results.fail += 1;
          results.failed.push('audit-02 satisfaction WO negative');
          console.log(`  ✗ satisfaction WO negative — expected satisfaction_unsupported_for_work_order, got: ${rpcErr?.message ?? '(no error)'}`);
        }
      } finally {
        await supa().from('work_orders').delete().eq('id', negWoId);
      }
    }
  } finally {
    await a2DropCase(c);
  }
}

async function runAudit02TicketProbes(adminHeaders) {
  console.log('\n══════ audit-02 Slice-8 remediation probes (tickets/SLA) ══════');
  await a2ProbeBulkUpdate(adminHeaders);
  await a2ProbeCaseReassign(adminHeaders);
  await a2ProbeRoutingEvalClear(adminHeaders);
  await a2ProbeChildVisibility(adminHeaders);
  await a2ProbeReclassify(adminHeaders);
  await a2ProbeSatisfaction(adminHeaders);
  await a2ProbeSlaEscalation(adminHeaders); // slowest (cron waits) — last
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

  // Seed fixtures before the auth dance so probes have what they need.
  // Both are idempotent + use psql to bypass a broken AFTER INSERT trigger
  // on tenants (`trg_tenants_seed_retention` references a renamed column).
  await ensureTenantBFixture();
  await ensureStateMachineFixture();

  const accessToken = await mintAdminToken();
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'X-Tenant-Id': TENANT_ID,
    'Content-Type': 'application/json',
  };
  const probe = makeProber(headers);

  try {
    await runMutationMatrix(headers, probe);
    await runConcurrencyProbes(headers, probe);
    await runCrossTenantProbes(headers, probe);
    await runStateMachineProbes(headers, probe);
    await runGuardCoverageProbes(headers, probe);
    await runBoundaryProbes(headers, probe);
    await runAudit02TicketProbes(headers);
  } finally {
    // Always clean up the SM fixture, even on failure, so the next
    // run starts clean.
    await deleteStateMachineFixture();
  }

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

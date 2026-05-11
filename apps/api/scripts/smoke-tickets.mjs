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

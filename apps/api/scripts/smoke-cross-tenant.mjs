#!/usr/bin/env node
/**
 * scripts/smoke-cross-tenant.mjs
 *
 * Live-API security smoke test for global tenant binding.
 *
 * Gate for: docs/follow-ups/audits/04-rls-security.md Slice 1 + Slice 2.
 *
 * Coverage:
 *   1. Regression guard — Tenant-A admin JWT + Tenant-A X-Tenant-Id header
 *      can still read its own admin/config surface (workflows, routing
 *      rules, sla policies, etc.). 200 expected.
 *   2. Cross-tenant header-flip — Tenant-A admin JWT + Tenant-B
 *      X-Tenant-Id header MUST be rejected with 403
 *      `auth.user_not_in_tenant`. This is the P0 attack from the audit.
 *   3. Bare-auth regression — no Bearer token + Tenant-A header still 401.
 *
 * Before the Slice 1 AuthGuard fix, the cross-tenant probes return 2xx
 * with target-tenant data — they FAIL the probe (expect=forbidden).
 * After the fix, they 403. The asymmetry between "200 before, 403 after"
 * is the fail-before / pass-after gate.
 *
 * USAGE:
 *   pnpm dev:api &     (or have the dev server already running)
 *   node apps/api/scripts/smoke-cross-tenant.mjs
 *
 *   exit 0 = all probes pass; exit 1 = at least one regression.
 *
 * Citations:
 *   - apps/api/src/modules/auth/auth.guard.ts (the global guard)
 *   - apps/api/src/modules/auth/admin.guard.ts:21-29 (the same bridge
 *     pattern, applied per-controller today)
 *   - apps/api/scripts/smoke-tickets.mjs:81-179 (TENANT_B fixture seed
 *     pattern — mirrored here)
 */

import { createClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─────────────────────────────────────────────────────────────────────
// Config — mirrors smoke-tickets.mjs:54-75
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
const TENANT_A_ID = '00000000-0000-0000-0000-000000000001';
const ADMIN_AUTH_UID = '93d41232-35b5-424c-b215-bb5d55a2dfd9';

// Slice 9 (docs/follow-ups/audits/04-rls-security.md, 2026-05-16).
// Non-admin same-tenant fixture from the seed data:
// employee.requester@prequest.nl has role type='employee' (no admin).
// Used to prove (a) AdminGuard denies same-tenant non-admins on the
// Slice-2 admin controllers, and (b) the user-management
// privilege-escalation P0 is closed — a non-admin can no longer
// POST /role-assignments to self-grant the Admin role.
const NONADMIN_AUTH_UID = 'd572cfa5-b2b6-42b5-8853-5102621e3819';
const NONADMIN_USER_ID = '95100000-0000-0000-0000-00000000000c';
const ADMIN_ROLE_ID = '91000000-0000-0000-0000-000000000001';
// Slice 10 (2026-05-16) — TENANT_A team for the team-membership
// self-add escalation probe (team_members feeds ticket_visibility_ids).
const TEAM_ID = '94000000-0000-0000-0000-000000000001';

// Slice 11.2b (2026-05-16, codex risk #2) — the "one live case" proving
// the @RequirePermission re-gate delivers what blanket AdminGuard
// structurally could NOT: a non-admin role (type='agent', NOT 'admin')
// holding exactly `spaces.create` can POST /spaces. Under the old
// AdminGuard (hard role.type==='admin') this same role 403'd; under
// @RequirePermission('spaces.create') it passes the guard. Fixed UUIDs
// so the finally-cleanup is deterministic. Assigned to the existing
// NONADMIN user — the proof section runs LAST (after every Slice-9/10
// probe that asserts this user 403s) so it cannot perturb them, and
// user_has_permission re-evaluates roles.permissions live per request
// (no token re-mint needed).
const PROOF_ROLE_ID = '91000000-0000-0000-0000-0000000011b2';
const PROOF_ASSIGNMENT_ID = '96000000-0000-0000-0000-0000000011b2';

// Notification same-tenant IDOR proof (docs/follow-ups/audits/04-rls-security.md
// — codex 2026-05-18 remaining item #1). A notification owned by some
// TENANT_A person that is NOT the admin caller. The legacy
// NotificationController consumer routes (POST /notifications/:id/read,
// /notifications/person/:personId*, .../read-all) updated/read by
// id/personId with NO recipient binding (supabase.admin bypasses RLS) —
// any same-tenant authed user could flip anyone's read-state. Fixed UUID
// so the finally-cleanup is deterministic.
const IDOR_NOTIF_ID = '9a000000-0000-0000-0000-00000000d0e1';

// Mirror smoke-tickets.mjs:86-87 — TENANT_B fixture seed shape.
const TENANT_B_ID = '00000000-0000-0000-0000-0000000000b1';

// ─────────────────────────────────────────────────────────────────────
// TENANT_B fixture — idempotent seed (mirrors smoke-tickets.mjs:133-179)
// ─────────────────────────────────────────────────────────────────────

async function ensureTenantBFixture() {
  const dbPass = env.SUPABASE_DB_PASS;
  if (!dbPass) {
    throw new Error(
      'ensureTenantBFixture: SUPABASE_DB_PASS missing from .env — cannot seed TENANT_B',
    );
  }
  const dbUrl =
    env.SUPABASE_DB_URL ||
    'postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres';
  // `set session_replication_role = 'replica'` disables the
  // `trg_tenants_seed_retention` trigger (drifted from migrations per
  // smoke-tickets.mjs:135-141 — tracked tech debt, out of scope here).
  const sql = `
    set session_replication_role = 'replica';
    insert into public.tenants (id, name, slug, status)
      values ('${TENANT_B_ID}', 'Smoke Tenant B (xtenant probes)', 'smoke-tenant-b', 'active')
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
// Slice 11.2b — non-admin-WITH-permission proof fixture.
// Idempotent seed + deterministic teardown. Same psql/replica pattern
// as ensureTenantBFixture (roles + user_role_assignments carry audit
// triggers that have drifted from migrations — out of scope here).
// ─────────────────────────────────────────────────────────────────────

function proofDbArgs() {
  const dbPass = env.SUPABASE_DB_PASS;
  if (!dbPass) {
    throw new Error(
      'Slice 11.2b proof: SUPABASE_DB_PASS missing from .env — cannot seed the non-admin proof role',
    );
  }
  const dbUrl =
    env.SUPABASE_DB_URL ||
    'postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres';
  return { dbPass, dbUrl };
}

function seedProofRoleFixture() {
  const { dbPass, dbUrl } = proofDbArgs();
  // type='agent' — explicitly NOT 'admin'. permissions holds exactly
  // three single keys: spaces.create (generic 11.2b re-gate proof),
  // request_types.use (Slice 11.4 portal-fix proof), and
  // visitors.configure (Slice 11.5 — the LAST AdminGuard caller
  // re-gated). None is a wildcard and none is admin — this is the role
  // blanket AdminGuard would have 403'd (role.type !== 'admin') but
  // @RequirePermission lets through, per-key.
  const sql = `
    set session_replication_role = 'replica';
    insert into public.roles (id, tenant_id, name, description, permissions, type, active)
      values ('${PROOF_ROLE_ID}', '${TENANT_A_ID}', 'xtenant-proof multi-key',
              'RLS Slice 11.2b/11.4/11.5 proof — non-admin (agent) role holding exactly spaces.create + request_types.use + visitors.configure',
              '["spaces.create","request_types.use","visitors.configure"]'::jsonb, 'agent', true)
      on conflict (id) do update
        set permissions = excluded.permissions, type = excluded.type, active = true;
    insert into public.user_role_assignments (id, tenant_id, user_id, role_id, active)
      values ('${PROOF_ASSIGNMENT_ID}', '${TENANT_A_ID}', '${NONADMIN_USER_ID}', '${PROOF_ROLE_ID}', true)
      on conflict (id) do update set active = true;
    set session_replication_role = 'origin';
  `;
  execFileSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    env: { ...process.env, PGPASSWORD: dbPass },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function cleanupProofRoleFixture() {
  try {
    const { dbPass, dbUrl } = proofDbArgs();
    // Order: assignment → role (FK), then any space the proof POST
    // actually created (idempotent; harmless if it 400'd on the body).
    const sql = `
      delete from public.user_role_assignments where id = '${PROOF_ASSIGNMENT_ID}';
      delete from public.roles where id = '${PROOF_ROLE_ID}';
      delete from public.spaces where tenant_id = '${TENANT_A_ID}' and name = 'xtenant-11.2b-proof';
    `;
    execFileSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-c', sql], {
      env: { ...process.env, PGPASSWORD: dbPass },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    console.log(`  ! slice11.2b-cleanup failed (non-fatal): ${e.message}`);
  }
}

// Seed one in_app notification owned by a TENANT_A person that is NOT the
// admin caller (resolve NONADMIN's person; fall back to any TENANT_A
// person — never the admin's). read_at NULL so a successful IDOR mark is
// observable. set_replication_role replica: notifications has no audit
// trigger today but mirror the proof-fixture pattern for consistency.
function seedIdorNotificationFixture() {
  const { dbPass, dbUrl } = proofDbArgs();
  const sql = `
    set session_replication_role = 'replica';
    insert into public.notifications
      (id, tenant_id, notification_type, target_channel,
       recipient_person_id, subject, body, status, read_at, created_at)
    values (
      '${IDOR_NOTIF_ID}', '${TENANT_A_ID}', 'smoke_idor_probe', 'in_app',
      coalesce(
        (select person_id from public.users
           where tenant_id = '${TENANT_A_ID}'
             and id = '${NONADMIN_USER_ID}' and person_id is not null),
        (select id from public.persons
           where tenant_id = '${TENANT_A_ID}' limit 1)),
      'IDOR probe — victim notification',
      'Must NOT be markable-read by a non-recipient same-tenant user.',
      'sent', null, now())
    on conflict (id) do update
      set status = 'sent', read_at = null;
    set session_replication_role = 'origin';
  `;
  execFileSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    env: { ...process.env, PGPASSWORD: dbPass },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Returns true iff the seeded notification's read_at is still NULL — i.e.
// the IDOR did NOT succeed. -tA = tuples-only, unaligned (empty string
// when read_at IS NULL).
function idorNotificationStillUnread() {
  const { dbPass, dbUrl } = proofDbArgs();
  const out = execFileSync(
    'psql',
    [
      dbUrl,
      '-tA',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `select read_at from public.notifications where id = '${IDOR_NOTIF_ID}';`,
    ],
    { env: { ...process.env, PGPASSWORD: dbPass }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
    .toString()
    .trim();
  return out === '';
}

// Browser-direct PostgREST hardening proof (04-rls-security.md, codex
// 2026-05-18 #2 / migration 00434, formerly 00415). Two layers:
//  (1) grant assertion — anon+authenticated must hold NO write DML on
//      ANY public base table (the guard's scope matches 00434's
//      `REVOKE … ON ALL TABLES`, not just an escalation subset — the
//      full-review I2 scope-mismatch fix), but MUST retain SELECT on the
//      Realtime-published set (Supabase Realtime per-subscriber RLS
//      needs it; revoking it breaks the inbox bell / scheduler live
//      updates). Deterministic red→green for the migration (verified:
//      pre-push 12 grants → RED; post-push 0 → GREEN).
//  (2) live end-to-end — a real authenticated browser session token
//      cannot INSERT into user_role_assignments via PostgREST. Post-
//      00434 this is GRANT-denied (claim-independent: holds even if a
//      future custom-access-token hook starts minting tenant_id).
const REALTIME_TABLES = [
  'bookings',
  'inbox_notifications',
  'booking_slots',
  'orders',
  'order_line_items',
  'recurrence_series',
  'room_booking_rules',
  'vendor_order_status_events',
];

function browserGrantPosture() {
  const { dbPass, dbUrl } = proofDbArgs();
  const rtList = REALTIME_TABLES.map((t) => `('${t}')`).join(',');
  // writes_left = ANY public base table where anon/authenticated still
  // holds INSERT/UPDATE/DELETE (scope == the 00434 REVOKE). select_missing
  // = a Realtime-published table that LOST SELECT (over-broad revoke).
  const sql = `select
    (select count(*) from pg_tables tb
       cross join (values ('anon'),('authenticated')) r(g)
       where tb.schemaname = 'public'
         and (has_table_privilege(r.g, format('public.%I', tb.tablename), 'INSERT')
           or has_table_privilege(r.g, format('public.%I', tb.tablename), 'UPDATE')
           or has_table_privilege(r.g, format('public.%I', tb.tablename), 'DELETE'))) as writes_left,
    (select count(*) from (values ${rtList}) t(n)
       cross join (values ('anon'),('authenticated')) r(g)
       where not has_table_privilege(r.g, 'public.'||t.n, 'SELECT')) as select_missing;`;
  const out = execFileSync(
    'psql',
    [dbUrl, '-tA', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { env: { ...process.env, PGPASSWORD: dbPass }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
    .toString()
    .trim();
  const [writesLeft, selectMissing] = out.split('|').map((n) => Number(n));
  return { writesLeft, selectMissing };
}

// Bearer-token trio (anon-callable by audit design — public invitation /
// kiosk flows). Used by the trio-reachability probe below.
const BEARER_TRIO = [
  'validate_invitation_token',
  'peek_invitation_token',
  'validate_kiosk_token',
];

// 00435 → 00436 EXECUTE-axis guard (post-00436, the RLS-correct
// posture). The 2026-05-19 P0 incident proved that the previous
// "zero browser-EXECUTE-able app routines" invariant
// (00435_revoke_browser_execute_grants.sql, formerly 00417) is
// fundamentally incompatible with Supabase RLS: every tenant_isolation
// policy's USING clause invokes public.current_tenant_id() (others call
// current_user_id() / user_has_permission()), and Postgres checks
// EXECUTE on those helper functions AS THE QUERYING ROLE
// (anon/authenticated) even for SECURITY DEFINER — so revoking their
// EXECUTE from the browser roles 42501'd every browser/Realtime read.
// 00436_fix_00435_rls_helper_execute_regression.sql (formerly 00420,
// PR #31) fully reverts 00435 and restores the Supabase-default grant.
// The correct, achievable, security-meaningful EXECUTE-axis invariant
// is therefore the INVERSE of the old one: the RLS-helper functions
// MUST remain browser-EXECUTE-able. `missing` = count of the supplied
// RLS helpers for which anon OR authenticated lacks EXECUTE. Must be 0;
// any non-zero ⇒ the 00435-class outage has regressed.
function rlsHelperExecutePosture(helpers) {
  const { dbPass, dbUrl } = proofDbArgs();
  const list = helpers.map((n) => `('${n}')`).join(',');
  // Overload-safe: a helper counts as `missing` for role g if it is
  // absent entirely OR ANY pg_proc row of that name lacks EXECUTE for
  // g. The old form (`not exists(... and has_function_privilege ...)`)
  // let one EXECUTE-able overload of an overloaded helper (e.g.
  // user_has_permission has multiple signatures) mask a revoked
  // sibling overload. We keep an `exists(... proname = h.n)` arm so a
  // missing-entirely helper still surfaces (negated: a helper with
  // zero pg_proc rows is counted), AND add the per-overload
  // `exists(... and not has_function_privilege ...)` arm so any
  // single non-EXECUTE-able overload is flagged.
  const sql = `select count(*)
    from (values ${list}) h(n)
    cross join (values ('anon'),('authenticated')) r(g)
    where not exists (
        select 1 from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.proname = h.n)
      or exists (
        select 1 from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.proname = h.n
          and not has_function_privilege(r.g, p.oid, 'EXECUTE'));`;
  const missing = Number(
    execFileSync(
      'psql',
      [dbUrl, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql],
      { env: { ...process.env, PGPASSWORD: dbPass }, stdio: ['ignore', 'pipe', 'pipe'] },
    )
      .toString()
      .trim(),
  );
  return { missing };
}

function cleanupIdorNotificationFixture() {
  try {
    const { dbPass, dbUrl } = proofDbArgs();
    execFileSync(
      'psql',
      [
        dbUrl,
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        `delete from public.notifications where id = '${IDOR_NOTIF_ID}';`,
      ],
      { env: { ...process.env, PGPASSWORD: dbPass }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    console.log(`  ! idor-notif-cleanup failed (non-fatal): ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Auth — mint a real Admin JWT for TENANT_A.
// Mirrors smoke-tickets.mjs:186-206.
// ─────────────────────────────────────────────────────────────────────

let SUPA = null;
function supa() {
  if (SUPA) return SUPA;
  SUPA = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return SUPA;
}

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

const mintAdminToken = () => mintTokenFor(ADMIN_AUTH_UID);

// ─────────────────────────────────────────────────────────────────────
// Probe runner — shared shape with smoke-tickets.mjs.
// ─────────────────────────────────────────────────────────────────────

const results = { pass: 0, fail: 0, failed: [] };

async function probe(name, options) {
  const {
    method = 'GET',
    url,
    headers = {},
    body,
    expect = 'success',
  } = options;
  const r = await fetch(url, {
    method,
    headers: body !== undefined ? { ...headers, 'Content-Type': 'application/json' } : headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const ok =
    (expect === 'success' && r.status >= 200 && r.status < 300) ||
    (expect === 'badrequest' && r.status === 400) ||
    (expect === 'unauthorized' && r.status === 401) ||
    (expect === 'forbidden' && r.status === 403) ||
    (expect === 'notfound' && r.status === 404) ||
    // Slice 11.2b: "the permission guard let it through". 403 = denied
    // by the guard, 401 = no platform user (guard couldn't resolve the
    // caller). Anything else (2xx, or 400/422 business validation on the
    // body) proves the @RequirePermission gate PASSED — which is the
    // whole proof. Robust to POST /spaces body-validation variance.
    (expect === 'not_forbidden' && r.status !== 403 && r.status !== 401);
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
  return { status: r.status, body: txt };
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`smoke-cross-tenant against ${API_BASE}`);
  console.log(`tenant A: ${TENANT_A_ID}`);
  console.log(`tenant B: ${TENANT_B_ID}`);

  await ensureTenantBFixture();
  const token = await mintAdminToken();
  console.log(`admin JWT minted (tenant A): ${token.slice(0, 16)}…`);

  const tenantA = {
    Authorization: `Bearer ${token}`,
    'X-Tenant-Id': TENANT_A_ID,
  };
  const tenantBHeader = {
    Authorization: `Bearer ${token}`,
    'X-Tenant-Id': TENANT_B_ID,
  };
  const noAuth = { 'X-Tenant-Id': TENANT_A_ID };

  console.log('\n─── Regression: Tenant-A JWT + Tenant-A header (must still work)');
  await probe('GET /workflows  (own tenant)', {
    url: `${API_BASE}/api/workflows`,
    headers: tenantA,
    expect: 'success',
  });
  await probe('GET /routing-rules  (own tenant)', {
    url: `${API_BASE}/api/routing-rules`,
    headers: tenantA,
    expect: 'success',
  });

  console.log('\n─── Regression: missing bearer token (must still 401)');
  await probe('GET /workflows  (no bearer)', {
    url: `${API_BASE}/api/workflows`,
    headers: noAuth,
    expect: 'unauthorized',
  });

  console.log('\n─── P0 attack: Tenant-A JWT + Tenant-B header (must 403)');
  // These probes exercise the controllers identified in
  // docs/follow-ups/audits/04-rls-security.md P0 as un-bridged.
  // Before the Slice 1 fix, each returns 200 with Tenant B's data
  // (or 200 empty, which is still a leak of "Tenant B exists").
  // After the fix, AuthGuard rejects with 403 auth.user_not_in_tenant.
  //
  // GET-only on purpose: writes are tested separately in Slice 3 after
  // Slice 2 hardens the admin controllers with @UseGuards(AdminGuard).
  // Running cross-tenant POSTs before Slice 1 lands would actually
  // create attacker rows in Tenant B.
  await probe('GET /workflows  (cross-tenant)', {
    url: `${API_BASE}/api/workflows`,
    headers: tenantBHeader,
    expect: 'forbidden',
  });
  await probe('GET /routing-rules  (cross-tenant)', {
    url: `${API_BASE}/api/routing-rules`,
    headers: tenantBHeader,
    expect: 'forbidden',
  });
  await probe('GET /sla-policies  (cross-tenant)', {
    url: `${API_BASE}/api/sla-policies`,
    headers: tenantBHeader,
    expect: 'forbidden',
  });
  await probe('GET /space-groups  (cross-tenant)', {
    url: `${API_BASE}/api/space-groups`,
    headers: tenantBHeader,
    expect: 'forbidden',
  });
  await probe('GET /location-teams  (cross-tenant)', {
    url: `${API_BASE}/api/location-teams`,
    headers: tenantBHeader,
    expect: 'forbidden',
  });
  await probe('GET /domain-parents  (cross-tenant)', {
    url: `${API_BASE}/api/domain-parents`,
    headers: tenantBHeader,
    expect: 'forbidden',
  });

  console.log('\n─── Cross-tenant WRITE attempts (Slice 1 + Slice 2 belt+suspenders)');
  // After Slice 1 (AuthGuard global tenant binding) these were already
  // safe to assert against the live API — the bridge rejects the
  // cross-tenant header before the controller / RPC sees any body, so
  // no attacker row can land in Tenant B. Slice 2 (AdminGuard on the
  // admin controllers) is the second layer: even if Slice 1 regressed,
  // AdminGuard would still reject because the cross-tenant admin has
  // no role_assignment in Tenant B.
  await probe('POST /workflows  (cross-tenant write)', {
    url: `${API_BASE}/api/workflows`,
    method: 'POST',
    headers: tenantBHeader,
    body: { name: 'xtenant-attack', graph_definition: {} },
    expect: 'forbidden',
  });
  await probe('POST /routing-rules  (cross-tenant write)', {
    url: `${API_BASE}/api/routing-rules`,
    method: 'POST',
    headers: tenantBHeader,
    body: { name: 'xtenant-attack', applies_when: {} },
    expect: 'forbidden',
  });
  await probe('POST /sla-policies  (cross-tenant write)', {
    url: `${API_BASE}/api/sla-policies`,
    method: 'POST',
    headers: tenantBHeader,
    body: { name: 'xtenant-attack' },
    expect: 'forbidden',
  });

  // ── Slice 9: same-tenant non-admin denial + privilege-escalation ──
  // The cross-tenant probes above prove the Slice 1 bridge. They do
  // NOT prove the Slice 2 AdminGuard layer, because AuthGuard rejects
  // the header-flip before AdminGuard runs. These probes mint a
  // SAME-tenant NON-admin JWT (employee.requester, role type=employee)
  // so AuthGuard passes and AdminGuard is actually exercised.
  console.log('\n─── Slice 9: same-tenant non-admin (AdminGuard layer + escalation P0)');
  const naToken = await mintTokenFor(NONADMIN_AUTH_UID);
  console.log(`non-admin JWT minted (tenant A): ${naToken.slice(0, 16)}…`);
  const nonAdminA = {
    Authorization: `Bearer ${naToken}`,
    'X-Tenant-Id': TENANT_A_ID,
  };

  // Regression: bootstrap + operational reads stay open to non-admins.
  // We deliberately did NOT lock these (GET /users backs the desk
  // ticket-filter / user-picker; GET /users/me is session bootstrap).
  await probe('GET /users/me  (non-admin, own tenant)', {
    url: `${API_BASE}/api/users/me`,
    headers: nonAdminA,
    expect: 'success',
  });
  await probe('GET /users  (non-admin, operational picker)', {
    url: `${API_BASE}/api/users`,
    headers: nonAdminA,
    expect: 'success',
  });

  // AdminGuard layer: same-tenant non-admin hitting a Slice-2 admin
  // controller must 403 (auth.admin_required). This is the assertion
  // the cross-tenant probes structurally cannot make.
  await probe('GET /workflows  (non-admin → AdminGuard 403)', {
    url: `${API_BASE}/api/workflows`,
    headers: nonAdminA,
    expect: 'forbidden',
  });

  // The P0 itself: a non-admin self-granting the Admin role via the
  // previously-unguarded POST /role-assignments. Must 403 after
  // Slice 9. The cleanup below defensively removes the assignment if
  // a regression ever lets this through, so a red run can't leave the
  // seed user permanently escalated.
  await probe('POST /role-assignments  (non-admin self-grants Admin → P0)', {
    url: `${API_BASE}/api/role-assignments`,
    method: 'POST',
    headers: nonAdminA,
    body: { user_id: NONADMIN_USER_ID, role_id: ADMIN_ROLE_ID },
    expect: 'forbidden',
  });

  // Defensive cleanup — only matters if the probe above regressed to
  // 200 and actually wrote the escalation row. Idempotent.
  try {
    const dbPass = env.SUPABASE_DB_PASS;
    const dbUrl =
      env.SUPABASE_DB_URL ||
      'postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres';
    execFileSync(
      'psql',
      [
        dbUrl,
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        `delete from public.user_role_assignments where user_id = '${NONADMIN_USER_ID}' and role_id = '${ADMIN_ROLE_ID}';`,
      ],
      { env: { ...process.env, PGPASSWORD: dbPass }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    console.log(`  ! escalation-cleanup failed (non-fatal): ${e.message}`);
  }

  // ── Slice 10: 9 further unguarded admin-mutation controllers ──
  // The sweep after Slice 9 found these. Probe the two escalation-
  // class ones with the same-tenant non-admin JWT (the rest follow
  // the identical @UseGuards(AdminGuard)-per-mutation pattern, so
  // these two are representative — team membership feeds
  // ticket_visibility_ids; delegation.create takes no actor).
  // Plus operational-GET regressions: Slice 10 must NOT have locked
  // the reads that back non-admin operator pickers.
  console.log('\n─── Slice 10: same-tenant non-admin on newly-guarded controllers');
  await probe('GET /spaces  (non-admin, operational picker)', {
    url: `${API_BASE}/api/spaces`,
    headers: nonAdminA,
    expect: 'success',
  });
  await probe('GET /vendors  (non-admin, operational)', {
    url: `${API_BASE}/api/vendors`,
    headers: nonAdminA,
    expect: 'success',
  });
  await probe('GET /teams  (non-admin, assignment picker)', {
    url: `${API_BASE}/api/teams`,
    headers: nonAdminA,
    expect: 'success',
  });
  // Escalation-class P0: non-admin self-adding to a team would grant
  // operator visibility on that team's tickets (team_members →
  // ticket_visibility_ids). Must 403.
  await probe('POST /teams/:id/members  (non-admin self-add → visibility escalation)', {
    url: `${API_BASE}/api/teams/${TEAM_ID}/members`,
    method: 'POST',
    headers: nonAdminA,
    body: { user_id: NONADMIN_USER_ID },
    expect: 'forbidden',
  });
  // Escalation-class: delegation.create takes no actor — a non-admin
  // minting a delegation between arbitrary users. Must 403.
  await probe('POST /delegations  (non-admin mints delegation → escalation)', {
    url: `${API_BASE}/api/delegations`,
    method: 'POST',
    headers: nonAdminA,
    body: { from_user_id: NONADMIN_USER_ID, to_user_id: NONADMIN_USER_ID },
    expect: 'forbidden',
  });
  // Slice 11.5: the LAST AdminGuard caller, re-gated to
  // @RequirePermission('visitors.configure'). A plain non-admin (no
  // visitors.configure) must 403 — and 403 not 500 also proves the
  // PermissionMetadataGuard DI is wired in visitors.module after the
  // AuthModule drop (a missing provider would 500 here).
  await probe('POST /admin/visitors/types  (non-admin, no visitors.configure → 403)', {
    url: `${API_BASE}/api/admin/visitors/types`,
    method: 'POST',
    headers: nonAdminA,
    body: { display_name: 'xtenant-noadmin', slug: 'xt-noadmin' },
    expect: 'forbidden',
  });
  // Slice 11.6(A): the 3 admin-only audit/effective GETs were ungated
  // pre-11.6 (any active same-tenant user → 200, the P2 leak). Now
  // gated users.read / roles.read — plain non-admin must 403 (gate
  // engaged; 403 not 500 also confirms DI). They're admin-detail-page
  // only so no operator UX breaks (codex-verified).
  await probe('GET /users/:id/audit  (non-admin, no users.read → 403, was open pre-11.6)', {
    url: `${API_BASE}/api/users/00000000-0000-0000-0000-0000000011b2/audit`,
    headers: nonAdminA,
    expect: 'forbidden',
  });
  await probe('GET /roles/:id/audit  (non-admin, no roles.read → 403, was open pre-11.6)', {
    url: `${API_BASE}/api/roles/00000000-0000-0000-0000-0000000011b2/audit`,
    headers: nonAdminA,
    expect: 'forbidden',
  });
  await probe('GET /permissions/users/:id/effective  (non-admin, no roles.read → 403, was open pre-11.6)', {
    url: `${API_BASE}/api/permissions/users/00000000-0000-0000-0000-0000000011b2/effective`,
    headers: nonAdminA,
    expect: 'forbidden',
  });
  // Slice 11.2-fix: notification TEMPLATE mutation. This re-gate's
  // controller edit sat uncommitted for two sessions (b4577f20 shipped
  // only the module DI). Runtime proof the now-committed
  // @RequirePermission('notifications.manage_templates') + the
  // already-committed module DI actually work together: plain non-admin
  // → 403 (gate engaged; 403 not 500 confirms the committed
  // controller+module are wired).
  await probe('POST /notification-templates  (non-admin, no notifications.manage_templates → 403)', {
    url: `${API_BASE}/api/notification-templates`,
    method: 'POST',
    headers: nonAdminA,
    body: {},
    expect: 'forbidden',
  });
  // Config-mutation sample: non-admin creating a space (location
  // hierarchy) must 403.
  await probe('POST /spaces  (non-admin config mutation)', {
    url: `${API_BASE}/api/spaces`,
    method: 'POST',
    headers: nonAdminA,
    body: { name: 'xtenant-noadmin', type: 'room' },
    expect: 'forbidden',
  });

  // Defensive cleanup — only matters if a probe above regressed to a
  // 2xx and actually wrote. Idempotent. Removes the would-be
  // team-membership escalation row.
  try {
    const dbPass = env.SUPABASE_DB_PASS;
    const dbUrl =
      env.SUPABASE_DB_URL ||
      'postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres';
    execFileSync(
      'psql',
      [
        dbUrl,
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        `delete from public.team_members where team_id = '${TEAM_ID}' and user_id = '${NONADMIN_USER_ID}';`,
      ],
      { env: { ...process.env, PGPASSWORD: dbPass }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    console.log(`  ! slice10-cleanup failed (non-fatal): ${e.message}`);
  }

  // ── Slice 11.2b: non-admin WITH the permission must NOT be 403 ──
  // codex risk #2's "one live case". Runs LAST so seeding spaces.create
  // onto NONADMIN cannot flip the earlier Slice-9/10 403 assertions
  // (which use the same user). Proves the @RequirePermission re-gate
  // delivers what blanket AdminGuard structurally could not: a
  // non-admin (type='agent') role that holds exactly spaces.create
  // passes the guard where AdminGuard (role.type==='admin') 403'd it.
  console.log(
    '\n─── Slice 11.2b: non-admin WITH permission (proves the re-gate)',
  );
  try {
    seedProofRoleFixture();
    // Sanity: the SAME role/user with NO spaces.create still 403s on a
    // different key's route — isolates "the grant did it", not "the
    // user is now privileged". POST /workflows needs workflows.create,
    // which this role does not hold.
    await probe('POST /workflows  (non-admin, role lacks workflows.create → still 403)', {
      url: `${API_BASE}/api/workflows`,
      method: 'POST',
      headers: nonAdminA,
      body: { name: 'xtenant-11.2b-neg', graph_definition: {} },
      expect: 'forbidden',
    });
    // The proof: same non-admin user, now holding spaces.create, hits
    // POST /spaces. NOT 403/401 ⇒ the permission guard passed (2xx, or
    // 400/422 body-validation — either way the gate let it through).
    await probe('POST /spaces  (non-admin role holds spaces.create → guard PASSES)', {
      url: `${API_BASE}/api/spaces`,
      method: 'POST',
      headers: nonAdminA,
      body: { name: 'xtenant-11.2b-proof', type: 'site' },
      expect: 'not_forbidden',
    });
    // Slice 11.4 proof: the SAME non-admin role also holds
    // request_types.use → GET /config-entities/:id (the Requester
    // portal / desk create-ticket form-render path) must pass the gate.
    // Pre-11.3 this was class-level AdminGuard (this exact role 403'd);
    // 11.4 gates it request_types.use. A non-existent id 404s AFTER the
    // gate — 404 ∉ {401,403} ⇒ the gate passed (which is the proof).
    // Negative isolation: the role lacks request_types.read, so this
    // proves request_types.use specifically, not a generic read grant.
    await probe('GET /config-entities/:id  (non-admin holds request_types.use → guard PASSES, was AdminGuard-403 pre-11.3)', {
      url: `${API_BASE}/api/config-entities/00000000-0000-0000-0000-0000000011b2`,
      headers: nonAdminA,
      expect: 'not_forbidden',
    });
    // Slice 11.5 proof: the SAME non-admin role also holds
    // visitors.configure → POST /admin/visitors/types (the last
    // AdminGuard caller, now @RequirePermission) must pass the gate.
    // Pre-11.5 the class-level AdminGuard 403'd this exact agent role.
    // Empty body ⇒ Zod 400 AFTER the gate (handler reached) — proves
    // gate-passed with zero side effects (no visitor_type row created),
    // same side-effect-free pattern as the 404 proof above. The
    // plain-nonAdmin negative for this route is asserted 403 in the
    // Slice-10 section above.
    await probe('POST /admin/visitors/types  (non-admin holds visitors.configure → guard PASSES, was AdminGuard-403 pre-11.5)', {
      url: `${API_BASE}/api/admin/visitors/types`,
      method: 'POST',
      headers: nonAdminA,
      body: {},
      expect: 'not_forbidden',
    });
  } catch (e) {
    results.fail += 1;
    results.failed.push('Slice 11.2b proof (seed/probe threw)');
    console.log(`  ✗ Slice 11.2b proof threw: ${e.message}`);
  } finally {
    cleanupProofRoleFixture();
  }

  // ── Notification same-tenant IDOR (codex 2026-05-18 remaining #1) ──
  // The admin is a valid TENANT_A authed user but NOT the seeded
  // notification's recipient. Pre-fix the legacy NotificationController
  // consumer routes flip/read read-state by id/personId with no
  // recipient binding — a same-tenant IDOR. The fix removes the dead
  // legacy surface entirely (the real inbox is the server-derived
  // /me/inbox/*); routes must be GONE (404) and the victim row's
  // read_at must remain NULL even if a route still answered.
  console.log(
    '\n─── Notification same-tenant IDOR: a non-recipient cannot touch read-state',
  );
  try {
    seedIdorNotificationFixture();
    const dummyPerson = '00000000-0000-0000-0000-0000000000a1';
    await probe('POST /notifications/:id/read  (non-recipient → route removed)', {
      url: `${API_BASE}/api/notifications/${IDOR_NOTIF_ID}/read`,
      method: 'POST',
      headers: tenantA,
      expect: 'notfound',
    });
    await probe('POST /notifications/person/:personId/read-all  (route removed)', {
      url: `${API_BASE}/api/notifications/person/${dummyPerson}/read-all`,
      method: 'POST',
      headers: tenantA,
      expect: 'notfound',
    });
    await probe('GET /notifications/person/:personId  (route removed)', {
      url: `${API_BASE}/api/notifications/person/${dummyPerson}`,
      headers: tenantA,
      expect: 'notfound',
    });
    await probe('GET /notifications/person/:personId/unread-count  (route removed)', {
      url: `${API_BASE}/api/notifications/person/${dummyPerson}/unread-count`,
      headers: tenantA,
      expect: 'notfound',
    });
    // Decisive behavioral proof — independent of HTTP status semantics:
    // the victim notification must still be unread after every attack.
    if (idorNotificationStillUnread()) {
      results.pass += 1;
      console.log(
        '  ✓ victim notification read_at still NULL (IDOR did not mark it)',
      );
    } else {
      results.fail += 1;
      results.failed.push('Notification IDOR — victim row was marked read');
      console.log(
        '  ✗ victim notification read_at is SET — a non-recipient marked it read (IDOR)',
      );
    }
  } catch (e) {
    results.fail += 1;
    results.failed.push('Notification IDOR proof (seed/probe threw)');
    console.log(`  ✗ Notification IDOR proof threw: ${e.message}`);
  } finally {
    cleanupIdorNotificationFixture();
  }

  // ── Browser-direct PostgREST hardening (codex 2026-05-18 #2 / 00434) ──
  console.log(
    '\n─── Browser-direct PostgREST: write grants revoked from anon/authenticated',
  );
  try {
    const { writesLeft, selectMissing } = browserGrantPosture();
    if (writesLeft === 0) {
      results.pass += 1;
      console.log(
        '  ✓ anon/authenticated hold NO INSERT/UPDATE/DELETE on ANY public table (00434 scope)',
      );
    } else {
      results.fail += 1;
      results.failed.push('Browser write grants NOT fully revoked (00434 not applied / regressed)');
      console.log(
        `  ✗ ${writesLeft} anon/authenticated write grants still present on public tables — apply/re-apply migration 00434`,
      );
    }
    if (selectMissing === 0) {
      results.pass += 1;
      console.log(
        '  ✓ SELECT retained on Realtime-published tables (inbox/scheduler live updates intact)',
      );
    } else {
      results.fail += 1;
      results.failed.push('SELECT wrongly revoked on a Realtime table');
      console.log(
        `  ✗ ${selectMissing} Realtime-table SELECT grants missing — Realtime would break; over-broad revoke`,
      );
    }

    // Live end-to-end: a real authenticated browser session token (the
    // exact thing apps/web holds post-login) cannot write an escalation
    // row via PostgREST. Goes through env.SUPABASE_URL — the same proxy
    // the browser uses. {401,403} = denied (grant- or RLS-layer).
    const browserTok = await mintTokenFor(ADMIN_AUTH_UID);
    const wr = await fetch(`${env.SUPABASE_URL}/rest/v1/user_role_assignments`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${browserTok}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        id: '9b000000-0000-0000-0000-00000000dead',
        tenant_id: TENANT_A_ID,
        user_id: ADMIN_AUTH_UID,
        role_id: ADMIN_ROLE_ID,
        active: true,
      }),
    });
    if (wr.status === 401 || wr.status === 403) {
      results.pass += 1;
      console.log(
        `  ✓ browser-direct POST /rest/v1/user_role_assignments → HTTP ${wr.status} (self-grant denied)`,
      );
    } else {
      results.fail += 1;
      results.failed.push('Browser-direct self-grant INSERT was NOT denied');
      console.log(
        `  ✗ browser-direct self-grant → HTTP ${wr.status} — LIVE escalation; cleaning up`,
      );
      try {
        const { dbPass, dbUrl } = proofDbArgs();
        execFileSync(
          'psql',
          [dbUrl, '-v', 'ON_ERROR_STOP=1', '-c',
           `delete from public.user_role_assignments where id = '9b000000-0000-0000-0000-00000000dead';`],
          { env: { ...process.env, PGPASSWORD: dbPass }, stdio: ['ignore', 'pipe', 'pipe'] },
        );
      } catch (e) {
        console.log(`  ! browser-direct cleanup failed (non-fatal): ${e.message}`);
      }
    }

    // ── 00435 → 00436: EXECUTE posture is the Supabase RLS default ──
    // 2026-05-19 P0 incident: 00435_revoke_browser_execute_grants.sql
    // (formerly 00417) did `REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA
    // public FROM PUBLIC, anon, authenticated`. That broke every
    // browser/Realtime RLS read (RLS policies invoke
    // public.current_tenant_id(); Postgres checks EXECUTE as the
    // querying role even for SECURITY DEFINER) → 42501 outage.
    // 00436_fix_00435_rls_helper_execute_regression.sql (formerly
    // 00420, PR #31) FULLY REVERTS 00435 — it deliberately RESTORES
    // `GRANT EXECUTE ON ALL ROUTINES ... TO anon, authenticated` (the
    // RLS-critical Supabase default) and keeps ONLY the narrow
    // per-function lock of the one proven leak. So the prior "ZERO
    // browser-EXECUTE-able app routines" assertion is now the
    // CATASTROPHIC state, not the safe one — it is removed (it would
    // fail RED against the green post-00436 main, a broken gate per the
    // runnable-guards mandate). The correct EXECUTE-axis invariant is
    // now: the RLS-helper trio (current_tenant_id / current_user_id /
    // user_has_permission) MUST be browser-EXECUTE-able (else the
    // 00435-class outage has regressed), AND the narrow
    // tickets_distinct_tags lock MUST still hold (next probe). The
    // end-to-end consequence — browser RLS reads return 200 not 42501 —
    // is the dedicated regression probe added below.
    const RLS_HELPERS = [
      'current_tenant_id',
      'current_user_id',
      'user_has_permission',
    ];
    const helperExec = rlsHelperExecutePosture(RLS_HELPERS);
    if (helperExec.missing === 0) {
      results.pass += 1;
      console.log(
        `  ✓ RLS-helper EXECUTE present for anon/authenticated (${RLS_HELPERS.join(', ')}) — 00435-outage class not regressed (post-00436)`,
      );
    } else {
      results.fail += 1;
      results.failed.push(
        'RLS-helper EXECUTE missing — RLS-helper EXECUTE regression (blanket REVOKE EXECUTE class; 00435-outage type)',
      );
      console.log(
        `  ✗ ${helperExec.missing} RLS-helper grant(s) missing for anon/authenticated — RLS-helper EXECUTE regression (blanket REVOKE EXECUTE class; 00435-outage type). Apply/keep migration 00436.`,
      );
    }
    // Decisive live probe — the one proven leak, still locked post-00436.
    // 00436 KEEPS the narrow per-function lock: tickets_distinct_tags is
    // revoked from PUBLIC/anon/authenticated and granted to service_role
    // only (the app calls it via the API/service_role). Authenticated
    // TENANT_A browser token calls the SECURITY DEFINER fn with a FOREIGN
    // tenant → must be grant-denied (PostgREST 404 PGRST202 / 401 / 403).
    // Status ∉ 2xx ⇒ denied.
    const lr = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/tickets_distinct_tags`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${browserTok}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenant: TENANT_B_ID }),
    });
    if (lr.status < 200 || lr.status >= 300) {
      results.pass += 1;
      console.log(
        `  ✓ browser-direct rpc/tickets_distinct_tags(foreign tenant) → HTTP ${lr.status} (cross-tenant RPC leak denied)`,
      );
    } else {
      results.fail += 1;
      results.failed.push('LIVE cross-tenant RPC leak: tickets_distinct_tags executable browser-direct');
      console.log(
        `  ✗ browser-direct rpc/tickets_distinct_tags(foreign tenant) → HTTP ${lr.status} — LIVE cross-tenant leak; apply/keep 00436 per-function lock`,
      );
    }
    // Trio reachable: a bearer-token fn must be browser-callable (not
    // grant-denied) — public invitation/kiosk flows depend on it. Post-
    // 00436 every public routine is anon/authenticated-EXECUTE-able by
    // the restored Supabase default, so this is now a sanity check that
    // the public bearer-token surface is intact rather than a 00435
    // over-revoke guard. Bogus token ⇒ the fn runs and returns its own
    // not-found, NOT PostgREST's PGRST202 "function not found".
    const tp = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/validate_kiosk_token`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${browserTok}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_token: 'smoke-bogus-token' }),
    });
    const tpBody = (await tp.text()).slice(0, 120);
    if (tp.status !== 403 && !tpBody.includes('PGRST202')) {
      results.pass += 1;
      console.log(
        `  ✓ bearer-token trio preserved (validate_kiosk_token still reachable → HTTP ${tp.status})`,
      );
    } else {
      results.fail += 1;
      results.failed.push('bearer-token trio no longer browser-reachable (public invitation/kiosk flow broken)');
      console.log(
        `  ✗ validate_kiosk_token → HTTP ${tp.status} ${tpBody} — public kiosk/invitation flow broken`,
      );
    }

    // ── Browser-path RLS-helper EXECUTE regression (00435 outage class) ──
    // The 2026-05-19 P0 outage: migration
    // 00435_revoke_browser_execute_grants.sql (formerly 00417) ran a
    // blanket `REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA public FROM
    // PUBLIC, anon, authenticated` and so revoked EXECUTE on the
    // RLS-helper `public.current_tenant_id()` too. Postgres checks
    // function EXECUTE as the *querying role* even for SECURITY
    // DEFINER, so every logged-in browser/Realtime SELECT — whose RLS
    // USING clause invokes current_tenant_id() (others call
    // current_user_id() / user_has_permission()) — died with
    // `42501 permission denied for function current_tenant_id`. Fixed
    // by 00436_fix_00435_rls_helper_execute_regression.sql (formerly
    // 00420, PR #31): full revert of 00435 + Supabase-default EXECUTE
    // restored to anon/authenticated + narrow per-function lock of the
    // one proven leak `public.tickets_distinct_tags(uuid)`.
    //
    // Every OTHER smoke gate exercises the service_role / NestJS-API
    // path, which BYPASSES this RLS-helper EXECUTE check — that is why
    // the outage shipped undetected. This probe exercises the BROWSER
    // path: a real authenticated browser session token (the exact
    // thing apps/web holds post-login) doing a plain PostgREST SELECT
    // through the same proxy the browser uses. We mint a NON-ADMIN
    // browser token — a non-admin session is the true outage-victim
    // profile and avoids any admin OR-branch a policy might carry.
    //
    // REGRESSION (fail) fires on ANY of: (a) HTTP status !== 200,
    // (b) body contains `permission denied for function`, or
    // (c) the PostgREST JSON error `code` === '42501'. A healthy
    // `200 []` stays GREEN: a browser JWT carries no tenant_id claim,
    // so current_tenant_id() = NULL → `tenant_id = NULL` → 0 rows.
    // That empty read is the correct healthy state; this probe's job
    // is specifically to catch the 42501 / blanket-REVOKE-EXECUTE
    // class, NOT empty-read regressions.
    const rlsBrowserTok = await mintTokenFor(NONADMIN_AUTH_UID);
    for (const tbl of ['inbox_notifications', 'bookings', 'tickets']) {
      const rr = await fetch(
        `${env.SUPABASE_URL}/rest/v1/${tbl}?select=id&limit=1`,
        {
          headers: {
            apikey: env.SUPABASE_PUBLISHABLE_KEY,
            Authorization: `Bearer ${rlsBrowserTok}`,
          },
        },
      );
      const rrBody = await rr.text();
      const helperDenied = rrBody.includes('permission denied for function');
      let jsonCode42501 = false;
      try {
        if (JSON.parse(rrBody)?.code === '42501') jsonCode42501 = true;
      } catch {
        /* non-JSON body (e.g. `[]`) — not a 42501 error envelope */
      }
      const regression =
        rr.status !== 200 || helperDenied || jsonCode42501;
      if (!regression) {
        results.pass += 1;
        console.log(
          `  ✓ browser-path RLS read /rest/v1/${tbl} → HTTP 200 (RLS-helper EXECUTE intact; non-admin browser session)`,
        );
      } else {
        const sqlstate =
          helperDenied || jsonCode42501 ? ' SQLSTATE 42501' : '';
        results.fail += 1;
        results.failed.push(
          `browser-path RLS read ${tbl}${sqlstate} — browser-path RLS-helper EXECUTE regression (blanket REVOKE EXECUTE class; the 00435-outage type) — service_role-path gates miss it`,
        );
        console.log(
          `  ✗ browser-path RLS read /rest/v1/${tbl} → HTTP ${rr.status}${
            helperDenied || jsonCode42501
              ? ` (42501 permission denied for function — table ${tbl})`
              : ''
          } — browser-path RLS-helper EXECUTE regression (blanket REVOKE EXECUTE class; the 00435-outage type) — service_role-path gates miss it. ${rrBody.slice(0, 200)}`,
        );
      }
    }
  } catch (e) {
    results.fail += 1;
    results.failed.push('Browser-direct PostgREST proof threw');
    console.log(`  ✗ Browser-direct PostgREST proof threw: ${e.message}`);
  }

  console.log('');
  console.log(
    `Result: ${results.pass} pass, ${results.fail} fail${
      results.failed.length ? ` — ${results.failed.join(', ')}` : ''
    }`,
  );
  process.exit(results.fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});

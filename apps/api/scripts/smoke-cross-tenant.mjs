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
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
const PROOF_SPACE_NAME = `xtenant-11.2b-proof-${randomUUID()}`;

// Notification same-tenant IDOR proof (docs/follow-ups/audits/04-rls-security.md
// — codex 2026-05-18 remaining item #1). A notification owned by some
// TENANT_A person that is NOT the admin caller. The legacy
// NotificationController consumer routes (POST /notifications/:id/read,
// /notifications/person/:personId*, .../read-all) updated/read by
// id/personId with NO recipient binding (supabase.admin bypasses RLS) —
// any same-tenant authed user could flip anyone's read-state. Fixed UUID
// so the finally-cleanup is deterministic.
const IDOR_NOTIF_ID = '9a000000-0000-0000-0000-00000000d0e1';
const SELF_GRANT_INSERT_ID = randomUUID();

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
      delete from public.spaces where tenant_id = '${TENANT_A_ID}' and name = '${PROOF_SPACE_NAME}';
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
// 2026-05-18 #2 / migration 00415). Two layers:
//  (1) grant assertion — anon+authenticated must hold NO write DML on
//      ANY public base table (the guard's scope matches 00415's
//      `REVOKE … ON ALL TABLES`, not just an escalation subset — the
//      full-review I2 scope-mismatch fix), but MUST retain SELECT on the
//      Realtime-published set (Supabase Realtime per-subscriber RLS
//      needs it; revoking it breaks the inbox bell / scheduler live
//      updates). Deterministic red→green for the migration (verified:
//      pre-push 12 grants → RED; post-push 0 → GREEN).
//  (2) live end-to-end — a real authenticated browser session token
//      cannot INSERT into user_role_assignments via PostgREST. Post-
//      00415 this is GRANT-denied (claim-independent: holds even if a
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
  // holds INSERT/UPDATE/DELETE (scope == the 00415 REVOKE). select_missing
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

// 00420/00422 guard: browser roles MUST retain EXECUTE on RLS helper
// functions, but MUST NOT retain EXECUTE on app-owned SECURITY DEFINER
// business routines. Blanket schema-wide EXECUTE revokes break Supabase
// RLS because policies call helpers such as current_tenant_id() as the
// querying role. The security-meaningful invariant is narrower:
//   - authenticated can execute the audited bearer-token trio
//   - authenticated can execute gdpr_caller_has(), which RLS policies use
//   - authenticated cannot execute any other postgres-owned SECURITY
//     DEFINER routine, because those bypass RLS/table grants
//   - service_role can still execute them for the NestJS API path
const BEARER_TRIO = [
  'validate_invitation_token',
  'peek_invitation_token',
  'validate_kiosk_token',
];
const RLS_DEFINER_HELPERS = ['gdpr_caller_has'];
function browserExecuteGrantPosture() {
  const { dbPass, dbUrl } = proofDbArgs();
  const allowedNames = [...BEARER_TRIO, ...RLS_DEFINER_HELPERS].map((n) => `'${n}'`).join(',');
  const sql = `select count(*)
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and pg_get_userbyid(p.proowner) = 'postgres'
      and p.prosecdef
      and has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and p.proname not in (${allowedNames});

    select count(*)
    from (values
      ('public.validate_invitation_token(text,text)'::regprocedure),
      ('public.peek_invitation_token(text,text)'::regprocedure),
      ('public.validate_kiosk_token(text)'::regprocedure),
      ('public.gdpr_caller_has(text)'::regprocedure)
    ) allowed(oid)
    where not has_function_privilege('authenticated', allowed.oid, 'EXECUTE');

    select count(*)
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and pg_get_userbyid(p.proowner) = 'postgres'
      and p.prosecdef
      and not has_function_privilege('service_role', p.oid, 'EXECUTE');`;
  const out = execFileSync(
    'psql',
    [dbUrl, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { env: { ...process.env, PGPASSWORD: dbPass }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
    .toString()
    .trim()
    .split('\n')
    .map((n) => Number(n));
  return {
    riskyLeft: out[0] ?? Number.NaN,
    allowedMissing: out[1] ?? Number.NaN,
    serviceMissing: out[2] ?? Number.NaN,
  };
}

function rlsHelperExecutePosture(helpers) {
  const { dbPass, dbUrl } = proofDbArgs();
  const list = helpers.map((n) => `('${n}')`).join(',');
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
// R4 — Realtime channel CDC probe.
//
// Closes the "Realtime channel path NOT exercised end-to-end" gap on
// the `inbox_notifications` publication. Full design + scope/labels
// rationale lives in docs/follow-ups/audits/04-rls-security.md
// (Scope-of-this-probe → R4 fold). WHY-only comments inline below.
// ─────────────────────────────────────────────────────────────────────

// Per-run fixture UUIDs — driven by the post-run audit assertion that
// every fixture row was torn down (count must be 0).
const r4ProbeFixtureIds = [];

// ─── Concurrent-run safety (FIX C) ──────────────────────────────────
// Handoff Rule 2 anticipates concurrent gate runs. Two R4 probes racing
// on ADMIN's shared `raw_app_meta_data.tenant_id` will silently break
// each other: A's finally-restore can land between B's mutation and
// B's mint. A Postgres advisory lock serializes the probe across
// processes; non-blocking `pg_try_advisory_lock` lets a losing run
// skip cleanly instead of waiting.
//
// supabase-js cannot RPC `pg_*` builtins (PostgREST exposes only
// `public` schema functions by default), so we shell out to psql with
// the same connection + auth pattern already used by ensureTenantBFixture.
const R4_ADVISORY_LOCK_KEY = 0x52345200; // R4 sentinel; stable across runs

function r4DbArgs() {
  const dbPass = env.SUPABASE_DB_PASS;
  if (!dbPass) {
    throw new Error(
      'R4 advisory lock: SUPABASE_DB_PASS missing from .env',
    );
  }
  const dbUrl =
    env.SUPABASE_DB_URL ||
    'postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres';
  return { dbUrl, pgEnv: { ...process.env, PGPASSWORD: dbPass } };
}

// Spawn a long-lived psql child that holds the session open across the
// JS probe. The advisory lock is session-scoped, so it dies with the
// psql process on any crash path (no orphan-lock risk). Returns the
// child; the caller reads the t/f from pg_try_advisory_lock via
// readLockResult and releases via releaseR4Lock.
function r4LockSession() {
  const { dbUrl, pgEnv } = r4DbArgs();
  const child = spawn(
    'psql',
    [dbUrl, '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1'],
    { env: pgEnv, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  child.stdin.write(`SELECT pg_try_advisory_lock(${R4_ADVISORY_LOCK_KEY});\n`);
  return child;
}

// Read one line of psql output (the t/f from pg_try_advisory_lock) with
// a short timeout — if psql can't connect we don't want to hang.
function readLockResult(child) {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      reject(new Error('R4 lock acquire timed out (psql unresponsive)'));
    }, 10_000);
    const onData = (chunk) => {
      out += chunk.toString();
      const line = out.split(/\r?\n/).map((s) => s.trim()).find((s) => s === 't' || s === 'f');
      if (line) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve(line === 't');
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (out.includes('\nt\n') || out.trim() === 't') resolve(true);
      else if (out.includes('\nf\n') || out.trim() === 'f') resolve(false);
      else reject(new Error(`psql exited (${code}) before lock result; stderr=${err.trim()}`));
    });
  });
}

function releaseR4Lock(child) {
  if (!child || child.killed) return;
  try {
    child.stdin.write(`SELECT pg_advisory_unlock(${R4_ADVISORY_LOCK_KEY});\n\\q\n`);
    child.stdin.end();
  } catch {
    /* best-effort — session close will release the session-scoped lock */
  }
  // Hard guarantee: kill the child if it lingers.
  setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, 2000).unref();
}

// ─── Script-level advisory lock (F2 parallel-safety) ────────────────
// Distinct key from R4. Wraps the WHOLE probe run so concurrent
// `pnpm smoke:cross-tenant` invocations serialize on the parts that
// truly cannot interleave: the Slice 11.2b/11.4/11.5 proof seeds
// `spaces.create` + `request_types.use` + `visitors.configure` onto a
// SHARED user (NONADMIN_USER_ID), and any parallel Slice-10 negative
// probe (`POST /spaces` / `POST /admin/visitors/types` expects 403)
// running during that window incorrectly 2xxs.
//
// On contention, the second run emits the
// `cross-tenant-skipped-concurrent-run` marker and exits 0 — matching
// the R4-internal pattern. A session-scoped lock dies with the psql
// child, so a SIGKILL on Run A immediately unblocks Run B.
//
// Why not just extend R4? R4's lock is scoped to the realtime probe
// (it only needs to serialize the ADMIN app_metadata mutation). The
// proof seed/probes is a wider, earlier window — keeping the locks
// separate makes the failure surface (lock label + skip marker)
// unambiguous about which class skipped, and keeps R4 self-contained.
const SCRIPT_ADVISORY_LOCK_KEY = 0x58544e54; // 'XTNT' sentinel; stable across runs

function scriptLockSession() {
  const { dbUrl, pgEnv } = r4DbArgs(); // reuses the same conn args
  const child = spawn(
    'psql',
    [dbUrl, '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1'],
    { env: pgEnv, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  child.stdin.write(
    `SELECT pg_try_advisory_lock(${SCRIPT_ADVISORY_LOCK_KEY});\n`,
  );
  return child;
}

function releaseScriptLock(child) {
  if (!child || child.killed) return;
  try {
    child.stdin.write(
      `SELECT pg_advisory_unlock(${SCRIPT_ADVISORY_LOCK_KEY});\n\\q\n`,
    );
    child.stdin.end();
  } catch {
    /* best-effort — session close releases the session-scoped lock */
  }
  setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, 2000).unref();
}

async function realtimeChannelProbe() {
  console.log('\n─── R4: Realtime channel CDC probe (inbox_notifications)');

  // FIX C (concurrent-run safety): take an advisory lock BEFORE touching
  // ADMIN's shared app_metadata. A losing run skips cleanly — the parallel
  // run is presumably testing the same path.
  let lockChild = null;
  try {
    lockChild = r4LockSession();
    const acquired = await readLockResult(lockChild);
    if (!acquired) {
      console.log(
        '  · realtime probe — skipping [realtime-skipped-concurrent-run] (another smoke:cross-tenant run holds the R4 advisory lock)',
      );
      results.skipped = (results.skipped || 0) + 1;
      releaseR4Lock(lockChild);
      return;
    }
  } catch (e) {
    // If we can't even attempt the lock (psql missing / DB unreachable),
    // failing the gate is correct — the brief mandates concurrent-run
    // safety as a MUST-FIX.
    results.fail += 1;
    results.failed.push(
      `R4 realtime [realtime-lock-acquire-failed]: ${e?.message ?? e}`,
    );
    console.log(
      `  ✗ realtime probe: could not acquire R4 advisory lock — ${e?.message ?? e}`,
    );
    if (lockChild) releaseR4Lock(lockChild);
    return;
  }

  // inbox_notifications.user_id references public.users(id), NOT auth.users.id.
  const adm = supa();
  const { data: userRow, error: userErr } = await adm
    .from('users')
    .select('id')
    .eq('auth_uid', ADMIN_AUTH_UID)
    .eq('tenant_id', TENANT_A_ID)
    .maybeSingle();
  if (userErr || !userRow?.id) {
    results.fail += 1;
    results.failed.push(
      'R4 realtime: could not resolve admin users.id (cannot seed fixture)',
    );
    console.log(
      `  ✗ realtime probe: could not resolve admin users.id — ${userErr?.message ?? 'no row'}`,
    );
    releaseR4Lock(lockChild);
    return;
  }
  const adminUserId = userRow.id;

  // `let` (not const) — the cold-broker retry path reassigns this to a
  // fresh UUID per attempt so a stale subscription cannot deliver to a
  // newer attempt's filter. r4ProbeFixtureIds.push per-attempt so the
  // post-run audit covers every id we wrote.
  let fixtureId = randomUUID();
  r4ProbeFixtureIds.push(fixtureId);
  console.log(`  fixture id: ${fixtureId}`);

  const { data: adminUser, error: adminUserErr } = await adm.auth.admin
    .getUserById(ADMIN_AUTH_UID);
  if (adminUserErr || !adminUser?.user) {
    results.fail += 1;
    results.failed.push(
      `R4 realtime: could not fetch admin auth user — ${adminUserErr?.message ?? 'no user'}`,
    );
    console.log(
      `  ✗ realtime probe: could not fetch admin auth user — ${adminUserErr?.message ?? 'no user'}`,
    );
    releaseR4Lock(lockChild);
    return;
  }

  // FIX A (BLOCK-MERGE): signal/exception handlers BEFORE the mutation.
  // Ctrl-C between mutation and finally would otherwise leave the
  // tenant_id claim persisted in shared prod state. Guard flag ensures
  // emergency restore fires at most once. We also best-effort delete
  // the fixture row so SIGINT mid-probe doesn't leave it in shared DB.
  let restoreNeeded = false;
  let restoreInProgress = false;
  const emergencyRestore = async (reason) => {
    if (!restoreNeeded || restoreInProgress) return;
    restoreInProgress = true;
    try {
      const { error: restoreErr } = await adm.auth.admin.updateUserById(
        ADMIN_AUTH_UID,
        { app_metadata: { tenant_id: null } },
      );
      if (restoreErr) {
        console.error(
          `! emergency R4 restore (${reason}) FAILED: ${restoreErr.message} — manual cleanup:\n` +
            `    PGPASSWORD='${env.SUPABASE_DB_PASS}' psql "${env.SUPABASE_DB_URL || 'postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres'}" -c "update auth.users set raw_app_meta_data = raw_app_meta_data - 'tenant_id' where id = '${ADMIN_AUTH_UID}'::uuid;"`,
        );
      } else {
        console.error(`✓ emergency R4 restore (${reason}) ok`);
      }
      // Best-effort fixture-row delete (fixture-clutter hygiene, not
      // security-critical — the row carries no cross-tenant data).
      try {
        await adm.from('inbox_notifications').delete().eq('id', fixtureId);
      } catch {
        /* best-effort */
      }
    } catch (e) {
      console.error(
        `! emergency R4 restore (${reason}) threw: ${e?.message ?? e}`,
      );
    } finally {
      restoreNeeded = false;
      try { releaseR4Lock(lockChild); } catch {}
    }
  };
  const sigintHandler = () => { emergencyRestore('SIGINT').then(() => process.exit(130)).catch(() => process.exit(130)); };
  const sigtermHandler = () => { emergencyRestore('SIGTERM').then(() => process.exit(143)).catch(() => process.exit(143)); };
  const uncaughtHandler = (err) => {
    console.error('uncaughtException during R4:', err);
    emergencyRestore('uncaughtException').then(() => process.exit(2)).catch(() => process.exit(2));
  };
  process.once('SIGINT', sigintHandler);
  process.once('SIGTERM', sigtermHandler);
  process.once('uncaughtException', uncaughtHandler);

  // CRITICAL: Supabase Auth's updateUserById({ app_metadata }) MERGES
  // the supplied keys rather than REPLACING. To DELETE a key the restore
  // must send `{ tenant_id: null }` (verified empirically). The restore
  // payload is idempotent across crashed prior runs — they self-heal.
  const snapshotAppMeta = adminUser.user.app_metadata ?? {};
  const patchedAppMeta = { ...snapshotAppMeta, tenant_id: TENANT_A_ID };
  restoreNeeded = true;
  const { error: patchErr } = await adm.auth.admin.updateUserById(
    ADMIN_AUTH_UID,
    { app_metadata: patchedAppMeta },
  );
  if (patchErr) {
    restoreNeeded = false; // patch never applied
    process.removeListener('SIGINT', sigintHandler);
    process.removeListener('SIGTERM', sigtermHandler);
    process.removeListener('uncaughtException', uncaughtHandler);
    releaseR4Lock(lockChild);
    results.fail += 1;
    results.failed.push(
      `R4 realtime: could not patch app_metadata.tenant_id — ${patchErr.message}`,
    );
    console.log(
      `  ✗ realtime probe: could not patch app_metadata.tenant_id — ${patchErr.message}`,
    );
    return;
  }

  let browserSupa = null;
  let channel = null;
  try {
    // Mint a fresh ADMIN browser JWT — the patched app_metadata flows
    // into the freshly-minted access_token via the magiclink→verify
    // path. Token reuse across long probe chains would also risk the
    // access_token nearing expiry by the time the WS upgrade happens,
    // so we always mint here.
    const browserTok = await mintTokenFor(ADMIN_AUTH_UID);

    // Construct a SEPARATE supabase client bound to the browser JWT.
    // - apikey: the SUPABASE_PUBLISHABLE_KEY (anon key) — what the
    //   browser actually sends.
    // - global.headers.Authorization: pins the JWT for REST calls (not
    //   used here, but required for consistency with the WS handshake).
    // - realtime.params.apikey: forwarded as a query-string param on
    //   the WebSocket upgrade — Realtime reads JWT claims off this for
    //   per-subscriber RLS evaluation. supabase-js v2's setAuth path is
    //   the canonical way to bind a user JWT to a Realtime client.
    // - auth.persistSession=false: smoke is one-shot; no localStorage.
    // - auth.autoRefreshToken=false: short-lived token, no refresh.
    browserSupa = createClient(
      env.SUPABASE_URL,
      env.SUPABASE_PUBLISHABLE_KEY,
      {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${browserTok}` } },
        realtime: { params: { apikey: env.SUPABASE_PUBLISHABLE_KEY } },
      },
    );
    // The canonical browser-side flow uses `setSession` after sign-in to
    // bind the JWT to the realtime socket. We replicate that without
    // mounting a full auth flow.
    browserSupa.realtime.setAuth(browserTok);

    // 2-attempt retry: the Supabase Realtime broker's FIRST subscription
    // to a (filter, role) combo can take >15s on a cold start. Empirically
    // observed flake rate ~1/6 cold runs (other 5 arrive 207-532ms); warm
    // path P99 < 1s. We retry ONCE with a fresh fixtureId + fresh channel
    // on cdc-timeout. Real RLS-helper EXECUTE regressions on the Realtime
    // leg (the 00435-class outage this probe exists to catch) would fail
    // BOTH attempts because they are deterministic — the retry doesn't
    // mask the catastrophic class, only cold-broker noise. subscribe-
    // failed is NOT a cold-broker symptom (the WS handshake either works
    // or it doesn't) so we fail-fast on that — no retry.
    const attemptReasons = [];
    let cdcLatencyMs = null;
    let succeeded = false;
    const MAX_ATTEMPTS = 2;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        // Tear down the prior channel and start over with a fresh fixture id.
        // The stale channel might still be alive on the broker side — if its
        // delayed event ever arrives it would land on the OLD channel callback
        // (already unsubscribed), not the new one, so no cross-attempt pollution.
        try { await channel?.unsubscribe(); } catch { /* best-effort */ }
        channel = null;
        fixtureId = randomUUID();
        r4ProbeFixtureIds.push(fixtureId);
        console.log(`  retrying with fresh fixture id: ${fixtureId} (cold-broker mitigation)`);
      }

      let receivedPayload = null;
      const channelName = `r4-probe-${randomUUID()}`;
      channel = browserSupa
        .channel(channelName)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'inbox_notifications',
            filter: `id=eq.${fixtureId}`,
          },
          (payload) => {
            receivedPayload = payload;
          },
        );

      // Subscribe is async-callback-shaped. Resolve on SUBSCRIBED; reject
      // on any terminal failure status. Bound the wait so a stuck handshake
      // fails the probe instead of hanging forever.
      let subscribeError = null;
      let subscribeStatus = null;
      try {
        subscribeStatus = await new Promise((resolve, reject) => {
          const subscribeDeadline = setTimeout(() => {
            reject(new Error('subscribe handshake timed out after 10000ms'));
          }, 10_000);
          channel.subscribe((status, err) => {
            if (status === 'SUBSCRIBED') {
              clearTimeout(subscribeDeadline);
              resolve(status);
            } else if (
              status === 'CHANNEL_ERROR' ||
              status === 'TIMED_OUT' ||
              status === 'CLOSED'
            ) {
              clearTimeout(subscribeDeadline);
              reject(err || new Error(`subscribe status: ${status}`));
            }
          });
        });
      } catch (e) {
        subscribeError = e;
      }

      if (subscribeError || subscribeStatus !== 'SUBSCRIBED') {
        const reason =
          subscribeError?.message ??
          `unexpected status ${subscribeStatus ?? 'null'}`;
        attemptReasons.push(`attempt ${attempt}: subscribe-failed (${reason})`);
        // subscribe-failed is NOT cold-broker — fail-fast, no retry.
        results.fail += 1;
        results.failed.push(
          `R4 realtime [realtime-channel-subscribe-failed]: ${attemptReasons.join(' | ')}`,
        );
        console.log(
          `  ✗ realtime channel subscribe failed [realtime-channel-subscribe-failed] — ${reason}`,
        );
        return;
      }

      console.log('  realtime channel SUBSCRIBED; inserting fixture row');

      // Short post-subscribe settle. Empirically the Realtime broker
      // SOMETIMES needs a few hundred ms after the SUBSCRIBED ack before
      // its per-subscriber row-filter pipeline is actually wired up to
      // the replication slot. Without this, ~1/7 runs missed the event
      // (the slot emitted before the subscription filter was provisioned
      // server-side). 250ms is well under the 15s probe budget and
      // dwarfs the publication→WS latency, so it does NOT mask a real
      // regression.
      await new Promise((r) => setTimeout(r, 250));

      // Service-role INSERT — bypasses RLS (insert always succeeds when
      // the row matches FKs) so the test of CDC delivery is isolated
      // from the RLS happy path. The DELIVERY side still depends on the
      // per-subscriber RLS policy seeing the row for the browser JWT.
      // event_kind prefix `r4-probe-` lets the post-run audit query
      // confirm zero leaked rows.
      const insertStart = Date.now();
      const { error: insErr } = await adm.from('inbox_notifications').insert({
        id: fixtureId,
        tenant_id: TENANT_A_ID,
        user_id: adminUserId,
        event_kind: 'r4-probe-realtime-cdc',
        payload: { fixtureId, probe: 'r4-realtime-channel', attempt },
      });
      if (insErr) {
        results.fail += 1;
        results.failed.push(
          `R4 realtime: fixture INSERT failed (attempt ${attempt}) — ${insErr.message}`,
        );
        console.log(
          `  ✗ realtime probe: fixture INSERT failed — ${insErr.message}`,
        );
        return;
      }

      // Wait for the CDC event to land on the channel callback.
      // See timeout rationale in the function docstring above.
      const timeoutMs = 15000;
      const deadline = Date.now() + timeoutMs;
      while (!receivedPayload && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      cdcLatencyMs = Date.now() - insertStart;

      if (!receivedPayload) {
        attemptReasons.push(
          `attempt ${attempt}: cdc-timeout (${timeoutMs}ms, fixture ${fixtureId})`,
        );
        if (attempt < MAX_ATTEMPTS) {
          console.log(
            `  · attempt ${attempt}/${MAX_ATTEMPTS}: cdc-timeout — retrying once (cold-broker mitigation)`,
          );
          // Best-effort delete the timed-out fixture row to keep audit
          // clean. The outer `finally` only deletes the CURRENT fixtureId
          // (the one from the succeeded attempt), so stale rows would
          // accumulate otherwise.
          try {
            await adm.from('inbox_notifications').delete().eq('id', fixtureId);
          } catch { /* best-effort */ }
          continue;
        }
        results.fail += 1;
        results.failed.push(
          `R4 realtime [realtime-cdc-timeout]: ${attemptReasons.join(' | ')} — RLS-helper EXECUTE regression on the Realtime leg (a 00435-class outage) OR Realtime backend outage / publication drift / replication-slot stall (failed BOTH attempts so this is not a cold-broker false-positive)`,
        );
        console.log(
          `  ✗ realtime CDC did not arrive after ${MAX_ATTEMPTS} attempts [realtime-cdc-timeout] — both attempts failed, not a cold-broker false-positive`,
        );
        return;
      }

      // Validate payload before declaring success.
      const newRow = receivedPayload?.new ?? {};
      if (newRow.id !== fixtureId) {
        results.fail += 1;
        results.failed.push(
          `R4 realtime [realtime-payload-mismatch] (attempt ${attempt}): received id ${String(newRow.id)} !== fixture ${fixtureId}`,
        );
        console.log(
          `  ✗ realtime payload id mismatch [realtime-payload-mismatch] — got ${String(newRow.id)}, expected ${fixtureId}`,
        );
        return;
      }
      if (newRow.tenant_id !== TENANT_A_ID) {
        // Defense-in-depth: filter+RLS should already gate this, but if
        // this ever fires it's a Realtime-layer cross-tenant leak — load
        // a precise label so it surfaces loudly.
        results.fail += 1;
        results.failed.push(
          `R4 realtime [realtime-leak-foreign-tenant] (attempt ${attempt}): received tenant_id ${String(newRow.tenant_id)} !== ${TENANT_A_ID}`,
        );
        console.log(
          `  ✗ realtime payload tenant_id leak [realtime-leak-foreign-tenant] — got ${String(newRow.tenant_id)}, expected ${TENANT_A_ID}`,
        );
        return;
      }

      // Success.
      succeeded = true;
      if (attempt > 1) {
        console.log(
          `  (succeeded on attempt ${attempt} after cold-broker retry)`,
        );
      }
      break;
    }

    if (!succeeded) return; // defensive — all failure paths returned above

    results.pass += 1;
    console.log(
      `  ✓ Realtime channel /inbox_notifications → received CDC event for fixture ${fixtureId} in ${cdcLatencyMs} ms (browser JWT + publication membership + per-subscriber RLS eval all intact)`,
    );
  } finally {
    // Teardown runs on EVERY exit path. Order: channel close → fixture
    // delete → app_metadata restore → restore verification → signal
    // handler deregistration → lock release. Each step is independent
    // so a failure in one does not skip the next.
    if (channel) {
      try {
        await channel.unsubscribe();
      } catch (e) {
        console.log(
          `  ! realtime channel unsubscribe failed (non-fatal): ${e?.message ?? e}`,
        );
      }
    }
    if (browserSupa) {
      try {
        // Removing from the client registry lets the process exit
        // cleanly (otherwise WS heartbeats keep the event loop alive).
        await browserSupa.removeAllChannels();
      } catch {
        /* best-effort */
      }
    }
    try {
      const { error: delErr } = await adm
        .from('inbox_notifications')
        .delete()
        .eq('id', fixtureId);
      if (delErr) {
        console.log(
          `  ! realtime fixture delete failed (non-fatal): ${delErr.message} — id ${fixtureId} may have leaked, audit with: psql -c "select count(*) from public.inbox_notifications where event_kind like 'r4-probe-%';"`,
        );
      }
    } catch (e) {
      console.log(
        `  ! realtime fixture delete threw (non-fatal): ${e?.message ?? e} — id ${fixtureId} may have leaked`,
      );
    }
    // FIX B (BLOCK-MERGE): restore is GATE-FAILING, not log-only.
    // A green CDC probe + failed restore = silently dirty prod state.
    // Send { tenant_id: null } (not the snapshot) — updateUserById
    // merges, and `null` is the only payload that DELETES the key.
    let restoreOk = false;
    try {
      const { error: restoreErr } = await adm.auth.admin.updateUserById(
        ADMIN_AUTH_UID,
        { app_metadata: { tenant_id: null } },
      );
      if (restoreErr) {
        results.fail += 1;
        results.failed.push(
          `realtime-admin-metadata-restore-failed: ${restoreErr.message} — ADMIN.app_metadata.tenant_id is leaked; manual psql: \`update auth.users set raw_app_meta_data = raw_app_meta_data - 'tenant_id' where id = '${ADMIN_AUTH_UID}'::uuid;\``,
        );
        console.log(
          `  ✗ realtime-admin-metadata-restore-failed — ADMIN's tenant_id claim still set; gate failed.`,
        );
      } else {
        restoreOk = true;
        console.log('  ✓ realtime: ADMIN app_metadata restore call ok');
      }
    } catch (e) {
      results.fail += 1;
      results.failed.push(
        `realtime-admin-metadata-restore-threw: ${e?.message ?? e} — manual psql: \`update auth.users set raw_app_meta_data = raw_app_meta_data - 'tenant_id' where id = '${ADMIN_AUTH_UID}'::uuid;\``,
      );
      console.log(
        `  ✗ realtime-admin-metadata-restore-threw — gate failed: ${e?.message ?? e}`,
      );
    }
    // FIX B (BLOCK-MERGE): VERIFY the key was actually deleted, not
    // just set to null. If verification reads tenant_id !== undefined,
    // the next gate run silently picks up the leaked claim.
    if (restoreOk) {
      try {
        const { data: verifyData, error: verifyErr } =
          await adm.auth.admin.getUserById(ADMIN_AUTH_UID);
        const tenantClaim = verifyData?.user?.app_metadata?.tenant_id;
        if (verifyErr || tenantClaim != null) {
          results.fail += 1;
          results.failed.push(
            `realtime-admin-metadata-restore-verification-failed: tenant_id=${JSON.stringify(tenantClaim)} err=${verifyErr?.message ?? 'none'}`,
          );
          console.log(
            `  ✗ realtime-admin-metadata-restore-verification-failed — tenant_id still present (${JSON.stringify(tenantClaim)})`,
          );
        } else {
          restoreNeeded = false;
          console.log(
            '  ✓ realtime: ADMIN app_metadata.tenant_id verified absent',
          );
        }
      } catch (e) {
        results.fail += 1;
        results.failed.push(
          `realtime-admin-metadata-restore-verification-threw: ${e?.message ?? e}`,
        );
        console.log(
          `  ✗ realtime-admin-metadata-restore-verification-threw — ${e?.message ?? e}`,
        );
      }
    }
    // Deregister signal handlers now that the normal restore path
    // completed (success or fail-the-gate; either way the JS finally
    // ran). The emergency restore would no-op (restoreNeeded=false)
    // even if it fired after this point, but removing the handlers
    // keeps signal semantics clean for callers that orchestrate this.
    process.removeListener('SIGINT', sigintHandler);
    process.removeListener('SIGTERM', sigtermHandler);
    process.removeListener('uncaughtException', uncaughtHandler);
    // FIX C: release the advisory lock so concurrent runs can proceed.
    releaseR4Lock(lockChild);
  }
}

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

  // F2 parallel-safety: acquire the script-level advisory lock FIRST.
  // On contention, emit the skip marker and exit 0 (the second run
  // would race the Slice-11.2b proof seed against the Slice-10 negative
  // probes — see SCRIPT_ADVISORY_LOCK_KEY rationale above). Session-
  // scoped so a crashed run releases automatically.
  const scriptLockChild = scriptLockSession();
  let scriptLockAcquired = false;
  try {
    scriptLockAcquired = await readLockResult(scriptLockChild);
  } catch (e) {
    // psql unreachable / DB down → fail the gate. The brief mandates
    // concurrent-run safety as a MUST-FIX; if we can't even attempt
    // the lock, we cannot guarantee safety.
    console.error(
      `cross-tenant [script-lock-acquire-failed]: ${e?.message ?? e}`,
    );
    try { releaseScriptLock(scriptLockChild); } catch {}
    process.exit(1);
  }
  if (!scriptLockAcquired) {
    console.log(
      'cross-tenant-skipped-concurrent-run — another smoke:cross-tenant run holds the script advisory lock; this run is a no-op to avoid racing the shared-DB fixture seeds. Exiting 0.',
    );
    releaseScriptLock(scriptLockChild);
    process.exit(0);
  }

  try {
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
      body: { name: PROOF_SPACE_NAME, type: 'site' },
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

  // ── Browser-direct PostgREST hardening (codex 2026-05-18 #2 / 00415) ──
  console.log(
    '\n─── Browser-direct PostgREST: write grants revoked from anon/authenticated',
  );
  try {
    const { writesLeft, selectMissing } = browserGrantPosture();
    if (writesLeft === 0) {
      results.pass += 1;
      console.log(
        '  ✓ anon/authenticated hold NO INSERT/UPDATE/DELETE on ANY public table (00415 scope)',
      );
    } else {
      results.fail += 1;
      results.failed.push('Browser write grants NOT fully revoked (00415 not applied / regressed)');
      console.log(
        `  ✗ ${writesLeft} anon/authenticated write grants still present on public tables — apply/re-apply migration 00415`,
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
        id: SELF_GRANT_INSERT_ID,
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
           `delete from public.user_role_assignments where id = '${SELF_GRANT_INSERT_ID}';`],
          { env: { ...process.env, PGPASSWORD: dbPass }, stdio: ['ignore', 'pipe', 'pipe'] },
        );
      } catch (e) {
        console.log(`  ! browser-direct cleanup failed (non-fatal): ${e.message}`);
      }
    }

    // Normal browser/PostgREST read on an RLS-protected table. This is
    // the regression 00417 missed: helper EXECUTE over-revocation turns
    // harmless RLS reads into 42501 "permission denied for function
    // current_tenant_id". With the safe 00420/00422 posture this returns
    // 200 (usually [] because this project does not mint tenant_id claims).
    const rlsRead = await fetch(
      `${env.SUPABASE_URL}/rest/v1/bookings?select=id&limit=1`,
      {
        headers: {
          apikey: env.SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${browserTok}`,
        },
      },
    );
    const rlsReadBody = await rlsRead.text();
    if (rlsRead.status === 200) {
      results.pass += 1;
      console.log(
        '  ✓ browser-direct RLS read still works (bookings select did not hit helper EXECUTE denial)',
      );
    } else {
      results.fail += 1;
      results.failed.push('Browser RLS read failed after routine EXECUTE changes');
      console.log(
        `  ✗ browser-direct bookings read → HTTP ${rlsRead.status}; body=${rlsReadBody.slice(0, 180)}`,
      );
    }

    // ── 00420/00422: RLS helpers preserved, risky SECURITY DEFINER routines revoked ──
    // Codex done-check 2026-05-18 found a LIVE cross-tenant leak via
    // SECURITY DEFINER tickets_distinct_tags(tenant). 00420 corrected the
    // unsafe blanket 00417 revoke; 00422 revokes browser EXECUTE from the
    // remaining app-owned SECURITY DEFINER business routines while keeping
    // RLS helpers executable.
    const { riskyLeft, allowedMissing, serviceMissing } = browserExecuteGrantPosture();
    if (riskyLeft === 0) {
      results.pass += 1;
      console.log(
        '  ✓ anon/authenticated cannot EXECUTE app-owned SECURITY DEFINER routines except RLS/bearer allowlist',
      );
    } else {
      results.fail += 1;
      results.failed.push('Risky SECURITY DEFINER routines still browser-executable');
      console.log(
        `  ✗ ${riskyLeft} app-owned SECURITY DEFINER routines still anon/authenticated-EXECUTABLE beyond allowlist — apply 00422`,
      );
    }
    if (allowedMissing === 0) {
      results.pass += 1;
      console.log('  ✓ RLS/bearer routine EXECUTE allowlist is preserved');
    } else {
      results.fail += 1;
      results.failed.push('Required RLS/bearer routine EXECUTE missing');
      console.log(
        `  ✗ ${allowedMissing} required RLS/bearer routines lost authenticated EXECUTE — over-broad revoke`,
      );
    }
    if (serviceMissing === 0) {
      results.pass += 1;
      console.log('  ✓ service_role retains EXECUTE on app-owned SECURITY DEFINER routines');
    } else {
      results.fail += 1;
      results.failed.push('service_role EXECUTE missing on SECURITY DEFINER routines');
      console.log(
        `  ✗ ${serviceMissing} app-owned SECURITY DEFINER routines missing service_role EXECUTE`,
      );
    }
    // Decisive live red→green: the proven leak. Authenticated TENANT_A
    // browser token calls the SECURITY DEFINER fn with a FOREIGN tenant.
    // Pre-fix: HTTP 200 + that tenant's tags. Post-fix: grant-denied
    // (PostgREST 404 PGRST202 / 401 / 403). Status outside 2xx = denied.
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
        `  ✗ browser-direct rpc/tickets_distinct_tags(foreign tenant) → HTTP ${lr.status} — LIVE cross-tenant leak; apply 00417`,
      );
    }
    // Trio preserved: a bearer-token fn must still be reachable (not
    // grant-denied) — else 00417 over-revoked and kiosk/invitation
    // flows break. Bogus token ⇒ the fn runs and returns its own
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
      results.failed.push('00417 over-revoked: bearer-token trio no longer reachable');
      console.log(
        `  ✗ validate_kiosk_token → HTTP ${tp.status} ${tpBody} — 00417 broke the kiosk/invitation flow`,
      );
    }
  } catch (e) {
    results.fail += 1;
    results.failed.push('Browser-direct PostgREST proof threw');
    console.log(`  ✗ Browser-direct PostgREST proof threw: ${e.message}`);
  }

  console.log('');
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
      // F2: per-run unique name; the cleanup deletes by this name and
      // a static name would cross-delete a parallel run's row.
      body: { name: PROOF_SPACE_NAME, type: 'site' },
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
        // F2: per-run UUID — only observable on regression (denial is the
        // green path; the id never lands). Avoids cross-process unique
        // collision in the catastrophic double-regression case.
        id: SELF_GRANT_INSERT_ID,
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
           `delete from public.user_role_assignments where id = '${SELF_GRANT_INSERT_ID}';`],
          { env: { ...process.env, PGPASSWORD: dbPass }, stdio: ['ignore', 'pipe', 'pipe'] },
        );
      } catch (e) {
        console.log(`  ! browser-direct cleanup failed (non-fatal): ${e.message}`);
      }
    }

    // ── R1 (handoff-residuals 2026-05-20): /api/persons/me must not 500 ──
    // The exact prod incident this gate replaces: a missing `@Get('me')`
    // route in person.controller.ts let `GET /api/persons/me` fall through
    // to `@Get(':id')` with `id='me'` → Postgres invalid-UUID → unwrapped
    // raw throw → global filter wrapped as `unknown.server_error` 500.
    // Healthy state: 200 with a JSON body carrying an `id`. Failure modes:
    //   - 500 unknown.server_error  → R1 regressed (someone reordered the
    //     routes or removed @Get('me'))
    //   - !200 with any other code  → an AppError shape did surface but
    //     the endpoint is still broken
    //   - non-JSON body / no `id`   → wrong shape regression
    // Same minted ADMIN browser token used for the self-grant probe above.
    {
      const pr = await fetch(`${API_BASE}/api/persons/me`, {
        headers: {
          Authorization: `Bearer ${browserTok}`,
          'X-Tenant-Id': TENANT_A_ID,
        },
      });
      const prBodyRaw = await pr.text();
      let prCode = null;
      let prId = null;
      try {
        const parsed = JSON.parse(prBodyRaw);
        prCode = parsed?.code ?? null;
        prId = parsed?.id ?? null;
      } catch {
        /* non-JSON body — caught below as wrong-shape regression */
      }
      const personsMeRegression =
        pr.status !== 200 || typeof prId !== 'string' || prId.length === 0;
      if (!personsMeRegression) {
        results.pass += 1;
        console.log(
          `  ✓ browser-token GET /api/persons/me → HTTP 200 with person.id (R1: real @Get('me') route + AppError envelope intact)`,
        );
      } else {
        results.fail += 1;
        const reason =
          pr.status === 500 && prCode === 'unknown.server_error'
            ? 'unknown.server_error — raw throw in persons-me path; the original R1 bug regressed'
            : pr.status !== 200
              ? `HTTP ${pr.status}${prCode ? ` (code=${prCode})` : ''} — wrong status`
              : 'wrong body shape — missing person.id';
        results.failed.push(`R1 /api/persons/me regression: ${reason}`);
        console.log(
          `  ✗ browser-token GET /api/persons/me → ${reason}. Body: ${prBodyRaw.slice(0, 200)}`,
        );
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
    // Three named failure classes (R3 precision fold, 2026-05-20):
    //   (a) `42501-rls-helper`  — the catastrophic 00435-outage class
    //   (b) `postgrest-4xx`     — PostgREST 4xx unrelated to RLS helpers
    //   (c) `transport-or-5xx`  — fetch threw, body is not JSON, or >= 500
    // Fail-closed binary outcome preserved; only the label is precise.
    // Mirrors the same three-class vocabulary `smoke:prod-e2e` (R5) ships.
    //
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
    // Fail-closed binary outcome preserved — ANY non-200 still flags
    // the probe — but the failure LABEL is split into three named
    // classes so a 504 cold start or a 4xx PostgREST envelope unrelated
    // to function permissions is not mislabeled as the catastrophic
    // 42501 / blanket-REVOKE-EXECUTE class (codex MERGE-with-nit on
    // PR #34 `5d50dd55`; R3 in handoff-residuals 2026-05-20). Mirrors
    // the same three-class naming model `smoke:prod-e2e` (R5) ships:
    //
    //   (a) `42501-rls-helper`    — the actual catastrophic regression.
    //       Body contains `permission denied for function` OR parsed
    //       JSON `code === '42501'`. The 00435-outage class.
    //   (b) `postgrest-4xx`       — HTTP status in 400..499 but body
    //       does NOT match (a). Surfaces the PostgREST `.code` field
    //       (e.g. `42P01` table not found, `42703` column not found,
    //       `PGRST116` no rows, JWT errors). Unrelated to RLS-helper
    //       EXECUTE; do not blame it on 00435-class.
    //   (c) `transport-or-5xx`    — HTTP status >= 500, body is not
    //       JSON, or fetch threw (DNS/network/abort). Cold-start /
    //       gateway / unreachable; not a security regression.
    //
    // A healthy `200 []` stays GREEN: a browser JWT carries no
    // tenant_id claim, so current_tenant_id() = NULL → `tenant_id =
    // NULL` → 0 rows. That empty read is the correct healthy state;
    // this probe's job is specifically to catch the 42501 /
    // blanket-REVOKE-EXECUTE class, NOT empty-read regressions.
    const rlsBrowserTok = await mintTokenFor(NONADMIN_AUTH_UID);
    for (const tbl of ['inbox_notifications', 'bookings', 'tickets']) {
      // Per-table try/catch so a fetch throw on one table classifies as
      // (c) `transport-or-5xx` against THAT table, instead of aborting
      // the whole probe loop into the outer catch (which would lose
      // per-table attribution).
      let rr;
      let rrBody;
      let transportReason = null;
      try {
        rr = await fetch(
          `${env.SUPABASE_URL}/rest/v1/${tbl}?select=id&limit=1`,
          {
            headers: {
              apikey: env.SUPABASE_PUBLISHABLE_KEY,
              Authorization: `Bearer ${rlsBrowserTok}`,
            },
          },
        );
        rrBody = await rr.text();
      } catch (e) {
        transportReason = e?.message || String(e);
      }

      // ── 200 happy path ─────────────────────────────────────────────
      // Codex tertiary (PR #38): a 200 status is NOT proof of a healthy
      // PostgREST select on its own. Proxies, CDN error pages, or
      // upstream contract drift can deliver `HTTP 200 + HTML` (or `HTTP
      // 200 + JSON envelope code=42501`, a bizarre contract violation).
      // Parse the body and require a JSON array (the only legitimate
      // PostgREST select shape) before incrementing `results.pass`.
      // Otherwise fail-close with a precise class label so a silently
      // mis-shaped 200 can never mask the very regression the probe is
      // here to catch.
      if (!transportReason && rr.status === 200) {
        const ct = rr.headers.get('content-type') || '';
        const looksJson = ct.includes('application/json');
        if (!looksJson) {
          // 200 + non-JSON body — never legitimate from PostgREST. Treat
          // as transport/5xx class (proxy/CDN error page, gateway HTML,
          // etc.) so a green run is genuinely green.
          results.fail += 1;
          results.failed.push(
            `browser-path RLS read ${tbl} [transport-or-5xx]: HTTP 200 + non-JSON content-type "${ct}" — ${rrBody.slice(0, 160)}`,
          );
          console.log(
            `  ✗ browser-path RLS read /rest/v1/${tbl} [transport-or-5xx] → HTTP 200 + non-JSON content-type "${ct}" — fail-close on suspicious response (proxy/CDN error page?); not an RLS-helper EXECUTE regression.`,
          );
          continue;
        }
        let parsed200;
        try {
          parsed200 = JSON.parse(rrBody);
        } catch {
          results.fail += 1;
          results.failed.push(
            `browser-path RLS read ${tbl} [transport-or-5xx]: HTTP 200 + unparseable JSON — ${rrBody.slice(0, 160)}`,
          );
          console.log(
            `  ✗ browser-path RLS read /rest/v1/${tbl} [transport-or-5xx] → HTTP 200 + JSON parse error — fail-close on unparseable body; not an RLS-helper EXECUTE regression.`,
          );
          continue;
        }
        if (!Array.isArray(parsed200)) {
          // Could be `{code, message, ...}` PostgREST error envelope.
          // If the envelope says 42501 / permission denied for function,
          // classify as class (a) even though the status is 200 (it's a
          // catastrophic contract violation but still THE regression).
          const code = (parsed200 && typeof parsed200 === 'object' && parsed200.code) || '';
          const msg =
            (parsed200 && typeof parsed200 === 'object' && parsed200.message) || '';
          if (code === '42501' || /permission denied for function/i.test(msg)) {
            results.fail += 1;
            results.failed.push(
              `browser-path RLS read ${tbl} [42501-rls-helper]: HTTP 200 envelope code=42501 — ${rrBody.slice(0, 160)}`,
            );
            console.log(
              `  ✗ browser-path RLS read /rest/v1/${tbl} [42501-rls-helper] → HTTP 200 + JSON envelope code=42501 (catastrophic RLS-helper regression delivered with a 200 status — fail-close).`,
            );
            continue;
          }
          // Non-array, non-42501-error JSON: not a PostgREST select
          // shape. Fail closed under transport-or-5xx (upstream contract
          // drift), not as a green pass.
          results.fail += 1;
          results.failed.push(
            `browser-path RLS read ${tbl} [transport-or-5xx]: HTTP 200 + non-array JSON — ${rrBody.slice(0, 160)}`,
          );
          console.log(
            `  ✗ browser-path RLS read /rest/v1/${tbl} [transport-or-5xx] → HTTP 200 + JSON is not an array (PostgREST select returns [] or [{...}]) — fail-close on suspicious shape.`,
          );
          continue;
        }
        // Genuine pass: HTTP 200 + JSON array (PostgREST SELECT result).
        results.pass += 1;
        console.log(
          `  ✓ browser-path RLS read /rest/v1/${tbl} → HTTP 200 (RLS-helper EXECUTE intact; non-admin browser session; ${parsed200.length} row(s))`,
        );
        continue;
      }

      // ── Classify non-200 / transport failures ──────────────────────
      // Parse the body once; if non-JSON, we treat it as class (c)
      // when paired with a 4xx (PostgREST always returns JSON on
      // failure, so non-JSON 4xx is transport/proxy interference).
      // Codex tertiary (PR #38): also capture content-type so the
      // class (a) substring check is gated on a JSON envelope; a 4xx
      // HTML proxy error page that happens to contain the literal
      // text "permission denied for function" must NOT be mislabeled
      // as the 42501 RLS-helper class.
      const ct = !transportReason ? rr.headers.get('content-type') || '' : '';
      const looksJson = ct.includes('application/json');
      let parsedBody = null;
      let bodyIsJson = false;
      if (!transportReason) {
        try {
          parsedBody = JSON.parse(rrBody);
          bodyIsJson = true;
        } catch {
          /* non-JSON body */
        }
      }

      // Class (a): 42501-rls-helper — only when the response actually
      // looks like a PostgREST JSON envelope. Gate the substring check
      // on `looksJson` (content-type) AND `bodyIsJson` (body actually
      // parses) so an HTML proxy error page containing the literal
      // text "permission denied for function" can't be misattributed.
      const helperDenied =
        !transportReason &&
        looksJson &&
        bodyIsJson &&
        /permission denied for function/i.test(rrBody);
      const jsonCode42501 = bodyIsJson && parsedBody?.code === '42501';
      if (helperDenied || jsonCode42501) {
        const status = rr?.status ?? 'n/a';
        results.fail += 1;
        results.failed.push(
          `browser-path RLS read ${tbl} [42501-rls-helper]: HTTP ${status} SQLSTATE 42501 — ${rrBody.slice(0, 160)}`,
        );
        console.log(
          `  ✗ browser-path RLS read /rest/v1/${tbl} [42501-rls-helper] → HTTP ${status} (42501 permission denied for function — table ${tbl}) — 42501 RLS-helper EXECUTE regression (blanket REVOKE EXECUTE class; the 00435-outage type) — service_role-path gates miss it. ${rrBody.slice(0, 160)}`,
        );
        continue;
      }

      // Class (c): transport-or-5xx — fetch threw, status >= 500, or non-JSON body
      if (
        transportReason ||
        (rr.status >= 500) ||
        !bodyIsJson
      ) {
        const reason = transportReason
          ? `fetch threw: ${transportReason}`
          : `HTTP ${rr.status}${bodyIsJson ? '' : ' non-JSON body'} — ${rrBody?.slice(0, 160) ?? ''}`;
        results.fail += 1;
        results.failed.push(
          `browser-path RLS read ${tbl} [transport-or-5xx]: ${reason}`,
        );
        console.log(
          `  ✗ browser-path RLS read /rest/v1/${tbl} [transport-or-5xx] → ${reason} — not an RLS-helper EXECUTE regression; transport / gateway / unreachable. Investigate cold-start, proxy, or DNS before blaming 00435-class.`,
        );
        continue;
      }

      // Class (b): postgrest-4xx — status in 400..499, body is JSON, not 42501
      const pgCode = parsedBody?.code ?? '<no .code>';
      const pgMessage = parsedBody?.message ?? '';
      results.fail += 1;
      results.failed.push(
        `browser-path RLS read ${tbl} [postgrest-4xx]: HTTP ${rr.status} code=${pgCode} — ${String(pgMessage).slice(0, 160)}`,
      );
      console.log(
        `  ✗ browser-path RLS read /rest/v1/${tbl} [postgrest-4xx] → HTTP ${rr.status} — code=${pgCode} — ${String(pgMessage).slice(0, 160)} — PostgREST 4xx unrelated to RLS-helper EXECUTE (not the 00435-outage class). ${rrBody.slice(0, 160)}`,
      );
    }
  } catch (e) {
    results.fail += 1;
    results.failed.push('Browser-direct PostgREST proof threw');
    console.log(`  ✗ Browser-direct PostgREST proof threw: ${e.message}`);
  }

  // ── R4 (handoff-residuals 2026-05-20): Realtime channel CDC probe ──
  // Runs outside the browser-direct PostgREST try block so a thrown
  // failure on the REST leg does not skip the Realtime leg. The probe
  // has its own internal try/finally for teardown safety; failures
  // surface via results.fail with one of the four R4 labels:
  // realtime-channel-subscribe-failed, realtime-cdc-timeout,
  // realtime-payload-mismatch, realtime-leak-foreign-tenant.
  try {
    await realtimeChannelProbe();
  } catch (e) {
    results.fail += 1;
    results.failed.push(`R4 realtime probe threw: ${e?.message ?? e}`);
    console.log(`  ✗ R4 realtime probe threw: ${e?.message ?? e}`);
  }

  // FIX F: post-run fixture-row teardown verification. Service-role
  // SELECT must return zero rows for every fixture id minted this run.
  // Any nonzero count = the finally-delete failed silently — a leak in
  // the shared remote DB that the gate must surface.
  if (r4ProbeFixtureIds.length) {
    try {
      const { data: leakRows, error: leakErr } = await supa()
        .from('inbox_notifications')
        .select('id')
        .in('id', r4ProbeFixtureIds);
      if (leakErr) {
        results.fail += 1;
        results.failed.push(
          `R4 fixture teardown verification errored: ${leakErr.message}`,
        );
        console.log(
          `  ✗ R4 fixture teardown verification errored: ${leakErr.message}`,
        );
      } else if (leakRows && leakRows.length > 0) {
        results.fail += 1;
        results.failed.push(
          `R4 fixture teardown leak: ${leakRows.length} row(s) still present (${leakRows.map((r) => r.id).join(', ')})`,
        );
        console.log(
          `  ✗ R4 fixture teardown leak — ${leakRows.length} row(s) still in inbox_notifications: ${leakRows.map((r) => r.id).join(', ')}`,
        );
      } else {
        console.log(
          `  ✓ R4 fixture teardown verified: 0 of ${r4ProbeFixtureIds.length} fixture rows remain`,
        );
      }
    } catch (e) {
      results.fail += 1;
      results.failed.push(
        `R4 fixture teardown verification threw: ${e?.message ?? e}`,
      );
      console.log(
        `  ✗ R4 fixture teardown verification threw: ${e?.message ?? e}`,
      );
    }
  }

  console.log('');
  if (r4ProbeFixtureIds.length) {
    console.log(
      `R4 fixture ids this run: ${r4ProbeFixtureIds.join(', ')}`,
    );
  }
  const skippedSuffix = results.skipped ? `, ${results.skipped} skipped` : '';
  console.log(
    `Result: ${results.pass} pass, ${results.fail} fail${skippedSuffix}${
      results.failed.length ? ` — ${results.failed.join(', ')}` : ''
    }`,
  );
  } finally {
    // F2: always release the script-level lock so the next concurrent
    // run isn't blocked. The session-scoped lock would die with the
    // psql child anyway, but explicit release keeps semantics clean.
    // MUST run BEFORE process.exit (which short-circuits async finally).
    try { releaseScriptLock(scriptLockChild); } catch {}
  }
  process.exit(results.fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error(e);
  // Best-effort lock release on uncaught-throw path. We can't reference
  // scriptLockChild here directly (closure scope ends at the IIFE body),
  // so rely on the session-scoped lock dying with the psql child when
  // the process exits.
  process.exit(2);
});

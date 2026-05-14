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

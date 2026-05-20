#!/usr/bin/env node
/**
 * scripts/smoke-prod-e2e.mjs
 *
 * Live PROD read-only smoke gate. Hits the deployed API base
 * (default `https://xpqt-api-eu.onrender.com`) with a real authenticated
 * browser JWT and verifies the four canonical surfaces a healthy prod
 * deploy must answer:
 *
 *   1. GET /api/health                  — no auth, 200 + { status:"ok" }
 *   2. GET /api/me/inbox                — minted browser token, 200 + { items, nextCursor }
 *   3. GET /api/me/inbox/count          — minted browser token, 200 + { unread, total }
 *   4. GET /api/persons/me              — gated until R1 (PR #36) merges + redeploys
 *
 * This gate exists because the 2026-05-20 closeout had to write a
 * transient verifier outside the smoke-gate set to catch the
 * `/api/persons/me` 500 — a real failure mode the existing
 * service-role-path smoke gates structurally cannot see. It is the
 * post-deploy "did prod come up green for an authenticated browser
 * session" gate.
 *
 * Read-only — no writes. Safe to run against prod after every deploy.
 * Cold-start tolerant: a 45s per-probe timeout (PROD_E2E_TIMEOUT_MS) and
 * retry-on-transient absorbs Render free-tier spin-up. The retry trigger
 * is BOTH a transport throw AND a 5xx-gateway response (502 / 503 / 504)
 * — Render's cold-start path can return either, and classifying a
 * cold-start 503 as a real http-status outage is the bug R3 carves out.
 * On retry exhaustion, the failure CLASS is preserved (transport vs
 * http-status); only the retry trigger is unified.
 *
 * USAGE:
 *   node apps/api/scripts/smoke-prod-e2e.mjs
 *   PROD_BASE=https://other-host pnpm smoke:prod-e2e
 *   PROD_E2E_AUTH_UID=<uuid> pnpm smoke:prod-e2e  # override the admin user used to mint the browser JWT
 *   R1_LANDED=1 pnpm smoke:prod-e2e        # enable persons/me probe once R1 merges
 *
 *   exit 0 = all probes pass; exit 1 = at least one regression.
 *
 * FAILURE LABELS — three named classes (R3 precision model):
 *   - `transport`   network/DNS/timeout/non-HTTP response
 *   - `http-status` got a response, wrong status code (status + body excerpt)
 *   - `body-shape`  got 200, JSON shape mismatch (parsed key/type)
 *
 * Citations:
 *   - apps/api/scripts/smoke-cross-tenant.mjs:415-435 (`mintTokenFor`)
 *   - apps/api/src/modules/inbox/inbox.controller.ts                 — routes + shape
 *   - apps/api/src/modules/inbox/dto/inbox-list.dto.ts               — { items, nextCursor } / { unread, total }
 *   - docs/follow-ups/audits/04-rls-security.md                      — R3 named-failure-class model
 */

import { createClient } from '@supabase/supabase-js';
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

// Load .env from the repo (or worktree) root — same convention as
// smoke-cross-tenant.mjs / smoke-tickets.mjs. We do NOT use dotenv to
// keep this script dependency-free.
let env = {};
try {
  env = Object.fromEntries(
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
} catch (e) {
  // CI may inject via process.env instead; only block if we need a value
  // we can't find. Fall through to the per-key checks below.
}

function envOrProcess(key) {
  return process.env[key] || env[key];
}

const PROD_BASE = process.env.PROD_BASE || 'https://xpqt-api-eu.onrender.com';
// The admin user we mint a browser JWT for. Hard-coded UUID is the
// canonical-tenant prod admin used during the 2026-05-20 R5 carve-out;
// override via PROD_E2E_AUTH_UID if that user is rotated/deactivated.
// Documented in docs/smoke-gates.md under the prod-e2e section. The user
// MUST be active, hold the admin role, and live in the canonical tenant
// that the prod-e2e probes exercise.
const ADMIN_AUTH_UID =
  process.env.PROD_E2E_AUTH_UID || '93d41232-35b5-424c-b215-bb5d55a2dfd9';
// R1 (PR #36) ships GET /api/persons/me. Until it merges + prod redeploys,
// the route returns 500 — gate the probe rather than baking a known-fail
// into the script. Flip R1_LANDED=1 (or just leave it set after merge) to
// activate the probe.
const R1_LANDED = process.env.R1_LANDED === '1';

// Cold-start tolerance — Render free-tier wakeups can take >30s on the
// first hit. We give each probe TIMEOUT_MS per try and retry once on
// transport-class failure so a single cold-start spin-up doesn't fail
// the gate. Real outages still surface (two consecutive transport fails
// or any http-status/body-shape mismatch).
const TIMEOUT_MS = Number(process.env.PROD_E2E_TIMEOUT_MS || 45_000);
const TRANSPORT_RETRIES = Number(process.env.PROD_E2E_RETRIES ?? 1);

// ─────────────────────────────────────────────────────────────────────
// Auth — mint a real browser JWT (mirrors smoke-cross-tenant.mjs:415-435)
// ─────────────────────────────────────────────────────────────────────

let SUPA = null;
function supa() {
  if (SUPA) return SUPA;
  const url = envOrProcess('SUPABASE_URL');
  const secret = envOrProcess('SUPABASE_SECRET_KEY');
  if (!url || !secret) {
    throw new Error(
      'smoke-prod-e2e: SUPABASE_URL and SUPABASE_SECRET_KEY required (loaded from .env or process.env). ' +
        'See apps/api/scripts/smoke-cross-tenant.mjs for the same loader.',
    );
  }
  SUPA = createClient(url, secret, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return SUPA;
}

async function mintTokenFor(authUid) {
  const url = envOrProcess('SUPABASE_URL');
  const pub = envOrProcess('SUPABASE_PUBLISHABLE_KEY');
  if (!pub) {
    throw new Error('smoke-prod-e2e: SUPABASE_PUBLISHABLE_KEY required');
  }
  const adm = supa();
  const { data: u } = await adm.auth.admin.getUserById(authUid);
  if (!u?.user) throw new Error(`auth uid ${authUid} not found`);

  const { data: link, error: linkErr } = await adm.auth.admin.generateLink({
    type: 'magiclink',
    email: u.user.email,
  });
  if (linkErr) throw linkErr;

  const verifyUrl = `${url}/auth/v1/verify?token=${link.properties.hashed_token}&type=magiclink&redirect_to=http://localhost:5173`;
  const v = await fetch(verifyUrl, {
    redirect: 'manual',
    headers: { apikey: pub },
  });
  const loc = v.headers.get('location');
  const m = loc?.match(/access_token=([^&]+)/);
  if (!m) {
    // Don't surface `loc` — a partial/malformed verify redirect can
    // include token material in the URL fragment/query. Surface only
    // the origin (auth provider) to keep the failure diagnosable
    // without leaking auth-material into logs / results.failed.
    let redactedOrigin = '<no location header>';
    if (loc) {
      try {
        redactedOrigin = new URL(loc).origin;
      } catch {
        redactedOrigin = '<unparseable redirect>';
      }
    }
    throw new Error(`no access_token in verify redirect (origin=${redactedOrigin})`);
  }
  return m[1];
}

// ─────────────────────────────────────────────────────────────────────
// Probe runner — three named failure classes per R3
// ─────────────────────────────────────────────────────────────────────

const results = { pass: 0, fail: 0, failed: [], total: 0 };

/**
 * Run one probe. `validate(json, status)` must return null on success
 * or a string describing the body-shape mismatch.
 *
 *   class = transport   → fetch threw (DNS/network/abort/non-HTTP)
 *   class = http-status → got a response but status !== 200
 *   class = body-shape  → 200 + JSON, but `validate(json)` returned a reason
 *
 * Retry policy: BOTH a transport throw AND a 5xx-gateway response (502 /
 * 503 / 504) are treated as RETRYABLE transients while
 * `attempt < TRANSPORT_RETRIES`. Render free-tier cold starts can return
 * either, and classifying a cold-start 503 as a real outage was the
 * codex tertiary finding R3 carves out. On retry exhaustion the final
 * outcome's CLASS is preserved — a final-attempt 503 still surfaces as
 * `http-status` with the status code, not as `transport`. Retry-log
 * messages name the probe + status (no headers, no URL params).
 */
const GATEWAY_RETRY_STATUSES = new Set([502, 503, 504]);

async function probe(name, { url, headers = {}, validate }) {
  results.total += 1;
  let response = null;
  let lastTransportReason = null;
  for (let attempt = 0; attempt <= TRANSPORT_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      // 5xx-gateway statuses behave like a cold-start transport hiccup;
      // retry while we have budget, then preserve `http-status` class on
      // exhaustion (response is kept, lastTransportReason stays null).
      if (GATEWAY_RETRY_STATUSES.has(res.status) && attempt < TRANSPORT_RETRIES) {
        if (typeof res.body?.cancel === 'function') {
          await res.body.cancel().catch(() => {});
        }
        console.log(
          `  · ${name} attempt ${attempt + 1} got HTTP ${res.status} (gateway transient); retrying…`,
        );
        continue;
      }
      response = res;
      lastTransportReason = null;
      break;
    } catch (e) {
      lastTransportReason =
        e?.name === 'AbortError' ? `timeout after ${TIMEOUT_MS}ms` : String(e?.message || e);
      if (attempt < TRANSPORT_RETRIES) {
        console.log(
          `  · ${name} attempt ${attempt + 1} transport failed (${lastTransportReason}); retrying…`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
  if (!response && lastTransportReason) {
    results.fail += 1;
    results.failed.push(`${name} [transport]: ${lastTransportReason}`);
    console.log(`  ✗ ${name} [transport] ${lastTransportReason}`);
    return;
  }
  if (!response) {
    // Defensive: loop exited without a response and without a captured
    // transport reason. Treat as transport so we never silently no-op.
    results.fail += 1;
    results.failed.push(`${name} [transport]: no response after ${TRANSPORT_RETRIES + 1} attempt(s)`);
    console.log(`  ✗ ${name} [transport] no response after ${TRANSPORT_RETRIES + 1} attempt(s)`);
    return;
  }

  const bodyText = await response.text().catch(() => '');
  if (response.status !== 200) {
    results.fail += 1;
    const excerpt = bodyText.slice(0, 200).replace(/\s+/g, ' ');
    results.failed.push(`${name} [http-status]: HTTP ${response.status} — ${excerpt}`);
    console.log(`  ✗ ${name} [http-status] HTTP ${response.status} — ${excerpt}`);
    return;
  }

  let json;
  try {
    json = JSON.parse(bodyText);
  } catch (e) {
    results.fail += 1;
    const excerpt = bodyText.slice(0, 200).replace(/\s+/g, ' ');
    results.failed.push(`${name} [body-shape]: non-JSON body — ${excerpt}`);
    console.log(`  ✗ ${name} [body-shape] non-JSON body — ${excerpt}`);
    return;
  }

  const shapeReason = validate ? validate(json, response.status) : null;
  if (shapeReason) {
    results.fail += 1;
    const excerpt = JSON.stringify(json).slice(0, 200);
    results.failed.push(`${name} [body-shape]: ${shapeReason} — ${excerpt}`);
    console.log(`  ✗ ${name} [body-shape] ${shapeReason} — ${excerpt}`);
    return;
  }

  results.pass += 1;
  console.log(`  ✓ ${name} → HTTP 200`);
}

// ─────────────────────────────────────────────────────────────────────
// Validators
// ─────────────────────────────────────────────────────────────────────

function validateHealth(json) {
  if (typeof json !== 'object' || json === null) return 'body is not a JSON object';
  if (!('status' in json)) return 'missing field `status`';
  if (json.status !== 'ok') return `expected status="ok", got ${JSON.stringify(json.status)}`;
  return null;
}

function validateInboxList(json) {
  if (typeof json !== 'object' || json === null) return 'body is not a JSON object';
  if (!Array.isArray(json.items)) return 'missing/non-array field `items`';
  // nextCursor MAY be null on a last/empty page; just enforce the field exists.
  if (!('nextCursor' in json)) return 'missing field `nextCursor`';
  return null;
}

function validateInboxCount(json) {
  if (typeof json !== 'object' || json === null) return 'body is not a JSON object';
  if (typeof json.unread !== 'number') return 'missing/non-number field `unread`';
  if (typeof json.total !== 'number') return 'missing/non-number field `total`';
  return null;
}

function validatePersonsMe(json) {
  if (typeof json !== 'object' || json === null) return 'body is not a JSON object';
  if (typeof json.id !== 'string' || json.id.length === 0) return 'missing/non-string field `id`';
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`🛰  smoke:prod-e2e — target=${PROD_BASE}`);
  console.log(`   timeout per probe: ${TIMEOUT_MS}ms`);
  console.log(`   R1 gate (persons/me): ${R1_LANDED ? 'ACTIVE' : 'inactive — set R1_LANDED=1 after PR #36 merges & prod redeploys'}`);

  // 1. /api/health — no auth.
  console.log('\n─── /api/health (no auth)');
  await probe('GET /api/health', {
    url: `${PROD_BASE}/api/health`,
    validate: validateHealth,
  });

  // Mint the browser token once for the authenticated probes.
  let browserToken;
  try {
    browserToken = await mintTokenFor(ADMIN_AUTH_UID);
    // Don't log any substring of the token — even a 16-char JWT prefix
    // is enough to discriminate sessions in shared log surfaces. The
    // confirmation that mint succeeded is the absence of the catch path.
    console.log('\nadmin browser JWT minted (token redacted)');
  } catch (e) {
    console.log(`\n  ✗ JWT mint failed — every authenticated probe will be skipped as transport failure`);
    console.log(`     ${e?.message || e}`);
    results.fail += 1;
    results.failed.push(`JWT mint [transport]: ${e?.message || e}`);
    console.log('');
    console.log(`RESULT: ${results.pass}/${results.total} green — ${results.failed.join(' | ')}`);
    process.exit(1);
  }
  const authed = { Authorization: `Bearer ${browserToken}` };

  // 2. /api/me/inbox
  console.log('\n─── /api/me/inbox (browser JWT)');
  await probe('GET /api/me/inbox', {
    url: `${PROD_BASE}/api/me/inbox`,
    headers: authed,
    validate: validateInboxList,
  });

  // 3. /api/me/inbox/count
  console.log('\n─── /api/me/inbox/count (browser JWT)');
  await probe('GET /api/me/inbox/count', {
    url: `${PROD_BASE}/api/me/inbox/count`,
    headers: authed,
    validate: validateInboxCount,
  });

  // 4. /api/persons/me — gated.
  // Pre-R1 prod returns HTTP 500 unknown.server_error here (the exact
  // failure mode R5 was carved out of). Activate after R1 lands so we
  // don't bake a known-red probe into the gate.
  console.log('\n─── /api/persons/me (browser JWT) — R1-gated');
  if (R1_LANDED) {
    await probe('GET /api/persons/me', {
      url: `${PROD_BASE}/api/persons/me`,
      headers: authed,
      validate: validatePersonsMe,
    });
  } else {
    console.log('  · skipped — set R1_LANDED=1 once PR #36 merges and prod redeploys');
  }

  console.log('');
  if (results.failed.length === 0) {
    console.log(`RESULT: ${results.pass}/${results.total} green`);
    process.exit(0);
  }
  console.log(`RESULT: ${results.pass}/${results.total} green — ${results.failed.join(' | ')}`);
  process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});

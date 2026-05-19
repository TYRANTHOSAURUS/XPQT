#!/usr/bin/env node
/**
 * scripts/smoke-create-multi-room.mjs
 *
 * Live-API smoke for the atomic multi-room create cascade — booking-audit
 * remediation Slice 3 (audit `docs/follow-ups/audits/03-booking-reservation.md`
 * P1-1, `:142-154`). This is the P1-1 regression gate.
 *
 * Hits `POST /api/reservations/multi-room` end-to-end against the remote
 * Supabase project with a real Admin JWT. Sibling to
 * smoke-cancel-booking.mjs / smoke-edit-booking.mjs (same scaffolding:
 * psql-seeded fixtures with session_replication_role='replica', real HTTP
 * probes, attach_operations + DB-level row assertions, FK-ordered cleanup).
 *
 * What this probe defends against:
 *   - **`create_booking_with_attach_plan` multi-slot atomicity (00309 /
 *     live 00315)** — ONE transaction commits booking + N booking_slots +
 *     orders + OLIs + asset_reservations + (approvals) for a multi-room
 *     group. Pre-Slice-3 multi-room rode `create_booking` + a SEPARATE
 *     `bundle.attachServicesToBooking` + in-process compensation — a real
 *     window of inconsistency. A wiring break is invisible to mocked-jest.
 *   - **Idempotency** — same actor + same X-Client-Request-Id replay →
 *     cached attach_operations result, NO duplicate booking / slots /
 *     orders / OLIs / asset_reservations.
 *   - **Partial-room atomicity** — one of the N rooms is pre-booked
 *     (GiST exclusion 23P01 fires inside the tx). The WHOLE tx rolls
 *     back: ZERO orphan slots / orders / OLIs / asset_reservations, the
 *     attach_operations marker rolled back with it.
 *   - **Cross-tenant** — a space_id in another tenant → rejected, no rows.
 *   - **Producer-route guard** — missing X-Client-Request-Id → 400
 *     (RequireClientRequestIdGuard, already on the route).
 *   - **Approval-correctness improvement** — a room matching a
 *     require_approval rule makes the booking enter `pending_approval`
 *     WITH approval rows created (the legacy multi-room path set the
 *     status but created ZERO approval rows — a permanently-stuck
 *     booking; this is the honest correctness fix, not a silent change).
 *   - **00410 §7a (D-4) — MULTI-room** — a matched room rule's id in
 *     `bookings.applied_rule_ids` no longer trips
 *     `validate_attach_plan_internal_refs` §7a (00410 repointed it at
 *     `room_booking_rules`; pre-fix it checked `service_rules` → 400).
 *   - **00410 §7a (D-4) — SINGLE-room** — the LARGEST blast radius:
 *     single-room create-with-services where a room rule matched was a
 *     pre-existing, never-smoke-covered latent break. Probe (g) covers
 *     it via POST /reservations (BookingFlowService → the same combined
 *     RPC) with one room + services + the deterministic off-hours match.
 *
 * USAGE:
 *   pnpm dev:api &     (or have the dev server already running)
 *   node apps/api/scripts/smoke-create-multi-room.mjs
 *
 *   exit 0 = all probes pass
 *   exit 1 = at least one regression
 *   exit 2 = infra error (API unreachable, fixture seed failed)
 *
 * Citations (every named symbol below was Read in this session):
 *   - supabase/migrations/00309_create_booking_with_attach_plan_rpc.sql +
 *     00315_combined_rpc_setup_emit_jsonb_null_fix.sql (live RPC body).
 *   - supabase/migrations/00302_attach_operations_table.sql (idempotency
 *     ledger — (tenant_id, idempotency_key) PK, outcome/payload_hash).
 *   - apps/api/src/modules/reservations/multi-room-booking.service.ts
 *     (Slice 3 createGroup — the combined-RPC rewrite).
 *   - apps/api/src/modules/reservations/reservation.controller.ts:150-183
 *     (@Post('multi-room') + RequireClientRequestIdGuard).
 *   - apps/api/src/modules/booking-bundles/bundle.service.ts:594
 *     (buildAttachPlan — requires per-line client_line_id).
 *   - apps/api/scripts/smoke-cancel-booking.mjs (sibling scaffold —
 *     runPsql/runPsqlQuery/mintAdminToken/makeProber/cleanup pattern).
 *   - idempotency key shape mirrors booking-flow.service.ts:519-520
 *     (`booking.create:<actor.user_id>:<clientRequestId>`).
 *   - spaces / catalog_items / assets / asset_types / room_booking_rules
 *     schemas verified via psql on remote.
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
const TENANT_ID = '00000000-0000-0000-0000-000000000001'; // Solana Inc.
const ADMIN_AUTH_UID = '93d41232-35b5-424c-b215-bb5d55a2dfd9'; // Admin role
// Real persons from 00133_seed_room_booking_examples.sql.
const THOMAS_PERSON = 'b3a0aa30-3648-4783-92fa-973090877238';
const NOOR_PERSON = '95000000-0000-0000-0000-000000000004';

// A second tenant id for the cross-tenant probe — any uuid that is NOT
// tenant-1. The booking pipeline tenant-scopes the space lookup, so a
// space seeded under this tenant must be rejected when the Admin JWT
// (tenant-1) calls multi-room with it.
const OTHER_TENANT_ID = '00000000-0000-0000-0000-000000000002';

// Fixture anchor. +145d future clears the edit-booking (+130→133) and
// cancel-booking (+140→142) windows so back-to-back smoke runs on the
// shared remote never collide on the same dedicated rooms.
const FIXTURE_DAYS = 145;

// ─────────────────────────────────────────────────────────────────────
// Idempotency-key shape — mirrors booking-flow.service.ts:519-520
// (`booking.create:<actor.user_id>:<clientRequestId>`). multi-room-
// booking.service.ts:createGroup constructs the byte-identical literal.
// The actor.user_id for the Admin JWT is the public.users.id resolved by
// the controller (NOT auth_uid — combined RPC has no F-CRIT-1); we read
// it from the DB at runtime so the key matches what the service minted.
// ─────────────────────────────────────────────────────────────────────

// FIX 4 — run-scoped idempotency-ledger cleanup. The shared remote runs
// sibling smokes (cancel / edit / outbox) concurrently; a tenant-wide
// `delete from attach_operations where idempotency_key like
// 'booking.create:%'` would nuke their in-flight ledger rows. This smoke
// knows every key it mints (it constructs them deterministically), so we
// record each one here and delete ONLY these exact keys in cleanup.
const mintedIdempotencyKeys = new Set();

function buildCreateBookingIdempotencyKey(userId, clientRequestId) {
  const key = `booking.create:${userId}:${clientRequestId}`;
  mintedIdempotencyKeys.add(key);
  return key;
}

// ─────────────────────────────────────────────────────────────────────
// Supabase admin singleton.
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
// psql helpers (mirror smoke-cancel-booking.mjs:147-177).
// ─────────────────────────────────────────────────────────────────────

function dbUrl() {
  return (
    env.SUPABASE_DB_URL ||
    'postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres'
  );
}

function runPsql(sql) {
  const dbPass = env.SUPABASE_DB_PASS;
  if (!dbPass) throw new Error('smoke-create-multi-room: SUPABASE_DB_PASS missing from .env');
  try {
    execFileSync('psql', [dbUrl(), '-v', 'ON_ERROR_STOP=1', '-c', sql], {
      env: { ...process.env, PGPASSWORD: dbPass },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const stderr = e.stderr?.toString() ?? '';
    const stdout = e.stdout?.toString() ?? '';
    throw new Error(
      `psql failed: ${e.message}\nstdout: ${stdout}\nstderr: ${stderr}\nsql: ${sql.slice(0, 220)}…`,
    );
  }
}

function runPsqlQuery(sql) {
  const dbPass = env.SUPABASE_DB_PASS;
  if (!dbPass) throw new Error('smoke-create-multi-room: SUPABASE_DB_PASS missing from .env');
  try {
    const out = execFileSync('psql', [dbUrl(), '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
      env: { ...process.env, PGPASSWORD: dbPass },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.toString().trim();
  } catch (e) {
    const stderr = e.stderr?.toString() ?? '';
    throw new Error(`psql query failed: ${e.message}\nstderr: ${stderr}\nsql: ${sql.slice(0, 220)}…`);
  }
}

function scalar(sql) {
  return runPsqlQuery(sql);
}
function num(sql) {
  return Number.parseInt(runPsqlQuery(sql), 10) || 0;
}

// ─────────────────────────────────────────────────────────────────────
// Fixture seeding. Dedicated, self-contained:
//   - 3 reservable test rooms in tenant-1 (+ a 4th in OTHER_TENANT for
//     the cross-tenant probe).
//   - 1 catering catalog_item (priced, unit) → 1 order (no menu offer →
//     service_type 'other'; the assertion is "≥1 order", atomicity-level).
//   - 1 AV asset (+ asset_type) + 1 AV catalog_item linked via the
//     service line's linked_asset_id → 1 asset_reservation + OLI link.
//   - 1 require_approval room rule scoped to the approval-fixture's
//     first room (no workflow_definition_id → legacy createApprovalRows
//     path, the exact bug-fix path).
//
// session_replication_role='replica' bypasses RLS + booking outbox
// triggers + the room-booking-rules auto-recompile so we control timing.
// ─────────────────────────────────────────────────────────────────────

function mkSpaceIds(tag, n) {
  return Array.from({ length: n }, () => crypto.randomUUID());
}

function spaceSeedSql(spaceIds, tag, tenantId = TENANT_ID) {
  return spaceIds
    .map(
      (id, i) => `
    insert into public.spaces
      (id, tenant_id, type, name, capacity, reservable, active,
       setup_buffer_minutes, teardown_buffer_minutes,
       check_in_required, check_in_grace_minutes)
    values
      ('${id}'::uuid, '${tenantId}'::uuid, 'room',
       'Smoke MR ${tag} room ${i}', 20, true, true, 0, 0, false, 15);`,
    )
    .join('\n');
}

// Catalog + asset graph shared by the service-bearing fixtures.
function catalogSeedSql(ids) {
  return `
    insert into public.catalog_items
      (id, tenant_id, name, category, unit, price_per_unit,
       display_order, active, requires_return)
    values
      ('${ids.cateringCatalogId}'::uuid, '${TENANT_ID}'::uuid,
       'Smoke MR catering ${ids.tag}', 'food_and_drinks', 'per_person', 12.50,
       0, true, false);

    insert into public.asset_types (id, tenant_id, name)
    values ('${ids.assetTypeId}'::uuid, '${TENANT_ID}'::uuid,
            'Smoke MR AV type ${ids.tag}');
    insert into public.assets
      (id, tenant_id, asset_type_id, asset_role, name, status)
    values
      ('${ids.assetId}'::uuid, '${TENANT_ID}'::uuid,
       '${ids.assetTypeId}'::uuid, 'pooled',
       'Smoke MR projector ${ids.tag}', 'available');
    insert into public.catalog_items
      (id, tenant_id, name, category, unit, price_per_unit,
       display_order, active, requires_return, linked_asset_type_id)
    values
      ('${ids.avCatalogId}'::uuid, '${TENANT_ID}'::uuid,
       'Smoke MR AV ${ids.tag}', 'equipment', 'flat_rate', 75.00,
       1, true, true, '${ids.assetTypeId}'::uuid);
  `;
}

function mkFixtureIds(tag) {
  return {
    tag,
    cateringCatalogId: crypto.randomUUID(),
    avCatalogId: crypto.randomUUID(),
    assetTypeId: crypto.randomUUID(),
    assetId: crypto.randomUUID(),
  };
}

function isoAnchor(offsetDays, hourUtc) {
  const a = new Date(Date.now() + offsetDays * 86400_000);
  a.setUTCMinutes(0, 0, 0);
  a.setUTCHours(hourUtc);
  const start = a.toISOString();
  const end = new Date(a.getTime() + 60 * 60_000).toISOString();
  return { start, end };
}

// ─────────────────────────────────────────────────────────────────────
// Cleanup — FK-ordered, best-effort. Sweeps every fixture table incl.
// attach_operations + outbox + audit + the dedicated spaces / catalog /
// asset graph.
// ─────────────────────────────────────────────────────────────────────

async function deleteFixtures(state) {
  const spaceIds = [
    ...state.allSpaceIds,
  ];
  const fixtureIds = state.fixtureIds; // {cateringCatalogId, avCatalogId, assetTypeId, assetId}
  const sl = spaceIds.map((id) => `'${id}'::uuid`).join(', ') || `'00000000-0000-0000-0000-000000000000'::uuid`;
  const catalogIds = fixtureIds
    .flatMap((f) => [f.cateringCatalogId, f.avCatalogId])
    .map((id) => `'${id}'::uuid`)
    .join(', ') || `'00000000-0000-0000-0000-000000000000'::uuid`;
  const assetIds = fixtureIds.map((f) => `'${f.assetId}'::uuid`).join(', ') || `'00000000-0000-0000-0000-000000000000'::uuid`;
  const assetTypeIds = fixtureIds.map((f) => `'${f.assetTypeId}'::uuid`).join(', ') || `'00000000-0000-0000-0000-000000000000'::uuid`;
  const ruleIds = state.ruleIds.map((id) => `'${id}'::uuid`).join(', ') || `'00000000-0000-0000-0000-000000000000'::uuid`;
  // audit-03 P2-3 — dedicated teams seeded for the team-approver probe (j).
  const teamIds =
    (state.teamIds ?? []).map((id) => `'${id}'::uuid`).join(', ') ||
    `'00000000-0000-0000-0000-000000000000'::uuid`;
  // audit-03 P2-3 probe (k) — real recurrence_series parents to sweep.
  // Deleted AFTER bookings (bookings.recurrence_series_id → this table).
  const seriesIds =
    (state.seriesIds ?? []).map((id) => `'${id}'::uuid`).join(', ') ||
    `'00000000-0000-0000-0000-000000000000'::uuid`;
  // FIX 4 — ONLY the idempotency keys THIS run minted (never a tenant-wide
  // `like 'booking.create:%'` sweep — that would clobber sibling smokes'
  // ledger rows on the shared remote). Escape single quotes defensively
  // even though uuids/key parts never contain them.
  const idemKeyList =
    [...mintedIdempotencyKeys]
      .map((k) => `'${k.replace(/'/g, "''")}'`)
      .join(', ') || `'__smoke_mr_no_keys__'`;

  // Bookings created by the API on these dedicated spaces (resolved by
  // booking_slots.space_id ∈ our spaces). attach_operations rows are
  // scoped to the exact keys this run minted.
  const sql = `
    set session_replication_role = 'replica';
    create temp table _smoke_mr_bk on commit drop as
      select distinct bs.booking_id as id
        from public.booking_slots bs
       where bs.tenant_id = '${TENANT_ID}'::uuid and bs.space_id in (${sl});
    delete from public.audit_events
      where tenant_id = '${TENANT_ID}'::uuid
        and entity_type = 'booking'
        and entity_id in (select id from _smoke_mr_bk);
    delete from public.domain_events
      where tenant_id = '${TENANT_ID}'::uuid
        and entity_type = 'booking'
        and entity_id in (select id from _smoke_mr_bk);
    delete from outbox.events
      where tenant_id = '${TENANT_ID}'::uuid
        and aggregate_id in (select id from _smoke_mr_bk);
    delete from public.inbox_notifications
      where tenant_id = '${TENANT_ID}'::uuid
        and event_kind = 'booking.approval_required'
        and (payload->>'booking_id') in (
          select id::text from _smoke_mr_bk
        );
    delete from public.approvals
      where tenant_id = '${TENANT_ID}'::uuid
        and target_entity_type = 'booking'
        and target_entity_id in (select id from _smoke_mr_bk);
    delete from public.attach_operations
      where tenant_id = '${TENANT_ID}'::uuid
        and idempotency_key in (${idemKeyList});
    delete from public.asset_reservations
      where tenant_id = '${TENANT_ID}'::uuid
        and (booking_id in (select id from _smoke_mr_bk)
             or asset_id in (${assetIds}));
    delete from public.order_line_items
      where tenant_id = '${TENANT_ID}'::uuid
        and order_id in (select id from public.orders
                          where tenant_id = '${TENANT_ID}'::uuid
                            and booking_id in (select id from _smoke_mr_bk));
    delete from public.orders
      where tenant_id = '${TENANT_ID}'::uuid
        and booking_id in (select id from _smoke_mr_bk);
    delete from public.booking_slots
      where tenant_id = '${TENANT_ID}'::uuid
        and booking_id in (select id from _smoke_mr_bk);
    delete from public.bookings
      where tenant_id = '${TENANT_ID}'::uuid
        and id in (select id from _smoke_mr_bk);
    delete from public.recurrence_series
      where tenant_id = '${TENANT_ID}'::uuid and id in (${seriesIds});
    delete from public.assets
      where tenant_id = '${TENANT_ID}'::uuid and id in (${assetIds});
    delete from public.catalog_items
      where tenant_id = '${TENANT_ID}'::uuid and id in (${catalogIds});
    delete from public.asset_types
      where tenant_id = '${TENANT_ID}'::uuid and id in (${assetTypeIds});
    delete from public.room_booking_rules
      where tenant_id = '${TENANT_ID}'::uuid and id in (${ruleIds});
    delete from public.team_members
      where tenant_id = '${TENANT_ID}'::uuid and team_id in (${teamIds});
    delete from public.teams
      where tenant_id = '${TENANT_ID}'::uuid and id in (${teamIds});
    delete from public.spaces
      where id in (${sl});
    set session_replication_role = 'origin';
  `;
  try {
    runPsql(sql);
  } catch (e) {
    console.log(`  ! fixture cleanup warn: ${e.message.slice(0, 220)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Auth — mint a real Admin JWT (mirror smoke-cancel-booking.mjs:472-490).
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

// Resolve the Admin's public.users.id (= actor.user_id the controller
// threads into the idempotency key — NOT auth_uid; the combined RPC has
// no F-CRIT-1 auth_uid resolution, confirmed by reading 00315:135).
function resolveAdminUserId() {
  return scalar(
    `select id from public.users where tenant_id='${TENANT_ID}'::uuid and auth_uid='${ADMIN_AUTH_UID}'::uuid limit 1;`,
  );
}

// audit-03 P2-3 — the admin user's person_id. Used as the deterministic
// PERSON approver for probe (i): the 00402 inbox trigger joins
// `users WHERE person_id = approvals.approver_person_id`, so the approver
// MUST map to a real users row for an inbox_notifications row to land. The
// admin user is guaranteed present (the smoke just minted its JWT).
function resolveAdminPersonId() {
  return scalar(
    `select person_id from public.users where tenant_id='${TENANT_ID}'::uuid and auth_uid='${ADMIN_AUTH_UID}'::uuid and person_id is not null limit 1;`,
  );
}

// ─────────────────────────────────────────────────────────────────────
// Probe runner (mirror smoke-cancel-booking.mjs:496-585).
// ─────────────────────────────────────────────────────────────────────

const results = { pass: 0, fail: 0, failed: [] };

async function fetchResilient(url, init) {
  const closeInit = {
    ...init,
    headers: { ...(init?.headers ?? {}), Connection: 'close' },
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetch(url, closeInit);
    } catch (e) {
      const msg = String(e?.cause?.code ?? e?.message ?? e);
      const transient =
        /ECONNRESET|UND_ERR_SOCKET|fetch failed|ECONNREFUSED|socket hang up/i.test(msg);
      if (!transient || attempt === 2) throw e;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw new Error('fetchResilient: unreachable');
}

function makeProber(headers) {
  return async function probe(name, options) {
    const {
      method = 'POST',
      url,
      body,
      expect = 'success',
      clientRequestId,
      omitClientRequestId = false,
    } = options;
    const xCid = !omitClientRequestId ? clientRequestId || crypto.randomUUID() : null;
    const probeHeaders = { ...headers };
    if (xCid) probeHeaders['X-Client-Request-Id'] = xCid;
    const r = await fetchResilient(url, {
      method,
      headers: probeHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const ok =
      (expect === 'success' && r.status >= 200 && r.status < 300) ||
      (expect === 'badrequest' && r.status === 400) ||
      (expect === 'conflict' && r.status === 409) ||
      (expect === 'forbidden' && r.status === 403) ||
      (expect === 'unprocessable' && r.status === 422) ||
      (expect === 'notfound' && r.status === 404);
    const txt = await r.text();
    if (ok) {
      results.pass += 1;
      console.log(`  ✓ ${name} → HTTP ${r.status}`);
    } else {
      results.fail += 1;
      results.failed.push(name);
      console.log(`  ✗ ${name} → HTTP ${r.status} (expected ${expect})`);
      console.log(`     ${txt.slice(0, 360)}`);
    }
    return { status: r.status, body: txt, ok, xClientRequestId: xCid };
  };
}

function passAssertion(name, condition, detail) {
  if (condition) {
    results.pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    results.fail += 1;
    results.failed.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function parseJsonSafe(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// DB introspection — all reads tenant-gated (#0 invariant). The smoke
// resolves "the created booking" via booking_slots.space_id ∈ the
// dedicated rooms of THIS probe (no shared-room collision possible).
// ─────────────────────────────────────────────────────────────────────

function bookingIdForSpaces(spaceIds) {
  const sl = spaceIds.map((id) => `'${id}'::uuid`).join(', ');
  return scalar(
    `select distinct booking_id from public.booking_slots
      where tenant_id='${TENANT_ID}'::uuid and space_id in (${sl}) limit 1;`,
  );
}
function countSlots(bookingId) {
  return num(
    `select count(*) from public.booking_slots
      where tenant_id='${TENANT_ID}'::uuid and booking_id='${bookingId}'::uuid;`,
  );
}
function countOrders(bookingId) {
  return num(
    `select count(*) from public.orders
      where tenant_id='${TENANT_ID}'::uuid and booking_id='${bookingId}'::uuid;`,
  );
}
function countOlis(bookingId) {
  return num(
    `select count(*) from public.order_line_items oli
       join public.orders o on o.id = oli.order_id
      where o.tenant_id='${TENANT_ID}'::uuid and o.booking_id='${bookingId}'::uuid;`,
  );
}
function countAssetReservations(bookingId) {
  return num(
    `select count(*) from public.asset_reservations
      where tenant_id='${TENANT_ID}'::uuid and booking_id='${bookingId}'::uuid;`,
  );
}
function bookingStatus(bookingId) {
  return scalar(
    `select status from public.bookings where tenant_id='${TENANT_ID}'::uuid and id='${bookingId}'::uuid;`,
  );
}
function countApprovals(bookingId) {
  return num(
    `select count(*) from public.approvals
      where tenant_id='${TENANT_ID}'::uuid and target_entity_type='booking'
        and target_entity_id='${bookingId}'::uuid;`,
  );
}
function countAttachOps(idemKey) {
  return num(
    `select count(*) from public.attach_operations
      where tenant_id='${TENANT_ID}'::uuid and idempotency_key='${idemKey}';`,
  );
}
// audit-03 P2-3 — inbox_notifications fanned out by the 00402 AFTER INSERT
// trigger when an approvals row lands with approval_chain_id IS NOT NULL.
// payload.booking_id = approvals.target_entity_id (the booking id).
function countInboxForBooking(bookingId) {
  return num(
    `select count(*) from public.inbox_notifications
      where tenant_id='${TENANT_ID}'::uuid
        and event_kind='booking.approval_required'
        and (payload->>'booking_id')='${bookingId}';`,
  );
}
// Count orphans across ALL the dedicated rooms (no booking_id needed —
// used for the partial-conflict rollback assertion: nothing should
// reference any of these spaces / catalogs).
function orphanCounts(spaceIds, fx) {
  const sl = spaceIds.map((id) => `'${id}'::uuid`).join(', ');
  const slots = num(
    `select count(*) from public.booking_slots
      where tenant_id='${TENANT_ID}'::uuid and space_id in (${sl});`,
  );
  const orders = num(
    `select count(*) from public.orders o
       join public.booking_slots bs on bs.booking_id = o.booking_id
      where o.tenant_id='${TENANT_ID}'::uuid and bs.space_id in (${sl});`,
  );
  const ars = num(
    `select count(*) from public.asset_reservations
      where tenant_id='${TENANT_ID}'::uuid and asset_id='${fx.assetId}'::uuid;`,
  );
  return { slots, orders, ars };
}

// ─────────────────────────────────────────────────────────────────────
// Probes
// ─────────────────────────────────────────────────────────────────────

const MR_URL = `${API_BASE}/api/reservations/multi-room`;

function serviceLines(fx) {
  // 1 catering line (no asset) + 1 AV line (linked_asset_id → 1
  // asset_reservation). client_line_id is REQUIRED by buildAttachPlan.
  return [
    {
      catalog_item_id: fx.cateringCatalogId,
      quantity: 8,
      client_line_id: 'mr-catering-1',
    },
    {
      catalog_item_id: fx.avCatalogId,
      quantity: 1,
      linked_asset_id: fx.assetId,
      client_line_id: 'mr-av-1',
    },
  ];
}

async function runAtomicCreateProbe(probe, spaceIds, fx, adminUserId) {
  console.log('\n=== (a) atomic multi-room create WITH services ===');
  const { start, end } = isoAnchor(FIXTURE_DAYS, 9);
  const crid = crypto.randomUUID();
  const idemKey = buildCreateBookingIdempotencyKey(adminUserId, crid);

  const res = await probe('Create 3-room booking + catering + AV → 200', {
    url: MR_URL,
    body: {
      space_ids: spaceIds,
      requester_person_id: THOMAS_PERSON,
      start_at: start,
      end_at: end,
      attendee_count: 8,
      services: serviceLines(fx),
      bundle: { bundle_type: 'event' },
    },
    clientRequestId: crid,
  });
  if (!res.ok) return null;

  const parsed = parseJsonSafe(res.body);
  passAssertion('(a) response { group_id, reservations[3] }',
    parsed && typeof parsed.group_id === 'string' && Array.isArray(parsed.reservations) &&
      parsed.reservations.length === 3,
    `body=${res.body.slice(0, 200)}`);

  const bookingId = parsed?.group_id || bookingIdForSpaces(spaceIds);
  passAssertion('(a) booking row present + confirmed',
    bookingStatus(bookingId) === 'confirmed', `status=${bookingStatus(bookingId)}`);
  passAssertion('(a) exactly 3 booking_slots (N rooms, one tx)',
    countSlots(bookingId) === 3, `slots=${countSlots(bookingId)}`);
  passAssertion('(a) ≥1 order present',
    countOrders(bookingId) >= 1, `orders=${countOrders(bookingId)}`);
  passAssertion('(a) ≥2 OLIs present (catering + AV)',
    countOlis(bookingId) >= 2, `olis=${countOlis(bookingId)}`);
  passAssertion('(a) ≥1 asset_reservation present (AV)',
    countAssetReservations(bookingId) >= 1, `ars=${countAssetReservations(bookingId)}`);
  passAssertion('(a) exactly 1 attach_operations row (atomic, one tx)',
    countAttachOps(idemKey) === 1, `attach_ops=${countAttachOps(idemKey)}`);
  passAssertion('(a) attach_operations.outcome=success + cached_result set',
    scalar(`select outcome || '|' || (cached_result is not null)::text from public.attach_operations where tenant_id='${TENANT_ID}'::uuid and idempotency_key='${idemKey}';`) === 'success|true',
    'attach op not success/cached');

  return { bookingId, crid, idemKey, start, end };
}

async function runIdempotencyProbe(probe, spaceIds, fx, adminUserId, ctx) {
  console.log('\n=== (b) idempotency replay (same actor + X-CRID) ===');
  const slotsBefore = countSlots(ctx.bookingId);
  const ordersBefore = countOrders(ctx.bookingId);
  const olisBefore = countOlis(ctx.bookingId);
  const arsBefore = countAssetReservations(ctx.bookingId);

  const replay = await probe('Replay same key → 200 cached', {
    url: MR_URL,
    body: {
      space_ids: spaceIds,
      requester_person_id: THOMAS_PERSON,
      start_at: ctx.start,
      end_at: ctx.end,
      attendee_count: 8,
      services: serviceLines(fx),
      bundle: { bundle_type: 'event' },
    },
    clientRequestId: ctx.crid,
  });
  if (!replay.ok) return;

  const rp = parseJsonSafe(replay.body);
  passAssertion('(b) replay returns the SAME group_id',
    rp?.group_id === ctx.bookingId, `got=${rp?.group_id} want=${ctx.bookingId}`);
  passAssertion('(b) no duplicate booking_slots',
    countSlots(ctx.bookingId) === slotsBefore && slotsBefore === 3,
    `before=${slotsBefore} after=${countSlots(ctx.bookingId)}`);
  passAssertion('(b) no duplicate orders',
    countOrders(ctx.bookingId) === ordersBefore,
    `before=${ordersBefore} after=${countOrders(ctx.bookingId)}`);
  passAssertion('(b) no duplicate OLIs',
    countOlis(ctx.bookingId) === olisBefore,
    `before=${olisBefore} after=${countOlis(ctx.bookingId)}`);
  passAssertion('(b) no duplicate asset_reservations',
    countAssetReservations(ctx.bookingId) === arsBefore,
    `before=${arsBefore} after=${countAssetReservations(ctx.bookingId)}`);
  passAssertion('(b) still exactly 1 attach_operations row',
    countAttachOps(ctx.idemKey) === 1, `attach_ops=${countAttachOps(ctx.idemKey)}`);
  // exactly 1 booking across all the dedicated rooms (no second group).
  passAssertion('(b) exactly 1 booking across the dedicated rooms',
    num(`select count(distinct booking_id) from public.booking_slots where tenant_id='${TENANT_ID}'::uuid and space_id in (${spaceIds.map((id) => `'${id}'::uuid`).join(', ')});`) === 1,
    'more than one booking landed');
}

async function runPartialConflictProbe(probe, fx, adminUserId) {
  console.log('\n=== (c) partial-room conflict → whole tx rolls back ===');
  // Fresh dedicated rooms so this probe is independent of (a)/(b).
  const spaceIds = mkSpaceIds('conflict', 3);
  runPsql(
    `set session_replication_role='replica';\n` +
      spaceSeedSql(spaceIds, 'conflict') +
      `\nset session_replication_role='origin';`,
  );
  const { start, end } = isoAnchor(FIXTURE_DAYS, 11);

  // Pre-book ONE of the 3 rooms (a standalone confirmed slot) so the
  // combined RPC's booking_slots_no_overlap GiST exclusion (00277:212-217)
  // fires on that room INSIDE the transaction → whole group rolls back.
  const blockerBooking = crypto.randomUUID();
  const blockerSlot = crypto.randomUUID();
  runPsql(`
    set session_replication_role='replica';
    insert into public.bookings
      (id, tenant_id, requester_person_id, location_id, start_at, end_at,
       timezone, status, source, policy_snapshot, applied_rule_ids)
    values
      ('${blockerBooking}'::uuid, '${TENANT_ID}'::uuid, '${THOMAS_PERSON}'::uuid,
       '${spaceIds[1]}'::uuid, '${start}'::timestamptz, '${end}'::timestamptz,
       'UTC', 'confirmed', 'desk', '{}'::jsonb, '{}'::uuid[]);
    -- session_replication_role='replica' bypasses the
    -- booking_slots_compute_effective_window trigger (00277:194-206), so
    -- effective_*_at + time_range must be set EXPLICITLY here — otherwise
    -- time_range stays NULL and the booking_slots_no_overlap GiST
    -- exclusion (00277:209-217, predicate WHERE status IN
    -- confirmed|checked_in|pending_approval) never matches a NULL range,
    -- and the conflict the probe is meant to force silently doesn't fire.
    -- No buffers (0/0) ⇒ effective window == [start, end).
    insert into public.booking_slots
      (id, tenant_id, booking_id, slot_type, space_id, start_at, end_at,
       status, display_order,
       effective_start_at, effective_end_at, time_range)
    values
      ('${blockerSlot}'::uuid, '${TENANT_ID}'::uuid, '${blockerBooking}'::uuid,
       'room', '${spaceIds[1]}'::uuid, '${start}'::timestamptz,
       '${end}'::timestamptz, 'confirmed', 0,
       '${start}'::timestamptz, '${end}'::timestamptz,
       tstzrange('${start}'::timestamptz, '${end}'::timestamptz, '[)'));
    set session_replication_role='origin';
  `);

  const before = orphanCounts(spaceIds, fx);
  const res = await probe('Create where room 2/3 is double-booked → 409', {
    url: MR_URL,
    body: {
      space_ids: spaceIds,
      requester_person_id: THOMAS_PERSON,
      start_at: start,
      end_at: end,
      attendee_count: 6,
      services: serviceLines(fx),
      bundle: { bundle_type: 'event' },
    },
    expect: 'conflict',
  });
  if (res.ok) {
    const mp = parseJsonSafe(res.body);
    passAssertion('(c) code=multi_room_booking_failed',
      mp?.code === 'multi_room_booking_failed', `code=${mp?.code}`);
  }

  // The blocker slot itself stays (it was pre-existing); assert NO new
  // group landed on these rooms and ZERO orphan orders / ARs.
  const after = orphanCounts(spaceIds, fx);
  passAssertion('(c) zero NEW booking_slots (only the pre-existing blocker)',
    after.slots === before.slots && before.slots === 1,
    `before=${before.slots} after=${after.slots}`);
  passAssertion('(c) zero orphan orders (whole tx rolled back)',
    after.orders === 0, `orders=${after.orders}`);
  // orphanCounts.ars counts ARs on the SHARED fx.assetId — the main
  // fixture (probe a) legitimately created 1 there and it's still alive
  // (cleanup runs in finally). The atomicity guarantee is that probe c's
  // ROLLED-BACK tx adds ZERO NEW asset_reservations → before == after
  // (delta=0), NOT an absolute zero (which would falsely flag the main
  // fixture's legit AR as an orphan).
  passAssertion('(c) zero NEW asset_reservations (rolled-back tx added none)',
    after.ars === before.ars, `before=${before.ars} after=${after.ars}`);
  passAssertion('(c) ZERO non-blocker bookings on these rooms',
    num(`select count(distinct booking_id) from public.booking_slots where tenant_id='${TENANT_ID}'::uuid and space_id in (${spaceIds.map((id) => `'${id}'::uuid`).join(', ')});`) === 1,
    'a partial group survived the rollback');

  // cleanup the blocker + conflict rooms is handled by deleteFixtures
  // (allSpaceIds includes these; booking_slots → bookings sweep covers
  // the blocker booking which references one of these spaces).
  return spaceIds;
}

async function runCrossTenantProbe(probe) {
  console.log('\n=== (d) cross-tenant space_id → rejected, no rows ===');
  // One real tenant-1 room + one space seeded in OTHER_TENANT. The
  // pipeline's loadSpaces() tenant-filters (multi-room-booking.service
  // .ts loadSpaces: .eq('tenant_id', tenantId).in('id', spaceIds)), so
  // the foreign space is invisible → space_not_found, no rows.
  const okSpace = crypto.randomUUID();
  const foreignSpace = crypto.randomUUID();
  runPsql(
    `set session_replication_role='replica';\n` +
      spaceSeedSql([okSpace], 'xt-ok') +
      spaceSeedSql([foreignSpace], 'xt-foreign', OTHER_TENANT_ID) +
      `\nset session_replication_role='origin';`,
  );
  const { start, end } = isoAnchor(FIXTURE_DAYS, 13);

  const res = await probe('Multi-room with a foreign-tenant space → 404', {
    url: MR_URL,
    body: {
      space_ids: [okSpace, foreignSpace],
      requester_person_id: THOMAS_PERSON,
      start_at: start,
      end_at: end,
      attendee_count: 4,
    },
    expect: 'notfound',
  });
  if (res.ok) {
    const mp = parseJsonSafe(res.body);
    passAssertion('(d) code=space_not_found',
      mp?.code === 'space_not_found', `code=${mp?.code}`);
  }
  passAssertion('(d) zero booking_slots on the ok-space (no partial create)',
    num(`select count(*) from public.booking_slots where tenant_id='${TENANT_ID}'::uuid and space_id='${okSpace}'::uuid;`) === 0,
    'a row leaked despite the foreign-tenant rejection');

  // Cleanup the two probe spaces (foreign one lives under OTHER_TENANT).
  runPsql(`
    set session_replication_role='replica';
    delete from public.spaces where id in ('${okSpace}'::uuid, '${foreignSpace}'::uuid);
    set session_replication_role='origin';
  `);
}

async function runMissingCridProbe(probe, spaceIds) {
  console.log('\n=== (e) missing X-Client-Request-Id → 400 ===');
  const { start, end } = isoAnchor(FIXTURE_DAYS, 15);
  await probe('Multi-room without X-Client-Request-Id → 400', {
    url: MR_URL,
    body: {
      space_ids: spaceIds,
      requester_person_id: THOMAS_PERSON,
      start_at: start,
      end_at: end,
      attendee_count: 4,
    },
    omitClientRequestId: true,
    expect: 'badrequest',
  });
}

async function runApprovalProbe(probe, fx, adminUserId) {
  console.log('\n=== (f) require_approval room rule → pending_approval + approval rows + atomic N-slot/services ===');
  // The D-4 fix this slice ships (migration 00410_fix_applied_rule_ids_
  // validates_room_rules.sql) repoints validate_attach_plan_internal_refs
  // §7a at public.room_booking_rules. `applied_rule_ids` is the matched
  // ROOM rule ids (RuleResolverService → room_booking_rules;
  // booking-flow.service.ts:7,291,948 · rule-resolver.service.ts:217,229),
  // NOT service_rules. Pre-fix, the combined RPC raised
  //   attach_plan.internal_refs: applied_rule_ids[] <uuid> not in tenant
  //   service_rules
  // (42501 → HTTP 400 booking.snapshot_uuid_invalid) whenever ANY room
  // rule matched — breaking BOTH the multi-room cutover AND single-room
  // create-with-services (latent, never smoke-covered). The legacy
  // `create_booking` RPC had no such validator → strict regression.
  //
  // This probe asserts the CORRECT post-fix behavior end-to-end: a
  // multi-room create that matches a `require_approval` ROOM rule must:
  //   - succeed (201/200), NOT 400
  //   - land the booking at status='pending_approval'
  //   - carry ≥1 room_booking_rules id in bookings.applied_rule_ids
  //     (proves §7a now validates against the right table — the exact
  //     D-4 fix; pre-fix this id would have tripped the validator)
  //   - create the approval rows the matched rule's approval_config
  //     dictates (target_entity_type='booking', approver derived from
  //     the matched rule, status='pending', chain_id set) — NOT a
  //     hardcoded approver. The matched rule is whatever the resolver
  //     picks; the seeded tenant-1 fixture deterministically routes a
  //     hour-17 (off-business-hours) 60-min booking to the pre-existing
  //     "Off-hours bookings need approval" tenant rule (b0010001,
  //     00133-seeded, effect=require_approval, threshold=any). We assert
  //     the approval rows MATCH that matched rule's required_approvers,
  //     read from the DB at runtime — robust to seed drift.
  //   - commit ALL N slots + the service orders/OLIs/ARs atomically in
  //     the one combined-RPC transaction
  // i.e. the honest approval-correctness fix the legacy multi-room path
  // never had (it set status='pending_approval' but created ZERO approval
  // rows — a permanently-stuck booking).
  //
  // No fixture rule is seeded here: the resolver-matched rule is
  // determined by the live seeded rule set + the booking shape. Seeding
  // a room-scoped fixture rule was misleading (it never won against the
  // higher-priority tenant-wide off-hours rule and conflated the test).
  const spaceIds = mkSpaceIds('appr', 2);
  const ruleId = null; // no fixture rule — see comment above
  runPsql(
    `set session_replication_role='replica';\n` +
      spaceSeedSql(spaceIds, 'appr') +
      `\nset session_replication_role='origin';`,
  );
  // Hour 17 UTC + 60-min duration → matches the seeded off-hours
  // tenant rule (b0010001, require_approval) and NOT the long-booking
  // rule (b0010002, needs >240min). Deterministic on the smoke tenant.
  const { start, end } = isoAnchor(FIXTURE_DAYS, 17);
  const crid = crypto.randomUUID();
  const idemKey = buildCreateBookingIdempotencyKey(adminUserId, crid);

  const res = await probe(
    'Multi-room + require_approval room rule + services → 200/201 (pending_approval, atomic)',
    {
      url: MR_URL,
      body: {
        space_ids: spaceIds,
        requester_person_id: THOMAS_PERSON,
        start_at: start,
        end_at: end,
        attendee_count: 4,
        services: serviceLines(fx),
        bundle: { bundle_type: 'event' },
      },
      clientRequestId: crid,
      expect: 'success',
    },
  );
  if (res.ok) {
    const parsed = parseJsonSafe(res.body);
    passAssertion(
      '(f) response { group_id, reservations[2] }',
      parsed && typeof parsed.group_id === 'string' &&
        Array.isArray(parsed.reservations) && parsed.reservations.length === 2,
      `body=${res.body.slice(0, 200)}`,
    );
    const bookingId = parsed?.group_id || bookingIdForSpaces(spaceIds);

    passAssertion(
      '(f) booking landed status=pending_approval (require_approval room rule matched)',
      bookingStatus(bookingId) === 'pending_approval',
      `status=${bookingStatus(bookingId)}`,
    );

    // D-4 core proof: applied_rule_ids carries ≥1 room_booking_rules id.
    // Pre-fix THIS exact id tripped §7a (validated vs service_rules) →
    // HTTP 400. Post-fix it validates vs room_booking_rules → success.
    const appliedRuleIds = runPsqlQuery(
      `select coalesce(array_to_string(applied_rule_ids, ','), '') from public.bookings where tenant_id='${TENANT_ID}'::uuid and id='${bookingId}'::uuid;`,
    );
    const ruleIdList = appliedRuleIds
      ? appliedRuleIds.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    passAssertion(
      '(f) bookings.applied_rule_ids carries ≥1 room rule id (the D-4 fix path)',
      ruleIdList.length >= 1,
      `applied_rule_ids=[${appliedRuleIds}]`,
    );
    const inList = ruleIdList.map((id) => `'${id}'::uuid`).join(', ') || `'00000000-0000-0000-0000-000000000000'::uuid`;
    // FIX 5a — the old "every applied_rule_id resolves in
    // room_booking_rules" check was a TAUTOLOGY: RuleResolverService only
    // ever queries room_booking_rules (rule-resolver.service.ts:217,229),
    // so any id it can produce trivially exists there — the assertion
    // could never fail and proved nothing about 00410. The real D-4
    // regression signal is: the create did NOT 400 with the §7a
    // `attach_plan.internal_refs` validator (pre-00410, a matched room
    // rule's id raised it because §7a checked service_rules) AND the
    // booking persisted a non-empty applied_rule_ids snapshot. `res.ok`
    // here already means HTTP 2xx; we additionally assert the success
    // body carries NO internal_refs marker and the snapshot stuck.
    passAssertion(
      '(f) NO §7a attach_plan.internal_refs 400 + applied_rule_ids persisted (the real 00410 signal)',
      !/attach_plan\.internal_refs/.test(res.body) && ruleIdList.length >= 1,
      `bodyHasInternalRefs=${/attach_plan\.internal_refs/.test(res.body)} applied_rule_ids=[${appliedRuleIds}]`,
    );

    passAssertion(
      '(f) ≥1 approval row created (room-rule approval fan-out — NOT a stuck booking)',
      countApprovals(bookingId) >= 1,
      `approvals=${countApprovals(bookingId)}`,
    );

    // Derive the EXPECTED approver set from whatever require_approval
    // room rule the resolver actually matched (read from the DB) — no
    // hardcoded approver. Asserts the created approval rows match the
    // matched rule's required_approvers, are 'pending', booking-targeted,
    // and chain_id-bearing (so the 00402 inbox fan-out fires).
    const expectedApproverPersonIds = runPsqlQuery(
      `select coalesce(string_agg(distinct (ra->>'id'), ',' order by (ra->>'id')), '')
         from public.room_booking_rules rbr,
              jsonb_array_elements(coalesce(rbr.approval_config->'required_approvers','[]'::jsonb)) ra
        where rbr.tenant_id='${TENANT_ID}'::uuid
          and rbr.id in (${inList})
          and rbr.effect='require_approval'
          and ra->>'type'='person';`,
    );
    const expectedSet = expectedApproverPersonIds
      ? expectedApproverPersonIds.split(',').map((s) => s.trim()).filter(Boolean).sort()
      : [];
    const actualApproverPersonIds = runPsqlQuery(
      `select coalesce(string_agg(distinct approver_person_id::text, ',' order by approver_person_id::text), '')
         from public.approvals
        where tenant_id='${TENANT_ID}'::uuid and target_entity_type='booking'
          and target_entity_id='${bookingId}'::uuid
          and approver_person_id is not null;`,
    );
    const actualSet = actualApproverPersonIds
      ? actualApproverPersonIds.split(',').map((s) => s.trim()).filter(Boolean).sort()
      : [];
    passAssertion(
      '(f) approval rows match the matched rule’s required_approvers (no hardcode)',
      expectedSet.length >= 1 &&
        expectedSet.length === actualSet.length &&
        expectedSet.every((id, i) => id === actualSet[i]),
      `expected=[${expectedSet.join(',')}] actual=[${actualSet.join(',')}]`,
    );
    passAssertion(
      "(f) every approval row: target booking, status='pending', chain_id set",
      scalar(
        `select (
            count(*) >= 1
            and count(*) filter (
              where target_entity_type='booking' and status='pending'
                and approval_chain_id is not null
            ) = count(*)
          )::text
          from public.approvals
         where tenant_id='${TENANT_ID}'::uuid
           and target_entity_id='${bookingId}'::uuid;`,
      ) === 'true',
      'an approval row is not booking-targeted/pending/chain-bearing',
    );
    // Atomicity: ALL N slots + the service graph committed in the one
    // combined-RPC transaction (catering OLI + AV OLI + AV asset_res).
    passAssertion(
      '(f) exactly 2 booking_slots (N rooms, one tx)',
      countSlots(bookingId) === 2,
      `slots=${countSlots(bookingId)}`,
    );
    passAssertion(
      '(f) ≥1 order present (services committed atomically with the slots)',
      countOrders(bookingId) >= 1,
      `orders=${countOrders(bookingId)}`,
    );
    passAssertion(
      '(f) ≥2 OLIs present (catering + AV — atomic with the approval booking)',
      countOlis(bookingId) >= 2,
      `olis=${countOlis(bookingId)}`,
    );
    passAssertion(
      '(f) ≥1 asset_reservation present (AV — atomic with the approval booking)',
      countAssetReservations(bookingId) >= 1,
      `ars=${countAssetReservations(bookingId)}`,
    );
    passAssertion(
      '(f) exactly 1 attach_operations row (atomic, one tx — no compensation window)',
      countAttachOps(idemKey) === 1,
      `attach_ops=${countAttachOps(idemKey)}`,
    );
  }
  // ruleId stays null — no fixture rule seeded (the resolver matches a
  // pre-existing seeded rule). spaceIds are swept by deleteFixtures via
  // booking_slots.space_id ∈ allSpaceIds; the matched pre-existing rule
  // is NOT ours to delete.
  void ruleId;
  return { spaceIds };
}

async function runSingleRoomRoomRuleProbe(probe, fx, adminUserId) {
  console.log('\n=== (g) SINGLE-room create-with-services + matched room rule → 201 (00410 §7a largest blast radius) ===');
  // FIX 3 — the 00410 §7a fix's BIGGEST blast radius is the SINGLE-room
  // create-with-services path where a room rule matched: it was a
  // pre-existing, never-smoke-covered latent break (the legacy
  // `create_booking` RPC had no §7a validator; the combined-RPC cutover
  // exposed it for single-room too, not just multi-room). Pre-00410, a
  // matched room rule's id in bookings.applied_rule_ids tripped §7a
  // (validated against service_rules) → 42501 → HTTP 400. We exercise
  // POST /reservations (the SINGLE-room route → BookingFlowService →
  // create_booking_with_attach_plan) with ONE dedicated room + services
  // + the SAME deterministic off-hours match probe (f) relies on (hour-17
  // UTC, 60-min → the 00133-seeded require_approval tenant rule b0010001).
  // A matched room rule ⇒ non-empty applied_rule_ids ⇒ §7a genuinely
  // exercised (NOT a tautology — an empty snapshot would skip §7a).
  const spaceIds = mkSpaceIds('sr', 1);
  runPsql(
    `set session_replication_role='replica';\n` +
      spaceSeedSql(spaceIds, 'sr') +
      `\nset session_replication_role='origin';`,
  );
  // Hour 19 UTC (NOT 17 — probe (f) books THOMAS_PERSON at hour-17; the
  // single-room conflict guard rejects the same requester double-booked
  // in an overlapping window even across different rooms). Hour-19 is
  // STILL off-business-hours → still deterministically matches the
  // 00133-seeded off-hours require_approval tenant rule (b0010001,
  // predicate `in_business_hours`), so applied_rule_ids is still
  // non-empty and §7a is genuinely exercised — without the cross-probe
  // requester-time collision.
  const { start, end } = isoAnchor(FIXTURE_DAYS, 19);
  const crid = crypto.randomUUID();
  const idemKey = buildCreateBookingIdempotencyKey(adminUserId, crid);

  const res = await probe(
    'Single-room + services + matched room rule → 201 (NOT §7a 400)',
    {
      url: `${API_BASE}/api/reservations`,
      body: {
        reservation_type: 'room',
        space_id: spaceIds[0],
        requester_person_id: THOMAS_PERSON,
        start_at: start,
        end_at: end,
        attendee_count: 4,
        source: 'desk',
        services: serviceLines(fx),
      },
      clientRequestId: crid,
      expect: 'success',
    },
  );
  if (res.ok) {
    const parsed = parseJsonSafe(res.body);
    // Response per BookingFlowService.create — { booking, slots, … }.
    const bookingId =
      parsed?.booking?.id ?? parsed?.booking_id ?? parsed?.bundle?.id ?? parsed?.id ??
      bookingIdForSpaces(spaceIds);
    passAssertion(
      '(g) single-room booking row present',
      !!bookingId && bookingStatus(bookingId) !== '',
      `bookingId=${bookingId} status=${bookingId ? bookingStatus(bookingId) : 'n/a'}`,
    );
    // THE 00410 §7a SIGNAL: a matched room rule ⇒ applied_rule_ids
    // non-empty; pre-00410 that exact id raised
    // `attach_plan.internal_refs: applied_rule_ids[] … not in tenant
    // service_rules` (42501 → 400). Success body must carry NO
    // internal_refs marker AND the snapshot must have persisted.
    const appliedRuleIds = runPsqlQuery(
      `select coalesce(array_to_string(applied_rule_ids, ','), '') from public.bookings where tenant_id='${TENANT_ID}'::uuid and id='${bookingId}'::uuid;`,
    );
    const ruleIdList = appliedRuleIds
      ? appliedRuleIds.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    passAssertion(
      '(g) single-room: matched room rule ⇒ applied_rule_ids non-empty (§7a genuinely exercised)',
      ruleIdList.length >= 1,
      `applied_rule_ids=[${appliedRuleIds}]`,
    );
    passAssertion(
      '(g) single-room: NO §7a attach_plan.internal_refs 400 (the real 00410 regression signal)',
      !/attach_plan\.internal_refs/.test(res.body),
      `bodyHasInternalRefs=${/attach_plan\.internal_refs/.test(res.body)} body=${res.body.slice(0, 200)}`,
    );
    passAssertion(
      '(g) single-room: ≥1 booking_slot present (create-with-services committed)',
      countSlots(bookingId) >= 1,
      `slots=${countSlots(bookingId)}`,
    );
    passAssertion(
      '(g) single-room: ≥1 order present (services attached atomically)',
      countOrders(bookingId) >= 1,
      `orders=${countOrders(bookingId)}`,
    );
  }
  return { spaceIds };
}

// ─────────────────────────────────────────────────────────────────────
// audit-03 P2-3 — NO-SERVICES single-room consolidation probes (h)-(k).
//
// smoke-recurrence-clone.mjs seeds WITH services + forces `confirmed`, so
// the no-services pending-approval path was NEVER live-covered. P2-3 cut
// it over from the legacy `create_booking` RPC + best-effort
// `createApprovalRows` onto the combined `create_booking_with_attach_plan`
// (migration 00429 extended its step-10 approvals INSERT 7→11 cols). These
// probes are the fail-closed gate for that cutover:
//
//   (h) no-services + NO approval rule → 2xx confirmed, 0 approval rows
//   (i) no-services + FLAT person-approver require_approval room rule →
//       pending_approval, ≥1 approvals row with approval_chain_id NOT NULL
//       + chain_threshold matching rule config + approver_person_id set,
//       ≥1 inbox_notifications row (THE exact P0 signal: pre-P2-3 a
//       no-services pending-approval booking via the combined RPC had
//       approval_chain_id=NULL and the 00402 trigger silently skipped it),
//       grant_booking_approval resolves it.
//   (j) FLAT team-approver rule → approver_team_id persisted + inbox
//       notified (the team branch of the 00402 trigger).
//   (k) C1-recurrence: a recurrence-tagged combined-RPC create with a
//       chain-bearing approval persists chain_id on the occurrence (the
//       00429 INSERT must not drop chain cols for recurrence_index rows).
//
// Self-contained fixtures (dedicated room-scoped rules + a dedicated team
// + the admin user as the deterministic approver so the 00402 trigger's
// users/team_members join actually finds a row). Real fail-closed:
// passAssertion feeds results.fail → main() exits 1.
// ─────────────────────────────────────────────────────────────────────

async function runNoServicesApprovalProbes(probe, adminUserId) {
  console.log(
    '\n=== (h)-(k) NO-SERVICES single-room consolidation (audit-03 P2-3) ===',
  );
  const adminPersonId = resolveAdminPersonId();
  if (!adminPersonId) {
    passAssertion(
      '(h-k) admin user has a person_id (deterministic approver fixture)',
      false,
      'resolveAdminPersonId() returned empty — cannot run the P2-3 probes',
    );
    return { spaceIds: [], ruleIds: [], teamIds: [], seriesIds: [] };
  }

  // 3 dedicated rooms: [h]=no-rule, [i]=person-rule, [j]=team-rule.
  const spaceIds = mkSpaceIds('p23', 3);
  const ruleIdPerson = crypto.randomUUID();
  const ruleIdTeam = crypto.randomUUID();
  const teamId = crypto.randomUUID();
  const ruleIds = [ruleIdPerson, ruleIdTeam];
  // audit-03 P2-3 probe (k): real recurrence_series parents seeded so the
  // 00303 validate_attach_plan_tenant_fks guard passes and the probe
  // genuinely exercises a recurrence-tagged combined-RPC create. Swept by
  // deleteFixtures (FK-ordered: after bookings, before nothing — it is a
  // parent of bookings.recurrence_series_id).
  const seriesIds = [];
  const teamIds = [teamId];

  runPsql(
    `set session_replication_role='replica';\n` +
      spaceSeedSql(spaceIds, 'p23') +
      `
      -- (i) FLAT person-approver require_approval rule, scoped to room[1],
      -- high priority (low number) so it deterministically wins. The
      -- approver IS the admin person so the 00402 users-join finds a row.
      insert into public.room_booking_rules
        (id, tenant_id, name, target_scope, target_id, applies_when,
         effect, approval_config, priority, active)
      values
        ('${ruleIdPerson}'::uuid, '${TENANT_ID}'::uuid,
         'Smoke P2-3 person approval', 'room', '${spaceIds[1]}'::uuid,
         '{"op":"eq","left":1,"right":1}'::jsonb,
         'require_approval',
         '{"required_approvers":[{"type":"person","id":"${adminPersonId}"}],"threshold":"all"}'::jsonb,
         1, true);

      -- (j) dedicated team + membership (admin user) so the 00402 team
      -- branch (team_members JOIN users) actually fans out an inbox row.
      insert into public.teams (id, tenant_id, name, active)
      values ('${teamId}'::uuid, '${TENANT_ID}'::uuid,
              'Smoke P2-3 approver team', true);
      insert into public.team_members (tenant_id, team_id, user_id)
      values ('${TENANT_ID}'::uuid, '${teamId}'::uuid,
              '${adminUserId}'::uuid);

      -- (j) FLAT team-approver require_approval rule, scoped to room[2].
      insert into public.room_booking_rules
        (id, tenant_id, name, target_scope, target_id, applies_when,
         effect, approval_config, priority, active)
      values
        ('${ruleIdTeam}'::uuid, '${TENANT_ID}'::uuid,
         'Smoke P2-3 team approval', 'room', '${spaceIds[2]}'::uuid,
         '{"op":"eq","left":1,"right":1}'::jsonb,
         'require_approval',
         '{"required_approvers":[{"type":"team","id":"${teamId}"}],"threshold":"all"}'::jsonb,
         1, true);
      ` +
      `\nset session_replication_role='origin';`,
  );

  const RES_URL = `${API_BASE}/api/reservations`;

  // ── (h) NO approval rule → confirmed, 0 approval rows ────────────────
  {
    const { start, end } = isoAnchor(FIXTURE_DAYS, 10); // business hours
    const crid = crypto.randomUUID();
    const idemKey = buildCreateBookingIdempotencyKey(adminUserId, crid);
    const res = await probe(
      '(h) no-services, no approval rule → 2xx confirmed, 0 approvals',
      {
        url: RES_URL,
        body: {
          reservation_type: 'room',
          space_id: spaceIds[0],
          requester_person_id: THOMAS_PERSON,
          start_at: start,
          end_at: end,
          attendee_count: 2,
          source: 'desk',
        },
        clientRequestId: crid,
        expect: 'success',
      },
    );
    if (res.ok) {
      const parsed = parseJsonSafe(res.body);
      const bookingId =
        parsed?.booking?.id ?? parsed?.booking_id ?? parsed?.id ??
        bookingIdForSpaces([spaceIds[0]]);
      passAssertion(
        '(h) booking landed status=confirmed',
        bookingStatus(bookingId) === 'confirmed',
        `status=${bookingStatus(bookingId)}`,
      );
      passAssertion(
        '(h) ZERO approval rows (no approval rule matched)',
        countApprovals(bookingId) === 0,
        `approvals=${countApprovals(bookingId)}`,
      );
      passAssertion(
        '(h) routed through the combined RPC (exactly 1 attach_operations row)',
        countAttachOps(idemKey) === 1,
        `attach_ops=${countAttachOps(idemKey)}`,
      );
      passAssertion(
        '(h) ≥1 booking_slot committed',
        countSlots(bookingId) >= 1,
        `slots=${countSlots(bookingId)}`,
      );
    }
  }

  // ── (i) FLAT person-approver rule → pending_approval + chain_id +
  //        inbox notified + grant resolves ──────────────────────────────
  {
    const { start, end } = isoAnchor(FIXTURE_DAYS, 12);
    const crid = crypto.randomUUID();
    const idemKey = buildCreateBookingIdempotencyKey(adminUserId, crid);
    const res = await probe(
      '(i) no-services + FLAT person approval rule → 2xx pending_approval',
      {
        url: RES_URL,
        body: {
          reservation_type: 'room',
          space_id: spaceIds[1],
          requester_person_id: THOMAS_PERSON,
          start_at: start,
          end_at: end,
          attendee_count: 2,
          source: 'desk',
        },
        clientRequestId: crid,
        expect: 'success',
      },
    );
    if (res.ok) {
      const parsed = parseJsonSafe(res.body);
      const bookingId =
        parsed?.booking?.id ?? parsed?.booking_id ?? parsed?.id ??
        bookingIdForSpaces([spaceIds[1]]);
      passAssertion(
        '(i) booking landed status=pending_approval (FLAT rule matched)',
        bookingStatus(bookingId) === 'pending_approval',
        `status=${bookingStatus(bookingId)}`,
      );
      passAssertion(
        '(i) ≥1 approval row (no-services FLAT path is NOT a stuck booking)',
        countApprovals(bookingId) >= 1,
        `approvals=${countApprovals(bookingId)}`,
      );
      // THE P0 signal: chain_id NOT NULL + chain_threshold matches the rule
      // config ('all') + person approver set. Pre-P2-3 the combined RPC's
      // 7-col INSERT left approval_chain_id NULL → the 00402 trigger
      // skipped it → silently un-notified.
      passAssertion(
        "(i) every approval row: chain_id NOT NULL, chain_threshold='all', approver_person_id set, pending",
        scalar(
          `select (
              count(*) >= 1
              and count(*) filter (
                where target_entity_type='booking' and status='pending'
                  and approval_chain_id is not null
                  and chain_threshold='all'
                  and approver_person_id is not null
              ) = count(*)
            )::text
            from public.approvals
           where tenant_id='${TENANT_ID}'::uuid
             and target_entity_id='${bookingId}'::uuid;`,
        ) === 'true',
        'an approval row is missing chain_id / chain_threshold / approver_person_id',
      );
      // THE exact P0 regression signal: the 00402 AFTER INSERT trigger
      // fanned out an inbox notification (only possible because chain_id is
      // now non-null on the in-transaction insert).
      passAssertion(
        '(i) ≥1 inbox_notifications row (00402 fan-out fired — the P2-3 fix)',
        countInboxForBooking(bookingId) >= 1,
        `inbox=${countInboxForBooking(bookingId)}`,
      );
      passAssertion(
        '(i) routed through the combined RPC (exactly 1 attach_operations row)',
        countAttachOps(idemKey) === 1,
        `attach_ops=${countAttachOps(idemKey)}`,
      );
      // grant_booking_approval resolves the chain (the approval is real +
      // wired, not an orphan row).
      const approvalRow = runPsqlQuery(
        `select id::text from public.approvals
          where tenant_id='${TENANT_ID}'::uuid
            and target_entity_id='${bookingId}'::uuid
          order by id limit 1;`,
      );
      if (approvalRow) {
        try {
          // Signature (00426): (p_approval_id, p_tenant_id, p_actor_user_id,
          // p_decision IN ('approved','rejected'), p_comments,
          // p_idempotency_key (required, non-empty)).
          runPsql(
            `select public.grant_booking_approval(
               '${approvalRow}'::uuid, '${TENANT_ID}'::uuid,
               '${adminUserId}'::uuid, 'approved', null,
               'smoke.p23.grant:${approvalRow}');`,
          );
          passAssertion(
            '(i) grant_booking_approval resolved the chain (no longer all-pending)',
            num(
              `select count(*) from public.approvals
                where tenant_id='${TENANT_ID}'::uuid
                  and target_entity_id='${bookingId}'::uuid
                  and status='pending';`,
            ) <
              num(
                `select count(*) from public.approvals
                  where tenant_id='${TENANT_ID}'::uuid
                    and target_entity_id='${bookingId}'::uuid;`,
              ) + 1,
            'grant_booking_approval did not change pending count',
          );
        } catch (e) {
          passAssertion(
            '(i) grant_booking_approval executed without error',
            false,
            `grant raised: ${String(e.message).slice(0, 160)}`,
          );
        }
      }
    }
  }

  // ── (j) FLAT team-approver rule → approver_team_id + inbox notified ──
  {
    const { start, end } = isoAnchor(FIXTURE_DAYS, 14);
    const crid = crypto.randomUUID();
    const idemKey = buildCreateBookingIdempotencyKey(adminUserId, crid);
    const res = await probe(
      '(j) no-services + FLAT TEAM approval rule → 2xx pending_approval',
      {
        url: RES_URL,
        body: {
          reservation_type: 'room',
          space_id: spaceIds[2],
          requester_person_id: THOMAS_PERSON,
          start_at: start,
          end_at: end,
          attendee_count: 2,
          source: 'desk',
        },
        clientRequestId: crid,
        expect: 'success',
      },
    );
    if (res.ok) {
      const parsed = parseJsonSafe(res.body);
      const bookingId =
        parsed?.booking?.id ?? parsed?.booking_id ?? parsed?.id ??
        bookingIdForSpaces([spaceIds[2]]);
      passAssertion(
        '(j) booking landed status=pending_approval (team rule matched)',
        bookingStatus(bookingId) === 'pending_approval',
        `status=${bookingStatus(bookingId)}`,
      );
      passAssertion(
        "(j) approval row: approver_team_id set, approver_person_id NULL, chain_id NOT NULL",
        scalar(
          `select (
              count(*) >= 1
              and count(*) filter (
                where approver_team_id is not null
                  and approver_person_id is null
                  and approval_chain_id is not null
                  and status='pending'
              ) = count(*)
            )::text
            from public.approvals
           where tenant_id='${TENANT_ID}'::uuid
             and target_entity_id='${bookingId}'::uuid;`,
        ) === 'true',
        'team approval row missing approver_team_id / chain_id, or has a person id',
      );
      passAssertion(
        '(j) ≥1 inbox_notifications row (00402 TEAM branch fanned out)',
        countInboxForBooking(bookingId) >= 1,
        `inbox=${countInboxForBooking(bookingId)}`,
      );
      passAssertion(
        '(j) routed through the combined RPC (exactly 1 attach_operations row)',
        countAttachOps(idemKey) === 1,
        `attach_ops=${countAttachOps(idemKey)}`,
      );
    }
  }

  // ── (k) C1-recurrence: a recurrence-tagged combined-RPC create with a
  //        chain-bearing approval must persist chain_id on the occurrence.
  //
  // Recurrence occurrences are materialised by RecurrenceService calling
  // bookingFlow.create → createWithAttachPlan per occurrence. An off-hours
  // occurrence can land pending_approval; its approval rows MUST keep the
  // chain cols (the 00429 INSERT must not special-case recurrence_index).
  // We assert this at the RPC boundary directly (deterministic, no
  // dependence on the fragile master-confirmed/occurrence-approval-gated
  // materialiser arrangement): invoke create_booking_with_attach_plan with
  // a recurrence_series_id + recurrence_index + a chain-bearing approval
  // and assert the persisted row carries the chain cols + the occurrence's
  // recurrence_index. ──────────────────────────────────────────────────
  {
    const occBookingId = crypto.randomUUID();
    const occSlotId = crypto.randomUUID();
    const seriesId = crypto.randomUUID();
    const approvalId = crypto.randomUUID();
    const chainId = crypto.randomUUID();
    const idemKey = `smoke.p23.recurrence:${seriesId}:7`;
    mintedIdempotencyKeys.add(idemKey);
    const { start, end } = isoAnchor(FIXTURE_DAYS, 16);

    // HONEST FIX (audit-03 slice6): seed a real tenant-scoped
    // recurrence_series PARENT before the combined-RPC call. Previously
    // probe (k) passed a dangling crypto.randomUUID() for
    // recurrence_series_id, so the PRE-EXISTING 00303
    // validate_attach_plan_tenant_fks guard correctly rejected the create
    // with 42501 'attach_plan.fk_invalid: recurrence_series_id' and the
    // probe never reached the chain-col assertions. Seeding a valid parent
    // (same proven-GREEN shape as smoke-edit-booking-scope.mjs:266-272 —
    // recurrence_series NOT-NULL cols per 00124: recurrence_rule,
    // series_start_at, materialized_through; max_occurrences defaults 365;
    // parent_booking_id nullable per 00278) makes the probe genuinely
    // exercise a recurrence-tagged combined-RPC create with chain-col
    // persistence. Swept by deleteFixtures via state.seriesIds.
    seriesIds.push(seriesId);
    runPsql(
      `set session_replication_role='replica';\n` +
        `insert into public.recurrence_series\n` +
        `  (id, tenant_id, recurrence_rule, series_start_at, materialized_through)\n` +
        `values\n` +
        `  ('${seriesId}'::uuid, '${TENANT_ID}'::uuid,\n` +
        `   jsonb_build_object('frequency','weekly','interval',1,'count',8),\n` +
        `   '${start}'::timestamptz, '${end}'::timestamptz);\n` +
        `set session_replication_role='origin';`,
    );

    const bookingInput = {
      booking_id: occBookingId,
      slot_ids: [occSlotId],
      requester_person_id: THOMAS_PERSON,
      host_person_id: null,
      booked_by_user_id: null,
      location_id: spaceIds[0],
      start_at: start,
      end_at: end,
      timezone: 'UTC',
      status: 'pending_approval',
      source: 'recurrence',
      title: 'Smoke P2-3 recurrence occurrence',
      description: null,
      cost_center_id: null,
      cost_amount_snapshot: null,
      policy_snapshot: {},
      applied_rule_ids: [],
      config_release_id: null,
      recurrence_series_id: seriesId,
      recurrence_index: 7,
      template_id: null,
      slots: [
        {
          id: occSlotId,
          slot_type: 'room',
          space_id: spaceIds[0],
          start_at: start,
          end_at: end,
          attendee_count: 2,
          attendee_person_ids: [],
          setup_buffer_minutes: 0,
          teardown_buffer_minutes: 0,
          check_in_required: false,
          check_in_grace_minutes: 15,
          display_order: 0,
        },
      ],
    };
    const attachPlan = {
      version: 1,
      any_pending_approval: true,
      any_deny: false,
      deny_messages: [],
      orders: [],
      asset_reservations: [],
      order_line_items: [],
      approvals: [
        {
          id: approvalId,
          target_entity_type: 'booking',
          target_entity_id: occBookingId,
          approver_person_id: adminPersonId,
          approver_team_id: null,
          approval_chain_id: chainId,
          parallel_group: `parallel-${occBookingId}`,
          chain_threshold: 'all',
          scope_breakdown: {
            reservation_ids: [],
            order_ids: [],
            order_line_item_ids: [],
            ticket_ids: [],
            asset_reservation_ids: [],
            reasons: [],
          },
          status: 'pending',
        },
      ],
      bundle_audit_payload: {
        bundle_id: occBookingId,
        booking_id: occBookingId,
        order_ids: [],
        order_line_item_ids: [],
        asset_reservation_ids: [],
        approval_ids: [approvalId],
        any_pending_approval: true,
      },
    };

    let rpcOk = false;
    let rpcErr = '';
    try {
      const { error } = await supa().rpc('create_booking_with_attach_plan', {
        p_booking_input: bookingInput,
        p_attach_plan: attachPlan,
        p_tenant_id: TENANT_ID,
        p_idempotency_key: idemKey,
      });
      rpcOk = !error;
      rpcErr = error ? JSON.stringify(error).slice(0, 200) : '';
    } catch (e) {
      rpcErr = String(e.message).slice(0, 200);
    }
    passAssertion(
      '(k) recurrence-tagged combined-RPC create succeeded',
      rpcOk,
      `rpcErr=${rpcErr}`,
    );
    if (rpcOk) {
      passAssertion(
        '(k) occurrence persisted with recurrence_series_id + recurrence_index=7',
        scalar(
          `select (recurrence_series_id='${seriesId}'::uuid
                   and recurrence_index=7)::text
             from public.bookings
            where tenant_id='${TENANT_ID}'::uuid and id='${occBookingId}'::uuid;`,
        ) === 'true',
        'occurrence missing recurrence tags',
      );
      // C1-recurrence core: the 00429 INSERT kept the chain cols on a
      // recurrence_index row (no special-casing) → chain_id present →
      // 00402 trigger fired for the occurrence's approval too.
      passAssertion(
        '(k) occurrence approval row carries chain_id + chain_threshold (C1-recurrence)',
        scalar(
          `select (approval_chain_id='${chainId}'::uuid
                   and chain_threshold='all'
                   and parallel_group='parallel-${occBookingId}')::text
             from public.approvals
            where tenant_id='${TENANT_ID}'::uuid and id='${approvalId}'::uuid;`,
        ) === 'true',
        'occurrence approval lost chain cols (00429 dropped them for recurrence)',
      );
      passAssertion(
        '(k) ≥1 inbox_notifications row for the recurrence occurrence',
        countInboxForBooking(occBookingId) >= 1,
        `inbox=${countInboxForBooking(occBookingId)}`,
      );
    }
  }

  // spaceIds + ruleIds + teamIds + seriesIds returned so deleteFixtures
  // sweeps them.
  return { spaceIds, ruleIds, teamIds, seriesIds };
}

// ─────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Smoke-testing multi-room create (create_booking_with_attach_plan) against ${API_BASE}`);

  try {
    const r = await fetch(`${API_BASE}/api/reservations?scope=upcoming&limit=1`, {
      method: 'HEAD',
    });
    if (r.status >= 500) throw new Error(`API health check failed: HTTP ${r.status}`);
  } catch (e) {
    console.error(`✗ API at ${API_BASE} is not reachable: ${e.message}`);
    console.error(`  Start the dev server first: pnpm dev:api`);
    process.exit(2);
  }

  // Pre-flight — the combined RPC must exist on remote.
  try {
    const exists = runPsqlQuery(
      "select to_regprocedure('public.create_booking_with_attach_plan(jsonb,jsonb,uuid,text)') is not null",
    );
    if (exists !== 't') {
      console.error('✗ public.create_booking_with_attach_plan RPC is NOT on remote.');
      process.exit(1);
    }
    console.log('✓ pre-flight: create_booking_with_attach_plan RPC present on remote');
  } catch (e) {
    console.error(`✗ pre-flight query failed: ${e.message}`);
    process.exit(2);
  }

  const state = { allSpaceIds: [], fixtureIds: [], ruleIds: [], teamIds: [], seriesIds: [] };

  try {
    const adminUserId = resolveAdminUserId();
    if (!adminUserId) {
      console.error('✗ could not resolve Admin public.users.id');
      process.exit(2);
    }
    console.log(`✓ admin actor.user_id resolved (${adminUserId.slice(0, 8)}…)`);

    // Primary fixture: 3 dedicated rooms + 1 catalog/asset graph.
    const mainSpaceIds = mkSpaceIds('main', 3);
    const fx = mkFixtureIds('main');
    state.allSpaceIds.push(...mainSpaceIds);
    state.fixtureIds.push(fx);
    runPsql(
      `set session_replication_role='replica';\n` +
        spaceSeedSql(mainSpaceIds, 'main') +
        catalogSeedSql(fx) +
        `\nset session_replication_role='origin';`,
    );
    console.log(`Seeded 3 main rooms + catering/AV catalog (+${FIXTURE_DAYS}d)…`);

    const accessToken = await mintAdminToken();
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'X-Tenant-Id': TENANT_ID,
      'Content-Type': 'application/json',
    };
    const probe = makeProber(headers);

    const ctx = await runAtomicCreateProbe(probe, mainSpaceIds, fx, adminUserId);
    if (ctx) {
      await runIdempotencyProbe(probe, mainSpaceIds, fx, adminUserId, ctx);
    }
    const conflictSpaceIds = await runPartialConflictProbe(probe, fx, adminUserId);
    state.allSpaceIds.push(...conflictSpaceIds);
    await runCrossTenantProbe(probe);
    await runMissingCridProbe(probe, mainSpaceIds);
    const appr = await runApprovalProbe(probe, fx, adminUserId);
    state.allSpaceIds.push(...appr.spaceIds);
    const sr = await runSingleRoomRoomRuleProbe(probe, fx, adminUserId);
    state.allSpaceIds.push(...sr.spaceIds);
    // audit-03 P2-3 — no-services consolidation probes (h)-(k).
    const p23 = await runNoServicesApprovalProbes(probe, adminUserId);
    state.allSpaceIds.push(...p23.spaceIds);
    state.ruleIds.push(...p23.ruleIds);
    state.teamIds.push(...p23.teamIds);
    state.seriesIds.push(...(p23.seriesIds ?? []));
  } finally {
    console.log('\nCleaning up fixtures…');
    await deleteFixtures(state);
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

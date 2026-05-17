#!/usr/bin/env node
/**
 * scripts/smoke-recurrence-clone.mjs
 *
 * Live-API smoke for the recurrence occurrence-clone path — booking-audit
 * remediation Slice 7 (audit 03 P2-1: retire BookingTransactionBoundary +
 * BookingCompensationService).
 *
 * What Slice 7 changed (the regression this gate defends):
 *   - The recurrence occurrence-clone used to wrap
 *     `cloneBundleOrdersToOccurrence` in
 *     `BookingTransactionBoundary.runWithCompensation(occId, clone,
 *     (id) => compensation.deleteBooking(id))`. Both legacy classes are
 *     RETIRED. `RecurrenceService.materialize()` now runs the clone in a
 *     plain `try/catch`; on a clone throw it calls the new focused
 *     private helper `RecurrenceService.deleteOrphanOccurrence` which
 *     calls `delete_booking_with_guard` (00292/00373) DIRECTLY and
 *     reproduces the `booking.compensation_failed` /
 *     `booking.compensation_partial_failure` audit_events emission +
 *     the "don't advance materialized_through on unexpected failure"
 *     signal VERBATIM. The TS clone (OrderService.cloneOrderForOccurrence
 *     — needs the JSONLogic rule resolver) STAYS in TS, unchanged.
 *
 * Real entrypoint (verified, NOT a synthetic route):
 *   `POST /api/reservations` with a `recurrence_rule` →
 *   BookingFlowService.create (booking-flow.service.ts:457-465 / :642-648)
 *   → `void this.startSeries(...)` (fire-and-forget, .catch()-swallowed)
 *   → startSeries inserts recurrence_series + calls
 *     `this.recurrence.materialize(seriesId, horizon)`
 *     (booking-flow.service.ts:1072-1076).
 *   Because startSeries is void-fired and materialize is .catch()-
 *   swallowed, materialisation failures do NOT surface in the HTTP
 *   response. So this probe asserts the DB rows of the cloned occurrence
 *   bookings, never the HTTP status.
 *
 * Coverage:
 *   - **Happy-path clone (load-bearing regression gate).** POST a
 *     recurring booking (daily ×3) carrying services with MIXED
 *     `repeats_with_series` (catering true, AV false). Poll the
 *     occurrence bookings, then assert (keyed to the seeded
 *     series/occurrence ids):
 *       · occurrence bookings materialised (recurrence_index > 0);
 *       · the `repeats_with_series=true` (catering) line is cloned onto
 *         each occurrence's order; the `repeats_with_series=false` (AV)
 *         line is NOT;
 *       · the cloned OLI service window is time-shifted by exactly
 *         (occurrence.start − master.start);
 *       · cloned order carries recurrence_series_id;
 *       · everything tenant-scoped (#0 invariant).
 *     A boundary-removal regression (clone silently dropped, wrong
 *     time-shift, wrong filter, cross-tenant leak) fails this gate —
 *     and it talks to the REAL entrypoint + real DB, which mocked jest
 *     cannot.
 *
 * Forced-failure compensation path (HONEST coverage boundary — printed,
 * NOT skipped-as-pass, NOT counted as a probe):
 *   The compensation branch (clone throws → deleteOrphanOccurrence →
 *   delete_booking_with_guard + booking.compensation_* audit + don't-
 *   advance materialized_through) is NOT deterministically drivable
 *   through the live POST entrypoint within a sane smoke budget:
 *     1. The only failure-injection points live INSIDE the void+catch-
 *        swallowed `startSeries`/`materialize` promise. Its intermediate
 *        occurrence booking ids are not observable until AFTER the
 *        promise completes, so a mid-flight blocker (e.g. a child
 *        recurrence_series whose parent_booking_id = the occurrence —
 *        the only delete_booking_with_guard blocker, 00373:127-133)
 *        cannot be seeded against an id that doesn't exist yet.
 *     2. The plan-suggested lever ("pre-seed a conflicting confirmed
 *        asset_reservation so the clone's AR insert trips GiST 23P01")
 *        is PROVABLY a false lead: order.service.ts:276-278 CATCHES the
 *        23P01 on the cloned AR (marks the OLI `recurrence_skipped`,
 *        does NOT throw) — so it never reaches the compensation path.
 *   The full compensation/audit/don't-advance wiring is covered against
 *   the REAL `deleteOrphanOccurrence` + the real
 *   `delete_booking_with_guard` arg shape by the rewritten jest:
 *   apps/api/src/modules/reservations/recurrence-materialize.service.spec.ts
 *   ("Slice 7 direct delete_booking_with_guard compensation" + "Slice 7
 *   audit emission + materialized_through gating" — 7 tests). Faking an
 *   HTTP failure here would be a constructed-to-pass probe; per the
 *   booking-canonicalisation honesty rule we state the boundary instead.
 *
 * USAGE:
 *   pnpm dev:api &     (or have the dev server already running)
 *   node apps/api/scripts/smoke-recurrence-clone.mjs
 *
 *   exit 0 = all probes pass
 *   exit 1 = at least one regression
 *   exit 2 = infra error (API unreachable, fixture seed failed)
 *
 * Citations (every named symbol below was Read in this session):
 *   - apps/api/src/modules/reservations/recurrence.service.ts
 *     (materialize / deleteOrphanOccurrence / cloneBundleOrdersToOccurrence).
 *   - apps/api/src/modules/reservations/booking-flow.service.ts:1032-1076
 *     (startSeries → recurrence.materialize entrypoint).
 *   - apps/api/src/modules/orders/order.service.ts:129-356
 *     (cloneOrderForOccurrence: repeats_with_series filter + window
 *     time-shift; :276-278 the swallowed 23P01).
 *   - apps/api/src/modules/reservations/reservation.controller.ts:104-126
 *     (@Post() create + RequireClientRequestIdGuard).
 *   - supabase/migrations/00144_orders_bundle_columns.sql (orders/OLI
 *     recurrence + service_window columns; repeats_with_series default true).
 *   - supabase/migrations/00277_create_canonical_booking_schema.sql:74-75
 *     (bookings.recurrence_series_id / recurrence_index).
 *   - apps/api/scripts/smoke-attach-services.mjs + smoke-cancel-booking.mjs
 *     (sibling harness — env / supa / psql / mintAdminToken / fetchResilient
 *     / makeProber / passAssertion / FK-ordered cleanup).
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
const THOMAS_PERSON = 'b3a0aa30-3648-4783-92fa-973090877238';

// Fixture anchor +160d clears the other booking smokes' windows
// (cancel +140/+141, attach-services +150) so back-to-back runs on the
// dedicated seeded room never collide.
// MUST be within the rolling 90-day materialization horizon:
// BookingFlowService.startSeries (booking-flow.service.ts:1017,1054)
// calls materialize() with horizon = now+90d, and
// RecurrenceService.materialize's `passes(d)` (recurrence.service.ts:
// 186-187) rejects any occurrence where d > materialized_through(=that
// horizon). A series whose daily×3 expansion lands beyond now+90d
// materialises ZERO occurrences (correct rolling-window behaviour — it
// would materialise later as the window advances). 30d + the Monday
// snap (~30-36d out) keeps the master + Tue/Wed occurrences all inside
// now+90d. This smoke seeds its OWN dedicated room, so a far-future
// window is NOT needed for sibling-smoke collision avoidance.
const FIXTURE_DAYS = 30;
// daily ×3 — 3 occurrences (master = index 0 + 2 materialised).
const OCC_COUNT = 3;

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
// psql helpers (mirror smoke-cancel-booking.mjs:140-177).
// ─────────────────────────────────────────────────────────────────────

function dbUrl() {
  return (
    env.SUPABASE_DB_URL ||
    'postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres'
  );
}

function runPsql(sql) {
  const dbPass = env.SUPABASE_DB_PASS;
  if (!dbPass)
    throw new Error('smoke-recurrence-clone: SUPABASE_DB_PASS missing from .env');
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
  if (!dbPass)
    throw new Error('smoke-recurrence-clone: SUPABASE_DB_PASS missing from .env');
  try {
    const out = execFileSync(
      'psql',
      [dbUrl(), '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql],
      {
        env: { ...process.env, PGPASSWORD: dbPass },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return out.toString().trim();
  } catch (e) {
    const stderr = e.stderr?.toString() ?? '';
    throw new Error(
      `psql query failed: ${e.message}\nstderr: ${stderr}\nsql: ${sql.slice(0, 220)}…`,
    );
  }
}

function scalar(sql) {
  return runPsqlQuery(sql);
}
function num(sql) {
  return Number.parseInt(runPsqlQuery(sql), 10) || 0;
}

// ─────────────────────────────────────────────────────────────────────
// Fixture seed — a dedicated reservable room + catering/AV catalog graph.
// session_replication_role='replica' bypasses RLS + booking outbox
// triggers so the seed is fast + deterministic.
// ─────────────────────────────────────────────────────────────────────

function mkFixtureIds(tag) {
  return {
    tag,
    spaceId: crypto.randomUUID(),
    cateringCatalogId: crypto.randomUUID(),
    avCatalogId: crypto.randomUUID(),
    assetTypeId: crypto.randomUUID(),
    assetId: crypto.randomUUID(),
  };
}

function seedFixture(ids) {
  runPsql(
    `set session_replication_role = 'replica';
     insert into public.spaces
       (id, tenant_id, type, name, capacity, reservable, active,
        setup_buffer_minutes, teardown_buffer_minutes,
        check_in_required, check_in_grace_minutes)
     values
       ('${ids.spaceId}'::uuid, '${TENANT_ID}'::uuid, 'room',
        'Smoke RC room ${ids.tag}', 20, true, true, 0, 0, false, 15);

     insert into public.catalog_items
       (id, tenant_id, name, category, unit, price_per_unit,
        display_order, active, requires_return)
     values
       ('${ids.cateringCatalogId}'::uuid, '${TENANT_ID}'::uuid,
        'Smoke RC catering ${ids.tag}', 'food_and_drinks', 'per_person',
        12.50, 0, true, false);

     insert into public.asset_types (id, tenant_id, name)
     values
       ('${ids.assetTypeId}'::uuid, '${TENANT_ID}'::uuid,
        'Smoke RC AV type ${ids.tag}');
     insert into public.assets
       (id, tenant_id, asset_type_id, asset_role, name, status)
     values
       ('${ids.assetId}'::uuid, '${TENANT_ID}'::uuid,
        '${ids.assetTypeId}'::uuid, 'pooled',
        'Smoke RC projector ${ids.tag}', 'available');
     insert into public.catalog_items
       (id, tenant_id, name, category, unit, price_per_unit,
        display_order, active, requires_return, linked_asset_type_id)
     values
       ('${ids.avCatalogId}'::uuid, '${TENANT_ID}'::uuid,
        'Smoke RC AV ${ids.tag}', 'equipment', 'flat_rate', 75.00,
        1, true, true, '${ids.assetTypeId}'::uuid);
     set session_replication_role = 'origin';`,
  );
}

// ─────────────────────────────────────────────────────────────────────
// Cleanup — FK-ordered, best-effort. Sweeps the whole materialised
// series (master + occurrences) + their cloned orders/OLIs/AR + the
// seeded catalog/asset/space + command_operations/outbox/audit rows.
// ─────────────────────────────────────────────────────────────────────

function cleanup(ids, seriesId, masterBookingId) {
  const sid = seriesId ? `'${seriesId}'::uuid` : 'null';
  const sql = `
    set session_replication_role = 'replica';
    -- All bookings in the series (master + occurrences).
    create temp table _rc_bk on commit drop as
      select id from public.bookings
       where tenant_id = '${TENANT_ID}'::uuid
         and (recurrence_series_id = ${sid}
              ${masterBookingId ? `or id = '${masterBookingId}'::uuid` : ''});
    delete from public.audit_events
      where tenant_id = '${TENANT_ID}'::uuid
        and entity_type = 'booking'
        and entity_id in (select id from _rc_bk);
    delete from public.domain_events
      where tenant_id = '${TENANT_ID}'::uuid
        and entity_type = 'booking'
        and entity_id in (select id from _rc_bk);
    delete from outbox.events
      where tenant_id = '${TENANT_ID}'::uuid
        and aggregate_id in (select id from _rc_bk);
    delete from public.command_operations
      where tenant_id = '${TENANT_ID}'::uuid
        and idempotency_key like 'booking.create:%';
    delete from public.approvals
      where tenant_id = '${TENANT_ID}'::uuid
        and target_entity_type = 'booking'
        and target_entity_id in (select id from _rc_bk);
    delete from public.asset_reservations
      where tenant_id = '${TENANT_ID}'::uuid
        and booking_id in (select id from _rc_bk);
    delete from public.order_line_items
      where tenant_id = '${TENANT_ID}'::uuid
        and order_id in (select id from public.orders
                          where tenant_id = '${TENANT_ID}'::uuid
                            and booking_id in (select id from _rc_bk));
    delete from public.orders
      where tenant_id = '${TENANT_ID}'::uuid
        and booking_id in (select id from _rc_bk);
    delete from public.booking_slots
      where tenant_id = '${TENANT_ID}'::uuid
        and booking_id in (select id from _rc_bk);
    delete from public.bookings
      where tenant_id = '${TENANT_ID}'::uuid
        and id in (select id from _rc_bk);
    delete from public.recurrence_series
      where tenant_id = '${TENANT_ID}'::uuid
        and (id = ${sid}
             ${masterBookingId ? `or parent_booking_id = '${masterBookingId}'::uuid` : ''});
    delete from public.catalog_items
      where tenant_id = '${TENANT_ID}'::uuid
        and id in ('${ids.cateringCatalogId}'::uuid, '${ids.avCatalogId}'::uuid);
    delete from public.assets
      where tenant_id = '${TENANT_ID}'::uuid and id = '${ids.assetId}'::uuid;
    delete from public.asset_types
      where tenant_id = '${TENANT_ID}'::uuid and id = '${ids.assetTypeId}'::uuid;
    delete from public.spaces
      where tenant_id = '${TENANT_ID}'::uuid and id = '${ids.spaceId}'::uuid;
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

// ─────────────────────────────────────────────────────────────────────
// HTTP + probe runner (mirror smoke-cancel-booking.mjs:496-577).
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
        /ECONNRESET|UND_ERR_SOCKET|fetch failed|ECONNREFUSED|socket hang up/i.test(
          msg,
        );
      if (!transient || attempt === 2) throw e;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw new Error('fetchResilient: unreachable');
}

function makeProber(headers) {
  return async function probe(name, options) {
    const { method = 'POST', url, body, expect = 'success' } = options;
    const xCid = crypto.randomUUID();
    const probeHeaders = { ...headers, 'X-Client-Request-Id': xCid };
    const r = await fetchResilient(url, {
      method,
      headers: probeHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const ok =
      (expect === 'success' && r.status >= 200 && r.status < 300) ||
      (expect === 'badrequest' && r.status === 400) ||
      (expect === 'notfound' && r.status === 404);
    const txt = await r.text();
    if (ok) {
      results.pass += 1;
      console.log(`  ✓ ${name} → HTTP ${r.status}`);
    } else {
      results.fail += 1;
      results.failed.push(name);
      console.log(`  ✗ ${name} → HTTP ${r.status} (expected ${expect})`);
      console.log(`     ${txt.slice(0, 320)}`);
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
// Poll for the materialised occurrence bookings (startSeries / materialize
// are void-fired + .catch()-swallowed → not in the HTTP response). Bounded
// retry on a tenant-scoped psql count.
// ─────────────────────────────────────────────────────────────────────

async function waitForOccurrences(seriesId, want, maxMs = 60_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const n = num(
      `select count(*) from public.bookings
        where tenant_id='${TENANT_ID}'::uuid
          and recurrence_series_id='${seriesId}'::uuid
          and recurrence_index > 0;`,
    );
    if (n >= want) return n;
    await new Promise((r) => setTimeout(r, 2500));
  }
  return num(
    `select count(*) from public.bookings
      where tenant_id='${TENANT_ID}'::uuid
        and recurrence_series_id='${seriesId}'::uuid
        and recurrence_index > 0;`,
  );
}

// ─────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(
    `Smoke-testing recurrence occurrence-clone (Slice 7) against ${API_BASE}`,
  );

  try {
    const r = await fetch(
      `${API_BASE}/api/reservations?scope=upcoming&limit=1`,
      { method: 'HEAD' },
    );
    if (r.status >= 500) throw new Error(`API health check failed: HTTP ${r.status}`);
  } catch (e) {
    console.error(`✗ API at ${API_BASE} is not reachable: ${e.message}`);
    console.error(`  Start the dev server first: pnpm dev:api`);
    process.exit(2);
  }

  // Pre-flight — delete_booking_with_guard must exist on remote
  // (00292 / 00373). Slice 7's compensation calls it directly.
  try {
    const exists = runPsqlQuery(
      "select to_regprocedure('public.delete_booking_with_guard(uuid,uuid)') is not null",
    );
    if (exists !== 't') {
      console.error('✗ public.delete_booking_with_guard RPC is NOT on remote.');
      console.error('  Push migration 00292 + 00373 first (psql fallback).');
      process.exit(1);
    }
    console.log(
      '✓ pre-flight: delete_booking_with_guard RPC present on remote',
    );
  } catch (e) {
    console.error(`✗ pre-flight query failed: ${e.message}`);
    process.exit(2);
  }

  const ids = mkFixtureIds('main');
  let seriesId = null;
  let masterBookingId = null;
  try {
    console.log(
      `Seeding fixture (+${FIXTURE_DAYS}d: 1 room + catering/AV catalog + asset)…`,
    );
    seedFixture(ids);

    const accessToken = await mintAdminToken();
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'X-Tenant-Id': TENANT_ID,
      'Content-Type': 'application/json',
    };
    const probe = makeProber(headers);

    // ── Create the recurring master booking WITH services. daily ×3.
    // The booking MUST land `confirmed` (NOT pending_approval) or
    // BookingFlowService.startSeries is suppressed by design
    // (booking-flow.service.ts:622-627 gates on status!=='pending_approval')
    // and no recurrence_series is ever created — the path under test.
    // Tenant-001's "Off-hours bookings need approval" room_booking_rule
    // (00133:48-81) routes any start_at NOT in business hours →
    // pending_approval. The active calendar (business_hours_calendars
    // 91100000-…-001 "TSS Office Hours") is Europe/Amsterdam, Mon-Fri
    // 08:00-17:00 (Sat/Sun closed). So: snap the anchor to a MONDAY at
    // 10:00 UTC (= 11:00 CET / 12:00 CEST — safely inside 08:00-17:00 for
    // either DST offset) so the daily×3 expansion lands Mon/Tue/Wed —
    // all business days, all in-hours → confirmed, startSeries fires.
    const anchor = new Date(Date.now() + FIXTURE_DAYS * 86400_000);
    anchor.setUTCMinutes(0, 0, 0);
    anchor.setUTCHours(10);
    // advance to the next Monday (getUTCDay(): 0=Sun..6=Sat → 1=Mon)
    while (anchor.getUTCDay() !== 1) {
      anchor.setUTCDate(anchor.getUTCDate() + 1);
    }
    const masterStart = anchor.toISOString();
    const masterEnd = new Date(anchor.getTime() + 60 * 60_000).toISOString();

    console.log('\n=== happy-path: create recurring booking with services ===');
    const createRes = await probe(
      'POST /api/reservations (daily ×3, services mixed repeats_with_series) → 2xx',
      {
        url: `${API_BASE}/api/reservations`,
        body: {
          reservation_type: 'room',
          space_id: ids.spaceId,
          requester_person_id: THOMAS_PERSON,
          start_at: masterStart,
          end_at: masterEnd,
          attendee_count: 8,
          source: 'desk',
          recurrence_rule: {
            frequency: 'daily',
            interval: 1,
            count: OCC_COUNT,
          },
          services: [
            {
              // Repeats — must be cloned onto every occurrence.
              catalog_item_id: ids.cateringCatalogId,
              quantity: 8,
              repeats_with_series: true,
              // buildAttachPlan requires a non-empty client_line_id on
              // every service line (client_line_id_required 400 otherwise
              // — mirrors smoke-attach-services / smoke-cancel-order-line).
              client_line_id: 'sr-catering-1',
            },
            {
              // Master-only — must NOT be cloned (order.service.ts:206
              // `.eq('repeats_with_series', true)`).
              catalog_item_id: ids.avCatalogId,
              quantity: 1,
              linked_asset_id: ids.assetId,
              repeats_with_series: false,
              client_line_id: 'sr-av-1',
            },
          ],
        },
      },
    );
    if (!createRes.ok) {
      console.log('  (create failed — cannot assert clone; see body above)');
    } else {
      const parsed = parseJsonSafe(createRes.body);
      masterBookingId =
        parsed?.booking?.id ??
        parsed?.booking_id ??
        parsed?.bundle?.id ??
        parsed?.id ??
        scalar(
          `select distinct booking_id from public.booking_slots
            where tenant_id='${TENANT_ID}'::uuid
              and space_id='${ids.spaceId}'::uuid limit 1;`,
        );
      passAssertion(
        'master booking row present',
        !!masterBookingId &&
          scalar(
            `select count(*) from public.bookings
              where tenant_id='${TENANT_ID}'::uuid and id='${masterBookingId}'::uuid;`,
          ) === '1',
        `masterBookingId=${masterBookingId}`,
      );
      // Self-diagnosing gate: startSeries (booking-flow.service.ts:622-627)
      // is suppressed by design when the booking is pending_approval, so
      // a fixture that trips the off-hours/approval rule would silently
      // make the whole recurrence-clone path untestable. Assert confirmed
      // LOUDLY with the remediation hint rather than fail opaquely later.
      const masterStatus = masterBookingId
        ? scalar(
            `select coalesce(status,'<none>') from public.bookings
              where tenant_id='${TENANT_ID}'::uuid and id='${masterBookingId}'::uuid;`,
          )
        : '<no-booking>';
      passAssertion(
        'master booking is confirmed (NOT pending_approval — else startSeries is suppressed by design)',
        masterStatus === 'confirmed',
        `status=${masterStatus} — if pending_approval the fixture window tripped the 00133 off-hours rule; ` +
          `the anchor must be a Europe/Amsterdam business-hours weekday (Mon-Fri 08:00-17:00)`,
      );

      // recurrence_series anchored at the master (booking-flow.service.ts:
      // 1037-1049 — parent_booking_id = master.id). `startSeries` is
      // `void`-fired (booking-flow.service.ts:462/647) so it runs AFTER
      // the HTTP 201; POLL for the row (bounded). If it never appears
      // within the budget that is a REAL failure (startSeries broke /
      // its .catch swallowed an error), NOT a timing artefact — the
      // assertion below then fails honestly with seriesId=''.
      for (let attempt = 0; attempt < 16 && !seriesId; attempt += 1) {
        seriesId = scalar(
          `select id from public.recurrence_series
            where tenant_id='${TENANT_ID}'::uuid
              and parent_booking_id='${masterBookingId}'::uuid limit 1;`,
        );
        if (!seriesId) await new Promise((r) => setTimeout(r, 2500));
      }
      passAssertion(
        'recurrence_series row created + anchored at master (polled ≤40s)',
        !!seriesId && seriesId !== '',
        `seriesId=${seriesId}`,
      );

      if (seriesId) {
        // ── Poll for the materialised occurrence bookings. startSeries
        // (void) → materialize (.catch-swallowed) runs the daily ×3
        // expansion: index 0 = master, indices 1..2 = occurrences.
        console.log(
          `  … polling for ${OCC_COUNT - 1} occurrence bookings (≤60s; startSeries is fire-and-forget)…`,
        );
        const got = await waitForOccurrences(seriesId, OCC_COUNT - 1);
        passAssertion(
          `materialised ${OCC_COUNT - 1} occurrence bookings`,
          got >= OCC_COUNT - 1,
          `got ${got} (want ≥ ${OCC_COUNT - 1}) — materialize() not producing occurrences?`,
        );

        // Per-occurrence assertions, keyed to the seeded series.
        const occRows = runPsqlQuery(
          `select id || '|' || recurrence_index || '|' || start_at
             from public.bookings
            where tenant_id='${TENANT_ID}'::uuid
              and recurrence_series_id='${seriesId}'::uuid
              and recurrence_index > 0
            order by recurrence_index;`,
        )
          .split('\n')
          .filter(Boolean)
          .map((l) => {
            const [id, idx, start] = l.split('|');
            return { id, idx: Number(idx), start };
          });

        passAssertion(
          'all occurrences are tenant-scoped (#0 invariant)',
          num(
            `select count(*) from public.bookings
              where recurrence_series_id='${seriesId}'::uuid
                and tenant_id <> '${TENANT_ID}'::uuid;`,
          ) === 0,
          'a cloned occurrence leaked outside the tenant',
        );

        const masterStartMs = Date.parse(masterStart);
        for (const occ of occRows) {
          const tag = `occ#${occ.idx}`;

          // The repeats_with_series=true (catering) line must be cloned
          // onto this occurrence's order; the AV line must NOT be.
          const cateringClonedCount = num(
            `select count(*) from public.order_line_items oli
               join public.orders o on o.id = oli.order_id
              where o.tenant_id='${TENANT_ID}'::uuid
                and o.booking_id='${occ.id}'::uuid
                and oli.catalog_item_id='${ids.cateringCatalogId}'::uuid;`,
          );
          passAssertion(
            `${tag}: catering line (repeats_with_series=true) cloned`,
            cateringClonedCount >= 1,
            `cateringClonedCount=${cateringClonedCount}`,
          );
          const avClonedCount = num(
            `select count(*) from public.order_line_items oli
               join public.orders o on o.id = oli.order_id
              where o.tenant_id='${TENANT_ID}'::uuid
                and o.booking_id='${occ.id}'::uuid
                and oli.catalog_item_id='${ids.avCatalogId}'::uuid;`,
          );
          passAssertion(
            `${tag}: AV line (repeats_with_series=false) NOT cloned`,
            avClonedCount === 0,
            `avClonedCount=${avClonedCount} (expected 0 — order.service.ts:206 filter)`,
          );

          // Cloned order carries the series id (order.service.ts:183).
          passAssertion(
            `${tag}: cloned order tagged recurrence_series_id`,
            num(
              `select count(*) from public.orders
                where tenant_id='${TENANT_ID}'::uuid
                  and booking_id='${occ.id}'::uuid
                  and recurrence_series_id='${seriesId}'::uuid;`,
            ) >= 1,
            'cloned order missing recurrence_series_id',
          );

          // Service window time-shift: cloned OLI.service_window_start_at
          // should equal occurrence.start + (masterLineWindow −
          // masterStart). The catering line had no explicit window →
          // master OLI window defaults to the order/booking window
          // (= masterStart); so delta = 0 and the cloned window equals
          // the occurrence start (order.service.ts:209-217,251).
          const cloned = scalar(
            `select coalesce(oli.service_window_start_at::text,'<null>')
               from public.order_line_items oli
               join public.orders o on o.id = oli.order_id
              where o.tenant_id='${TENANT_ID}'::uuid
                and o.booking_id='${occ.id}'::uuid
                and oli.catalog_item_id='${ids.cateringCatalogId}'::uuid
              limit 1;`,
          );
          // The cloned window must be shifted to the OCCURRENCE's day,
          // never left on the master's day (the boundary-removal
          // regression would copy the master window verbatim).
          const occStartMs = Date.parse(occ.start);
          const clonedMs = cloned === '<null>' ? NaN : Date.parse(cloned);
          passAssertion(
            `${tag}: cloned service window time-shifted onto the occurrence (not the master day)`,
            !Number.isNaN(clonedMs) &&
              Math.abs(clonedMs - occStartMs) < 60_000 &&
              Math.abs(clonedMs - masterStartMs) >
                23 * 3_600_000, // ≥ ~1 day off the master (daily ×N)
            `cloned=${cloned} occStart=${occ.start} masterStart=${masterStart}`,
          );
        }
      }
    }

    // ── Honest coverage boundary (printed; NOT a probe; NOT skip-as-pass).
    console.log('\n=== compensation path — honest coverage boundary ===');
    console.log(
      '  NOTE: the clone-failure compensation branch (deleteOrphanOccurrence →',
    );
    console.log(
      '  delete_booking_with_guard + booking.compensation_* audit + don\'t-advance',
    );
    console.log(
      '  materialized_through) is NOT deterministically drivable through the live',
    );
    console.log(
      '  POST entrypoint: the only failure-injection points live inside the',
    );
    console.log(
      '  void+catch-swallowed startSeries/materialize promise (intermediate',
    );
    console.log(
      '  occurrence ids unobservable), and the plan-suggested AR-conflict lever',
    );
    console.log(
      '  is provably SWALLOWED at order.service.ts:276-278 (not thrown). That',
    );
    console.log(
      '  branch is covered against the REAL deleteOrphanOccurrence +',
    );
    console.log(
      '  delete_booking_with_guard arg shape by the rewritten jest:',
    );
    console.log(
      '  src/modules/reservations/recurrence-materialize.service.spec.ts',
    );
    console.log(
      '  (Slice 7 — 7 tests: direct-delete args, rolled_back/partial/failed',
    );
    console.log(
      '  audit emission, materialized_through gating). Not faked here.',
    );
  } finally {
    console.log('\nCleaning up fixtures…');
    cleanup(ids, seriesId, masterBookingId);
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

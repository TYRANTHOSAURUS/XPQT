#!/usr/bin/env node
/**
 * scripts/smoke-edit-booking.mjs
 *
 * Live-API smoke test for the single-occurrence booking edit pipeline.
 * Hits `PATCH /api/reservations/:id` (editOne) + `PATCH /api/reservations/
 * :bookingId/slots/:slotId` (editSlot) end-to-end against the remote
 * Supabase project with a real Admin JWT.
 *
 * Sibling to `smoke-edit-booking-scope.mjs` (recurrence-scope edit
 * pipeline). Same shape: psql-seeded fixture, real HTTP probes,
 * command_operations + DB-level row assertions, deterministic cleanup.
 *
 * What this probe defends against:
 *   - **00364 `edit_booking` RPC contract** — same RPC powers editOne
 *     (single booking) + editSlot (one slot of a multi-slot booking).
 *     A subtle wiring break (parameter reorder, return-shape change,
 *     idempotency-key shape drift) is invisible to mocked-jest specs
 *     but production-critical. Citation:
 *     `apps/api/src/modules/reservations/reservation.controller.ts:301-380`,
 *     `apps/api/src/modules/reservations/reservation.service.ts:600-1450`,
 *     `supabase/migrations/00364_edit_booking_rpc_v4.sql`.
 *   - **Idempotency-key op-discrimination (Step 2F.3)** — `op='one'` and
 *     `op='slot'` must mint distinct `command_operations` rows even with
 *     the same `(bookingId, clientRequestId)`. A regression here
 *     silently collapses editOne + editSlot retries against the same
 *     booking into one cached row. Citation:
 *     `packages/shared/src/idempotency.ts:331-382`.
 *   - **`booking_slot.url_mismatch` guard** — defends against forged
 *     frontend state where `slot.booking_id ≠ URL bookingId`. Citation:
 *     `apps/api/src/modules/reservations/reservation.service.ts:1161-1165`.
 *   - **Validation gates** — `booking.invalid_window` (start>=end +
 *     unparseable timestamp), `booking.invalid_space_id` (empty string /
 *     null), `reference.not_in_tenant` (ghost-uuid space), missing
 *     `X-Client-Request-Id`, `booking_not_found` (ghost booking id),
 *     `command_operations.payload_mismatch`.
 *
 * USAGE:
 *   pnpm dev:api &     (or have the dev server already running)
 *   node apps/api/scripts/smoke-edit-booking.mjs
 *
 *   exit 0 = all probes pass
 *   exit 1 = at least one regression
 *   exit 2 = infra error (API unreachable, fixture seed failed)
 *
 * REQUIREMENTS:
 *   - Local API running on :3001 (`pnpm dev:api`).
 *   - .env with SUPABASE_URL + SUPABASE_SECRET_KEY + SUPABASE_PUBLISHABLE_KEY
 *     + SUPABASE_DB_PASS (for psql seed/cleanup of the booking + slot
 *     fixtures).
 *   - Remote DB has the seed data the smoke harness consumes:
 *     - Admin auth uid `93d41232-35b5-424c-b215-bb5d55a2dfd9`
 *     - Solana tenant `00000000-0000-0000-0000-000000000001`
 *     - Persons + spaces from 00133_seed_room_booking_examples.sql
 *       (Thomas + 3 meeting rooms — IDs constants below).
 *
 * DESIGN — the lessons baked in:
 *   1. **Two psql-seeded fixtures**, both bypassing `POST /reservations`
 *      (the create-flow's rule resolver + conflict guard are out of
 *      scope for an edit-pipeline probe — same rationale as the scope
 *      smoke). Fixture A: single non-recurring booking + 1 slot for
 *      editOne probes. Fixture B: single non-recurring booking + 2
 *      slots (primary + non-primary, multi-room) for editSlot probes.
 *      The URL-mismatch probe pairs Fixture A's slotId with Fixture B's
 *      bookingId — no third fixture needed.
 *   2. **Fixture anchors at +130 / +131 days future.** Pushes past the
 *      scope smoke's +90→+118 day window so back-to-back runs of the
 *      two probes don't collide on the same rooms.
 *   3. **Explicit `display_order` on Fixture B slots.** Slot 1 = 0
 *      (primary on ROOM_HUDDLE), slot 2 = 1 (non-primary on ROOM_BOARD).
 *      The "edit non-primary" probe needs a deterministic non-primary
 *      row — the assembler's primary-slot selector is
 *      `display_order ASC, created_at ASC, limit 1` (cited at
 *      `apps/api/src/modules/reservations/assemble-edit-plan.service.ts
 *      :558-571`). Explicit ordering removes any race condition on
 *      created_at when both rows insert in the same statement.
 *   4. **Idempotency key builder uses canonical TS arg order
 *      `(bookingId, clientRequestId, op)`** — matching the source-of-
 *      truth signature at `packages/shared/src/idempotency.ts:374-382`.
 *      The scope smoke's local copy uses `(op, bookingId, clientRequestId)`
 *      which produces the SAME on-wire key. This is a readability
 *      convention, not a bug fix — the wire bytes are identical.
 *   5. **Cleanup is non-negotiable.** Test bookings + slots + audits +
 *      domain_events + outbox.events + approvals + command_operations
 *      are dropped in a `finally` block so a failed run doesn't leave
 *      orphans. The cleanup is LIFO + best-effort (try/catch on each
 *      delete batch).
 *   6. **Fixture assumption.** Both fixtures intentionally have NO
 *      linked services / orders / work_orders, so the 00364 RPC's
 *      §10.c-§10.d cleanup branches are no-ops on these bookings. The
 *      cascade pipeline is exercised by the assembler unit tests + the
 *      scope smoke; this probe focuses on the editOne / editSlot wire
 *      paths.
 *   7. **Deliberately NOT covered:**
 *      - Malformed-UUID path id ("not-a-uuid" on `/reservations/:id`) —
 *        the Nest path-pipe rejects it before the controller runs; the
 *        response shape is framework-defined, not service-defined, so
 *        the probe yield is near zero. Established jest specs cover it.
 *      - 422 `booking.edit_requires_notification_dispatch` — needs an
 *        approval-rule-gated space; expensive fixture setup. Defer to
 *        B.4.A.5 when the gate is lifted, then probe the lift.
 *      - NUMERIC cost round-trip — editOne doesn't accept cost as a
 *        field; cost is recomputed by the assembler from
 *        `space.cost_per_hour`. The Slice 3.1 cost-float bug is in the
 *        work-order surface, covered by `pnpm smoke:work-orders`.
 *
 * Citations:
 *   - apps/api/src/modules/reservations/reservation.controller.ts:301-320
 *     (`@Patch(':id')` editOne route + DTO validation).
 *   - apps/api/src/modules/reservations/reservation.controller.ts:356-380
 *     (`@Patch(':bookingId/slots/:slotId')` editSlot route + DTO
 *     validation).
 *   - apps/api/src/modules/reservations/reservation.service.ts:638-1075
 *     (`editOne` body — preflight gates + assembler call + RPC call).
 *   - apps/api/src/modules/reservations/reservation.service.ts:1117-1450
 *     (`editSlot` body — preflight gates + url_mismatch guard + RPC
 *     call).
 *   - packages/shared/src/idempotency.ts:331-382 (canonical key builder;
 *     replicated below for the .mjs runtime).
 *   - supabase/migrations/00364_edit_booking_rpc_v4.sql (RPC contract).
 *   - apps/api/scripts/smoke-edit-booking-scope.mjs (sibling template).
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
// Real persons + rooms from 00133_seed_room_booking_examples.sql so the
// fixtures anchor in tenant-A's existing graph (visibility-friendly).
// IDs verified at `supabase/migrations/00133_seed_room_booking_examples
// .sql:160,163-165`.
const THOMAS_PERSON = 'b3a0aa30-3648-4783-92fa-973090877238';
const ROOM_HUDDLE = '14d74559-7f91-470a-98a3-780b3e8a5349';
const ROOM_TEAM = '6df43476-f6af-4ffa-9d39-e79c0bbb3dad';
const ROOM_BOARD = '207242ea-48e9-41a2-a72d-5ea4192f48bf';

// Fixture anchors. +130 / +131 days future clears the scope smoke's
// +90→+118 day window so back-to-back probes don't collide on the same
// rooms.
const FIXTURE_A_DAYS_FROM_NOW = 130;
const FIXTURE_B_DAYS_FROM_NOW = 131;

// ─────────────────────────────────────────────────────────────────────
// Idempotency-key shape — replicated from
// `packages/shared/src/idempotency.ts:374-382`. The .mjs runtime can't
// import the TS source (no compile step for smoke scripts). If you
// change the prefix or shape, update BOTH places in the same commit.
//
// Arg order matches the canonical TS source `(bookingId,
// clientRequestId, op)`. The sibling scope smoke uses a local
// `(op, bookingId, clientRequestId)` order which produces the same
// on-wire key (same byte string after interpolation) — preserved here
// as a readability convention so future readers see the canonical
// TS source signature, not a divergent local shape.
// ─────────────────────────────────────────────────────────────────────

const EDIT_BOOKING_IDEMPOTENCY_KEY_PREFIX = 'booking:edit';

function buildEditBookingIdempotencyKey(bookingId, clientRequestId, op) {
  return `${EDIT_BOOKING_IDEMPOTENCY_KEY_PREFIX}:${op}:${bookingId}:${clientRequestId}`;
}

// ─────────────────────────────────────────────────────────────────────
// Supabase admin singleton — used for command_operations assertions,
// booking_slots / audit_events introspection, and fixture cleanup.
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
// psql helpers — used for fixture seed + teardown. The bookings +
// booking_slots inserts need to bypass tenant-RLS (we're seeding as
// service_role) AND the various trigger-side effects (outbox emits,
// audit fan-out) the harness doesn't need. Using
// `session_replication_role='replica'` mirrors the scope-probe
// approach.
// ─────────────────────────────────────────────────────────────────────

function runPsql(sql) {
  const dbPass = env.SUPABASE_DB_PASS;
  if (!dbPass) {
    throw new Error(
      'smoke-edit-booking: SUPABASE_DB_PASS missing from .env — cannot seed fixture without it',
    );
  }
  const dbUrl =
    env.SUPABASE_DB_URL ||
    'postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres';
  try {
    execFileSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-c', sql], {
      env: { ...process.env, PGPASSWORD: dbPass },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const stderr = e.stderr?.toString() ?? '';
    const stdout = e.stdout?.toString() ?? '';
    throw new Error(
      `psql failed: ${e.message}\nstdout: ${stdout}\nstderr: ${stderr}\nsql: ${sql.slice(0, 200)}…`,
    );
  }
}

// Single-row, single-column query helper. Returns the trimmed scalar
// string. Used by the Phase 8.D pre-flight assertion (regprocedure
// existence check). Uses `psql -tA` (tuples-only + unaligned) so the
// output is the raw value with no header/footer chrome.
function runPsqlQuery(sql) {
  const dbPass = env.SUPABASE_DB_PASS;
  if (!dbPass) {
    throw new Error(
      'smoke-edit-booking: SUPABASE_DB_PASS missing from .env — cannot run query',
    );
  }
  const dbUrl =
    env.SUPABASE_DB_URL ||
    'postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres';
  try {
    const out = execFileSync('psql', [dbUrl, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
      env: { ...process.env, PGPASSWORD: dbPass },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.toString().trim();
  } catch (e) {
    const stderr = e.stderr?.toString() ?? '';
    throw new Error(
      `psql query failed: ${e.message}\nstderr: ${stderr}\nsql: ${sql.slice(0, 200)}…`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────
// Fixture A — single non-recurring booking + 1 slot on ROOM_HUDDLE.
// +130 days future, 1 hour duration. Used by all editOne probes.
// ─────────────────────────────────────────────────────────────────────

function seedFixtureA() {
  const bookingId = crypto.randomUUID();
  const slotId = crypto.randomUUID();
  const anchor = new Date(Date.now() + FIXTURE_A_DAYS_FROM_NOW * 86400_000);
  anchor.setUTCMinutes(0, 0, 0);
  anchor.setUTCHours(10);
  const startAt = anchor.toISOString();
  const endAt = new Date(anchor.getTime() + 60 * 60_000).toISOString();

  const sql = `
    set session_replication_role = 'replica';
    insert into public.bookings
      (id, tenant_id, title, requester_person_id, location_id,
       start_at, end_at, timezone, status, source, calendar_etag,
       cost_amount_snapshot, policy_snapshot, applied_rule_ids)
    values
      ('${bookingId}'::uuid, '${TENANT_ID}'::uuid, 'Smoke edit-one fixture A',
       '${THOMAS_PERSON}'::uuid, '${ROOM_HUDDLE}'::uuid,
       '${startAt}'::timestamptz, '${endAt}'::timestamptz, 'UTC',
       'confirmed', 'desk', 'smoke-etag-a-${bookingId.slice(0, 8)}',
       100.00, '{}'::jsonb, '{}'::uuid[]);
    insert into public.booking_slots
      (id, tenant_id, booking_id, slot_type, space_id,
       start_at, end_at, status, display_order)
    values
      ('${slotId}'::uuid, '${TENANT_ID}'::uuid, '${bookingId}'::uuid,
       'room', '${ROOM_HUDDLE}'::uuid,
       '${startAt}'::timestamptz, '${endAt}'::timestamptz,
       'confirmed', 0);
    set session_replication_role = 'origin';
  `;
  runPsql(sql);
  return { bookingId, slotId, startAt, endAt };
}

// ─────────────────────────────────────────────────────────────────────
// Fixture B — single non-recurring booking + 2 slots, multi-room.
// +131 days future. Slot 1: ROOM_HUDDLE, display_order=0 (PRIMARY).
// Slot 2: ROOM_BOARD, display_order=1 (non-primary). Same start_at /
// end_at on both slots.
//
// Used by editSlot probes that need a deterministic primary vs.
// non-primary distinction (the assembler's primary-slot selector is
// `display_order ASC, created_at ASC, limit 1` per
// `apps/api/src/modules/reservations/assemble-edit-plan.service.ts:
// 558-571`).
// ─────────────────────────────────────────────────────────────────────

function seedFixtureB() {
  const bookingId = crypto.randomUUID();
  const primarySlotId = crypto.randomUUID();
  const nonPrimarySlotId = crypto.randomUUID();
  const anchor = new Date(Date.now() + FIXTURE_B_DAYS_FROM_NOW * 86400_000);
  anchor.setUTCMinutes(0, 0, 0);
  anchor.setUTCHours(11);
  const startAt = anchor.toISOString();
  const endAt = new Date(anchor.getTime() + 60 * 60_000).toISOString();

  const sql = `
    set session_replication_role = 'replica';
    insert into public.bookings
      (id, tenant_id, title, requester_person_id, location_id,
       start_at, end_at, timezone, status, source, calendar_etag,
       cost_amount_snapshot, policy_snapshot, applied_rule_ids)
    values
      ('${bookingId}'::uuid, '${TENANT_ID}'::uuid, 'Smoke edit-slot fixture B',
       '${THOMAS_PERSON}'::uuid, '${ROOM_HUDDLE}'::uuid,
       '${startAt}'::timestamptz, '${endAt}'::timestamptz, 'UTC',
       'confirmed', 'desk', 'smoke-etag-b-${bookingId.slice(0, 8)}',
       200.00, '{}'::jsonb, '{}'::uuid[]);
    insert into public.booking_slots
      (id, tenant_id, booking_id, slot_type, space_id,
       start_at, end_at, status, display_order)
    values
      ('${primarySlotId}'::uuid, '${TENANT_ID}'::uuid, '${bookingId}'::uuid,
       'room', '${ROOM_HUDDLE}'::uuid,
       '${startAt}'::timestamptz, '${endAt}'::timestamptz,
       'confirmed', 0),
      ('${nonPrimarySlotId}'::uuid, '${TENANT_ID}'::uuid, '${bookingId}'::uuid,
       'room', '${ROOM_BOARD}'::uuid,
       '${startAt}'::timestamptz, '${endAt}'::timestamptz,
       'confirmed', 1);
    set session_replication_role = 'origin';
  `;
  runPsql(sql);
  return { bookingId, primarySlotId, nonPrimarySlotId, startAt, endAt };
}

// ─────────────────────────────────────────────────────────────────────
// Cleanup — LIFO sweep across audit_events, domain_events,
// outbox.events, approvals, command_operations, booking_slots,
// bookings. Best-effort: each delete batch wrapped in try/catch.
//
// Sweeps command_operations rows keyed under any 'booking:edit:%'
// prefix for our fixture bookings so retries / probes from prior runs
// don't pollute future runs.
// ─────────────────────────────────────────────────────────────────────

async function deleteFixtures(bookingIds) {
  if (bookingIds.length === 0) return;
  const bookingIdList = bookingIds.map((id) => `'${id}'::uuid`).join(', ');
  const sql = `
    set session_replication_role = 'replica';
    delete from public.audit_events
      where tenant_id = '${TENANT_ID}'::uuid
        and entity_type = 'booking'
        and entity_id in (${bookingIdList});
    delete from public.domain_events
      where tenant_id = '${TENANT_ID}'::uuid
        and entity_type = 'booking'
        and entity_id in (${bookingIdList});
    delete from outbox.events
      where tenant_id = '${TENANT_ID}'::uuid
        and aggregate_id in (${bookingIdList});
    delete from public.approvals
      where tenant_id = '${TENANT_ID}'::uuid
        and target_entity_type = 'booking'
        and target_entity_id in (${bookingIdList});
    delete from public.command_operations
      where tenant_id = '${TENANT_ID}'::uuid
        and (
          idempotency_key like 'booking:edit:one:%'
          or idempotency_key like 'booking:edit:slot:%'
        )
        and (
          ${bookingIds.map((id) => `idempotency_key like 'booking:edit:%:${id}:%'`).join(' or ')}
        );
    delete from public.booking_slots
      where tenant_id = '${TENANT_ID}'::uuid
        and booking_id in (${bookingIdList});
    delete from public.bookings
      where tenant_id = '${TENANT_ID}'::uuid
        and id in (${bookingIdList});
    set session_replication_role = 'origin';
  `;
  try {
    runPsql(sql);
  } catch (e) {
    console.log(`  ! fixture cleanup warn: ${e.message.slice(0, 200)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Auth — mint a real Admin JWT via Supabase auth.admin.generateLink.
// Mirrors smoke-edit-booking-scope.mjs:318-338.
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
// Probe runner — same shape as smoke-edit-booking-scope.mjs:346-391.
// ─────────────────────────────────────────────────────────────────────

const results = { pass: 0, fail: 0, failed: [] };

function makeProber(headers) {
  return async function probe(name, options) {
    const {
      method = 'PATCH',
      url,
      body,
      // 'success' (2xx) | 'badrequest' (400) | 'conflict' (409) |
      // 'forbidden' (403) | 'unprocessable' (422) | 'notfound' (404).
      expect = 'success',
      clientRequestId,
      omitClientRequestId = false,
    } = options;
    const isMutation = method === 'POST' || method === 'PATCH';
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

// ─────────────────────────────────────────────────────────────────────
// DB-level introspection helpers.
// Every supabase query gates by `tenant_id` — #0 invariant.
// ─────────────────────────────────────────────────────────────────────

async function readBookingById(bookingId) {
  const { data, error } = await supa()
    .from('bookings')
    .select('id, location_id, start_at, end_at, recurrence_series_id')
    .eq('tenant_id', TENANT_ID)
    .eq('id', bookingId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function readSlotsForBooking(bookingId) {
  const { data, error } = await supa()
    .from('booking_slots')
    .select('id, booking_id, space_id, start_at, end_at, display_order')
    .eq('tenant_id', TENANT_ID)
    .eq('booking_id', bookingId)
    .order('display_order', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

async function countAuditEventsForBooking(bookingId) {
  const { count, error } = await supa()
    .from('audit_events')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', TENANT_ID)
    .eq('entity_type', 'booking')
    .eq('entity_id', bookingId);
  if (error) throw error;
  return count ?? 0;
}

async function countCommandOpsForKey(key) {
  const { count, error } = await supa()
    .from('command_operations')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', TENANT_ID)
    .eq('idempotency_key', key);
  if (error) throw error;
  return count ?? 0;
}

function parseJsonSafe(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// editOne probes (Fixture A — single non-recurring booking, 1 slot
// on ROOM_HUDDLE, +130 days future, 1 hour duration). 11 probes.
// ─────────────────────────────────────────────────────────────────────

async function runEditOneProbes(probe, fixtureA, fixtureB) {
  console.log('\n=== editOne probes (Fixture A) ===');

  const editOneUrl = `${API_BASE}/api/reservations/${fixtureA.bookingId}`;

  // ────────────────────────────────────────────────────────────────
  // Scenario 1 — Setup verification.
  // ────────────────────────────────────────────────────────────────
  const initialSlots = await readSlotsForBooking(fixtureA.bookingId);
  passAssertion(
    'Setup A: exactly 1 slot on ROOM_HUDDLE',
    initialSlots.length === 1 && initialSlots[0].space_id === ROOM_HUDDLE,
    `slots=${initialSlots.length} space=${initialSlots[0]?.space_id?.slice(0, 8)}`,
  );

  // ────────────────────────────────────────────────────────────────
  // Scenario 2 — Edit space_id only → ROOM_TEAM.
  // - 200; slot.space_id=ROOM_TEAM; booking.location_id=ROOM_TEAM;
  //   ≥1 audit event; exactly 1 command_operations row.
  // ────────────────────────────────────────────────────────────────
  const editSpaceCrid = crypto.randomUUID();
  const editSpaceBody = { space_id: ROOM_TEAM };
  const auditCountBeforeEditSpace = await countAuditEventsForBooking(fixtureA.bookingId);
  const editSpaceResult = await probe('Edit space_id → ROOM_TEAM', {
    url: editOneUrl,
    body: editSpaceBody,
    clientRequestId: editSpaceCrid,
  });
  if (editSpaceResult.ok) {
    const slotsAfter = await readSlotsForBooking(fixtureA.bookingId);
    const bookingAfter = await readBookingById(fixtureA.bookingId);
    passAssertion(
      'Edit space_id: slot.space_id = ROOM_TEAM',
      slotsAfter[0]?.space_id === ROOM_TEAM,
      `got=${slotsAfter[0]?.space_id?.slice(0, 8)}`,
    );
    passAssertion(
      'Edit space_id: booking.location_id = ROOM_TEAM',
      bookingAfter?.location_id === ROOM_TEAM,
      `got=${bookingAfter?.location_id?.slice(0, 8)}`,
    );
    const auditCountAfter = await countAuditEventsForBooking(fixtureA.bookingId);
    passAssertion(
      'Edit space_id: ≥1 new audit event',
      auditCountAfter - auditCountBeforeEditSpace >= 1,
      `delta=${auditCountAfter - auditCountBeforeEditSpace}`,
    );
    const opKey = buildEditBookingIdempotencyKey(fixtureA.bookingId, editSpaceCrid, 'one');
    const opCount = await countCommandOpsForKey(opKey);
    passAssertion(
      'Edit space_id: exactly 1 command_operations row (booking:edit:one:...)',
      opCount === 1,
      `count=${opCount}`,
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Scenario 3 — Idempotency replay (same body + same crid).
  // - 200; response byte-identical; no new audit events; row count
  //   unchanged.
  // ────────────────────────────────────────────────────────────────
  const auditCountPreReplay = await countAuditEventsForBooking(fixtureA.bookingId);
  const replayResult = await probe('Edit space_id replay: cached, no new writes', {
    url: editOneUrl,
    body: editSpaceBody,
    clientRequestId: editSpaceCrid,
  });
  if (replayResult.ok) {
    passAssertion(
      'Replay: response body byte-identical',
      replayResult.body === editSpaceResult.body,
      'bodies differ — RPC re-executed?',
    );
    const auditCountAfterReplay = await countAuditEventsForBooking(fixtureA.bookingId);
    passAssertion(
      'Replay: no new audit events',
      auditCountAfterReplay === auditCountPreReplay,
      `delta=${auditCountAfterReplay - auditCountPreReplay}`,
    );
    const opKey = buildEditBookingIdempotencyKey(fixtureA.bookingId, editSpaceCrid, 'one');
    const opCount = await countCommandOpsForKey(opKey);
    passAssertion(
      'Replay: command_operations row count unchanged (1)',
      opCount === 1,
      `count=${opCount}`,
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Scenario 4 — Payload mismatch (same crid + different space_id).
  // - 409; code=command_operations.payload_mismatch; no new audits.
  // ────────────────────────────────────────────────────────────────
  const auditCountPreMismatch = await countAuditEventsForBooking(fixtureA.bookingId);
  const mismatchResult = await probe('Payload mismatch (same crid, space_id=ROOM_BOARD)', {
    url: editOneUrl,
    body: { space_id: ROOM_BOARD },
    clientRequestId: editSpaceCrid,
    expect: 'conflict',
  });
  if (mismatchResult.ok) {
    const parsed = parseJsonSafe(mismatchResult.body);
    passAssertion(
      'Payload mismatch: code=command_operations.payload_mismatch',
      parsed?.code === 'command_operations.payload_mismatch',
      `code=${parsed?.code}`,
    );
    const auditCountAfter = await countAuditEventsForBooking(fixtureA.bookingId);
    passAssertion(
      'Payload mismatch: no new writes',
      auditCountAfter === auditCountPreMismatch,
      `delta=${auditCountAfter - auditCountPreMismatch}`,
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Scenario 5 — Edit geometry (start_at + end_at shift +30 min).
  // - 200; slot + booking start_at & end_at updated.
  //
  // Fixture A is currently on ROOM_TEAM (post Scenario 2 commit).
  // Shift the window by +30 minutes; both endpoints move forward.
  // ────────────────────────────────────────────────────────────────
  const bookingBeforeGeom = await readBookingById(fixtureA.bookingId);
  const baseStartMs = new Date(bookingBeforeGeom.start_at).getTime();
  const newStart = new Date(baseStartMs + 30 * 60_000).toISOString();
  const newEnd = new Date(baseStartMs + 90 * 60_000).toISOString();
  const editGeomCrid = crypto.randomUUID();
  const editGeomResult = await probe('Edit geometry: start_at + end_at shift +30 min', {
    url: editOneUrl,
    body: { start_at: newStart, end_at: newEnd },
    clientRequestId: editGeomCrid,
  });
  if (editGeomResult.ok) {
    const slotsAfter = await readSlotsForBooking(fixtureA.bookingId);
    const bookingAfter = await readBookingById(fixtureA.bookingId);
    passAssertion(
      'Geometry edit: slot.start_at updated',
      slotsAfter[0]?.start_at === newStart,
      `got=${slotsAfter[0]?.start_at}`,
    );
    passAssertion(
      'Geometry edit: slot.end_at updated',
      slotsAfter[0]?.end_at === newEnd,
      `got=${slotsAfter[0]?.end_at}`,
    );
    passAssertion(
      'Geometry edit: booking.start_at updated',
      bookingAfter?.start_at === newStart,
      `got=${bookingAfter?.start_at}`,
    );
    passAssertion(
      'Geometry edit: booking.end_at updated',
      bookingAfter?.end_at === newEnd,
      `got=${bookingAfter?.end_at}`,
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Scenario 6 — Edit invalid window (start >= end).
  // - 400; code=booking.invalid_window; no writes.
  // Citation: reservation.service.ts:769-777.
  // ────────────────────────────────────────────────────────────────
  const auditCountPreInvalidWindow = await countAuditEventsForBooking(fixtureA.bookingId);
  const invalidWindowResult = await probe('Invalid window (start >= end) → 400', {
    url: editOneUrl,
    body: { start_at: '2026-08-01T10:00:00Z', end_at: '2026-08-01T10:00:00Z' },
    expect: 'badrequest',
  });
  if (invalidWindowResult.ok) {
    const parsed = parseJsonSafe(invalidWindowResult.body);
    passAssertion(
      'Invalid window (start>=end): code=booking.invalid_window',
      parsed?.code === 'booking.invalid_window',
      `code=${parsed?.code}`,
    );
    const auditCountAfter = await countAuditEventsForBooking(fixtureA.bookingId);
    passAssertion(
      'Invalid window: no new writes',
      auditCountAfter === auditCountPreInvalidWindow,
      `delta=${auditCountAfter - auditCountPreInvalidWindow}`,
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Scenario 7 — Edit start_at='invalid-date' (parse failure).
  // - 400; code=booking.invalid_window; no writes.
  // Citation: reservation.service.ts:753-768.
  // ────────────────────────────────────────────────────────────────
  const auditCountPreParseFail = await countAuditEventsForBooking(fixtureA.bookingId);
  const parseFailResult = await probe('Invalid window (start_at=\'invalid-date\') → 400', {
    url: editOneUrl,
    body: { start_at: 'invalid-date' },
    expect: 'badrequest',
  });
  if (parseFailResult.ok) {
    const parsed = parseJsonSafe(parseFailResult.body);
    passAssertion(
      "Parse-fail start_at: code=booking.invalid_window",
      parsed?.code === 'booking.invalid_window',
      `code=${parsed?.code}`,
    );
    const auditCountAfter = await countAuditEventsForBooking(fixtureA.bookingId);
    passAssertion(
      'Parse-fail: no new writes',
      auditCountAfter === auditCountPreParseFail,
      `delta=${auditCountAfter - auditCountPreParseFail}`,
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Scenario 8 — Edit space_id="" empty string.
  // - 400; code=booking.invalid_space_id; no writes.
  // Citation: reservation.service.ts:793-797.
  // ────────────────────────────────────────────────────────────────
  const auditCountPreEmptySpace = await countAuditEventsForBooking(fixtureA.bookingId);
  const emptySpaceResult = await probe('Empty space_id → 400', {
    url: editOneUrl,
    body: { space_id: '' },
    expect: 'badrequest',
  });
  if (emptySpaceResult.ok) {
    const parsed = parseJsonSafe(emptySpaceResult.body);
    passAssertion(
      'Empty space_id: code=booking.invalid_space_id',
      parsed?.code === 'booking.invalid_space_id',
      `code=${parsed?.code}`,
    );
    const auditCountAfter = await countAuditEventsForBooking(fixtureA.bookingId);
    passAssertion(
      'Empty space_id: no new writes',
      auditCountAfter === auditCountPreEmptySpace,
      `delta=${auditCountAfter - auditCountPreEmptySpace}`,
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Scenario 9 — Edit ghost-but-valid-uuid space_id.
  // Freshly-minted uuid not present in any tenant's spaces table.
  // - 400; code=reference.not_in_tenant; no writes.
  // Citation: reservation.service.ts:838-850 (assertTenantOwned).
  // ────────────────────────────────────────────────────────────────
  const ghostSpaceId = crypto.randomUUID();
  const auditCountPreGhostSpace = await countAuditEventsForBooking(fixtureA.bookingId);
  const ghostSpaceResult = await probe('Ghost-uuid space_id → 400 reference.not_in_tenant', {
    url: editOneUrl,
    body: { space_id: ghostSpaceId },
    expect: 'badrequest',
  });
  if (ghostSpaceResult.ok) {
    const parsed = parseJsonSafe(ghostSpaceResult.body);
    passAssertion(
      'Ghost space_id: code=reference.not_in_tenant',
      parsed?.code === 'reference.not_in_tenant',
      `code=${parsed?.code}`,
    );
    const auditCountAfter = await countAuditEventsForBooking(fixtureA.bookingId);
    passAssertion(
      'Ghost space_id: no new writes',
      auditCountAfter === auditCountPreGhostSpace,
      `delta=${auditCountAfter - auditCountPreGhostSpace}`,
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Scenario 10 — Edit ghost booking (freshly-minted uuid not in DB).
  // - 404; code=booking_not_found.
  // Citation: reservation.service.ts:182 (always 404s on absent
  // booking).
  // ────────────────────────────────────────────────────────────────
  const ghostBookingId = crypto.randomUUID();
  const ghostBookingResult = await probe('Ghost booking id → 404 booking_not_found', {
    url: `${API_BASE}/api/reservations/${ghostBookingId}`,
    body: { space_id: ROOM_TEAM },
    expect: 'notfound',
  });
  if (ghostBookingResult.ok) {
    const parsed = parseJsonSafe(ghostBookingResult.body);
    passAssertion(
      'Ghost booking: code=booking_not_found',
      parsed?.code === 'booking_not_found',
      `code=${parsed?.code}`,
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Scenario 11 — Missing X-Client-Request-Id.
  // - 400; code=client_request_id.required.
  // Controller guard fires before the DTO is even parsed.
  // ────────────────────────────────────────────────────────────────
  const missingHeaderResult = await probe('Missing X-Client-Request-Id → 400', {
    url: editOneUrl,
    body: { space_id: ROOM_TEAM },
    omitClientRequestId: true,
    expect: 'badrequest',
  });
  if (missingHeaderResult.ok) {
    const parsed = parseJsonSafe(missingHeaderResult.body);
    passAssertion(
      'Missing header: code=client_request_id.required',
      parsed?.code === 'client_request_id.required',
      `code=${parsed?.code}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────
// editSlot probes (Fixture B — single non-recurring multi-slot
// booking, 2 slots: ROOM_HUDDLE primary display_order=0 + ROOM_BOARD
// non-primary display_order=1, +131 days future). 8 probes.
// ─────────────────────────────────────────────────────────────────────

async function runEditSlotProbes(probe, fixtureA, fixtureB) {
  console.log('\n=== editSlot probes (Fixture B) ===');

  const editNonPrimaryUrl = `${API_BASE}/api/reservations/${fixtureB.bookingId}/slots/${fixtureB.nonPrimarySlotId}`;

  // ────────────────────────────────────────────────────────────────
  // Scenario 12 — Setup verification: 2 slots, distinct rooms.
  // ────────────────────────────────────────────────────────────────
  const initialSlots = await readSlotsForBooking(fixtureB.bookingId);
  passAssertion(
    'Setup B: exactly 2 slots',
    initialSlots.length === 2,
    `slots=${initialSlots.length}`,
  );
  const primarySlot = initialSlots.find((s) => s.display_order === 0);
  const nonPrimarySlot = initialSlots.find((s) => s.display_order === 1);
  passAssertion(
    'Setup B: primary slot on ROOM_HUDDLE, non-primary on ROOM_BOARD',
    primarySlot?.space_id === ROOM_HUDDLE && nonPrimarySlot?.space_id === ROOM_BOARD,
    `primary=${primarySlot?.space_id?.slice(0, 8)} non-primary=${nonPrimarySlot?.space_id?.slice(0, 8)}`,
  );

  // ────────────────────────────────────────────────────────────────
  // Scenario 13 — Edit slot.space_id of NON-primary slot → ROOM_TEAM.
  // - 200; non-primary slot moved; PRIMARY slot's space_id unchanged;
  //   ≥1 audit event; exactly 1 command_operations row.
  // ────────────────────────────────────────────────────────────────
  const editNonPrimaryCrid = crypto.randomUUID();
  const editNonPrimaryBody = { space_id: ROOM_TEAM };
  const auditCountBeforeNonPrimary = await countAuditEventsForBooking(fixtureB.bookingId);
  const editNonPrimaryResult = await probe('Edit non-primary slot space_id → ROOM_TEAM', {
    url: editNonPrimaryUrl,
    body: editNonPrimaryBody,
    clientRequestId: editNonPrimaryCrid,
  });
  if (editNonPrimaryResult.ok) {
    const slotsAfter = await readSlotsForBooking(fixtureB.bookingId);
    const primaryAfter = slotsAfter.find((s) => s.display_order === 0);
    const nonPrimaryAfter = slotsAfter.find((s) => s.display_order === 1);
    passAssertion(
      'Edit non-primary: non-primary slot moved to ROOM_TEAM',
      nonPrimaryAfter?.space_id === ROOM_TEAM,
      `got=${nonPrimaryAfter?.space_id?.slice(0, 8)}`,
    );
    passAssertion(
      'Edit non-primary: PRIMARY slot space_id unchanged (still ROOM_HUDDLE)',
      primaryAfter?.space_id === ROOM_HUDDLE,
      `got=${primaryAfter?.space_id?.slice(0, 8)}`,
    );
    const auditCountAfter = await countAuditEventsForBooking(fixtureB.bookingId);
    passAssertion(
      'Edit non-primary: ≥1 new audit event',
      auditCountAfter - auditCountBeforeNonPrimary >= 1,
      `delta=${auditCountAfter - auditCountBeforeNonPrimary}`,
    );
    const opKey = buildEditBookingIdempotencyKey(fixtureB.bookingId, editNonPrimaryCrid, 'slot');
    const opCount = await countCommandOpsForKey(opKey);
    passAssertion(
      'Edit non-primary: exactly 1 command_operations row (booking:edit:slot:...)',
      opCount === 1,
      `count=${opCount}`,
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Scenario 14 — URL mismatch: PATCH /api/reservations/<B_bookingId>/
  // slots/<A_slotId> — A's slotId belongs to A's booking, not B's.
  // - 400; code=booking_slot.url_mismatch.
  // Citation: reservation.service.ts:1161-1165.
  // ────────────────────────────────────────────────────────────────
  const urlMismatchUrl = `${API_BASE}/api/reservations/${fixtureB.bookingId}/slots/${fixtureA.slotId}`;
  const urlMismatchResult = await probe('URL mismatch (B.bookingId + A.slotId) → 400', {
    url: urlMismatchUrl,
    body: { space_id: ROOM_TEAM },
    expect: 'badrequest',
  });
  if (urlMismatchResult.ok) {
    const parsed = parseJsonSafe(urlMismatchResult.body);
    passAssertion(
      'URL mismatch: code=booking_slot.url_mismatch',
      parsed?.code === 'booking_slot.url_mismatch',
      `code=${parsed?.code}`,
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Scenario 15 — Edit slot.start_at on non-primary slot.
  // - 200; slot.start_at updated.
  // - booking.start_at = MIN(slots) post-update — RPC's MIN/MAX
  //   rollup (00364) recomputes the booking-level window from the
  //   surviving slot rows.
  //
  // Non-primary slot start_at shifts BACKWARD by 30 min, making it
  // EARLIER than the primary slot. booking.start_at should then equal
  // the new non-primary start_at (the MIN).
  // ────────────────────────────────────────────────────────────────
  const slotsBeforeShift = await readSlotsForBooking(fixtureB.bookingId);
  const nonPrimaryBefore = slotsBeforeShift.find((s) => s.display_order === 1);
  const earlierStartMs = new Date(nonPrimaryBefore.start_at).getTime() - 30 * 60_000;
  const earlierStart = new Date(earlierStartMs).toISOString();
  const earlierEnd = new Date(earlierStartMs + 60 * 60_000).toISOString();
  const editStartCrid = crypto.randomUUID();
  const editStartResult = await probe('Edit non-primary slot.start_at (earlier than primary)', {
    url: editNonPrimaryUrl,
    body: { start_at: earlierStart, end_at: earlierEnd },
    clientRequestId: editStartCrid,
  });
  if (editStartResult.ok) {
    const slotsAfter = await readSlotsForBooking(fixtureB.bookingId);
    const nonPrimaryAfter = slotsAfter.find((s) => s.display_order === 1);
    passAssertion(
      'Geometry slot: non-primary slot.start_at updated',
      nonPrimaryAfter?.start_at === earlierStart,
      `got=${nonPrimaryAfter?.start_at}`,
    );
    const bookingAfter = await readBookingById(fixtureB.bookingId);
    const minSlotStart = slotsAfter
      .map((s) => new Date(s.start_at).getTime())
      .reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
    passAssertion(
      'Geometry slot: booking.start_at = MIN(slots) post-update',
      new Date(bookingAfter.start_at).getTime() === minSlotStart,
      `booking=${bookingAfter?.start_at} min=${new Date(minSlotStart).toISOString()}`,
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Scenario 16 — Idempotency replay (slot, same body + same crid).
  // - 200; response body byte-identical; no new audits.
  // ────────────────────────────────────────────────────────────────
  const replayCrid = crypto.randomUUID();
  const replayBody = { space_id: ROOM_HUDDLE };
  const auditCountBeforeReplay = await countAuditEventsForBooking(fixtureB.bookingId);
  const firstReplay = await probe('Slot idempotency: first call (space_id=ROOM_HUDDLE)', {
    url: editNonPrimaryUrl,
    body: replayBody,
    clientRequestId: replayCrid,
  });
  const secondReplay = await probe('Slot idempotency: replay (cached)', {
    url: editNonPrimaryUrl,
    body: replayBody,
    clientRequestId: replayCrid,
  });
  if (firstReplay.ok && secondReplay.ok) {
    passAssertion(
      'Slot replay: body byte-identical',
      firstReplay.body === secondReplay.body,
      'bodies differ — RPC re-executed?',
    );
    const opKey = buildEditBookingIdempotencyKey(fixtureB.bookingId, replayCrid, 'slot');
    const opCount = await countCommandOpsForKey(opKey);
    passAssertion(
      'Slot replay: command_operations row count = 1 (not 2)',
      opCount === 1,
      `count=${opCount}`,
    );
    // Self-review remediation (code-reviewer 2026-05-12): assert the
    // audit-event delta is zero. Mirrors Scenario 3 (editOne replay)
    // and locks the same idempotency contract on the editSlot path —
    // if the slot RPC re-executes on replay, audits leak and this
    // probe catches it. The editOne sibling already covered this;
    // editSlot must too.
    const auditCountAfterReplay = await countAuditEventsForBooking(fixtureB.bookingId);
    passAssertion(
      'Slot replay: no new audit events (RPC short-circuited on cached_result)',
      auditCountAfterReplay === auditCountBeforeReplay,
      `delta=${auditCountAfterReplay - auditCountBeforeReplay}`,
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Scenario 17 — Payload mismatch (slot, same crid + different
  // space_id).
  // - 409.
  // ────────────────────────────────────────────────────────────────
  const slotMismatchResult = await probe('Slot payload mismatch (same crid, space_id=ROOM_BOARD)', {
    url: editNonPrimaryUrl,
    body: { space_id: ROOM_BOARD },
    clientRequestId: replayCrid,
    expect: 'conflict',
  });
  if (slotMismatchResult.ok) {
    const parsed = parseJsonSafe(slotMismatchResult.body);
    passAssertion(
      'Slot payload mismatch: code=command_operations.payload_mismatch',
      parsed?.code === 'command_operations.payload_mismatch',
      `code=${parsed?.code}`,
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Scenario 18 — Edit slot.space_id="" empty string.
  // - 400; code=booking.invalid_space_id.
  // Citation: reservation.service.ts:1236-1240.
  // ────────────────────────────────────────────────────────────────
  const emptySlotSpaceResult = await probe('Empty slot space_id → 400', {
    url: editNonPrimaryUrl,
    body: { space_id: '' },
    expect: 'badrequest',
  });
  if (emptySlotSpaceResult.ok) {
    const parsed = parseJsonSafe(emptySlotSpaceResult.body);
    passAssertion(
      'Empty slot space_id: code=booking.invalid_space_id',
      parsed?.code === 'booking.invalid_space_id',
      `code=${parsed?.code}`,
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Scenario 19 — Missing X-Client-Request-Id (slot endpoint).
  // - 400; code=client_request_id.required.
  // ────────────────────────────────────────────────────────────────
  const slotMissingHeaderResult = await probe('Missing X-Client-Request-Id (slot) → 400', {
    url: editNonPrimaryUrl,
    body: { space_id: ROOM_TEAM },
    omitClientRequestId: true,
    expect: 'badrequest',
  });
  if (slotMissingHeaderResult.ok) {
    const parsed = parseJsonSafe(slotMissingHeaderResult.body);
    passAssertion(
      'Slot missing header: code=client_request_id.required',
      parsed?.code === 'client_request_id.required',
      `code=${parsed?.code}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────
// Op-discrimination probe — Step 2F.3 contract.
// Fire editOne(crid=X) on Fixture A's booking AND editSlot(crid=X) on
// Fixture B's non-primary slot. BOTH command_operations rows exist
// for crid=X with distinct prefixes — proves cross-op key namespacing.
// ─────────────────────────────────────────────────────────────────────

async function runOpDiscriminationProbe(probe, fixtureA, fixtureB) {
  console.log('\n=== Op-discrimination (Step 2F.3 contract) ===');

  const sharedCrid = crypto.randomUUID();
  const editOneResult = await probe('Op-disc: editOne(crid=X) on A', {
    url: `${API_BASE}/api/reservations/${fixtureA.bookingId}`,
    body: { space_id: ROOM_HUDDLE },
    clientRequestId: sharedCrid,
  });
  const editSlotResult = await probe('Op-disc: editSlot(crid=X) on B non-primary', {
    url: `${API_BASE}/api/reservations/${fixtureB.bookingId}/slots/${fixtureB.nonPrimarySlotId}`,
    body: { space_id: ROOM_TEAM },
    clientRequestId: sharedCrid,
  });
  if (editOneResult.ok && editSlotResult.ok) {
    const oneKey = buildEditBookingIdempotencyKey(fixtureA.bookingId, sharedCrid, 'one');
    const slotKey = buildEditBookingIdempotencyKey(fixtureB.bookingId, sharedCrid, 'slot');
    const oneCount = await countCommandOpsForKey(oneKey);
    const slotCount = await countCommandOpsForKey(slotKey);
    passAssertion(
      "Op-disc: 'booking:edit:one:...' row exists for crid=X",
      oneCount === 1,
      `count=${oneCount} key=${oneKey}`,
    );
    passAssertion(
      "Op-disc: 'booking:edit:slot:...' row exists for crid=X",
      slotCount === 1,
      `count=${slotCount} key=${slotKey}`,
    );
    passAssertion(
      'Op-disc: keys are distinct (different on-wire bytes)',
      oneKey !== slotKey,
      `one=${oneKey} slot=${slotKey}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Smoke-testing editOne + editSlot against ${API_BASE}`);

  // Health check — fail loudly if API isn't running. fetch() throws
  // on connection failure (caught below); the `>= 500` clause catches
  // a running but broken server.
  try {
    const r = await fetch(`${API_BASE}/api/reservations?scope=upcoming&limit=1`, {
      method: 'HEAD',
    });
    if (r.status >= 500) {
      throw new Error(`API health check failed: HTTP ${r.status}`);
    }
  } catch (e) {
    console.error(`✗ API at ${API_BASE} is not reachable: ${e.message}`);
    console.error(`  Start the dev server first: pnpm dev:api`);
    process.exit(2);
  }

  // Phase 8.D regression guard — the legacy edit_booking_slot RPC was
  // dropped by migration 00379. If a future migration re-creates the
  // function (intentionally or by mistake), this assertion trips before
  // any fixture is seeded so the smoke can't accidentally exercise the
  // dead surface. The check uses to_regprocedure to resolve the
  // function signature; NULL means "no such function." Citation:
  // supabase/migrations/00379_drop_edit_booking_slot_rpc.sql.
  try {
    const slotRpcDropped = runPsqlQuery(
      "select to_regprocedure('public.edit_booking_slot(uuid, jsonb, uuid)') is null",
    );
    if (slotRpcDropped !== 't') {
      console.error('✗ Phase 8.D regression: public.edit_booking_slot(uuid, jsonb, uuid) still exists on remote.');
      console.error('  Expected: dropped by migration 00379. A migration after 00379 has re-created it.');
      console.error('  Action: identify the offending migration and decide whether to drop again or restore the legacy path on purpose.');
      process.exit(1);
    }
    console.log('✓ Phase 8.D guard: public.edit_booking_slot RPC is dropped (00379)');
  } catch (e) {
    console.error(`✗ Phase 8.D guard query failed: ${e.message}`);
    process.exit(2);
  }

  // Self-review remediation (code-reviewer 2026-05-12): the seed +
  // mintAdminToken calls must live inside the try/finally so the
  // cleanup fires even if token-minting throws after fixtures are on
  // disk. Pre-fix, a Supabase auth outage between seeding and probing
  // would leak both fixtures.
  let fixtureA = null;
  let fixtureB = null;
  try {
    console.log('Seeding fixture A (single booking + 1 slot, +130d)…');
    fixtureA = seedFixtureA();
    console.log(`  booking ${fixtureA.bookingId.slice(0, 8)}… / slot ${fixtureA.slotId.slice(0, 8)}…`);

    console.log('Seeding fixture B (single booking + 2 slots, +131d)…');
    fixtureB = seedFixtureB();
    console.log(
      `  booking ${fixtureB.bookingId.slice(0, 8)}… / primary ${fixtureB.primarySlotId.slice(0, 8)}… / non-primary ${fixtureB.nonPrimarySlotId.slice(0, 8)}…`,
    );

    const accessToken = await mintAdminToken();
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'X-Tenant-Id': TENANT_ID,
      'Content-Type': 'application/json',
    };
    const probe = makeProber(headers);

    await runEditOneProbes(probe, fixtureA, fixtureB);
    await runEditSlotProbes(probe, fixtureA, fixtureB);
    await runOpDiscriminationProbe(probe, fixtureA, fixtureB);
  } finally {
    console.log('\nCleaning up fixtures…');
    const idsToDelete = [fixtureA?.bookingId, fixtureB?.bookingId].filter(Boolean);
    if (idsToDelete.length > 0) {
      await deleteFixtures(idsToDelete);
    }
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

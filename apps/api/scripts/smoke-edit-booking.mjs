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
 *      - 422 `booking.edit_requires_notification_dispatch` — gate
 *        lifted by B.4.A.5 sub-step H (2026-05-13). Approval-flip
 *        probe ADDED (see `runApprovalFlipProbe` below): extends
 *        Fixture C past 4h to trigger seeded rule b0010002 and
 *        asserts the 200 + approvals + inbox + outbox tuple.
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
// Noor — required_approver on the seeded "Long bookings need manager
// approval" rule (`b0010002-...`, effect=require_approval, fires when
// duration_minutes_gt > 240). The B.4.A.5 approval-flip smoke uses this
// rule to drive an editOne-induced approval insert.
// Citation: supabase/migrations/00133_seed_room_booking_examples.sql:99
// (rule's approval_config.required_approvers) + Noor's users row
// confirmed via psql on remote (person_id 95000000-..-04 → user_id
// 95100000-..-04).
const NOOR_PERSON = '95000000-0000-0000-0000-000000000004';
const NOOR_USER = '95100000-0000-0000-0000-000000000004';
const LONG_BOOKING_RULE_ID = 'b0010002-0000-0000-0000-000000000001';

// Fixture anchors. +130 / +131 / +132 / +133 days future clears the
// scope smoke's +90→+118 day window so back-to-back probes don't
// collide on the same rooms.
const FIXTURE_A_DAYS_FROM_NOW = 130;
const FIXTURE_B_DAYS_FROM_NOW = 131;
const FIXTURE_C_DAYS_FROM_NOW = 132;
const FIXTURE_D_DAYS_FROM_NOW = 133;
// audit-03 Slice 3 (P0-2 multi-slot residual, Path B) — Fixture E:
// 2-room (2 booking_slots) booking + the full linked-row graph. +135d
// (skips 134 to leave clear air around Fixture D's window).
const FIXTURE_E_DAYS_FROM_NOW = 135;

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
// Fixture C — single non-recurring booking + 1 slot on ROOM_HUDDLE.
// +132 days future, 1 hour duration. Used by the B.4.A.5 sub-step H
// approval-flip probe (editOne extends end_at past +4h → triggers
// rule b0010002 → approval insert + inbox row + outbox emit).
//
// Same shape as Fixture A but separated so the approval-flip side
// effects (approvals row + inbox_notifications row + outbox event)
// don't entangle with Fixture A's mutation scenarios.
// ─────────────────────────────────────────────────────────────────────

function seedFixtureC() {
  const bookingId = crypto.randomUUID();
  const slotId = crypto.randomUUID();
  const anchor = new Date(Date.now() + FIXTURE_C_DAYS_FROM_NOW * 86400_000);
  anchor.setUTCMinutes(0, 0, 0);
  anchor.setUTCHours(9);
  const startAt = anchor.toISOString();
  const endAt = new Date(anchor.getTime() + 60 * 60_000).toISOString();

  const sql = `
    set session_replication_role = 'replica';
    insert into public.bookings
      (id, tenant_id, title, requester_person_id, location_id,
       start_at, end_at, timezone, status, source, calendar_etag,
       cost_amount_snapshot, policy_snapshot, applied_rule_ids)
    values
      ('${bookingId}'::uuid, '${TENANT_ID}'::uuid, 'Smoke approval-flip fixture C',
       '${THOMAS_PERSON}'::uuid, '${ROOM_HUDDLE}'::uuid,
       '${startAt}'::timestamptz, '${endAt}'::timestamptz, 'UTC',
       'confirmed', 'desk', 'smoke-etag-c-${bookingId.slice(0, 8)}',
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
// Fixture D — single non-recurring booking + 1 slot on ROOM_HUDDLE,
// PLUS the full linked-row graph: 1 order (+ 1 order_line_item), 2
// asset_reservations (boundary-aligned + custom-window), 1 setup
// work_order. +133 days future, 1 hour duration.
//
// Closes audit P0-2/P0-3: proves an editOne pure-move (+2h, duration
// unchanged) cascades into the linked orders / asset_reservations /
// setup work_orders via the `edit_booking` v5 RPC's §10.c/§10.d/§10.f
// patch arrays. Before the AssembleEditPlanService.buildLinkedRowPatches
// fix, the assembler emitted [] for all three arrays and these rows
// stayed at the OLD time (caterer daglijst diverged).
//
// Single-room single-slot so the multi-slot attribution ambiguity does
// NOT apply (linked rows key only off booking_id — see
// supabase/migrations/00278_retarget_sibling_tables.sql:108-144; none of
// orders / asset_reservations / work_orders carry a slot/space
// attribution column beyond booking_id, so a multi-slot booking can't
// attribute a booking-level child to one slot — the helper skips that
// case; this fixture deliberately avoids it).
//
// Self-contained: seeds its own asset_type + asset + catalog_item with
// fixture-generated UUIDs (same pattern as the booking/slot UUIDs) so
// the fixture is hermetic and doesn't depend on queried-at-runtime seed
// ids. asset_types/assets/catalog_items columns + nullability verified
// against supabase/migrations/00005_assets.sql:3-37,17-37 +
// 00013_orders_catalog.sql:3-30,44-59,73-88 + 00144_orders_bundle_
// columns.sql:4-10. work_orders parent_kind/booking_id invariant per
// 00213_step1c1_work_orders_new_table.sql:33-46 + 00278:86-95 (rename;
// parent_kind label stays 'booking_bundle'). asset_reservations status
// literals ('confirmed','cancelled','released') per 00142:14-15. orders
// status literals ('draft','submitted','approved','confirmed',
// 'fulfilled','cancelled') per 00013:55. work_orders.status_category
// ('new','assigned','in_progress','waiting','resolved','closed') per
// 00213:52-53. THOMAS_PERSON is the requester (00133:160).
// ─────────────────────────────────────────────────────────────────────

function seedFixtureD() {
  const bookingId = crypto.randomUUID();
  const slotId = crypto.randomUUID();
  const assetTypeId = crypto.randomUUID();
  // Two distinct assets — the asset_reservations GiST exclusion
  // constraint (00142:27-30) rejects two 'confirmed' reservations on
  // the SAME asset with overlapping windows, and the boundary +
  // custom windows overlap by design. One shared asset_type is fine
  // (asset_types has no exclusion constraint).
  const assetBoundaryId = crypto.randomUUID();
  const assetCustomId = crypto.randomUUID();
  const catalogItemId = crypto.randomUUID();
  const orderId = crypto.randomUUID();
  const orderLineItemId = crypto.randomUUID();
  const arBoundaryId = crypto.randomUUID();
  const arCustomId = crypto.randomUUID();
  const workOrderId = crypto.randomUUID();

  const anchor = new Date(Date.now() + FIXTURE_D_DAYS_FROM_NOW * 86400_000);
  anchor.setUTCMinutes(0, 0, 0);
  anchor.setUTCHours(13);
  const slotStartMs = anchor.getTime();
  const slotEndMs = slotStartMs + 60 * 60_000; // 1h booking
  const startAt = new Date(slotStartMs).toISOString();
  const endAt = new Date(slotEndMs).toISOString();

  // Custom-window asset_reservation: slot.start + 15min → +45min
  // (30-min duration, NOT aligned to either booking boundary). Proves
  // custom windows shift by startDelta only (duration preserved), not
  // restretched to (newStart, newEnd).
  const arCustomStart = new Date(slotStartMs + 15 * 60_000).toISOString();
  const arCustomEnd = new Date(slotStartMs + 45 * 60_000).toISOString();

  // Setup work_order: planned_start_at = slot.start − 30min (setup
  // lead). SLA resolution due at slot end (arbitrary; only its +2h
  // shift via needs_repoint is asserted, not its absolute value — the
  // helper does NOT emit a raw sla_due_at shift).
  const woPlannedStart = new Date(slotStartMs - 30 * 60_000).toISOString();
  const woSlaDue = new Date(slotEndMs).toISOString();

  // work_orders.module_number is NOT NULL with no column default — it's
  // normally assigned by a trigger that `session_replication_role=
  // 'replica'` disables during seeding. Pick a high, collision-safe
  // value well above any real sequence (real rows are in the low
  // thousands; 9e14 + random keeps the fixture hermetic and unique
  // across concurrent runs). Cleaned up with the rest of Fixture D.
  const woModuleNumber =
    900_000_000_000_000 + Math.floor(Math.random() * 1_000_000_000);

  const sql = `
    set session_replication_role = 'replica';
    insert into public.bookings
      (id, tenant_id, title, requester_person_id, location_id,
       start_at, end_at, timezone, status, source, calendar_etag,
       cost_amount_snapshot, policy_snapshot, applied_rule_ids)
    values
      ('${bookingId}'::uuid, '${TENANT_ID}'::uuid, 'Smoke linked-row fixture D',
       '${THOMAS_PERSON}'::uuid, '${ROOM_HUDDLE}'::uuid,
       '${startAt}'::timestamptz, '${endAt}'::timestamptz, 'UTC',
       'confirmed', 'desk', 'smoke-etag-d-${bookingId.slice(0, 8)}',
       100.00, '{}'::jsonb, '{}'::uuid[]);
    insert into public.booking_slots
      (id, tenant_id, booking_id, slot_type, space_id,
       start_at, end_at, status, display_order)
    values
      ('${slotId}'::uuid, '${TENANT_ID}'::uuid, '${bookingId}'::uuid,
       'room', '${ROOM_HUDDLE}'::uuid,
       '${startAt}'::timestamptz, '${endAt}'::timestamptz,
       'confirmed', 0);

    -- Self-contained asset_type + 2 pooled assets (00005:3-37,17-37).
    -- Two assets so the boundary + custom asset_reservations don't
    -- collide on the GiST overlap exclusion (00142:27-30).
    insert into public.asset_types (id, tenant_id, name)
    values ('${assetTypeId}'::uuid, '${TENANT_ID}'::uuid, 'Smoke D asset type');
    insert into public.assets
      (id, tenant_id, asset_type_id, asset_role, name, status)
    values
      ('${assetBoundaryId}'::uuid, '${TENANT_ID}'::uuid, '${assetTypeId}'::uuid,
       'pooled', 'Smoke D projector (boundary)', 'available'),
      ('${assetCustomId}'::uuid, '${TENANT_ID}'::uuid, '${assetTypeId}'::uuid,
       'pooled', 'Smoke D projector (custom)', 'available');

    -- Self-contained catalog_item (00013:3-30; category NOT NULL).
    insert into public.catalog_items (id, tenant_id, name, category)
    values ('${catalogItemId}'::uuid, '${TENANT_ID}'::uuid,
            'Smoke D catalog item', 'equipment');

    -- Order: window mirrors the slot; delivery_location = slot's space
    -- (00013:44-59 + 00144:4-10 added requested_for_*; 00278:108-118
    -- renamed booking_bundle_id → booking_id).
    insert into public.orders
      (id, tenant_id, requester_person_id, booking_id, status,
       requested_for_start_at, requested_for_end_at, delivery_location_id)
    values
      ('${orderId}'::uuid, '${TENANT_ID}'::uuid, '${THOMAS_PERSON}'::uuid,
       '${bookingId}'::uuid, 'confirmed',
       '${startAt}'::timestamptz, '${endAt}'::timestamptz,
       '${ROOM_HUDDLE}'::uuid);
    insert into public.order_line_items
      (id, order_id, tenant_id, catalog_item_id, quantity)
    values
      ('${orderLineItemId}'::uuid, '${orderId}'::uuid, '${TENANT_ID}'::uuid,
       '${catalogItemId}'::uuid, 1);

    -- Asset reservation #1 — boundary-aligned (== slot start/end).
    insert into public.asset_reservations
      (id, tenant_id, asset_id, start_at, end_at, status,
       requester_person_id, booking_id)
    values
      ('${arBoundaryId}'::uuid, '${TENANT_ID}'::uuid, '${assetBoundaryId}'::uuid,
       '${startAt}'::timestamptz, '${endAt}'::timestamptz, 'confirmed',
       '${THOMAS_PERSON}'::uuid, '${bookingId}'::uuid);
    -- Asset reservation #2 — custom-window (30-min, off-boundary).
    insert into public.asset_reservations
      (id, tenant_id, asset_id, start_at, end_at, status,
       requester_person_id, booking_id)
    values
      ('${arCustomId}'::uuid, '${TENANT_ID}'::uuid, '${assetCustomId}'::uuid,
       '${arCustomStart}'::timestamptz, '${arCustomEnd}'::timestamptz,
       'confirmed', '${THOMAS_PERSON}'::uuid, '${bookingId}'::uuid);

    -- Setup work_order. The parent-kind invariant was tightened post-
    -- canonicalization: the live CHECK work_orders_kind_matches_fk now
    -- requires parent_kind='booking' (renamed from the bridge label
    -- 'booking_bundle') paired with booking_id NOT NULL + parent_ticket
    -- _id NULL (verified via pg_get_constraintdef on remote). sla_id
    -- reuses the seeded tenant-1 policy a3000000-..-01 (00008_sla_
    -- policies.sql seed; cited as a stable literal — the helper carries
    -- it through to the outbox payload's sla_policy_id).
    insert into public.work_orders
      (id, tenant_id, title, status_category, parent_kind, booking_id,
       module_number, planned_start_at, sla_id, sla_resolution_due_at)
    values
      ('${workOrderId}'::uuid, '${TENANT_ID}'::uuid,
       'Smoke D setup work order', 'assigned', 'booking',
       '${bookingId}'::uuid, ${woModuleNumber},
       '${woPlannedStart}'::timestamptz,
       'a3000000-0000-0000-0000-000000000001'::uuid,
       '${woSlaDue}'::timestamptz);
    set session_replication_role = 'origin';
  `;
  runPsql(sql);
  return {
    bookingId,
    slotId,
    assetTypeId,
    assetBoundaryId,
    assetCustomId,
    catalogItemId,
    orderId,
    orderLineItemId,
    arBoundaryId,
    arCustomId,
    workOrderId,
    startAt,
    endAt,
    arCustomStart,
    arCustomEnd,
    woPlannedStart,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Fixture E — audit-03 Slice 3 (P0-2 multi-slot residual, Path B)
// SAFETY probe. A 2-ROOM (2 booking_slots) non-recurring booking PLUS
// the full linked-row graph: 1 catering order (+1 OLI), 1 boundary-
// aligned asset_reservation, 1 custom-window asset_reservation, 1 setup
// work_order. +135 days future, 1h duration.
//
// This is the HONEST-CONTRACT probe. `AssembleEditPlanService.
// buildLinkedRowPatches` SKIPS linked-row time propagation for a >1-slot
// booking (children key only off booking_id, no slot/space attribution
// column — 00278:108-144). Path B does NOT generalize propagation (that
// is deferred-with-owner as discovered finding D-11): a uniform whole-
// booking move of a multi-slot booking is itself under-defined today
// (editOne resolves/patches only the PRIMARY slot; the v5 RPC writes
// bookings.start_at/end_at straight from the booking patch with NO
// MIN/MAX over booking_slots — the "Step 2F" envelope recompute is
// unbuilt). So the ONLY honest contract is: the booking/primary-slot
// move commits, the OTHER slot + ALL linked children are LEFT UNCHANGED,
// and a DURABLE tenant-scoped audit_events row records the residual gap.
//
// The probe asserts (post-edit DB reads, epoch compare, NOT http-200-
// only): (i) every linked child UNCHANGED vs its seed window (proves NO
// silent corruption — children NOT shifted to a window the other slots
// never moved to); (ii) the durable signal exists (audit_events row
// keyed by booking_id+tenant_id, event_type
// 'booking.linked_rows_not_propagated'); (iii) clean 2xx + the response
// carries NO invented wire field. Fails CLOSED if any child moved OR the
// signal is absent.
//
// Same column/nullability citations as Fixture D (00005/00013/00142/
// 00144/00213/00278). The 2-slot shape mirrors Fixture B. Cleaned up
// generically by `deleteFixtures` (everything keys off booking_id).
// ─────────────────────────────────────────────────────────────────────

function seedFixtureE() {
  const bookingId = crypto.randomUUID();
  const primarySlotId = crypto.randomUUID();
  const nonPrimarySlotId = crypto.randomUUID();
  const assetTypeId = crypto.randomUUID();
  const assetBoundaryId = crypto.randomUUID();
  const assetCustomId = crypto.randomUUID();
  const catalogItemId = crypto.randomUUID();
  const orderId = crypto.randomUUID();
  const orderLineItemId = crypto.randomUUID();
  const arBoundaryId = crypto.randomUUID();
  const arCustomId = crypto.randomUUID();
  const workOrderId = crypto.randomUUID();

  const anchor = new Date(Date.now() + FIXTURE_E_DAYS_FROM_NOW * 86400_000);
  anchor.setUTCMinutes(0, 0, 0);
  anchor.setUTCHours(13);
  const slotStartMs = anchor.getTime();
  const slotEndMs = slotStartMs + 60 * 60_000; // 1h booking
  const startAt = new Date(slotStartMs).toISOString();
  const endAt = new Date(slotEndMs).toISOString();

  // Custom-window asset_reservation: slot.start + 15min → +45min
  // (30-min, off both booking boundaries).
  const arCustomStart = new Date(slotStartMs + 15 * 60_000).toISOString();
  const arCustomEnd = new Date(slotStartMs + 45 * 60_000).toISOString();
  // Setup work_order: planned_start_at = slot.start − 30min.
  const woPlannedStart = new Date(slotStartMs - 30 * 60_000).toISOString();
  const woSlaDue = new Date(slotEndMs).toISOString();
  const woModuleNumber =
    900_000_000_000_000 + Math.floor(Math.random() * 1_000_000_000);

  const sql = `
    set session_replication_role = 'replica';
    insert into public.bookings
      (id, tenant_id, title, requester_person_id, location_id,
       start_at, end_at, timezone, status, source, calendar_etag,
       cost_amount_snapshot, policy_snapshot, applied_rule_ids)
    values
      ('${bookingId}'::uuid, '${TENANT_ID}'::uuid, 'Smoke multi-slot fixture E',
       '${THOMAS_PERSON}'::uuid, '${ROOM_HUDDLE}'::uuid,
       '${startAt}'::timestamptz, '${endAt}'::timestamptz, 'UTC',
       'confirmed', 'desk', 'smoke-etag-e-${bookingId.slice(0, 8)}',
       100.00, '{}'::jsonb, '{}'::uuid[]);
    -- TWO slots: primary on ROOM_HUDDLE (display_order=0), non-primary
    -- on ROOM_BOARD (display_order=1). Same window on both. >1 slot ⇒
    -- buildLinkedRowPatches SKIPS linked-row propagation.
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

    insert into public.asset_types (id, tenant_id, name)
    values ('${assetTypeId}'::uuid, '${TENANT_ID}'::uuid, 'Smoke E asset type');
    insert into public.assets
      (id, tenant_id, asset_type_id, asset_role, name, status)
    values
      ('${assetBoundaryId}'::uuid, '${TENANT_ID}'::uuid, '${assetTypeId}'::uuid,
       'pooled', 'Smoke E projector (boundary)', 'available'),
      ('${assetCustomId}'::uuid, '${TENANT_ID}'::uuid, '${assetTypeId}'::uuid,
       'pooled', 'Smoke E projector (custom)', 'available');

    -- catalog_items.category is constrained (00013:8) to
    -- ('food_and_drinks','equipment','supplies','services'). This is a
    -- catering order (see header: "1 catering order (+1 OLI)"); catering
    -- is food/drink → 'food_and_drinks' (was the stale 'catering' literal
    -- which violated catalog_items_category_check and aborted seedFixtureE).
    insert into public.catalog_items (id, tenant_id, name, category)
    values ('${catalogItemId}'::uuid, '${TENANT_ID}'::uuid,
            'Smoke E catalog item', 'food_and_drinks');

    insert into public.orders
      (id, tenant_id, requester_person_id, booking_id, status,
       requested_for_start_at, requested_for_end_at, delivery_location_id)
    values
      ('${orderId}'::uuid, '${TENANT_ID}'::uuid, '${THOMAS_PERSON}'::uuid,
       '${bookingId}'::uuid, 'confirmed',
       '${startAt}'::timestamptz, '${endAt}'::timestamptz,
       '${ROOM_HUDDLE}'::uuid);
    insert into public.order_line_items
      (id, order_id, tenant_id, catalog_item_id, quantity)
    values
      ('${orderLineItemId}'::uuid, '${orderId}'::uuid, '${TENANT_ID}'::uuid,
       '${catalogItemId}'::uuid, 1);

    insert into public.asset_reservations
      (id, tenant_id, asset_id, start_at, end_at, status,
       requester_person_id, booking_id)
    values
      ('${arBoundaryId}'::uuid, '${TENANT_ID}'::uuid, '${assetBoundaryId}'::uuid,
       '${startAt}'::timestamptz, '${endAt}'::timestamptz, 'confirmed',
       '${THOMAS_PERSON}'::uuid, '${bookingId}'::uuid);
    insert into public.asset_reservations
      (id, tenant_id, asset_id, start_at, end_at, status,
       requester_person_id, booking_id)
    values
      ('${arCustomId}'::uuid, '${TENANT_ID}'::uuid, '${assetCustomId}'::uuid,
       '${arCustomStart}'::timestamptz, '${arCustomEnd}'::timestamptz,
       'confirmed', '${THOMAS_PERSON}'::uuid, '${bookingId}'::uuid);

    insert into public.work_orders
      (id, tenant_id, title, status_category, parent_kind, booking_id,
       module_number, planned_start_at, sla_id, sla_resolution_due_at)
    values
      ('${workOrderId}'::uuid, '${TENANT_ID}'::uuid,
       'Smoke E setup work order', 'assigned', 'booking',
       '${bookingId}'::uuid, ${woModuleNumber},
       '${woPlannedStart}'::timestamptz,
       'a3000000-0000-0000-0000-000000000001'::uuid,
       '${woSlaDue}'::timestamptz);
    set session_replication_role = 'origin';
  `;
  runPsql(sql);
  return {
    bookingId,
    primarySlotId,
    nonPrimarySlotId,
    assetTypeId,
    assetBoundaryId,
    assetCustomId,
    catalogItemId,
    orderId,
    orderLineItemId,
    arBoundaryId,
    arCustomId,
    workOrderId,
    startAt,
    endAt,
    arCustomStart,
    arCustomEnd,
    woPlannedStart,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Cleanup — LIFO sweep across audit_events, domain_events,
// outbox.events, approvals, inbox_notifications, command_operations,
// booking_slots, bookings. Best-effort: each delete batch wrapped in
// try/catch.
//
// Sweeps command_operations rows keyed under any 'booking:edit:%'
// prefix for our fixture bookings so retries / probes from prior runs
// don't pollute future runs.
//
// The approval-flip probe inserts inbox_notifications rows tagged with
// `payload.booking_id` matching a fixture booking_id; sweep them by
// that key so we don't leak rows into Noor's real inbox.
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
    -- Fixture D's sla.timer_repointed_required events have
    -- aggregate_id = work_order_id (00394:1016-1017), not booking_id —
    -- sweep them via the WO ↔ booking_id link before the WOs are
    -- deleted below.
    delete from outbox.events
      where tenant_id = '${TENANT_ID}'::uuid
        and event_type = 'sla.timer_repointed_required'
        and aggregate_id in (
          select id from public.work_orders
           where tenant_id = '${TENANT_ID}'::uuid
             and booking_id in (${bookingIdList})
        );
    delete from public.approvals
      where tenant_id = '${TENANT_ID}'::uuid
        and target_entity_type = 'booking'
        and target_entity_id in (${bookingIdList});
    delete from public.inbox_notifications
      where tenant_id = '${TENANT_ID}'::uuid
        and event_kind = 'booking.approval_required'
        and (payload->>'booking_id') in (${bookingIds.map((id) => `'${id}'`).join(', ')});
    delete from public.command_operations
      where tenant_id = '${TENANT_ID}'::uuid
        and (
          idempotency_key like 'booking:edit:one:%'
          or idempotency_key like 'booking:edit:slot:%'
        )
        and (
          ${bookingIds.map((id) => `idempotency_key like 'booking:edit:%:${id}:%'`).join(' or ')}
        );
    -- ── Fixture D linked-row graph cleanup ──────────────────────────
    -- orders / asset_reservations / work_orders all carry booking_id
    -- (00278:108-144 rename) so they sweep generically. Self-seeded
    -- asset / asset_type / catalog_item are captured via their link
    -- rows BEFORE those rows are deleted (temp tables hold the ids so
    -- the FK-parent deletes can run after the children). Fixtures
    -- A/B/C have no linked rows so these are no-ops for them.
    create temp table _smoke_d_assets on commit drop as
      select distinct ar.asset_id as id
        from public.asset_reservations ar
       where ar.tenant_id = '${TENANT_ID}'::uuid
         and ar.booking_id in (${bookingIdList});
    create temp table _smoke_d_catalog on commit drop as
      select distinct oli.catalog_item_id as id
        from public.order_line_items oli
        join public.orders o on o.id = oli.order_id
       where o.tenant_id = '${TENANT_ID}'::uuid
         and o.booking_id in (${bookingIdList});
    create temp table _smoke_d_asset_types on commit drop as
      select distinct a.asset_type_id as id
        from public.assets a
       where a.tenant_id = '${TENANT_ID}'::uuid
         and a.id in (select id from _smoke_d_assets);

    delete from public.work_orders
      where tenant_id = '${TENANT_ID}'::uuid
        and booking_id in (${bookingIdList});
    delete from public.asset_reservations
      where tenant_id = '${TENANT_ID}'::uuid
        and booking_id in (${bookingIdList});
    delete from public.order_line_items
      where tenant_id = '${TENANT_ID}'::uuid
        and order_id in (
          select id from public.orders
           where tenant_id = '${TENANT_ID}'::uuid
             and booking_id in (${bookingIdList})
        );
    delete from public.orders
      where tenant_id = '${TENANT_ID}'::uuid
        and booking_id in (${bookingIdList});
    -- Self-seeded support rows last (now unreferenced).
    delete from public.assets
      where tenant_id = '${TENANT_ID}'::uuid
        and id in (select id from _smoke_d_assets);
    delete from public.catalog_items
      where tenant_id = '${TENANT_ID}'::uuid
        and id in (select id from _smoke_d_catalog);
    delete from public.asset_types
      where tenant_id = '${TENANT_ID}'::uuid
        and id in (select id from _smoke_d_asset_types);

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

// A successful edit writes its `booking.edited` audit row inside the RPC
// txn (synchronous), but the B.4.A.5 outbox→audit projection for the
// same edit lands post-commit (async). When a "no new writes" baseline
// is sampled immediately after a successful edit, that async row can
// arrive between the pre-sample and the post-sample, faking a delta=1
// on the NEXT (rejected) request — even though the rejected request
// wrote nothing. Poll until the count is stable (two equal reads) so
// the prior edit's async projection has fully landed before baselining.
// Keeps the "no new writes" assertion strict (a real write still trips
// it) while removing the sample-then-settle race.
async function settledAuditCount(bookingId) {
  let prev = await countAuditEventsForBooking(bookingId);
  for (let i = 0; i < 12; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    const next = await countAuditEventsForBooking(bookingId);
    if (next === prev) return next;
    prev = next;
  }
  return prev;
}

// `command_operations` is an internal idempotency ledger and is NOT
// exposed through PostgREST (the supabase-js client returns an opaque
// `{ message: '' }` error on any select — verified 2026-05-16). Read it
// the same way the seed/cleanup paths touch it: a tenant-gated psql
// scalar. Mirrors the `public.command_operations` + tenant_id filter
// used by the cleanup sweep (smoke-edit-booking.mjs:671-675).
function countCommandOpsForKey(key) {
  const out = runPsqlQuery(
    `select count(*) from public.command_operations ` +
      `where tenant_id = '${TENANT_ID}'::uuid ` +
      `and idempotency_key = '${key}';`,
  );
  return Number.parseInt(out, 10) || 0;
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
    // Postgres returns timestamptz as `…+00:00`; JS toISOString() emits
    // `…Z`. Same instant, different string — compare by epoch, not bytes
    // (sameInstant is the script's canonical tz-normalizing comparator,
    // already used by the Fixture D probe).
    passAssertion(
      'Geometry edit: slot.start_at updated',
      sameInstant(slotsAfter[0]?.start_at, newStart),
      `got=${slotsAfter[0]?.start_at}`,
    );
    passAssertion(
      'Geometry edit: slot.end_at updated',
      sameInstant(slotsAfter[0]?.end_at, newEnd),
      `got=${slotsAfter[0]?.end_at}`,
    );
    passAssertion(
      'Geometry edit: booking.start_at updated',
      sameInstant(bookingAfter?.start_at, newStart),
      `got=${bookingAfter?.start_at}`,
    );
    passAssertion(
      'Geometry edit: booking.end_at updated',
      sameInstant(bookingAfter?.end_at, newEnd),
      `got=${bookingAfter?.end_at}`,
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Scenario 6 — Edit invalid window (start >= end).
  // - 400; code=booking.invalid_window; no writes.
  // Citation: reservation.service.ts:769-777.
  // ────────────────────────────────────────────────────────────────
  // settledAuditCount (not the bare count) — Scenario 5 above was a
  // SUCCESSFUL geometry edit; its async outbox→audit projection may
  // still be in flight. Settle before baselining or that row lands
  // mid-probe and fakes a delta on this rejected request.
  const auditCountPreInvalidWindow = await settledAuditCount(fixtureA.bookingId);
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
    // tz-format normalization (Postgres `+00:00` vs JS `Z`) — compare
    // by epoch via the canonical sameInstant comparator.
    passAssertion(
      'Geometry slot: non-primary slot.start_at updated',
      sameInstant(nonPrimaryAfter?.start_at, earlierStart),
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
  const firstReplay = await probe('Slot idempotency: first call (space_id=ROOM_HUDDLE)', {
    url: editNonPrimaryUrl,
    body: replayBody,
    clientRequestId: replayCrid,
  });
  // booking-audit Slice 1: the FIRST call legitimately executes the RPC
  // (space_id=ROOM_HUDDLE is a real change — the non-primary slot is on
  // ROOM_TEAM from Scenario 12) and writes 1 audit event. The
  // idempotency invariant is "the REPLAY writes nothing", so capture the
  // baseline AFTER the executing first call and BEFORE the replay —
  // exactly the structure Scenario 3 (editOne sibling) uses. Capturing
  // it before the first call asserted a structurally-impossible "first
  // call + replay combined write nothing", which only ever passed by
  // accident because the broken idempotency hash made `secondReplay.ok`
  // false and skipped this whole block. Fixing the hash exposed the
  // latent probe-structure bug; this aligns it to its editOne sibling.
  const auditCountPreReplay = await countAuditEventsForBooking(fixtureB.bookingId);
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
      auditCountAfterReplay === auditCountPreReplay,
      `delta=${auditCountAfterReplay - auditCountPreReplay}`,
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
// Approval-flip probe — B.4.A.5 sub-step H gate-lift assertion.
//
// Defends against: a regression that re-introduces the 422
// `booking.edit_requires_notification_dispatch` gate at any of the
// four sites the sub-step H commit lifted it from. Fixture C anchors
// a 1-hour booking; the probe PATCHes start_at/end_at to extend the
// duration past 4h (240 min), triggering the seeded
// "Long bookings need manager approval" rule (b0010002, effect=
// require_approval, approver=Noor person_id 95000000-..-04). Asserts:
//   - HTTP 200 (gate is lifted; pre-H this was 422).
//   - One new `approvals` row scoped by (tenant_id, booking_id) with
//     approver_person_id=NOOR_PERSON and status='pending'.
//   - One new `inbox_notifications` row for Noor's user_id, event_kind=
//     'booking.approval_required', payload.chain_id matching the
//     approval row's approval_chain_id.
//   - One new `outbox.events` row event_type='booking.approval_required'
//     with payload.chain_id matching.
// All assertions are tenant-scoped (#0 invariant).
//
// Citations:
//   - supabase/migrations/00133_seed_room_booking_examples.sql:84-107
//     (the rule that drives this flip).
//   - supabase/migrations/00399_edit_booking_scope_lift_b4a5_gate.sql
//     (scope-side gate lift; this probe covers the editOne mirror at
//     reservation.service.ts).
//   - supabase/migrations/00394 (or current edit_booking RPC) §3.6.5
//     row 2 + Hybrid C atomic inbox INSERT block.
// ─────────────────────────────────────────────────────────────────────

async function readApprovalsForBooking(bookingId) {
  const { data, error } = await supa()
    .from('approvals')
    .select('id, approval_chain_id, approver_person_id, status')
    .eq('tenant_id', TENANT_ID)
    .eq('target_entity_type', 'booking')
    .eq('target_entity_id', bookingId);
  if (error) throw error;
  return data ?? [];
}

async function readInboxRowsForBooking(bookingId) {
  // PostgREST quirk — `.filter()` on a JSON path with eq can be picky
  // about value coercion. Fetch the small tenant-scoped event_kind set
  // and filter in JS by booking_id (cheap, deterministic).
  const { data, error } = await supa()
    .from('inbox_notifications')
    .select('id, user_id, event_kind, payload')
    .eq('tenant_id', TENANT_ID)
    .eq('event_kind', 'booking.approval_required');
  if (error) throw error;
  return (data ?? []).filter((r) => r.payload?.booking_id === bookingId);
}

// The `outbox` schema is NOT exposed through PostgREST (only `public`
// + `graphql_public` are — supabase-js `.schema('outbox')` throws
// PGRST106, verified 2026-05-16). Read it via a tenant-gated psql
// scalar, mirroring how the cleanup sweep touches `outbox.events`
// (smoke-edit-booking.mjs:648-650). json_agg keeps the caller's
// `.find()`/`.length`/`.payload` shape intact.
function readOutboxRowsForBooking(bookingId) {
  const out = runPsqlQuery(
    `select coalesce(json_agg(json_build_object(` +
      `'id', id, 'event_type', event_type, 'payload', payload)), '[]'::json) ` +
      `from outbox.events ` +
      `where tenant_id = '${TENANT_ID}'::uuid ` +
      `and event_type = 'booking.approval_required' ` +
      `and aggregate_id = '${bookingId}'::uuid;`,
  );
  return JSON.parse(out || '[]');
}

async function runApprovalFlipProbe(probe, fixtureC) {
  console.log('\n=== Approval-flip probe (B.4.A.5 sub-step H gate lift) ===');

  // Sanity — Fixture C must start with zero approvals + zero inbox rows
  // so post-probe deltas equal the absolute counts.
  const apprBefore = await readApprovalsForBooking(fixtureC.bookingId);
  passAssertion(
    'Flip setup: 0 approvals before probe',
    apprBefore.length === 0,
    `count=${apprBefore.length}`,
  );

  // Extend the booking to 5h (> 240 min duration → rule b0010002 fires
  // with effect=require_approval). The end_at moves forward; start_at
  // stays the same. The booking-edit RPC reads the rule resolver
  // outcome from the assembler's plan; we trust the rule to fire on
  // duration > 240.
  const startAt = fixtureC.startAt;
  const newEndAtMs = new Date(startAt).getTime() + 5 * 60 * 60_000;
  const newEndAt = new Date(newEndAtMs).toISOString();

  const flipCrid = crypto.randomUUID();
  const flipResult = await probe('Approval-flip: editOne extends duration to 5h → 200', {
    url: `${API_BASE}/api/reservations/${fixtureC.bookingId}`,
    body: { start_at: startAt, end_at: newEndAt },
    clientRequestId: flipCrid,
  });
  if (!flipResult.ok) return;

  // ── Assertion 1: one new approvals row, status=pending, approver=Noor.
  const apprAfter = await readApprovalsForBooking(fixtureC.bookingId);
  const noorAppr = apprAfter.find(
    (a) => a.approver_person_id === NOOR_PERSON && a.status === 'pending',
  );
  passAssertion(
    'Flip: 1 pending approval for NOOR_PERSON',
    apprAfter.length >= 1 && Boolean(noorAppr),
    `count=${apprAfter.length} matches=${noorAppr ? 1 : 0}`,
  );
  if (!noorAppr) return;
  const chainId = noorAppr.approval_chain_id;

  // ── Assertion 2: one inbox_notifications row for Noor's user_id, chain_id matches.
  const inboxRows = await readInboxRowsForBooking(fixtureC.bookingId);
  const noorInbox = inboxRows.find(
    (r) => r.user_id === NOOR_USER && r.payload?.chain_id === chainId,
  );
  passAssertion(
    'Flip: 1 inbox_notifications row for Noor with matching chain_id',
    Boolean(noorInbox),
    `inbox_count=${inboxRows.length} noorMatch=${noorInbox ? 1 : 0}`,
  );

  // ── Assertion 3: one outbox.events row with matching chain_id.
  const outboxRows = await readOutboxRowsForBooking(fixtureC.bookingId);
  const outboxMatch = outboxRows.find(
    (r) => r.payload?.chain_id === chainId,
  );
  passAssertion(
    "Flip: 1 outbox.events row 'booking.approval_required' with matching chain_id",
    Boolean(outboxMatch),
    `outbox_count=${outboxRows.length} chainMatch=${outboxMatch ? 1 : 0}`,
  );
}

// ─────────────────────────────────────────────────────────────────────
// Fixture D linked-row probe — closes audit P0-2/P0-3.
//
// editOne pure-move (+2h on BOTH start_at and end_at; duration
// unchanged, so startDelta == endDelta == +2h). Asserts the booking +
// slot move AND the linked orders / asset_reservations / setup
// work_order all follow:
//   - orders.requested_for_start_at / requested_for_end_at +2h.
//   - boundary-aligned asset_reservation (== old slot window) → new =
//     (newStart, newEnd) [+2h both endpoints].
//   - custom-window asset_reservation (off-boundary 30-min) → both
//     endpoints +startDelta, DURATION STILL 30min (not restretched).
//   - work_orders.planned_start_at +2h (still 30min before new slot
//     start — setup lead preserved).
//   - an outbox.events row 'sla.timer_repointed_required' with
//     aggregate_id = work_order_id (00394:1011-1031) — proves
//     needs_repoint propagated and the producer set sla_policy_id.
//
// All reads tenant-scoped (#0 invariant).
// ─────────────────────────────────────────────────────────────────────

async function readOrderById(orderId) {
  const { data, error } = await supa()
    .from('orders')
    .select('id, requested_for_start_at, requested_for_end_at, delivery_location_id')
    .eq('tenant_id', TENANT_ID)
    .eq('id', orderId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function readAssetReservationById(arId) {
  const { data, error } = await supa()
    .from('asset_reservations')
    .select('id, start_at, end_at, status')
    .eq('tenant_id', TENANT_ID)
    .eq('id', arId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function readWorkOrderById(woId) {
  const { data, error } = await supa()
    .from('work_orders')
    .select('id, planned_start_at, sla_resolution_due_at')
    .eq('tenant_id', TENANT_ID)
    .eq('id', woId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// audit-03 Slice 3 (P0-2 multi-slot residual, Path B) — read the durable
// `booking.linked_rows_not_propagated` audit_events row(s) for a booking.
// Tenant-gated (#0 rule). The service emits this POST-COMMIT, best-
// effort + awaited, so it is deterministically readable once the editOne
// HTTP call returns 2xx.
async function readMultiSlotSkipAuditRows(bookingId) {
  const { data, error } = await supa()
    .from('audit_events')
    .select('id, event_type, entity_type, entity_id, details')
    .eq('tenant_id', TENANT_ID)
    .eq('entity_type', 'booking')
    .eq('entity_id', bookingId)
    .eq('event_type', 'booking.linked_rows_not_propagated');
  if (error) throw error;
  return data ?? [];
}

// Same PGRST106 constraint as readOutboxRowsForBooking — the `outbox`
// schema is not PostgREST-exposed. Tenant-gated psql scalar; json_agg
// preserves the caller's `.find()`/`.length`/`.payload`/`.aggregate_id`
// shape.
function readSlaRepointOutboxForWorkOrder(woId) {
  const out = runPsqlQuery(
    `select coalesce(json_agg(json_build_object(` +
      `'id', id, 'event_type', event_type, ` +
      `'aggregate_id', aggregate_id, 'payload', payload)), '[]'::json) ` +
      `from outbox.events ` +
      `where tenant_id = '${TENANT_ID}'::uuid ` +
      `and event_type = 'sla.timer_repointed_required' ` +
      `and aggregate_id = '${woId}'::uuid;`,
  );
  return JSON.parse(out || '[]');
}

// Compare two ISO timestamps by epoch ms (tz-normalized — Postgres may
// return +00 / Z / +00:00; Date.parse normalizes all three).
function sameInstant(a, b) {
  return new Date(a).getTime() === new Date(b).getTime();
}

async function runFixtureDProbe(probe, fixtureD) {
  console.log('\n=== Fixture D linked-row probe (P0-2/P0-3) ===');

  const TWO_H = 2 * 60 * 60_000;
  const oldStartMs = new Date(fixtureD.startAt).getTime();
  const oldEndMs = new Date(fixtureD.endAt).getTime();
  const newStart = new Date(oldStartMs + TWO_H).toISOString();
  const newEnd = new Date(oldEndMs + TWO_H).toISOString();

  // Sanity — linked rows seeded at the OLD window.
  const slotsBefore = await readSlotsForBooking(fixtureD.bookingId);
  passAssertion(
    'Fixture D setup: exactly 1 slot on ROOM_HUDDLE at old window',
    slotsBefore.length === 1 &&
      slotsBefore[0].space_id === ROOM_HUDDLE &&
      sameInstant(slotsBefore[0].start_at, fixtureD.startAt),
    `slots=${slotsBefore.length} space=${slotsBefore[0]?.space_id?.slice(0, 8)}`,
  );

  // editOne pure-move: shift start AND end by +2h. Duration unchanged
  // (startDelta == endDelta == +2h) so this is a plain time move — no
  // approval rule trips (the seeded rule b0010002 fires on duration >
  // 240min; this booking stays 1h).
  const moveCrid = crypto.randomUUID();
  const moveResult = await probe('Fixture D: editOne pure-move +2h (duration unchanged) → 200', {
    url: `${API_BASE}/api/reservations/${fixtureD.bookingId}`,
    body: { start_at: newStart, end_at: newEnd },
    clientRequestId: moveCrid,
  });
  if (!moveResult.ok) return;

  // ── Booking + slot moved +2h.
  const bookingAfter = await readBookingById(fixtureD.bookingId);
  const slotsAfter = await readSlotsForBooking(fixtureD.bookingId);
  passAssertion(
    'Fixture D: booking start_at/end_at moved +2h',
    bookingAfter &&
      sameInstant(bookingAfter.start_at, newStart) &&
      sameInstant(bookingAfter.end_at, newEnd),
    `start=${bookingAfter?.start_at} end=${bookingAfter?.end_at}`,
  );
  passAssertion(
    'Fixture D: slot start_at/end_at moved +2h',
    slotsAfter.length === 1 &&
      sameInstant(slotsAfter[0].start_at, newStart) &&
      sameInstant(slotsAfter[0].end_at, newEnd),
    `start=${slotsAfter[0]?.start_at} end=${slotsAfter[0]?.end_at}`,
  );

  // ── Order window moved +2h.
  const orderAfter = await readOrderById(fixtureD.orderId);
  passAssertion(
    'Fixture D: order.requested_for_start_at moved +2h',
    orderAfter && sameInstant(orderAfter.requested_for_start_at, newStart),
    `got=${orderAfter?.requested_for_start_at} want=${newStart}`,
  );
  passAssertion(
    'Fixture D: order.requested_for_end_at moved +2h',
    orderAfter && sameInstant(orderAfter.requested_for_end_at, newEnd),
    `got=${orderAfter?.requested_for_end_at} want=${newEnd}`,
  );

  // ── Boundary-aligned asset_reservation: both endpoints = new window.
  const arBoundary = await readAssetReservationById(fixtureD.arBoundaryId);
  passAssertion(
    'Fixture D: boundary-aligned asset_reservation moved to (newStart, newEnd)',
    arBoundary &&
      sameInstant(arBoundary.start_at, newStart) &&
      sameInstant(arBoundary.end_at, newEnd),
    `start=${arBoundary?.start_at} end=${arBoundary?.end_at}`,
  );

  // ── Custom-window asset_reservation: both endpoints +startDelta,
  // 30-min duration PRESERVED (proves it shifts by startDelta, not
  // restretched to the new boundary window).
  const arCustom = await readAssetReservationById(fixtureD.arCustomId);
  const wantCustomStart = new Date(
    new Date(fixtureD.arCustomStart).getTime() + TWO_H,
  ).toISOString();
  const wantCustomEnd = new Date(
    new Date(fixtureD.arCustomEnd).getTime() + TWO_H,
  ).toISOString();
  const customDurMin =
    arCustom &&
    (new Date(arCustom.end_at).getTime() - new Date(arCustom.start_at).getTime()) /
      60_000;
  passAssertion(
    'Fixture D: custom-window asset_reservation shifted +startDelta, duration still 30min',
    arCustom &&
      sameInstant(arCustom.start_at, wantCustomStart) &&
      sameInstant(arCustom.end_at, wantCustomEnd) &&
      customDurMin === 30,
    `start=${arCustom?.start_at} end=${arCustom?.end_at} durMin=${customDurMin}`,
  );

  // ── Work order planned_start_at moved +2h (still 30min before the
  // new slot start — setup lead preserved).
  const woAfter = await readWorkOrderById(fixtureD.workOrderId);
  const wantWoPlanned = new Date(
    new Date(fixtureD.woPlannedStart).getTime() + TWO_H,
  ).toISOString();
  const leadMin =
    woAfter &&
    (new Date(newStart).getTime() - new Date(woAfter.planned_start_at).getTime()) /
      60_000;
  passAssertion(
    'Fixture D: work_order.planned_start_at moved +2h (30min setup lead preserved)',
    woAfter &&
      sameInstant(woAfter.planned_start_at, wantWoPlanned) &&
      leadMin === 30,
    `got=${woAfter?.planned_start_at} want=${wantWoPlanned} leadMin=${leadMin}`,
  );

  // ── needs_repoint propagated: outbox.events 'sla.timer_repointed_
  // required' with aggregate_id = work_order_id, sla_policy_id carried.
  const slaOutbox = await readSlaRepointOutboxForWorkOrder(fixtureD.workOrderId);
  const slaMatch = slaOutbox.find(
    (r) =>
      r.aggregate_id === fixtureD.workOrderId &&
      r.payload?.work_order_id === fixtureD.workOrderId,
  );
  passAssertion(
    "Fixture D: 1 outbox 'sla.timer_repointed_required' for the work_order",
    Boolean(slaMatch),
    `outbox_count=${slaOutbox.length} match=${slaMatch ? 1 : 0}`,
  );
  passAssertion(
    'Fixture D: sla repoint event carries sla_policy_id from the WO row',
    slaMatch?.payload?.sla_policy_id === 'a3000000-0000-0000-0000-000000000001',
    `sla_policy_id=${slaMatch?.payload?.sla_policy_id}`,
  );
}

// ─────────────────────────────────────────────────────────────────────
// Fixture E SAFETY probe — audit-03 Slice 3 (P0-2 multi-slot residual,
// Path B). The HONEST-CONTRACT gate. A 2-slot booking + full linked-row
// graph; editOne window-shift it. Assert (post-edit DB reads, epoch
// compare — NOT http-200-only):
//   (i)   EVERY linked child (order window, both asset_reservations,
//         setup work_order) + the NON-PRIMARY slot are UNCHANGED vs
//         their seed windows → proves NO silent corruption (children
//         were NOT shifted to a window the other slots never moved to).
//   (ii)  the DURABLE signal exists — exactly one audit_events row,
//         tenant-scoped, event_type 'booking.linked_rows_not_propagated',
//         entity_id == bookingId, details.{reason,edit_kind,slot_count}.
//   (iii) clean 2xx + the response carries NO invented wire field
//         (no `warnings`, no `_skipped_multi_slot_linked_rows`).
// Fails CLOSED: any child moved OR signal absent ⇒ a failed assertion ⇒
// `results.fail` ⇒ exit 1. This is a real gate, not constructed-to-pass.
// ─────────────────────────────────────────────────────────────────────

async function runFixtureEProbe(probe, fixtureE) {
  console.log('\n=== Fixture E SAFETY probe (audit-03 Slice 3 — P0-2 multi-slot, Path B) ===');

  const TWO_H = 2 * 60 * 60_000;
  const oldStartMs = new Date(fixtureE.startAt).getTime();
  const oldEndMs = new Date(fixtureE.endAt).getTime();
  const newStart = new Date(oldStartMs + TWO_H).toISOString();
  const newEnd = new Date(oldEndMs + TWO_H).toISOString();

  // Sanity — 2 slots seeded, linked rows at the OLD window.
  const slotsBefore = await readSlotsForBooking(fixtureE.bookingId);
  passAssertion(
    'Fixture E setup: exactly 2 slots (primary ROOM_HUDDLE + non-primary ROOM_BOARD)',
    slotsBefore.length === 2 &&
      slotsBefore.some((s) => s.space_id === ROOM_HUDDLE) &&
      slotsBefore.some((s) => s.space_id === ROOM_BOARD),
    `slots=${slotsBefore.length}`,
  );
  const nonPrimaryBefore = slotsBefore.find(
    (s) => s.id === fixtureE.nonPrimarySlotId,
  );

  // editOne window-shift +2h on the multi-slot booking.
  const moveCrid = crypto.randomUUID();
  const moveResult = await probe(
    'Fixture E: editOne +2h on a MULTI-slot booking → 2xx',
    {
      url: `${API_BASE}/api/reservations/${fixtureE.bookingId}`,
      body: { start_at: newStart, end_at: newEnd },
      clientRequestId: moveCrid,
    },
  );
  if (!moveResult.ok) return; // probe() already recorded the fail

  // (iii) Response carries NO invented wire field.
  const respJson = parseJsonSafe(moveResult.body);
  passAssertion(
    'Fixture E: response has NO invented wire field (no warnings / no _skipped_multi_slot_linked_rows)',
    !!respJson &&
      !('warnings' in respJson) &&
      !('_skipped_multi_slot_linked_rows' in respJson),
    `keys=${respJson ? Object.keys(respJson).join(',').slice(0, 160) : 'unparseable'}`,
  );

  // (i) NO silent corruption — every linked child UNCHANGED vs seed.
  const orderAfter = await readOrderById(fixtureE.orderId);
  passAssertion(
    'Fixture E: order window UNCHANGED (NOT propagated — the honest skip)',
    orderAfter &&
      sameInstant(orderAfter.requested_for_start_at, fixtureE.startAt) &&
      sameInstant(orderAfter.requested_for_end_at, fixtureE.endAt),
    `start=${orderAfter?.requested_for_start_at} end=${orderAfter?.requested_for_end_at}`,
  );

  const arBoundary = await readAssetReservationById(fixtureE.arBoundaryId);
  passAssertion(
    'Fixture E: boundary-aligned asset_reservation UNCHANGED',
    arBoundary &&
      sameInstant(arBoundary.start_at, fixtureE.startAt) &&
      sameInstant(arBoundary.end_at, fixtureE.endAt),
    `start=${arBoundary?.start_at} end=${arBoundary?.end_at}`,
  );

  const arCustom = await readAssetReservationById(fixtureE.arCustomId);
  passAssertion(
    'Fixture E: custom-window asset_reservation UNCHANGED',
    arCustom &&
      sameInstant(arCustom.start_at, fixtureE.arCustomStart) &&
      sameInstant(arCustom.end_at, fixtureE.arCustomEnd),
    `start=${arCustom?.start_at} end=${arCustom?.end_at}`,
  );

  const woAfter = await readWorkOrderById(fixtureE.workOrderId);
  passAssertion(
    'Fixture E: setup work_order.planned_start_at UNCHANGED',
    woAfter && sameInstant(woAfter.planned_start_at, fixtureE.woPlannedStart),
    `got=${woAfter?.planned_start_at} want=${fixtureE.woPlannedStart}`,
  );

  // The non-primary slot must also be untouched (editOne moves only the
  // PRIMARY slot — this is the D-11 "half-move" reality the probe pins).
  const slotsAfter = await readSlotsForBooking(fixtureE.bookingId);
  const nonPrimaryAfter = slotsAfter.find(
    (s) => s.id === fixtureE.nonPrimarySlotId,
  );
  passAssertion(
    'Fixture E: NON-primary slot UNCHANGED (editOne moved only the primary slot — D-11)',
    nonPrimaryAfter &&
      nonPrimaryBefore &&
      sameInstant(nonPrimaryAfter.start_at, nonPrimaryBefore.start_at) &&
      sameInstant(nonPrimaryAfter.end_at, nonPrimaryBefore.end_at),
    `before=${nonPrimaryBefore?.start_at} after=${nonPrimaryAfter?.start_at}`,
  );

  // (ii) The DURABLE signal exists — exactly one tenant-scoped audit row.
  const skipRows = await readMultiSlotSkipAuditRows(fixtureE.bookingId);
  passAssertion(
    "Fixture E: exactly 1 durable 'booking.linked_rows_not_propagated' audit row",
    skipRows.length === 1,
    `count=${skipRows.length}`,
  );
  const row = skipRows[0];
  passAssertion(
    'Fixture E: skip audit row is tenant-scoped + booking-keyed',
    !!row &&
      row.entity_type === 'booking' &&
      row.entity_id === fixtureE.bookingId,
    `entity_type=${row?.entity_type} entity_id=${row?.entity_id?.slice(0, 8)}`,
  );
  const d = row?.details ?? {};
  passAssertion(
    'Fixture E: skip audit details = {reason:multi_slot_no_attribution, edit_kind:one, slot_count:2}',
    d.reason === 'multi_slot_no_attribution' &&
      d.edit_kind === 'one' &&
      d.slot_count === 2,
    `details=${JSON.stringify(d).slice(0, 200)}`,
  );
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
  let fixtureC = null;
  let fixtureD = null;
  let fixtureE = null;
  try {
    console.log('Seeding fixture A (single booking + 1 slot, +130d)…');
    fixtureA = seedFixtureA();
    console.log(`  booking ${fixtureA.bookingId.slice(0, 8)}… / slot ${fixtureA.slotId.slice(0, 8)}…`);

    console.log('Seeding fixture B (single booking + 2 slots, +131d)…');
    fixtureB = seedFixtureB();
    console.log(
      `  booking ${fixtureB.bookingId.slice(0, 8)}… / primary ${fixtureB.primarySlotId.slice(0, 8)}… / non-primary ${fixtureB.nonPrimarySlotId.slice(0, 8)}…`,
    );

    console.log('Seeding fixture C (single booking + 1 slot, +132d, approval-flip)…');
    fixtureC = seedFixtureC();
    console.log(`  booking ${fixtureC.bookingId.slice(0, 8)}… / slot ${fixtureC.slotId.slice(0, 8)}…`);

    console.log('Seeding fixture D (single booking + 1 slot + linked rows, +133d)…');
    fixtureD = seedFixtureD();
    console.log(
      `  booking ${fixtureD.bookingId.slice(0, 8)}… / order ${fixtureD.orderId.slice(0, 8)}… / ar ${fixtureD.arBoundaryId.slice(0, 8)}…+${fixtureD.arCustomId.slice(0, 8)}… / wo ${fixtureD.workOrderId.slice(0, 8)}…`,
    );

    console.log('Seeding fixture E (2-slot booking + linked rows, +135d — multi-slot safety)…');
    fixtureE = seedFixtureE();
    console.log(
      `  booking ${fixtureE.bookingId.slice(0, 8)}… / primary ${fixtureE.primarySlotId.slice(0, 8)}… / non-primary ${fixtureE.nonPrimarySlotId.slice(0, 8)}… / order ${fixtureE.orderId.slice(0, 8)}… / wo ${fixtureE.workOrderId.slice(0, 8)}…`,
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
    await runApprovalFlipProbe(probe, fixtureC);
    await runFixtureDProbe(probe, fixtureD);
    await runFixtureEProbe(probe, fixtureE);
  } finally {
    console.log('\nCleaning up fixtures…');
    const idsToDelete = [
      fixtureA?.bookingId,
      fixtureB?.bookingId,
      fixtureC?.bookingId,
      fixtureD?.bookingId,
      fixtureE?.bookingId,
    ].filter(Boolean);
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

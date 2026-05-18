#!/usr/bin/env node
/**
 * scripts/smoke-edit-booking-scope.mjs
 *
 * Live-API smoke test for the recurrence-scope booking edit pipeline.
 * Hits `POST /api/reservations/:id/edit-scope` end-to-end against the
 * remote Supabase project with a real Admin JWT.
 *
 * Sibling to `smoke-work-orders.mjs` + `smoke-tickets.mjs`. Same
 * shape: psql-seeded fixture, real HTTP probes, command_operations
 * + DB-level row assertions, deterministic cleanup.
 *
 * What this probe defends against:
 *   - Step 2F.3 cutover regressing: the controller used to call
 *     `BookingFlowService.editScope` (bare-UPDATE, zero rule eval).
 *     Post-cutover it routes through `ReservationService.editScope` →
 *     `assembleScopeEditPlan` → `edit_booking_scope` RPC (00371 v2).
 *     A subtle wiring break (e.g. the splitSeries call moves back to
 *     the assembler, or the dry-run path accidentally writes a
 *     command_operations row) is invisible to mocked-jest specs but
 *     load-bearing for the controller surface.
 *   - 00371 v2 dry-run contract (`dry_run` MUST NOT touch
 *     command_operations). If a future migration regresses this, the
 *     "dry-run then commit with same crid" pattern blows up with 409
 *     payload_mismatch in production. This probe locks it in.
 *   - `splitSeries` non-idempotency: on retry the TS pre-check must
 *     skip the splitSeries call so we don't mint an orphan series. The
 *     idempotency-replay probe walks that path.
 *   - Validation gates: time-shift fields rejected, scope='this'
 *     rejected (wrong endpoint), bogus scopes + non-boolean dry_run
 *     rejected, missing X-Client-Request-Id rejected.
 *
 * USAGE:
 *   pnpm dev:api &     (or have the dev server already running)
 *   node apps/api/scripts/smoke-edit-booking-scope.mjs
 *
 *   exit 0 = all probes pass; exit 1 = at least one regression.
 *
 * REQUIREMENTS:
 *   - Local API running on :3001 (`pnpm dev:api`).
 *   - .env with SUPABASE_URL + SUPABASE_SECRET_KEY + SUPABASE_PUBLISHABLE_KEY
 *     + SUPABASE_DB_PASS (for psql seed/cleanup of the recurrence_series
 *     + bookings + slots fixture).
 *   - Remote DB has the seed data the smoke harness consumes:
 *     - Admin auth uid `93d41232-35b5-424c-b215-bb5d55a2dfd9`
 *     - Solana tenant `00000000-0000-0000-0000-000000000001`
 *     - Persons + spaces from 00133_seed_room_booking_examples.sql
 *       (Thomas + 3 meeting rooms — IDs constants below).
 *
 * DESIGN — the lessons baked in:
 *   1. **psql-seeded fixture** for the recurrence_series + 5 occurrences.
 *      Going through `POST /reservations` to mint a recurring booking
 *      runs the full rule resolver + conflict guard, which is fragile
 *      in a smoke environment (any pre-existing booking on the target
 *      space at the chosen window kills the fixture). The concurrency
 *      tests use the same direct-seed pattern at
 *      `apps/api/test/concurrency/edit_booking_scope.spec.ts:115-153`.
 *   2. **Anchor the fixture in TENANT_ID's seed graph.** We use the
 *      real Thomas (`v_thomas` in 00133) + real meeting rooms so the
 *      visibility service treats the bookings as Thomas-owned rather
 *      than synthetic. Admin's `has_admin` flag means `canEdit` returns
 *      true regardless, but anchoring on real fixture data minimises
 *      cross-test interference.
 *   3. **Idempotency key shape replicated here.** The .mjs runtime
 *      can't import the TS source; if you change `EDIT_BOOKING_
 *      IDEMPOTENCY_KEY_PREFIX` or `buildEditBookingIdempotencyKey` in
 *      `packages/shared/src/idempotency.ts`, mirror the change here.
 *      Cross-reference comment at the constant.
 *   4. **Cleanup is non-negotiable.** Test bookings + slots + series
 *      are dropped in a `finally` block so a failed run doesn't leave
 *      orphans in the DB. The cleanup also removes any
 *      `command_operations` rows the smoke wrote (keyed on
 *      `booking:edit:scope:<pivotId>:<crid>` per probe).
 *
 * Citations:
 *   - apps/api/src/modules/reservations/reservation.controller.ts:422-450
 *     (`@Post(':id/edit-scope')` route + DTO validation).
 *   - apps/api/src/modules/reservations/reservation.service.ts:1551-1944
 *     (`editScope` — splitSeries gating, dry-run path, RPC call).
 *   - supabase/migrations/00371_edit_booking_scope_rpc_v2.sql
 *     (RPC v2 commit + dry-run return shapes; idempotency contract).
 *   - packages/shared/src/idempotency.ts:331 + :374-382
 *     (canonical key builder; replicated below for the .mjs runtime).
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
// fixture anchors in tenant-A's existing graph (visibility-friendly).
const THOMAS_PERSON = 'b3a0aa30-3648-4783-92fa-973090877238';
// Three meeting rooms in the Solana tenant — picked so the smoke can
// move bookings between rooms without clashing on existing seeded
// bookings (00133 seeds confirmed bookings on these rooms but only at
// fixed past anchors; our fixture lives ~+90 days in the future, well
// outside the conflict window).
const ROOM_HUDDLE = '14d74559-7f91-470a-98a3-780b3e8a5349';
const ROOM_TEAM = '6df43476-f6af-4ffa-9d39-e79c0bbb3dad';
const ROOM_BOARD = '207242ea-48e9-41a2-a72d-5ea4192f48bf';

// Series + 5 bookings + 5 slots are minted per-run with fresh uuids
// (computed in `seedRecurringFixture`). We pivot on the 3rd occurrence
// (index 2) for `this_and_following` so 3 forward + 2 backward.
const RECURRENCE_COUNT = 5;
const PIVOT_INDEX = 2;

// ─── B.4.A.5 sub-step H approval-flip probe — fixture2 + test rule.
// Noor — required_approver on a one-shot rule we mint per smoke run.
// Citation: psql confirmed person_id 95000000-..-04 → user_id
// 95100000-..-04 in tenant A.
const NOOR_PERSON = '95000000-0000-0000-0000-000000000004';
const NOOR_USER = '95100000-0000-0000-0000-000000000004';
const FLIP_RECURRENCE_COUNT = 3;
const FLIP_PIVOT_INDEX = 0;
// Anchor the flip fixture far away from the existing +90→+118d window
// to avoid any cross-fixture rule interaction.
const FLIP_DAYS_FROM_NOW = 200;

// ─────────────────────────────────────────────────────────────────────
// Idempotency-key shape — replicated from
// `packages/shared/src/idempotency.ts:331 + :374-382`. The .mjs runtime
// can't import the TS source (no compile step for smoke scripts). If
// you change the prefix or shape, update BOTH places in the same
// commit. Mirrored from smoke-tickets.mjs:96-107 pattern.
// ─────────────────────────────────────────────────────────────────────

const EDIT_BOOKING_IDEMPOTENCY_KEY_PREFIX = 'booking:edit';

function buildEditBookingIdempotencyKey(op, bookingId, clientRequestId) {
  return `${EDIT_BOOKING_IDEMPOTENCY_KEY_PREFIX}:${op}:${bookingId}:${clientRequestId}`;
}

// Booking-audit Slice 4 (audit 03 P1-2) — split_recurrence_series RPC
// (00411) key shape, replicated from
// `packages/shared/src/idempotency.ts` (SPLIT_RECURRENCE_SERIES_
// IDEMPOTENCY_KEY_PREFIX + buildSplitSeriesIdempotencyKey). Same
// lockstep rule as the edit key above. The split runs INSIDE editScope
// keyed on the SAME (bookingId, clientRequestId) the editScope uses.
const SPLIT_RECURRENCE_SERIES_IDEMPOTENCY_KEY_PREFIX =
  'booking:recurrence:split';

function buildSplitSeriesIdempotencyKey(bookingId, clientRequestId) {
  return `${SPLIT_RECURRENCE_SERIES_IDEMPOTENCY_KEY_PREFIX}:${bookingId}:${clientRequestId}`;
}

// ─────────────────────────────────────────────────────────────────────
// Supabase admin singleton — used for command_operations assertions,
// booking_slots / audit_events introspection, and fixture cleanup.
// Lifted to module-level so probes can share one client. Matches
// smoke-tickets.mjs:113-120 pattern.
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
// `session_replication_role='replica'` mirrors the concurrency-test
// approach (`apps/api/test/concurrency/edit_booking_scope.spec.ts:172`).
// ─────────────────────────────────────────────────────────────────────

function runPsql(sql) {
  const dbPass = env.SUPABASE_DB_PASS;
  if (!dbPass) {
    throw new Error(
      'smoke-edit-booking-scope: SUPABASE_DB_PASS missing from .env — cannot seed fixture without it',
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

// ─────────────────────────────────────────────────────────────────────
// Fixture: recurrence_series + N booking + slot occurrences. Mirrors
// edit_booking_scope.spec.ts:97-159 but anchored at TENANT_ID +
// THOMAS_PERSON + ROOM_HUDDLE so existing tenant graph applies.
//
// Series anchor is ~90 days in the future so the bookings don't clash
// with seed data on the same rooms. Each occurrence is 1 hour, 7 days
// apart. The pivot (index 2) is exactly 21 days after the anchor.
// ─────────────────────────────────────────────────────────────────────

function seedRecurringFixture() {
  const seriesId = crypto.randomUUID();
  const occurrences = [];
  const baseAnchor = new Date(Date.now() + 90 * 86400_000);
  baseAnchor.setUTCMinutes(0, 0, 0);
  baseAnchor.setUTCHours(10);
  const baseStartMs = baseAnchor.getTime();
  const seriesEnd = new Date(baseStartMs + RECURRENCE_COUNT * 7 * 86400_000).toISOString();

  // Pre-compute all occurrence rows so we can interpolate them in one
  // SQL string (psql -c takes a single statement-or-block; we wrap in
  // a DO block to keep it atomic).
  const valuesBookings = [];
  const valuesSlots = [];
  for (let i = 0; i < RECURRENCE_COUNT; i++) {
    const bookingId = crypto.randomUUID();
    const slotId = crypto.randomUUID();
    const startMs = baseStartMs + i * 7 * 86400_000;
    const endMs = startMs + 60 * 60_000;
    const startAt = new Date(startMs).toISOString();
    const endAt = new Date(endMs).toISOString();
    occurrences.push({ bookingId, slotId, startAt, endAt, index: i });
    valuesBookings.push(
      `('${bookingId}'::uuid, '${TENANT_ID}'::uuid, 'Smoke edit-scope series', '${THOMAS_PERSON}'::uuid, '${ROOM_HUDDLE}'::uuid, '${startAt}'::timestamptz, '${endAt}'::timestamptz, 'UTC', 'confirmed', 'desk', 'smoke-etag-${bookingId.slice(0, 8)}', 100.00, '{}'::jsonb, '{}'::uuid[], '${seriesId}'::uuid, ${i})`,
    );
    valuesSlots.push(
      `('${slotId}'::uuid, '${TENANT_ID}'::uuid, '${bookingId}'::uuid, 'room', '${ROOM_HUDDLE}'::uuid, '${startAt}'::timestamptz, '${endAt}'::timestamptz, 'confirmed', 0)`,
    );
  }

  const sql = `
    set session_replication_role = 'replica';
    insert into public.recurrence_series
      (id, tenant_id, recurrence_rule, series_start_at, materialized_through)
    values
      ('${seriesId}'::uuid, '${TENANT_ID}'::uuid,
       jsonb_build_object('frequency', 'weekly', 'interval', 1, 'count', ${RECURRENCE_COUNT}),
       '${new Date(baseStartMs).toISOString()}'::timestamptz,
       '${seriesEnd}'::timestamptz);
    insert into public.bookings
      (id, tenant_id, title, requester_person_id, location_id,
       start_at, end_at, timezone, status, source, calendar_etag,
       cost_amount_snapshot, policy_snapshot, applied_rule_ids,
       recurrence_series_id, recurrence_index)
    values ${valuesBookings.join(', ')};
    insert into public.booking_slots
      (id, tenant_id, booking_id, slot_type, space_id,
       start_at, end_at, status, display_order)
    values ${valuesSlots.join(', ')};
    set session_replication_role = 'origin';
  `;
  runPsql(sql);
  return { seriesId, occurrences };
}

// ─────────────────────────────────────────────────────────────────────
// B.4.A.5 sub-step H approval-flip fixture — 3-occurrence series at
// +200d on ROOM_HUDDLE + a one-shot room_booking_rule scoped to
// ROOM_TEAM that requires Noor's approval. Each occurrence is 1h, so
// none of the seeded tenant-wide rules (off-hours / long-bookings)
// fires on the source state. The probe PATCHes scope='series'
// space_id=ROOM_TEAM, which triggers the test rule on each occurrence
// and asserts the 200 + 3 approvals + 3 inbox rows + 3 outbox rows
// tuple — locks in the gate-lift end-to-end through the editScope
// per-occurrence loop.
//
// The test rule uses a tautology predicate `{op:eq,left:1,right:1}`
// (always-fires) + target_scope='room' + target_id=ROOM_TEAM so it
// only matches bookings ON the target room. Rule versions cascade on
// rule delete (00121:42-50).
// ─────────────────────────────────────────────────────────────────────

function seedFlipFixture(testRuleId) {
  const seriesId = crypto.randomUUID();
  const occurrences = [];
  const baseAnchor = new Date(Date.now() + FLIP_DAYS_FROM_NOW * 86400_000);
  baseAnchor.setUTCMinutes(0, 0, 0);
  baseAnchor.setUTCHours(14);
  const baseStartMs = baseAnchor.getTime();
  const seriesEnd = new Date(baseStartMs + FLIP_RECURRENCE_COUNT * 7 * 86400_000).toISOString();

  const valuesBookings = [];
  const valuesSlots = [];
  for (let i = 0; i < FLIP_RECURRENCE_COUNT; i++) {
    const bookingId = crypto.randomUUID();
    const slotId = crypto.randomUUID();
    const startMs = baseStartMs + i * 7 * 86400_000;
    const endMs = startMs + 60 * 60_000;
    const startAt = new Date(startMs).toISOString();
    const endAt = new Date(endMs).toISOString();
    occurrences.push({ bookingId, slotId, startAt, endAt, index: i });
    valuesBookings.push(
      `('${bookingId}'::uuid, '${TENANT_ID}'::uuid, 'Smoke edit-scope flip series', '${THOMAS_PERSON}'::uuid, '${ROOM_HUDDLE}'::uuid, '${startAt}'::timestamptz, '${endAt}'::timestamptz, 'UTC', 'confirmed', 'desk', 'smoke-flip-etag-${bookingId.slice(0, 8)}', 100.00, '{}'::jsonb, '{}'::uuid[], '${seriesId}'::uuid, ${i})`,
    );
    valuesSlots.push(
      `('${slotId}'::uuid, '${TENANT_ID}'::uuid, '${bookingId}'::uuid, 'room', '${ROOM_HUDDLE}'::uuid, '${startAt}'::timestamptz, '${endAt}'::timestamptz, 'confirmed', 0)`,
    );
  }

  const sql = `
    set session_replication_role = 'replica';
    -- One-shot test rule: any booking on ROOM_TEAM requires Noor's approval.
    insert into public.room_booking_rules
      (id, tenant_id, name, description, target_scope, target_id,
       applies_when, effect, approval_config, priority, active)
    values
      ('${testRuleId}'::uuid, '${TENANT_ID}'::uuid,
       'Smoke flip — ROOM_TEAM needs Noor', 'B.4.A.5 sub-step H smoke; rule deleted post-run.',
       'room', '${ROOM_TEAM}'::uuid,
       '{"op":"eq","left":1,"right":1}'::jsonb,
       'require_approval',
       '{"required_approvers":[{"type":"person","id":"${NOOR_PERSON}"}],"threshold":"any"}'::jsonb,
       50, true);
    insert into public.recurrence_series
      (id, tenant_id, recurrence_rule, series_start_at, materialized_through)
    values
      ('${seriesId}'::uuid, '${TENANT_ID}'::uuid,
       jsonb_build_object('frequency', 'weekly', 'interval', 1, 'count', ${FLIP_RECURRENCE_COUNT}),
       '${new Date(baseStartMs).toISOString()}'::timestamptz,
       '${seriesEnd}'::timestamptz);
    insert into public.bookings
      (id, tenant_id, title, requester_person_id, location_id,
       start_at, end_at, timezone, status, source, calendar_etag,
       cost_amount_snapshot, policy_snapshot, applied_rule_ids,
       recurrence_series_id, recurrence_index)
    values ${valuesBookings.join(', ')};
    insert into public.booking_slots
      (id, tenant_id, booking_id, slot_type, space_id,
       start_at, end_at, status, display_order)
    values ${valuesSlots.join(', ')};
    set session_replication_role = 'origin';
  `;
  runPsql(sql);
  return { seriesId, occurrences };
}

async function deleteFlipFixture(seriesId, testRuleId) {
  const sql = `
    set session_replication_role = 'replica';
    delete from public.audit_events
      where tenant_id = '${TENANT_ID}'::uuid
        and entity_type = 'booking'
        and entity_id in (select id from public.bookings where recurrence_series_id = '${seriesId}'::uuid);
    delete from public.domain_events
      where tenant_id = '${TENANT_ID}'::uuid
        and entity_type = 'booking'
        and entity_id in (select id from public.bookings where recurrence_series_id = '${seriesId}'::uuid);
    delete from outbox.events
      where tenant_id = '${TENANT_ID}'::uuid
        and aggregate_id in (select id from public.bookings where recurrence_series_id = '${seriesId}'::uuid);
    delete from public.approvals
      where tenant_id = '${TENANT_ID}'::uuid
        and target_entity_type = 'booking'
        and target_entity_id in (select id from public.bookings where recurrence_series_id = '${seriesId}'::uuid);
    delete from public.inbox_notifications
      where tenant_id = '${TENANT_ID}'::uuid
        and event_kind = 'booking.approval_required'
        and (payload->>'booking_id')::uuid in (select id from public.bookings where recurrence_series_id = '${seriesId}'::uuid);
    delete from public.booking_slots
      where booking_id in (select id from public.bookings where recurrence_series_id = '${seriesId}'::uuid);
    delete from public.bookings where recurrence_series_id = '${seriesId}'::uuid;
    delete from public.recurrence_series where id = '${seriesId}'::uuid;
    delete from public.room_booking_rules where id = '${testRuleId}'::uuid;
    set session_replication_role = 'origin';
  `;
  try {
    runPsql(sql);
  } catch (e) {
    console.log(`  ! flip fixture cleanup warn: ${e.message.slice(0, 200)}`);
  }
}

async function deleteFixture(seriesId) {
  // LIFO order: child rows first, then the series itself. We also
  // sweep any command_operations rows the smoke wrote — both the
  // direct edit-scope rows AND any outbox/audit fan-out keyed on
  // booking ids. Best-effort: log + continue on individual failures.
  const sql = `
    set session_replication_role = 'replica';
    -- Booking-audit Slice 4 — scope the booking-fan-out sweeps to the
    -- FULL fixture set (original series OR title), so split-child
    -- bookings' audit/domain/outbox/approval rows don't accumulate on
    -- the shared remote. Tenant-scoped (#0 invariant).
    delete from public.audit_events
      where tenant_id = '${TENANT_ID}'::uuid
        and entity_type = 'booking'
        and entity_id in (select id from public.bookings
                           where tenant_id = '${TENANT_ID}'::uuid
                             and (recurrence_series_id = '${seriesId}'::uuid
                                  or title = 'Smoke edit-scope series'));
    delete from public.domain_events
      where tenant_id = '${TENANT_ID}'::uuid
        and entity_type = 'booking'
        and entity_id in (select id from public.bookings
                           where tenant_id = '${TENANT_ID}'::uuid
                             and (recurrence_series_id = '${seriesId}'::uuid
                                  or title = 'Smoke edit-scope series'));
    delete from outbox.events
      where tenant_id = '${TENANT_ID}'::uuid
        and aggregate_id in (select id from public.bookings
                              where tenant_id = '${TENANT_ID}'::uuid
                                and (recurrence_series_id = '${seriesId}'::uuid
                                     or title = 'Smoke edit-scope series'));
    delete from public.approvals
      where tenant_id = '${TENANT_ID}'::uuid
        and target_entity_type = 'booking'
        and target_entity_id in (select id from public.bookings
                                  where tenant_id = '${TENANT_ID}'::uuid
                                    and (recurrence_series_id = '${seriesId}'::uuid
                                         or title = 'Smoke edit-scope series'));
    -- Booking-audit Slice 4 — the split RPC writes an in-tx
    -- booking.recurrence_split audit_events row with
    -- entity_type='recurrence_series' (entity_id = source series id).
    -- The entity_type='booking' delete above misses it; sweep it here.
    delete from public.audit_events
      where tenant_id = '${TENANT_ID}'::uuid
        and entity_type = 'recurrence_series'
        and event_type = 'booking.recurrence_split'
        and entity_id = '${seriesId}'::uuid;
    delete from public.command_operations
      where tenant_id = '${TENANT_ID}'::uuid
        and idempotency_key like 'booking:edit:scope:%';
    -- Booking-audit Slice 4 — sweep the split RPC's own
    -- command_operations rows (00411 key prefix). The edit-scope sweep
    -- above does not match this prefix.
    delete from public.command_operations
      where tenant_id = '${TENANT_ID}'::uuid
        and idempotency_key like 'booking:recurrence:split:%';
    -- Booking-audit Slice 4 FIX: after a 'this_and_following' commit the
    -- split RPC moves the forward bookings to a NEW recurrence_series.
    -- The pre-fix slot-delete was keyed ONLY on the ORIGINAL seriesId,
    -- so split-child bookings' slots were NOT deleted here; then the
    -- title-scoped booking delete below removed the parent bookings,
    -- ORPHANING those slots permanently — a GiST landmine on ROOM_BOARD
    -- at the fixture window that made every SUBSEQUENT run's TAF commit
    -- 409 with booking.slot_conflict. Delete slots for the FULL fixture
    -- booking set (original-series OR title-scoped, which catches the
    -- split-children that retain the title) BEFORE deleting the
    -- bookings. Tenant-scoped (#0 invariant).
    delete from public.booking_slots
      where booking_id in (
        select id from public.bookings
         where tenant_id = '${TENANT_ID}'::uuid
           and (recurrence_series_id = '${seriesId}'::uuid
                or title = 'Smoke edit-scope series'));
    -- Sweep the original-series bookings + the post-split children
    -- (forward occurrences moved to a new series id but keep the title).
    delete from public.bookings where recurrence_series_id = '${seriesId}'::uuid;
    delete from public.bookings
      where tenant_id = '${TENANT_ID}'::uuid
        and title = 'Smoke edit-scope series';
    delete from public.recurrence_series
      where tenant_id = '${TENANT_ID}'::uuid
        and (id = '${seriesId}'::uuid
             or id not in (select recurrence_series_id from public.bookings where recurrence_series_id is not null));
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
// Mirrors smoke-tickets.mjs:186-206.
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
// Probe runner — same shape as smoke-tickets.mjs:214-257.
// ─────────────────────────────────────────────────────────────────────

const results = { pass: 0, fail: 0, failed: [] };

function makeProber(headers) {
  return async function probe(name, options) {
    const {
      method = 'POST',
      url,
      body,
      // Expect can be 'success' | 'badrequest' (400) | 'conflict' (409)
      // | 'forbidden' (403) | 'unprocessable' (422) | 'notfound' (404).
      expect = 'success',
      clientRequestId,
      omitClientRequestId = false,
      rawBody = false,
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
      body: body !== undefined ? (rawBody ? body : JSON.stringify(body)) : undefined,
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

// ─────────────────────────────────────────────────────────────────────
// DB-level introspection helpers — used to verify the RPC actually
// wrote (or didn't write, on dry-run) at the row level.
// ─────────────────────────────────────────────────────────────────────

async function readSlotsForSeries(seriesId) {
  // Pull all slots whose booking belongs to ANY booking with the given
  // recurrence_series_id. Returns one row per slot. The smoke uses this
  // to verify space_id moves (or doesn't move on dry-run).
  const { data, error } = await supa()
    .from('booking_slots')
    .select('id, booking_id, space_id, start_at, end_at')
    .in(
      'booking_id',
      // Sub-query: bookings.id in this series. supabase-js doesn't
      // support sub-selects, so fetch in two passes.
      (
        await supa()
          .from('bookings')
          .select('id')
          .eq('tenant_id', TENANT_ID)
          .eq('recurrence_series_id', seriesId)
      ).data?.map((b) => b.id) ?? [],
    )
    .order('start_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

async function readBookingsForSeries(seriesId) {
  const { data, error } = await supa()
    .from('bookings')
    .select('id, recurrence_series_id, recurrence_index, start_at')
    .eq('tenant_id', TENANT_ID)
    .eq('recurrence_series_id', seriesId)
    .order('recurrence_index', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

async function readBookingsByIds(bookingIds) {
  if (bookingIds.length === 0) return [];
  const { data, error } = await supa()
    .from('bookings')
    .select('id, recurrence_series_id, recurrence_index')
    .eq('tenant_id', TENANT_ID)
    .in('id', bookingIds);
  if (error) throw error;
  return data ?? [];
}

async function countAuditEventsForBookings(bookingIds) {
  if (bookingIds.length === 0) return 0;
  const { count, error } = await supa()
    .from('audit_events')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', TENANT_ID)
    .eq('entity_type', 'booking')
    .in('entity_id', bookingIds);
  if (error) throw error;
  return count ?? 0;
}

async function countCommandOpsForPivot(pivotBookingId, crid) {
  const key = buildEditBookingIdempotencyKey('scope', pivotBookingId, crid);
  const { count, error } = await supa()
    .from('command_operations')
    // command_operations is keyed on (tenant_id, idempotency_key) and
    // has NO `id` column (00316 schema: tenant_id, idempotency_key,
    // payload_hash, outcome, cached_result, enqueued_at, completed_at).
    // Selecting a non-existent column makes PostgREST 400 with an empty
    // message and aborts the whole smoke. Count over a real column.
    .select('idempotency_key', { count: 'exact', head: true })
    .eq('tenant_id', TENANT_ID)
    .eq('idempotency_key', key);
  if (error) throw error;
  return count ?? 0;
}

// Booking-audit Slice 4 — count command_operations rows under the SPLIT
// idempotency key (00411). Tenant-scoped (#0 invariant). On a successful
// split there is exactly 1 row; a retry of the same editScope must NOT
// mint a second (the RPC's command_operations gate cache-hits).
async function countCommandOpsForSplitKey(pivotBookingId, crid) {
  const key = buildSplitSeriesIdempotencyKey(pivotBookingId, crid);
  const { data, error } = await supa()
    .from('command_operations')
    // No `id` column (see countCommandOpsForPivot note) — select the
    // real key + outcome.
    .select('idempotency_key, outcome')
    .eq('tenant_id', TENANT_ID)
    .eq('idempotency_key', key);
  if (error) throw error;
  return data ?? [];
}

// Booking-audit Slice 4 — count recurrence_series rows that point at a
// given pivot booking (parent_booking_id). After an atomic split there
// is EXACTLY 1 (the new series the RPC minted, anchored at the pivot).
// A non-idempotent retry would mint a SECOND orphan series here — the
// core P1-2 regression this probe defends. Tenant-scoped (#0 invariant).
async function countRecurrenceSeriesForPivot(pivotBookingId) {
  const { count, error } = await supa()
    .from('recurrence_series')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', TENANT_ID)
    .eq('parent_booking_id', pivotBookingId);
  if (error) throw error;
  return count ?? 0;
}

// Booking-audit Slice 4 — total recurrence_series rows reachable from a
// fixture (the source series row + any split-children pointing at any of
// the fixture's bookings). Used to assert "exactly 1 NEW series minted,
// no orphans" by comparing a before/after delta across a retry.
// Tenant-scoped (#0 invariant).
async function countRecurrenceSeriesForFixture(sourceSeriesId, bookingIds) {
  // Source series row.
  const src = await supa()
    .from('recurrence_series')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', TENANT_ID)
    .eq('id', sourceSeriesId);
  if (src.error) throw src.error;
  // Any series whose parent_booking_id is one of the fixture bookings
  // (the split-children — there should be exactly 1 after a split).
  const children = await supa()
    .from('recurrence_series')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', TENANT_ID)
    .in('parent_booking_id', bookingIds);
  if (children.error) throw children.error;
  return (src.count ?? 0) + (children.count ?? 0);
}

// ─────────────────────────────────────────────────────────────────────
// Probes
// ─────────────────────────────────────────────────────────────────────

async function runScopeProbes(headers, probe, fixture) {
  console.log('\n=== edit_booking_scope probes ===');

  const pivot = fixture.occurrences[PIVOT_INDEX];
  const allBookingIds = fixture.occurrences.map((o) => o.bookingId);
  const forwardBookingIds = fixture.occurrences
    .slice(PIVOT_INDEX)
    .map((o) => o.bookingId);
  const backwardBookingIds = fixture.occurrences
    .slice(0, PIVOT_INDEX)
    .map((o) => o.bookingId);

  // ────────────────────────────────────────────────────────────────
  // Scenario 1 — Setup verification.
  // The fixture has been seeded. Verify all 5 slots exist on the
  // original room before we touch anything.
  // ────────────────────────────────────────────────────────────────
  const initialSlots = await readSlotsForSeries(fixture.seriesId);
  if (initialSlots.length === RECURRENCE_COUNT) {
    results.pass += 1;
    console.log(`  ✓ Setup: ${RECURRENCE_COUNT} slots seeded on series ${fixture.seriesId.slice(0, 8)}…`);
  } else {
    results.fail += 1;
    results.failed.push('Setup: slot count');
    console.log(`  ✗ Setup: expected ${RECURRENCE_COUNT} slots, got ${initialSlots.length}`);
    return;
  }
  if (initialSlots.every((s) => s.space_id === ROOM_HUDDLE)) {
    results.pass += 1;
    console.log(`  ✓ Setup: all slots on ROOM_HUDDLE`);
  } else {
    results.fail += 1;
    results.failed.push('Setup: slot rooms');
    console.log(`  ✗ Setup: slots not uniformly on ROOM_HUDDLE`);
  }

  // ────────────────────────────────────────────────────────────────
  // Scenario 2 — Dry-run scope='series', space_id=ROOM_TEAM.
  // - HTTP 200, would_succeed=true, per_occurrence has 5 entries.
  // - NO writes (booking_slots.space_id unchanged for all 5).
  // - NO command_operations row written (00371 v2 dry-run contract).
  // ────────────────────────────────────────────────────────────────
  const dryRunSeriesUrl = `${API_BASE}/api/reservations/${pivot.bookingId}/edit-scope`;
  const dryRunSeriesResult = await probe('Series dry-run: 5 occurrences previewed', {
    url: dryRunSeriesUrl,
    body: { scope: 'series', space_id: ROOM_TEAM, dry_run: true },
  });
  if (dryRunSeriesResult.ok) {
    const parsed = JSON.parse(dryRunSeriesResult.body);
    if (parsed.would_succeed === true && Array.isArray(parsed.per_occurrence) && parsed.per_occurrence.length === RECURRENCE_COUNT) {
      results.pass += 1;
      console.log(`  ✓ Series dry-run: would_succeed=true + ${parsed.per_occurrence.length} per_occurrence`);
    } else {
      results.fail += 1;
      results.failed.push('Series dry-run: shape');
      console.log(`  ✗ Series dry-run: shape unexpected — would_succeed=${parsed.would_succeed} per_occurrence.length=${parsed.per_occurrence?.length}`);
    }
    // Verify no rows were touched (space_id unchanged).
    const afterDry = await readSlotsForSeries(fixture.seriesId);
    if (afterDry.every((s) => s.space_id === ROOM_HUDDLE)) {
      results.pass += 1;
      console.log(`  ✓ Series dry-run: no slot rooms changed`);
    } else {
      results.fail += 1;
      results.failed.push('Series dry-run: slot mutated');
      console.log(`  ✗ Series dry-run: at least one slot.space_id changed`);
    }
    // Verify no command_operations row (00371 v2 stateless dry-run).
    const opCount = await countCommandOpsForPivot(pivot.bookingId, dryRunSeriesResult.xClientRequestId);
    if (opCount === 0) {
      results.pass += 1;
      console.log(`  ✓ Series dry-run: no command_operations row (stateless preview)`);
    } else {
      results.fail += 1;
      results.failed.push('Series dry-run: command_operations row leaked');
      console.log(`  ✗ Series dry-run: ${opCount} command_operations row(s) for the dry-run crid`);
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Scenario 3 — Commit scope='series', same target.
  // - HTTP 200, committed=5.
  // - All 5 slots' space_id now == ROOM_TEAM.
  // - 5 audit_events rows written for the bookings.
  // - Exactly ONE command_operations row.
  // ────────────────────────────────────────────────────────────────
  const commitSeriesCrid = crypto.randomUUID();
  const commitSeriesBody = { scope: 'series', space_id: ROOM_TEAM };
  const auditCountBefore = await countAuditEventsForBookings(allBookingIds);
  const commitSeriesResult = await probe('Series commit: 5 occurrences moved to ROOM_TEAM', {
    url: dryRunSeriesUrl,
    body: commitSeriesBody,
    clientRequestId: commitSeriesCrid,
  });
  if (commitSeriesResult.ok) {
    const parsed = JSON.parse(commitSeriesResult.body);
    if (parsed.committed === RECURRENCE_COUNT) {
      results.pass += 1;
      console.log(`  ✓ Series commit: committed=${RECURRENCE_COUNT}`);
    } else {
      results.fail += 1;
      results.failed.push('Series commit: committed count');
      console.log(`  ✗ Series commit: committed=${parsed.committed} (expected ${RECURRENCE_COUNT})`);
    }
    const afterCommit = await readSlotsForSeries(fixture.seriesId);
    if (afterCommit.every((s) => s.space_id === ROOM_TEAM)) {
      results.pass += 1;
      console.log(`  ✓ Series commit: all slots moved to ROOM_TEAM`);
    } else {
      results.fail += 1;
      results.failed.push('Series commit: slots not all moved');
      const stillOnHuddle = afterCommit.filter((s) => s.space_id === ROOM_HUDDLE).length;
      console.log(`  ✗ Series commit: ${stillOnHuddle} slot(s) still on ROOM_HUDDLE`);
    }
    const auditCountAfter = await countAuditEventsForBookings(allBookingIds);
    if (auditCountAfter - auditCountBefore >= RECURRENCE_COUNT) {
      results.pass += 1;
      console.log(`  ✓ Series commit: ${auditCountAfter - auditCountBefore} audit_events rows written`);
    } else {
      results.fail += 1;
      results.failed.push('Series commit: audit_events under-count');
      console.log(`  ✗ Series commit: audit_events delta=${auditCountAfter - auditCountBefore}, expected ≥${RECURRENCE_COUNT}`);
    }
    const opCount = await countCommandOpsForPivot(pivot.bookingId, commitSeriesCrid);
    if (opCount === 1) {
      results.pass += 1;
      console.log(`  ✓ Series commit: exactly 1 command_operations row`);
    } else {
      results.fail += 1;
      results.failed.push('Series commit: command_operations row count');
      console.log(`  ✗ Series commit: ${opCount} command_operations row(s) (expected 1)`);
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Scenario 4 — Idempotency replay (commit) with same crid + body.
  // - HTTP 200, body byte-identical to first commit's body.
  // - No NEW audit_events rows.
  // - command_operations row count still 1.
  // ────────────────────────────────────────────────────────────────
  const auditCountPreReplay = await countAuditEventsForBookings(allBookingIds);
  const replayResult = await probe('Series commit replay: cached response, no new writes', {
    url: dryRunSeriesUrl,
    body: commitSeriesBody,
    clientRequestId: commitSeriesCrid,
  });
  if (replayResult.ok) {
    if (replayResult.body === commitSeriesResult.body) {
      results.pass += 1;
      console.log(`  ✓ Series replay: response body byte-identical (cached_result hit)`);
    } else {
      results.fail += 1;
      results.failed.push('Series replay: body mismatch');
      console.log(`  ✗ Series replay: response bodies differ — RPC re-executed?`);
    }
    const auditCountAfterReplay = await countAuditEventsForBookings(allBookingIds);
    if (auditCountAfterReplay === auditCountPreReplay) {
      results.pass += 1;
      console.log(`  ✓ Series replay: no new audit_events rows (idempotent)`);
    } else {
      results.fail += 1;
      results.failed.push('Series replay: audit_events leaked');
      console.log(`  ✗ Series replay: audit_events delta=${auditCountAfterReplay - auditCountPreReplay} (expected 0)`);
    }
    const opCount = await countCommandOpsForPivot(pivot.bookingId, commitSeriesCrid);
    if (opCount === 1) {
      results.pass += 1;
      console.log(`  ✓ Series replay: command_operations row count unchanged (1)`);
    } else {
      results.fail += 1;
      results.failed.push('Series replay: extra command_operations row');
      console.log(`  ✗ Series replay: ${opCount} command_operations row(s) (expected 1)`);
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Scenario 5 — Payload mismatch on retry (same crid, different body).
  // - HTTP 409 conflict with code command_operations.payload_mismatch.
  // - No additional writes.
  // ────────────────────────────────────────────────────────────────
  const auditCountPreMismatch = await countAuditEventsForBookings(allBookingIds);
  const mismatchResult = await probe('Series replay with DIFFERENT body → 409 payload_mismatch', {
    url: dryRunSeriesUrl,
    body: { scope: 'series', space_id: ROOM_BOARD }, // differs from commitSeriesBody
    clientRequestId: commitSeriesCrid,
    expect: 'conflict',
  });
  if (mismatchResult.ok) {
    try {
      const parsed = JSON.parse(mismatchResult.body);
      if (parsed.code === 'command_operations.payload_mismatch') {
        results.pass += 1;
        console.log(`  ✓ Series payload-mismatch: code=command_operations.payload_mismatch`);
      } else {
        results.fail += 1;
        results.failed.push('Series payload-mismatch: wrong code');
        console.log(`  ✗ Series payload-mismatch: code=${parsed.code}`);
      }
    } catch {
      results.fail += 1;
      results.failed.push('Series payload-mismatch: body parse');
    }
    const auditCountAfterMismatch = await countAuditEventsForBookings(allBookingIds);
    if (auditCountAfterMismatch === auditCountPreMismatch) {
      results.pass += 1;
      console.log(`  ✓ Series payload-mismatch: no new writes`);
    } else {
      results.fail += 1;
      results.failed.push('Series payload-mismatch: writes leaked');
      console.log(`  ✗ Series payload-mismatch: audit delta=${auditCountAfterMismatch - auditCountPreMismatch}`);
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Scenario 6 — Dry-run scope='this_and_following' (pivot at index 2).
  // - HTTP 200, would_succeed=true.
  // - per_occurrence has only FORWARD occurrences (3 of 5).
  // - splitSeries did NOT fire (verify the original recurrence_series_id
  //   is unchanged on all 5 bookings).
  // ────────────────────────────────────────────────────────────────
  // Re-read current series state — after the series commit + replay,
  // all bookings still belong to fixture.seriesId. Verify before the
  // this_and_following dry-run.
  const bookingsBeforeTAF = await readBookingsByIds(allBookingIds);
  const allOnOriginalSeries = bookingsBeforeTAF.every(
    (b) => b.recurrence_series_id === fixture.seriesId,
  );
  if (allOnOriginalSeries) {
    results.pass += 1;
    console.log(`  ✓ Pre-TAF: all 5 bookings still on original series`);
  } else {
    results.fail += 1;
    results.failed.push('Pre-TAF: series id drift');
    console.log(`  ✗ Pre-TAF: some bookings on a different series already`);
  }

  const tafDryRunResult = await probe(
    "this_and_following dry-run: 3 forward occurrences previewed",
    {
      url: dryRunSeriesUrl,
      body: { scope: 'this_and_following', space_id: ROOM_BOARD, dry_run: true },
    },
  );
  if (tafDryRunResult.ok) {
    const parsed = JSON.parse(tafDryRunResult.body);
    const expectedForward = RECURRENCE_COUNT - PIVOT_INDEX;
    if (
      parsed.would_succeed === true &&
      Array.isArray(parsed.per_occurrence) &&
      parsed.per_occurrence.length === expectedForward
    ) {
      results.pass += 1;
      console.log(`  ✓ TAF dry-run: would_succeed=true + ${parsed.per_occurrence.length} forward per_occurrence`);
    } else {
      results.fail += 1;
      results.failed.push('TAF dry-run: forward count');
      console.log(`  ✗ TAF dry-run: per_occurrence.length=${parsed.per_occurrence?.length} (expected ${expectedForward})`);
    }
    // splitSeries did NOT fire on dry-run: all 5 bookings still
    // anchored to the original series.
    const bookingsAfterDry = await readBookingsByIds(allBookingIds);
    const stillOnOriginal = bookingsAfterDry.every(
      (b) => b.recurrence_series_id === fixture.seriesId,
    );
    if (stillOnOriginal) {
      results.pass += 1;
      console.log(`  ✓ TAF dry-run: splitSeries did NOT fire (all bookings still on original series)`);
    } else {
      results.fail += 1;
      results.failed.push('TAF dry-run: splitSeries leaked');
      console.log(`  ✗ TAF dry-run: at least one booking moved off original series — splitSeries leaked`);
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Scenario 7 — Commit scope='this_and_following'.
  // - HTTP 200 with new_series_id present, committed=3.
  // - The forward occurrences (indexes 2,3,4) now have a new
  //   recurrence_series_id == new_series_id.
  // - The new_series_id IS the pivot's new recurrence_series_id.
  // - Backward occurrences (indexes 0,1) still have the original
  //   recurrence_series_id.
  // ────────────────────────────────────────────────────────────────
  const tafCommitCrid = crypto.randomUUID();
  const tafCommitResult = await probe(
    "this_and_following commit: 3 forward occurrences split + moved",
    {
      url: dryRunSeriesUrl,
      body: { scope: 'this_and_following', space_id: ROOM_BOARD },
      clientRequestId: tafCommitCrid,
    },
  );
  let newSeriesId = null;
  if (tafCommitResult.ok) {
    const parsed = JSON.parse(tafCommitResult.body);
    const expectedForward = RECURRENCE_COUNT - PIVOT_INDEX;
    if (parsed.committed === expectedForward && typeof parsed.new_series_id === 'string') {
      results.pass += 1;
      console.log(`  ✓ TAF commit: committed=${expectedForward} + new_series_id minted`);
      newSeriesId = parsed.new_series_id;
    } else {
      results.fail += 1;
      results.failed.push('TAF commit: shape');
      console.log(`  ✗ TAF commit: committed=${parsed.committed} new_series_id=${parsed.new_series_id}`);
    }
    if (newSeriesId) {
      const forwardBookings = await readBookingsByIds(forwardBookingIds);
      const allForwardOnNew = forwardBookings.every(
        (b) => b.recurrence_series_id === newSeriesId,
      );
      if (allForwardOnNew) {
        results.pass += 1;
        console.log(`  ✓ TAF commit: forward bookings (${forwardBookingIds.length}) all on new series`);
      } else {
        results.fail += 1;
        results.failed.push('TAF commit: forward bookings split mismatch');
        console.log(`  ✗ TAF commit: forward booking series ids drifted from new_series_id`);
      }
      const backwardBookings = await readBookingsByIds(backwardBookingIds);
      const allBackwardOnOriginal = backwardBookings.every(
        (b) => b.recurrence_series_id === fixture.seriesId,
      );
      if (allBackwardOnOriginal) {
        results.pass += 1;
        console.log(`  ✓ TAF commit: backward bookings still on original series`);
      } else {
        results.fail += 1;
        results.failed.push('TAF commit: backward bookings drifted');
        console.log(`  ✗ TAF commit: backward bookings unexpectedly moved off original series`);
      }
      // Verify forward slots ARE on ROOM_BOARD.
      const allSlots = await supa()
        .from('booking_slots')
        .select('booking_id, space_id')
        .in('booking_id', forwardBookingIds);
      if ((allSlots.data ?? []).every((s) => s.space_id === ROOM_BOARD)) {
        results.pass += 1;
        console.log(`  ✓ TAF commit: forward slots moved to ROOM_BOARD`);
      } else {
        results.fail += 1;
        results.failed.push('TAF commit: forward slots not on ROOM_BOARD');
        console.log(`  ✗ TAF commit: at least one forward slot did NOT move to ROOM_BOARD`);
      }
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Scenario 7b — Booking-audit Slice 4 (audit 03 P1-2):
  //   split_recurrence_series RPC (00411) is ATOMIC + IDEMPOTENT.
  //
  // Scenario 7 already committed a `this_and_following` split: the
  // forward occurrences moved to `newSeriesId`, the source series was
  // capped, exactly 1 new recurrence_series row was minted. These
  // probes PROVE the regression the audit flagged is closed:
  //
  //   (i)  exactly 1 recurrence_series row points at the pivot
  //        (parent_booking_id = pivot) — no orphan from the legacy
  //        3-write race.
  //   (ii) the split's OWN command_operations row exists with
  //        outcome=success (the RPC's idempotency gate fired).
  //   (iii) RETRY the SAME editScope (same crid, same body) — it
  //        returns the SAME new_series_id, no SECOND/orphan
  //        recurrence_series row is minted (the core P1-2 fix: the
  //        legacy non-idempotent splitSeries minted a fresh orphan
  //        series on every retry; the brittle TS skipSplitSeries hack
  //        is gone — the RPC's command_operations gate now dedups).
  //   (iv) the split command_operations row count stays 1 after the
  //        retry (cache-hit, not a re-execute).
  //
  // pivot.bookingId IS forwardBookingIds[0] (PIVOT_INDEX occurrence).
  // newSeriesId was captured by scenario 7.
  // ────────────────────────────────────────────────────────────────
  if (newSeriesId) {
    // (i) Exactly 1 recurrence_series row anchored at the pivot.
    const seriesForPivot = await countRecurrenceSeriesForPivot(
      pivot.bookingId,
    );
    if (seriesForPivot === 1) {
      results.pass += 1;
      console.log(
        `  ✓ Slice4 split: exactly 1 recurrence_series row points at the pivot (no orphan)`,
      );
    } else {
      results.fail += 1;
      results.failed.push('Slice4 split: orphan/missing series for pivot');
      console.log(
        `  ✗ Slice4 split: ${seriesForPivot} recurrence_series rows point at the pivot (expected 1)`,
      );
    }

    // (ii) The split RPC's OWN command_operations row exists + success.
    const splitOpsAfterCommit = await countCommandOpsForSplitKey(
      pivot.bookingId,
      tafCommitCrid,
    );
    if (
      splitOpsAfterCommit.length === 1 &&
      splitOpsAfterCommit[0].outcome === 'success'
    ) {
      results.pass += 1;
      console.log(
        `  ✓ Slice4 split: 1 command_operations split row, outcome=success`,
      );
    } else {
      results.fail += 1;
      results.failed.push('Slice4 split: split command_operations row state');
      console.log(
        `  ✗ Slice4 split: ${splitOpsAfterCommit.length} split command_operations row(s), outcomes=${JSON.stringify(splitOpsAfterCommit.map((r) => r.outcome))} (expected 1 × success)`,
      );
    }

    // Snapshot the total recurrence_series footprint for this fixture
    // BEFORE the retry. A non-idempotent split would inflate this by 1
    // on the retry (a second orphan series).
    const seriesCountBeforeRetry = await countRecurrenceSeriesForFixture(
      fixture.seriesId,
      allBookingIds,
    );

    // (iii) RETRY the exact same editScope (same crid, same body).
    //
    // D-5 LIVE COMPLETENESS GATE (audit-03 Slice 2 — AUTHORITATIVE).
    // This probe is the authoritative live-DB completeness check for the
    // D-5 fix (migration 00428 + producer canonical-approver-sort): it
    // exercises a REAL same-intent `edit_booking_scope` COMMIT→RETRY
    // against the running server. The COMMIT's §3.6.5 reconciliation
    // mutates `approvals`; before the fix, the RETRY's producer re-read
    // the mutated live chain and flipped `approval.old_outcome` +
    // `approval.chain_config_changed`, so the re-assembled `p_plans`
    // hashed DIFFERENTLY → `command_operations.payload_mismatch` 409 and
    // the op was permanently lost. 00428 excludes those two pre-state
    // fields (plus `_resolution_at`) from the idempotency hash, so the
    // RETRY now hashes identically → the RPC's command_operations gate
    // CACHE-HITS and returns the original success body (the RPC still
    // reads the two fields from the UNSTRIPPED plan so §3.6.5
    // reconciliation is unaffected). This live gate is authoritative
    // OVER the modeled jest GUARD-3 (assemble-edit-plan.idempotency
    // .spec.ts) — the jest guard models the producer; this talks to the
    // real DB. Validated in the audit-03 batch push pass once 00428 is
    // on remote.
    //
    // `splitSeries` runs BEFORE the assembler, so on retry the split RPC
    // is invoked with the SAME (pivot, crid) → its OWN
    // command_operations gate cache-hits (the core P1-2 invariant,
    // asserted directly at the DB level below regardless of the
    // envelope outcome).
    const tafRetryResult = await probe(
      'Slice4 split: RETRY same editScope → cached success (D-5 fixed: idempotent replay, no payload_mismatch)',
      {
        url: dryRunSeriesUrl,
        body: { scope: 'this_and_following', space_id: ROOM_BOARD },
        clientRequestId: tafCommitCrid,
        expect: 'success',
      },
    );
    if (tafRetryResult.ok) {
      if (tafRetryResult.body === tafCommitResult.body) {
        results.pass += 1;
        console.log(
          `  ✓ Slice4 split retry: editScope cached success — body byte-identical (D-5 fixed; idempotent replay)`,
        );
      } else {
        results.fail += 1;
        results.failed.push('Slice4 split retry: D-5 cached-body mismatch');
        console.log(
          `  ✗ Slice4 split retry: editScope 200 but body differs from first commit — RPC re-executed (D-5 NOT idempotent)`,
        );
      }
    }

    // ── Split-level idempotency invariants (the actual P1-2 fix) ──
    // These hold REGARDLESS of the editScope envelope above, because
    // the split RPC fired (before the assembler) and is idempotent.

    // No SECOND series minted: total fixture series footprint
    // unchanged across the retry (the core P1-2 regression — the
    // legacy non-idempotent splitSeries minted a fresh orphan series
    // on every retry).
    const seriesCountAfterRetry = await countRecurrenceSeriesForFixture(
      fixture.seriesId,
      allBookingIds,
    );
    if (seriesCountAfterRetry === seriesCountBeforeRetry) {
      results.pass += 1;
      console.log(
        `  ✓ Slice4 split retry: recurrence_series count unchanged (${seriesCountAfterRetry}) — NO orphan series minted (P1-2 fixed)`,
      );
    } else {
      results.fail += 1;
      results.failed.push('Slice4 split retry: orphan series minted');
      console.log(
        `  ✗ Slice4 split retry: recurrence_series count ${seriesCountBeforeRetry} → ${seriesCountAfterRetry} (orphan series minted — P1-2 REGRESSION)`,
      );
    }

    // Still exactly 1 series anchored at the pivot after the retry.
    const seriesForPivotAfter = await countRecurrenceSeriesForPivot(
      pivot.bookingId,
    );
    if (seriesForPivotAfter === 1) {
      results.pass += 1;
      console.log(
        `  ✓ Slice4 split retry: still exactly 1 recurrence_series row points at the pivot (idempotent)`,
      );
    } else {
      results.fail += 1;
      results.failed.push('Slice4 split retry: pivot series count != 1');
      console.log(
        `  ✗ Slice4 split retry: ${seriesForPivotAfter} recurrence_series rows point at the pivot (expected 1)`,
      );
    }

    // (iv) split command_operations row count still exactly 1 with
    //      outcome=success (the split RPC's OWN gate cache-hit, not a
    //      re-execute — proves the split is idempotent end-to-end even
    //      though the surrounding editScope 409'd).
    const splitOpsAfterRetry = await countCommandOpsForSplitKey(
      pivot.bookingId,
      tafCommitCrid,
    );
    if (
      splitOpsAfterRetry.length === 1 &&
      splitOpsAfterRetry[0].outcome === 'success'
    ) {
      results.pass += 1;
      console.log(
        `  ✓ Slice4 split retry: split command_operations row count still 1 × success (RPC cache-hit)`,
      );
    } else {
      results.fail += 1;
      results.failed.push('Slice4 split retry: split command_operations row count');
      console.log(
        `  ✗ Slice4 split retry: ${splitOpsAfterRetry.length} split command_operations row(s) (expected 1 × success)`,
      );
    }

    // Residual note: a dedicated payload-mismatch probe ON THE SPLIT
    // KEY (same split crid, different pivot) is NOT added here — the
    // split crid is derived from (pivot.bookingId, editScope crid) and
    // the smoke harness drives the split only transitively via
    // editScope, so it cannot mint a same-split-key/different-pivot
    // request without a bespoke direct-RPC harness. The split RPC's
    // payload_mismatch path mirrors 00408's verbatim (codex-reviewed in
    // Slice 2) + is covered by the editScope payload-mismatch probe
    // (Scenario 5) which exercises the SAME command_operations gate
    // shape. Documented in
    // docs/follow-ups/slice4-split-recurrence-decision.md §Residuals.
  }

  // ────────────────────────────────────────────────────────────────
  // Scenario 8 — Reject scope='this' (wrong endpoint).
  // ────────────────────────────────────────────────────────────────
  // ReservationService.editScope raises AppErrors.validationFailed
  // ('wrong_endpoint', ...) — `validationFailed` maps to 400 per the
  // app-error registry. Some message-registry deployments stamp it as
  // 422; accept both.
  const wrongEndpointResult = await probe('Reject scope=\'this\' → wrong_endpoint', {
    url: dryRunSeriesUrl,
    body: { scope: 'this', space_id: ROOM_TEAM },
    expect: 'badrequest',
  });
  if (wrongEndpointResult.ok) {
    try {
      const parsed = JSON.parse(wrongEndpointResult.body);
      if (parsed.code === 'wrong_endpoint') {
        results.pass += 1;
        console.log(`  ✓ scope='this' code=wrong_endpoint`);
      } else {
        results.fail += 1;
        results.failed.push("scope='this' wrong code");
        console.log(`  ✗ scope='this' code=${parsed.code}`);
      }
    } catch {
      results.fail += 1;
      results.failed.push("scope='this' body parse");
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Scenario 9 — Reject body with `start_at` (time-shift not
  // supported on scope edits). ReservationService.editScope (1631-
  // 1638) raises `edit_booking_scope.time_shift_not_supported` with
  // raw AppError(422).
  // ────────────────────────────────────────────────────────────────
  const timeShiftResult = await probe(
    'Reject start_at on scope edit → 422 time_shift_not_supported',
    {
      url: dryRunSeriesUrl,
      body: { scope: 'series', start_at: '2026-01-01T10:00:00Z' },
      expect: 'unprocessable',
    },
  );
  if (timeShiftResult.ok) {
    try {
      const parsed = JSON.parse(timeShiftResult.body);
      if (parsed.code === 'edit_booking_scope.time_shift_not_supported') {
        results.pass += 1;
        console.log(`  ✓ time_shift code matches`);
      } else {
        results.fail += 1;
        results.failed.push('time_shift wrong code');
        console.log(`  ✗ time_shift code=${parsed.code}`);
      }
    } catch {
      results.fail += 1;
      results.failed.push('time_shift body parse');
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Scenario 10 — Reject invalid scope value.
  // ReservationService.editScope (1646-1649) raises
  // `edit_booking_scope.invalid_plans` (400) for any non-allowlist
  // scope.
  // ────────────────────────────────────────────────────────────────
  const garbageScopeResult = await probe('Reject scope=\'garbage\' → invalid_plans', {
    url: dryRunSeriesUrl,
    body: { scope: 'garbage', space_id: ROOM_TEAM },
    expect: 'badrequest',
  });
  if (garbageScopeResult.ok) {
    try {
      const parsed = JSON.parse(garbageScopeResult.body);
      if (parsed.code === 'edit_booking_scope.invalid_plans') {
        results.pass += 1;
        console.log(`  ✓ scope='garbage' code=edit_booking_scope.invalid_plans`);
      } else {
        results.fail += 1;
        results.failed.push("scope='garbage' wrong code");
        console.log(`  ✗ scope='garbage' code=${parsed.code}`);
      }
    } catch {
      results.fail += 1;
      results.failed.push("scope='garbage' body parse");
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Scenario 11 — Reject non-boolean dry_run.
  // Controller (reservation.controller.ts:444-448) AND service
  // (reservation.service.ts:1604-1608) both raise
  // `edit_booking_scope.invalid_plans` (400) on a string dry_run.
  // ────────────────────────────────────────────────────────────────
  const dryRunStringResult = await probe('Reject dry_run=\'true\' (string) → invalid_plans', {
    url: dryRunSeriesUrl,
    body: { scope: 'series', dry_run: 'true' },
    expect: 'badrequest',
  });
  if (dryRunStringResult.ok) {
    try {
      const parsed = JSON.parse(dryRunStringResult.body);
      if (parsed.code === 'edit_booking_scope.invalid_plans') {
        results.pass += 1;
        console.log(`  ✓ dry_run='true' code=edit_booking_scope.invalid_plans`);
      } else {
        results.fail += 1;
        results.failed.push("dry_run='true' wrong code");
        console.log(`  ✗ dry_run='true' code=${parsed.code}`);
      }
    } catch {
      results.fail += 1;
      results.failed.push("dry_run='true' body parse");
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Scenario 12 — Reject missing X-Client-Request-Id (controller
  // guard fires before the DTO is even parsed). Raw 400 with code
  // `client_request_id.required`.
  // ────────────────────────────────────────────────────────────────
  const missingHeaderResult = await probe('Missing X-Client-Request-Id → 400 guard fires', {
    url: dryRunSeriesUrl,
    body: { scope: 'series', space_id: ROOM_TEAM },
    omitClientRequestId: true,
    expect: 'badrequest',
  });
  if (missingHeaderResult.ok) {
    try {
      const parsed = JSON.parse(missingHeaderResult.body);
      if (parsed.code === 'client_request_id.required') {
        results.pass += 1;
        console.log(`  ✓ missing header code=client_request_id.required`);
      } else {
        results.fail += 1;
        results.failed.push('missing header wrong code');
        console.log(`  ✗ missing header code=${parsed.code}`);
      }
    } catch {
      results.fail += 1;
      results.failed.push('missing header body parse');
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Approval-flip probe — B.4.A.5 sub-step H gate-lift assertion at the
// scope-edit pipeline.
//
// Defends against: a regression that re-introduces the 422
// `booking.edit_requires_notification_dispatch` gate inside
// `assemble-edit-plan.service.ts` (`assembleScopeEditPlan` per-
// occurrence loop) OR the in-PG mirror at 00399 / `edit_booking_scope`.
//
// Fixture: 3 occurrences on ROOM_HUDDLE at +200d (well clear of the
// existing scope smoke's +90→+118d window). A one-shot test rule
// targets ROOM_TEAM with require_approval, approver=Noor. The probe
// PATCHes scope='series' space_id=ROOM_TEAM — every occurrence flips
// approval. Asserts the 200 + per-occurrence approval/inbox/outbox
// tuple. Tenant-scoped on every read (#0 invariant).
// ─────────────────────────────────────────────────────────────────────

async function readFlipApprovalsForBookings(bookingIds) {
  if (bookingIds.length === 0) return [];
  const { data, error } = await supa()
    .from('approvals')
    .select('id, target_entity_id, approval_chain_id, approver_person_id, status')
    .eq('tenant_id', TENANT_ID)
    .eq('target_entity_type', 'booking')
    .in('target_entity_id', bookingIds);
  if (error) throw error;
  return data ?? [];
}

async function readFlipInboxForBookings(bookingIds) {
  if (bookingIds.length === 0) return [];
  // PostgREST quirk — `.in()` on a JSON path doesn't reliably bind the
  // typed array; fetch all matching event_kind rows for the tenant
  // (small per-tenant) and filter in JS by booking_id. Safer + clearer
  // than coaxing supabase-js's filter DSL to emit the right URL.
  const { data, error } = await supa()
    .from('inbox_notifications')
    .select('id, user_id, payload')
    .eq('tenant_id', TENANT_ID)
    .eq('event_kind', 'booking.approval_required');
  if (error) throw error;
  const set = new Set(bookingIds);
  return (data ?? []).filter((r) => set.has(r.payload?.booking_id));
}

function runPsqlJson(sql) {
  // psql -t -A -c with row_to_json — returns one JSON object per line.
  // The smoke already shells psql for fixtures; the `outbox` schema is
  // reachable via direct postgres even though PostgREST does NOT expose
  // it (only public + graphql_public). supabase-js `.schema('outbox')`
  // therefore 400s with PGRST106 on this remote.
  const dbPass = env.SUPABASE_DB_PASS;
  if (!dbPass) throw new Error('SUPABASE_DB_PASS missing — cannot read outbox via psql');
  const dbUrl =
    env.SUPABASE_DB_URL ||
    'postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres';
  const out = execFileSync('psql', [dbUrl, '-t', '-A', '-c', sql], {
    env: { ...process.env, PGPASSWORD: dbPass },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim();
  if (!out) return [];
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function readFlipOutboxForBookings(bookingIds) {
  if (bookingIds.length === 0) return [];
  // PostgREST on this remote does NOT expose the `outbox` schema
  // (PGRST106 "Invalid schema: outbox"). Pre-existing flip-probe
  // (B.4.A.5) Assertion 3 used supabase-js `.schema('outbox')` which
  // 400s + aborted the whole gate via an uncaught throw — masking the
  // Slice 4 probe results. Read via psql instead (the `outbox` schema
  // IS reachable on direct postgres). Behavior-preserving: same rows,
  // same fields. Tenant-scoped (#0 invariant).
  const idList = bookingIds.map((b) => `'${b}'::uuid`).join(',');
  return runPsqlJson(
    `select row_to_json(t) from (
       select id, aggregate_id, payload
       from outbox.events
       where tenant_id = '${TENANT_ID}'::uuid
         and event_type = 'booking.approval_required'
         and aggregate_id in (${idList})
     ) t;`,
  );
}

async function runFlipScopeProbe(probe, flipFixture) {
  console.log('\n=== Approval-flip probe (B.4.A.5 sub-step H — scope-edit gate lift) ===');

  const pivot = flipFixture.occurrences[FLIP_PIVOT_INDEX];
  const allFlipBookingIds = flipFixture.occurrences.map((o) => o.bookingId);

  // Sanity — zero approvals/inbox/outbox rows for these bookings pre-flip.
  const apprBefore = await readFlipApprovalsForBookings(allFlipBookingIds);
  if (apprBefore.length === 0) {
    results.pass += 1;
    console.log(`  ✓ Flip setup: 0 approvals before scope edit`);
  } else {
    results.fail += 1;
    results.failed.push('Flip setup: approvals leaked from prior run');
    console.log(`  ✗ Flip setup: ${apprBefore.length} approvals (expected 0)`);
  }

  const flipCrid = crypto.randomUUID();
  const flipUrl = `${API_BASE}/api/reservations/${pivot.bookingId}/edit-scope`;
  const flipResult = await probe('Flip scope=series: 3 occurrences move to ROOM_TEAM → 200', {
    url: flipUrl,
    body: { scope: 'series', space_id: ROOM_TEAM },
    clientRequestId: flipCrid,
  });
  if (!flipResult.ok) return;

  // ── Assertion 1: ≥3 pending approvals across the 3 bookings, all for Noor.
  const apprAfter = await readFlipApprovalsForBookings(allFlipBookingIds);
  const noorAppr = apprAfter.filter(
    (a) => a.approver_person_id === NOOR_PERSON && a.status === 'pending',
  );
  const distinctBookings = new Set(noorAppr.map((a) => a.target_entity_id));
  if (distinctBookings.size === FLIP_RECURRENCE_COUNT) {
    results.pass += 1;
    console.log(`  ✓ Flip: ${FLIP_RECURRENCE_COUNT} pending approvals for NOOR across ${distinctBookings.size} bookings`);
  } else {
    results.fail += 1;
    results.failed.push('Flip: approvals count');
    console.log(`  ✗ Flip: noor-pending-approvals across ${distinctBookings.size} distinct bookings (expected ${FLIP_RECURRENCE_COUNT})`);
  }

  // ── Assertion 2: ≥3 inbox_notifications rows for Noor with payload.chain_id
  //    matching one of the approval rows.
  const inboxRows = await readFlipInboxForBookings(allFlipBookingIds);
  const chainIds = new Set(noorAppr.map((a) => a.approval_chain_id));
  const noorInbox = inboxRows.filter(
    (r) => r.user_id === NOOR_USER && chainIds.has(r.payload?.chain_id),
  );
  if (noorInbox.length >= FLIP_RECURRENCE_COUNT) {
    results.pass += 1;
    console.log(`  ✓ Flip: ${noorInbox.length} inbox_notifications rows for Noor with matching chain_ids`);
  } else {
    results.fail += 1;
    results.failed.push('Flip: inbox row count');
    console.log(`  ✗ Flip: ${noorInbox.length} matching inbox rows (expected ≥${FLIP_RECURRENCE_COUNT})`);
  }

  // ── Assertion 3: ≥3 outbox.events rows event_type=booking.approval_required
  //    with payload.chain_id matching one of the approval rows.
  const outboxRows = await readFlipOutboxForBookings(allFlipBookingIds);
  const matchingOutbox = outboxRows.filter((r) => chainIds.has(r.payload?.chain_id));
  if (matchingOutbox.length >= FLIP_RECURRENCE_COUNT) {
    results.pass += 1;
    console.log(`  ✓ Flip: ${matchingOutbox.length} outbox.events rows 'booking.approval_required' with matching chain_ids`);
  } else {
    results.fail += 1;
    results.failed.push('Flip: outbox row count');
    console.log(`  ✗ Flip: ${matchingOutbox.length} matching outbox rows (expected ≥${FLIP_RECURRENCE_COUNT})`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Smoke-testing edit_booking_scope against ${API_BASE}`);

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

  // Self-review remediation (code-reviewer 2026-05-12 on the sibling
  // smoke-edit-booking.mjs flagged the same pattern here): the fixture
  // seed + mintAdminToken calls must live inside the try/finally so
  // the cleanup fires even if token-minting throws after the fixture
  // is on disk. Pre-fix, a Supabase auth outage between seeding and
  // probing would leak the recurring fixture.
  let fixture = null;
  let flipFixture = null;
  const flipTestRuleId = crypto.randomUUID();
  try {
    console.log('Seeding recurring-booking fixture (5 occurrences, 1 week apart)…');
    fixture = seedRecurringFixture();
    console.log(`  series ${fixture.seriesId.slice(0, 8)}… / pivot ${fixture.occurrences[PIVOT_INDEX].bookingId.slice(0, 8)}…`);

    console.log('Seeding approval-flip fixture (3 occurrences at +200d + test rule)…');
    flipFixture = seedFlipFixture(flipTestRuleId);
    console.log(`  series ${flipFixture.seriesId.slice(0, 8)}… / rule ${flipTestRuleId.slice(0, 8)}…`);

    const accessToken = await mintAdminToken();
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'X-Tenant-Id': TENANT_ID,
      'Content-Type': 'application/json',
    };
    const probe = makeProber(headers);

    await runScopeProbes(headers, probe, fixture);
    await runFlipScopeProbe(probe, flipFixture);
  } finally {
    // Always clean up the fixture, even on failure, so the next run
    // starts clean. The cleanup also sweeps any command_operations
    // rows the smoke wrote so they don't pollute future tenant-A
    // metrics.
    if (fixture) {
      console.log('\nCleaning up fixture…');
      await deleteFixture(fixture.seriesId);
    }
    if (flipFixture) {
      console.log('Cleaning up flip fixture + test rule…');
      await deleteFlipFixture(flipFixture.seriesId, flipTestRuleId);
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

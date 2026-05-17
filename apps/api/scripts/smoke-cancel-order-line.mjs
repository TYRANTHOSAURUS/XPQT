#!/usr/bin/env node
/**
 * scripts/smoke-cancel-order-line.mjs
 *
 * Live-API smoke for the atomic order-line / bundle-services cancel
 * cascade — booking-audit remediation Slice 6 (audit 03 P1-4). This is
 * the P1-4 regression gate.
 *
 * Hits `DELETE /api/reservations/:id/services/:lineId` (per-line) and
 * `DELETE /api/reservations/:id/bundle` (bundle) end-to-end against the
 * remote Supabase project with a real Admin JWT. Sibling to
 * smoke-cancel-booking.mjs (same scaffolding: psql-seeded fixtures with
 * session_replication_role='replica', real HTTP probes,
 * command_operations + DB-level row assertions, FK-ordered cleanup,
 * per-booking-scoped assertions — NEVER global counts).
 *
 * What this probe defends against:
 *   - **`cancel_order_lines_with_cascade` RPC atomicity (00414)** — one tx
 *     cancels OLI + asset_reservation + work_order + (conditionally)
 *     booking/slots + approvals, branches approvals on p_line_ids IS NULL,
 *     writes audit + domain_events, emits bundle.services_cancelled on the
 *     bundle path only. A wiring break is invisible to mocked-jest specs.
 *   - **Idempotency** — same X-Client-Request-Id replay → cached success,
 *     NO double cascade; same crid + different line set → 409
 *     command_operations.payload_mismatch.
 *   - **Fulfilled-line protection** — cancel a `confirmed` line → 422
 *     line_already_fulfilled, zero writes.
 *   - **Approval rescope correctness** — multi-line approval: cancel one
 *     line ⇒ scope_breakdown shrinks (still pending); cancel the last ⇒
 *     status='expired'.
 *   - **Bundle weak-close** — booking+slots cancelled IFF no fulfilled &
 *     no kept line; test BOTH.
 *   - **Atomic rollback** — a poisoned approval whose `order_line_item_ids`
 *     value is a JSON string scalar makes the RPC's per-line rescope loop
 *     (`jsonb_array_elements_text(scope_breakdown->'order_line_item_ids')`,
 *     00414:469) RAISE `22023` mid-tx ⇒ the whole RPC transaction
 *     (including the `in_progress` command_operations insert) rolls back ⇒
 *     zero partial rows.
 *   - **Cross-tenant** — a REAL booking + cancellable line seeded under a
 *     DIFFERENT tenant: the caller's real-tenant Admin JWT attempting the
 *     per-line cancel on it is rejected with 404 (controller visibility
 *     gate / RPC tenant scope) and ZERO writes land on the foreign
 *     booking's line, cascade entities, or command_operations.
 *   - **Producer-route guard** — missing X-Client-Request-Id → 400.
 *
 * USAGE:
 *   pnpm dev:api &     (or have the dev server already running)
 *   node apps/api/scripts/smoke-cancel-order-line.mjs
 *
 *   exit 0 = all probes pass
 *   exit 1 = at least one regression
 *   exit 2 = infra error (API unreachable, fixture seed failed)
 *
 * Citations (every named symbol below was Read in this session):
 *   - supabase/migrations/00414_cancel_order_lines_with_cascade.sql (RPC).
 *   - apps/api/src/modules/reservations/reservation.controller.ts (the
 *     @Delete(':id/services/:lineId') + @Delete(':id/bundle') routes +
 *     RequireClientRequestIdGuard).
 *   - apps/api/src/modules/booking-bundles/bundle-cascade.service.ts
 *     (cancelLine / cancelBundle — the thin RPC wrappers).
 *   - apps/api/src/modules/outbox/handlers/bundle-services-cancelled-cascade.handler.ts
 *     (the durable OBX handler).
 *   - apps/api/scripts/smoke-cancel-booking.mjs (sibling scaffold —
 *     runPsql/runPsqlQuery/mintAdminToken/makeProber/cleanup pattern).
 *   - apps/api/scripts/smoke-attach-services.mjs:164 OTHER_TENANT_ID +
 *     smoke-cross-tenant.mjs:104 TENANT_B_ID (the shared foreign-tenant
 *     id `…0000b1`, pre-seeded on remote — reused by probe 8's real
 *     cross-tenant fixture).
 *   - apps/api/src/modules/reservations/reservation.service.ts:182-194
 *     (findOne → findByIdOrThrow `.eq('tenant_id', tenantId)` →
 *     AppErrors.notFoundWithCode('booking_not_found') — the visibility
 *     gate that 404s a foreign-tenant booking before the RPC).
 *   - packages/shared/src/idempotency.ts:buildCancelOrderLinesIdempotencyKey
 *     (replicated below for the .mjs runtime — keep in lockstep).
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
// Foreign tenant — the EXACT id the sibling smokes use
// (smoke-attach-services.mjs:164 OTHER_TENANT_ID / smoke-cross-tenant.mjs:104
// TENANT_B_ID). Pre-seeded on remote as "Smoke Tenant B (xtenant probes)".
const OTHER_TENANT_ID = '00000000-0000-0000-0000-0000000000b1';
const ADMIN_AUTH_UID = '93d41232-35b5-424c-b215-bb5d55a2dfd9'; // Admin role
// Real persons + rooms from 00133_seed_room_booking_examples.sql.
const THOMAS_PERSON = 'b3a0aa30-3648-4783-92fa-973090877238';
const ROOM_HUDDLE = '14d74559-7f91-470a-98a3-780b3e8a5349';
const NOOR_PERSON = '95000000-0000-0000-0000-000000000004';

// Fixture anchors. +150..+159 days future clears the edit/cancel-booking
// smoke windows (+130→+142) so back-to-back probes don't collide on rooms.
const FIXTURE_BASE_DAYS = 150;

// ─────────────────────────────────────────────────────────────────────
// Idempotency-key shape — replicated from
// packages/shared/src/idempotency.ts:buildCancelOrderLinesIdempotencyKey.
// `booking:lines:cancel:<booking_id>:<clientRequestId>`. If the shape
// changes there, update this in the same commit.
// ─────────────────────────────────────────────────────────────────────

const CANCEL_OL_PREFIX = 'booking:lines:cancel';
function buildCancelOrderLinesIdempotencyKey(bookingId, clientRequestId) {
  return `${CANCEL_OL_PREFIX}:${bookingId}:${clientRequestId}`;
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
  if (!dbPass) throw new Error('smoke-cancel-order-line: SUPABASE_DB_PASS missing from .env');
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
  if (!dbPass) throw new Error('smoke-cancel-order-line: SUPABASE_DB_PASS missing from .env');
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

// ─────────────────────────────────────────────────────────────────────
// Fixture seeding. Each fixture: booking + slot + order + N OLIs +
// asset_reservation(s) + non-terminal setup work_order(s) + optional
// pending approval(s) + optional visitor.
//
// session_replication_role='replica' bypasses RLS, the booking outbox
// triggers, AND the visitors single-write-path trigger (00270).
// ─────────────────────────────────────────────────────────────────────

function mkBase(tag, dayOffset) {
  const anchor = new Date(Date.now() + dayOffset * 86400_000);
  anchor.setUTCMinutes(0, 0, 0);
  anchor.setUTCHours(9);
  const startAt = anchor.toISOString();
  const endAt = new Date(anchor.getTime() + 90 * 60_000).toISOString();
  return {
    tag,
    bookingId: crypto.randomUUID(),
    slotId: crypto.randomUUID(),
    orderId: crypto.randomUUID(),
    startAt,
    endAt,
  };
}

// Seed one OLI + its linked asset_reservation + its setup work_order.
// `fulfillmentStatus` lets a probe seed a 'confirmed' (protected) line.
function lineSeedSql(ids, line, startAt, endAt) {
  const woModule = 910_000_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
  return `
    insert into public.asset_types (id, tenant_id, name)
    values ('${line.assetTypeId}'::uuid, '${TENANT_ID}'::uuid, 'Smoke OL atype ${line.tag}');
    insert into public.assets
      (id, tenant_id, asset_type_id, asset_role, name, status)
    values
      ('${line.assetId}'::uuid, '${TENANT_ID}'::uuid, '${line.assetTypeId}'::uuid,
       'pooled', 'Smoke OL asset ${line.tag}', 'available');
    insert into public.catalog_items (id, tenant_id, name, category)
    values ('${line.catalogItemId}'::uuid, '${TENANT_ID}'::uuid,
            'Smoke OL catalog ${line.tag}', 'equipment');
    insert into public.asset_reservations
      (id, tenant_id, asset_id, start_at, end_at, status,
       requester_person_id, booking_id, linked_order_line_item_id)
    values
      ('${line.arId}'::uuid, '${TENANT_ID}'::uuid, '${line.assetId}'::uuid,
       '${startAt}'::timestamptz, '${endAt}'::timestamptz, 'confirmed',
       '${THOMAS_PERSON}'::uuid, '${ids.bookingId}'::uuid,
       '${line.oliId}'::uuid);
    insert into public.order_line_items
      (id, order_id, tenant_id, catalog_item_id, quantity,
       fulfillment_status, linked_asset_reservation_id)
    values
      ('${line.oliId}'::uuid, '${ids.orderId}'::uuid, '${TENANT_ID}'::uuid,
       '${line.catalogItemId}'::uuid, 1, '${line.fulfillmentStatus}',
       '${line.arId}'::uuid);
    insert into public.work_orders
      (id, tenant_id, title, status_category, parent_kind, booking_id,
       linked_order_line_item_id, module_number, planned_start_at, sla_id)
    values
      ('${line.woId}'::uuid, '${TENANT_ID}'::uuid,
       'Smoke OL setup WO ${line.tag}', 'assigned', 'booking',
       '${ids.bookingId}'::uuid, '${line.oliId}'::uuid,
       ${woModule}, '${startAt}'::timestamptz,
       'a3000000-0000-0000-0000-000000000001'::uuid);
  `;
}

function mkLine(tag, fulfillmentStatus = 'ordered') {
  return {
    tag,
    oliId: crypto.randomUUID(),
    arId: crypto.randomUUID(),
    assetTypeId: crypto.randomUUID(),
    assetId: crypto.randomUUID(),
    catalogItemId: crypto.randomUUID(),
    woId: crypto.randomUUID(),
    fulfillmentStatus,
  };
}

// Build a complete booking fixture with N lines + optional approval(s).
// approvals: array of { id, scopeOliIds } — each is a pending approval
// targeting the booking with scope_breakdown covering scopeOliIds.
function seedBookingFixture(opts) {
  const { tag, dayOffset, lines, approvals = [] } = opts;
  const ids = mkBase(tag, dayOffset);
  let sql =
    `set session_replication_role = 'replica';\n` +
    `insert into public.bookings
       (id, tenant_id, title, requester_person_id, location_id,
        start_at, end_at, timezone, status, source, calendar_etag,
        cost_amount_snapshot, policy_snapshot, applied_rule_ids)
     values
       ('${ids.bookingId}'::uuid, '${TENANT_ID}'::uuid, 'Smoke OL ${tag}',
        '${THOMAS_PERSON}'::uuid, '${ROOM_HUDDLE}'::uuid,
        '${ids.startAt}'::timestamptz, '${ids.endAt}'::timestamptz, 'UTC',
        'confirmed', 'desk', 'smoke-ol-${ids.bookingId.slice(0, 8)}',
        150.00, '{}'::jsonb, '{}'::uuid[]);
     insert into public.booking_slots
       (id, tenant_id, booking_id, slot_type, space_id,
        start_at, end_at, status, display_order)
     values
       ('${ids.slotId}'::uuid, '${TENANT_ID}'::uuid, '${ids.bookingId}'::uuid,
        'room', '${ROOM_HUDDLE}'::uuid,
        '${ids.startAt}'::timestamptz, '${ids.endAt}'::timestamptz, 'confirmed', 0);
     insert into public.orders
       (id, tenant_id, requester_person_id, booking_id, status,
        requested_for_start_at, requested_for_end_at, delivery_location_id)
     values
       ('${ids.orderId}'::uuid, '${TENANT_ID}'::uuid, '${THOMAS_PERSON}'::uuid,
        '${ids.bookingId}'::uuid, 'confirmed',
        '${ids.startAt}'::timestamptz, '${ids.endAt}'::timestamptz, '${ROOM_HUDDLE}'::uuid);\n`;
  for (const line of lines) {
    sql += lineSeedSql(ids, line, ids.startAt, ids.endAt);
  }
  for (const ap of approvals) {
    const sb = JSON.stringify({
      order_line_item_ids: ap.scopeOliIds,
      ticket_ids: [],
      asset_reservation_ids: [],
    }).replace(/'/g, "''");
    sql += `
      insert into public.approvals
        (id, tenant_id, target_entity_type, target_entity_id,
         approver_person_id, status, scope_breakdown)
      values
        ('${ap.id}'::uuid, '${TENANT_ID}'::uuid, 'booking',
         '${ids.bookingId}'::uuid, '${NOOR_PERSON}'::uuid, 'pending',
         '${sb}'::jsonb);\n`;
  }
  sql += `set session_replication_role = 'origin';`;
  runPsql(sql);
  return ids;
}

// ─────────────────────────────────────────────────────────────────────
// Foreign-tenant fixture (Fix B — real cross-tenant probe).
//
// Seeds a complete booking + slot + order + ONE cancellable OLI + its
// linked asset_reservation + non-terminal setup work_order under
// OTHER_TENANT_ID. The persons/spaces FKs (persons.id / spaces.id) are
// satisfied by the tenant-1 seed rows (FKs reference by id, NOT
// tenant-scoped — the canonicalisation schema 00277:36-41); the booking's
// OWN tenant_id IS the foreign one, which is exactly the cross-tenant
// shape we attack. asset_types/assets/catalog_items use fresh uuids under
// OTHER_TENANT_ID so they're self-consistent + cleaned up by id.
// ─────────────────────────────────────────────────────────────────────

function seedForeignTenantFixture(dayOffset) {
  const anchor = new Date(Date.now() + dayOffset * 86400_000);
  anchor.setUTCMinutes(0, 0, 0);
  anchor.setUTCHours(9);
  const startAt = anchor.toISOString();
  const endAt = new Date(anchor.getTime() + 90 * 60_000).toISOString();
  const f = {
    bookingId: crypto.randomUUID(),
    slotId: crypto.randomUUID(),
    orderId: crypto.randomUUID(),
    oliId: crypto.randomUUID(),
    arId: crypto.randomUUID(),
    assetTypeId: crypto.randomUUID(),
    assetId: crypto.randomUUID(),
    catalogItemId: crypto.randomUUID(),
    woId: crypto.randomUUID(),
    startAt,
    endAt,
  };
  const woModule = 920_000_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
  const sql = `
    set session_replication_role = 'replica';
    insert into public.bookings
      (id, tenant_id, title, requester_person_id, location_id,
       start_at, end_at, timezone, status, source, calendar_etag,
       cost_amount_snapshot, policy_snapshot, applied_rule_ids)
    values
      ('${f.bookingId}'::uuid, '${OTHER_TENANT_ID}'::uuid, 'Smoke OL xtenant',
       '${THOMAS_PERSON}'::uuid, '${ROOM_HUDDLE}'::uuid,
       '${f.startAt}'::timestamptz, '${f.endAt}'::timestamptz, 'UTC',
       'confirmed', 'desk', 'smoke-ol-xt-${f.bookingId.slice(0, 8)}',
       150.00, '{}'::jsonb, '{}'::uuid[]);
    insert into public.booking_slots
      (id, tenant_id, booking_id, slot_type, space_id,
       start_at, end_at, status, display_order)
    values
      ('${f.slotId}'::uuid, '${OTHER_TENANT_ID}'::uuid, '${f.bookingId}'::uuid,
       'room', '${ROOM_HUDDLE}'::uuid,
       '${f.startAt}'::timestamptz, '${f.endAt}'::timestamptz, 'confirmed', 0);
    insert into public.orders
      (id, tenant_id, requester_person_id, booking_id, status,
       requested_for_start_at, requested_for_end_at, delivery_location_id)
    values
      ('${f.orderId}'::uuid, '${OTHER_TENANT_ID}'::uuid, '${THOMAS_PERSON}'::uuid,
       '${f.bookingId}'::uuid, 'confirmed',
       '${f.startAt}'::timestamptz, '${f.endAt}'::timestamptz, '${ROOM_HUDDLE}'::uuid);
    insert into public.asset_types (id, tenant_id, name)
    values ('${f.assetTypeId}'::uuid, '${OTHER_TENANT_ID}'::uuid, 'Smoke OL xt atype');
    insert into public.assets
      (id, tenant_id, asset_type_id, asset_role, name, status)
    values
      ('${f.assetId}'::uuid, '${OTHER_TENANT_ID}'::uuid, '${f.assetTypeId}'::uuid,
       'pooled', 'Smoke OL xt asset', 'available');
    insert into public.catalog_items (id, tenant_id, name, category)
    values ('${f.catalogItemId}'::uuid, '${OTHER_TENANT_ID}'::uuid,
            'Smoke OL xt catalog', 'equipment');
    insert into public.asset_reservations
      (id, tenant_id, asset_id, start_at, end_at, status,
       requester_person_id, booking_id, linked_order_line_item_id)
    values
      ('${f.arId}'::uuid, '${OTHER_TENANT_ID}'::uuid, '${f.assetId}'::uuid,
       '${f.startAt}'::timestamptz, '${f.endAt}'::timestamptz, 'confirmed',
       '${THOMAS_PERSON}'::uuid, '${f.bookingId}'::uuid, '${f.oliId}'::uuid);
    insert into public.order_line_items
      (id, order_id, tenant_id, catalog_item_id, quantity,
       fulfillment_status, linked_asset_reservation_id)
    values
      ('${f.oliId}'::uuid, '${f.orderId}'::uuid, '${OTHER_TENANT_ID}'::uuid,
       '${f.catalogItemId}'::uuid, 1, 'ordered', '${f.arId}'::uuid);
    insert into public.work_orders
      (id, tenant_id, title, status_category, parent_kind, booking_id,
       linked_order_line_item_id, module_number, planned_start_at, sla_id)
    values
      ('${f.woId}'::uuid, '${OTHER_TENANT_ID}'::uuid,
       'Smoke OL xt setup WO', 'assigned', 'booking',
       '${f.bookingId}'::uuid, '${f.oliId}'::uuid,
       ${woModule}, '${f.startAt}'::timestamptz,
       'a3000000-0000-0000-0000-000000000001'::uuid);
    set session_replication_role = 'origin';
  `;
  runPsql(sql);
  return f;
}

async function deleteForeignTenantFixture(f) {
  if (!f) return;
  const t = `'${OTHER_TENANT_ID}'::uuid`;
  const sql = `
    set session_replication_role = 'replica';
    delete from public.work_orders
      where tenant_id=${t} and id='${f.woId}'::uuid;
    delete from public.asset_reservations
      where tenant_id=${t} and id='${f.arId}'::uuid;
    delete from public.order_line_items
      where tenant_id=${t} and id='${f.oliId}'::uuid;
    delete from public.orders
      where tenant_id=${t} and id='${f.orderId}'::uuid;
    delete from public.assets
      where tenant_id=${t} and id='${f.assetId}'::uuid;
    delete from public.catalog_items
      where tenant_id=${t} and id='${f.catalogItemId}'::uuid;
    delete from public.asset_types
      where tenant_id=${t} and id='${f.assetTypeId}'::uuid;
    delete from public.booking_slots
      where tenant_id=${t} and booking_id='${f.bookingId}'::uuid;
    delete from public.bookings
      where tenant_id=${t} and id='${f.bookingId}'::uuid;
    set session_replication_role = 'origin';
  `;
  try {
    runPsql(sql);
  } catch (e) {
    console.log(`  ! foreign-tenant fixture cleanup warn: ${e.message.slice(0, 200)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Cleanup — FK-ordered, LIFO, best-effort. Selective on minted keys.
// ─────────────────────────────────────────────────────────────────────

async function deleteFixtures(bookingIds) {
  if (bookingIds.length === 0) return;
  const bl = bookingIds.map((id) => `'${id}'::uuid`).join(', ');
  const sql = `
    set session_replication_role = 'replica';
    delete from public.audit_events
      where tenant_id = '${TENANT_ID}'::uuid
        and ((entity_type = 'booking' and entity_id in (${bl}))
          or (entity_type = 'order_line_item' and entity_id in (
             select oli.id from public.order_line_items oli
               join public.orders o on o.id = oli.order_id
              where o.tenant_id = '${TENANT_ID}'::uuid and o.booking_id in (${bl}))));
    delete from public.domain_events
      where tenant_id = '${TENANT_ID}'::uuid
        and entity_type = 'booking' and entity_id in (${bl});
    delete from outbox.events
      where tenant_id = '${TENANT_ID}'::uuid
        and aggregate_id in (${bl});
    delete from public.approvals
      where tenant_id = '${TENANT_ID}'::uuid
        and target_entity_type = 'booking'
        and target_entity_id in (${bl});
    delete from public.command_operations
      where tenant_id = '${TENANT_ID}'::uuid
        and idempotency_key like '${CANCEL_OL_PREFIX}:%'
        and (${bookingIds.map((id) => `idempotency_key like '${CANCEL_OL_PREFIX}:${id}:%'`).join(' or ')});
    create temp table _smoke_ol_assets on commit drop as
      select distinct ar.asset_id as id
        from public.asset_reservations ar
       where ar.tenant_id = '${TENANT_ID}'::uuid and ar.booking_id in (${bl});
    create temp table _smoke_ol_catalog on commit drop as
      select distinct oli.catalog_item_id as id
        from public.order_line_items oli
        join public.orders o on o.id = oli.order_id
       where o.tenant_id = '${TENANT_ID}'::uuid and o.booking_id in (${bl});
    create temp table _smoke_ol_atypes on commit drop as
      select distinct a.asset_type_id as id
        from public.assets a
       where a.tenant_id = '${TENANT_ID}'::uuid
         and a.id in (select id from _smoke_ol_assets);
    delete from public.work_orders
      where tenant_id = '${TENANT_ID}'::uuid and booking_id in (${bl});
    delete from public.asset_reservations
      where tenant_id = '${TENANT_ID}'::uuid and booking_id in (${bl});
    delete from public.order_line_items
      where tenant_id = '${TENANT_ID}'::uuid
        and order_id in (select id from public.orders
                          where tenant_id = '${TENANT_ID}'::uuid and booking_id in (${bl}));
    delete from public.orders
      where tenant_id = '${TENANT_ID}'::uuid and booking_id in (${bl});
    delete from public.assets
      where tenant_id = '${TENANT_ID}'::uuid and id in (select id from _smoke_ol_assets);
    delete from public.catalog_items
      where tenant_id = '${TENANT_ID}'::uuid and id in (select id from _smoke_ol_catalog);
    delete from public.asset_types
      where tenant_id = '${TENANT_ID}'::uuid and id in (select id from _smoke_ol_atypes);
    delete from public.booking_slots
      where tenant_id = '${TENANT_ID}'::uuid and booking_id in (${bl});
    delete from public.bookings
      where tenant_id = '${TENANT_ID}'::uuid and id in (${bl});
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
      method = 'DELETE',
      url,
      body,
      expect = 'success',
      clientRequestId,
      omitClientRequestId = false,
      tenantOverride = null,
    } = options;
    const xCid = !omitClientRequestId ? clientRequestId || crypto.randomUUID() : null;
    const probeHeaders = { ...headers };
    if (xCid) probeHeaders['X-Client-Request-Id'] = xCid;
    if (tenantOverride) probeHeaders['X-Tenant-Id'] = tenantOverride;
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
      (expect === 'notfound' && r.status === 404) ||
      // 'error' = ANY non-2xx (4xx OR 5xx). Mirrors smoke-attach-services
      // probe 6: for a FORCED RPC-internal failure the load-bearing
      // assertion is "did NOT succeed AND zero partial rows", not a
      // specific status — a forced raw-Postgres raise (e.g. 22023 from a
      // corrupt-scope_breakdown poison) is an UNMAPPED error → correctly
      // surfaces as 500/unknown.server_error, NOT a user-actionable 422.
      (expect === 'error' && r.status >= 400);
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
// DB introspection (all reads tenant-gated — #0 invariant).
// ─────────────────────────────────────────────────────────────────────

function scalar(sql) {
  return runPsqlQuery(sql);
}
function num(sql) {
  return Number.parseInt(runPsqlQuery(sql), 10) || 0;
}
function bookingStatus(id) {
  return scalar(`select status from public.bookings where tenant_id='${TENANT_ID}'::uuid and id='${id}'::uuid;`);
}
function oliStatus(id) {
  return scalar(`select fulfillment_status from public.order_line_items where tenant_id='${TENANT_ID}'::uuid and id='${id}'::uuid;`);
}
function oliState(id) {
  return scalar(
    `select fulfillment_status || '|' || (pending_setup_trigger_args is null)::text
       from public.order_line_items where tenant_id='${TENANT_ID}'::uuid and id='${id}'::uuid;`,
  );
}
function arStatus(id) {
  return scalar(`select status from public.asset_reservations where tenant_id='${TENANT_ID}'::uuid and id='${id}'::uuid;`);
}
function woState(id) {
  return scalar(
    `select status_category || '|' || (closed_at is not null)::text
       from public.work_orders where tenant_id='${TENANT_ID}'::uuid and id='${id}'::uuid;`,
  );
}
function approvalStatus(id) {
  return scalar(`select status from public.approvals where tenant_id='${TENANT_ID}'::uuid and id='${id}'::uuid;`);
}
function approvalScopeOliCount(id) {
  return num(
    `select coalesce(jsonb_array_length(scope_breakdown->'order_line_item_ids'),0)
       from public.approvals where tenant_id='${TENANT_ID}'::uuid and id='${id}'::uuid;`,
  );
}
function slotStatus(bookingId) {
  return scalar(
    `select status from public.booking_slots where tenant_id='${TENANT_ID}'::uuid and booking_id='${bookingId}'::uuid order by display_order limit 1;`,
  );
}
function cmdOpRows(bookingId) {
  return num(
    `select count(*) from public.command_operations
      where tenant_id='${TENANT_ID}'::uuid
        and idempotency_key like '${CANCEL_OL_PREFIX}:${bookingId}:%'
        and outcome='success';`,
  );
}
function outboxCount(bookingId, eventType) {
  return num(
    `select count(*) from outbox.events
      where tenant_id='${TENANT_ID}'::uuid
        and event_type='${eventType}'
        and payload->>'booking_id'='${bookingId}';`,
  );
}

// Foreign-tenant introspection (Fix B) — reads scoped to OTHER_TENANT_ID.
function foreignOliStatus(id) {
  return scalar(
    `select fulfillment_status from public.order_line_items where tenant_id='${OTHER_TENANT_ID}'::uuid and id='${id}'::uuid;`,
  );
}
function foreignArStatus(id) {
  return scalar(
    `select status from public.asset_reservations where tenant_id='${OTHER_TENANT_ID}'::uuid and id='${id}'::uuid;`,
  );
}
function foreignWoState(id) {
  return scalar(
    `select status_category from public.work_orders where tenant_id='${OTHER_TENANT_ID}'::uuid and id='${id}'::uuid;`,
  );
}
function foreignBookingStatus(id) {
  return scalar(
    `select status from public.bookings where tenant_id='${OTHER_TENANT_ID}'::uuid and id='${id}'::uuid;`,
  );
}
// command_operations rows recorded under the CALLER's (real) tenant for a
// foreign booking id — must be ZERO (the cancel never reached the gate).
function cmdOpRowsForBooking(bookingId) {
  return num(
    `select count(*) from public.command_operations
      where idempotency_key like '${CANCEL_OL_PREFIX}:${bookingId}:%'
        and outcome='success';`,
  );
}

const URL_LINE = (b, l) => `${API_BASE}/api/reservations/${b}/services/${l}`;
const URL_BUNDLE = (b) => `${API_BASE}/api/reservations/${b}/bundle`;

// ─────────────────────────────────────────────────────────────────────
// Probes
// ─────────────────────────────────────────────────────────────────────

async function probe1_perLineCancel(probe) {
  console.log('\n=== 1. per-line cancel — atomic deltas keyed to booking_id ===');
  const line = mkLine('p1', 'ordered');
  const ap = { id: crypto.randomUUID(), scopeOliIds: [line.oliId] };
  const ids = seedBookingFixture({ tag: 'p1', dayOffset: FIXTURE_BASE_DAYS, lines: [line], approvals: [ap] });
  try {
    passAssertion('1 setup: OLI ordered, AR confirmed, WO assigned, approval pending',
      oliStatus(line.oliId) === 'ordered' && arStatus(line.arId) === 'confirmed' &&
        woState(line.woId).startsWith('assigned') && approvalStatus(ap.id) === 'pending',
      `oli=${oliStatus(line.oliId)} ar=${arStatus(line.arId)} wo=${woState(line.woId)} ap=${approvalStatus(ap.id)}`);

    const crid = crypto.randomUUID();
    const r = await probe('1 DELETE /services/:lineId → 200', {
      url: URL_LINE(ids.bookingId, line.oliId),
      body: { reason: 'smoke_line_cancel' },
      clientRequestId: crid,
    });
    if (r.ok) {
      passAssertion('1: OLI → cancelled + pending_setup_trigger_args null',
        oliState(line.oliId) === 'cancelled|true', `got=${oliState(line.oliId)}`);
      passAssertion('1: linked asset_reservation → cancelled',
        arStatus(line.arId) === 'cancelled', `got=${arStatus(line.arId)}`);
      passAssertion('1: linked work_order → closed + closed_at set',
        woState(line.woId) === 'closed|true', `got=${woState(line.woId)}`);
      passAssertion('1: approval rescoped (scope drained, single-line → expired)',
        approvalStatus(ap.id) === 'expired', `got=${approvalStatus(ap.id)}`);
      passAssertion('1: exactly 1 command_operations success row for this booking',
        cmdOpRows(ids.bookingId) === 1, `count=${cmdOpRows(ids.bookingId)}`);
      passAssertion('1: per-line path emits NO bundle.services_cancelled (verified no-op)',
        outboxCount(ids.bookingId, 'bundle.services_cancelled') === 0,
        `count=${outboxCount(ids.bookingId, 'bundle.services_cancelled')}`);

      // ── 2. idempotency replay (same crid) → counts unchanged.
      const r2 = await probe('2 idempotency replay (same crid) → 200 cached', {
        url: URL_LINE(ids.bookingId, line.oliId),
        body: { reason: 'smoke_line_cancel' },
        clientRequestId: crid,
      });
      if (r2.ok) {
        passAssertion('2: response byte-identical (cached_result)',
          r2.body === r.body, 'bodies differ — RPC re-executed?');
        passAssertion('2: still exactly 1 command_operations success row',
          cmdOpRows(ids.bookingId) === 1, `count=${cmdOpRows(ids.bookingId)}`);
      }

      // ── 3. same crid + different line set → 409 payload_mismatch.
      const line2 = mkLine('p1b', 'ordered');
      runPsql(
        `set session_replication_role='replica';` +
          lineSeedSql(ids, line2, ids.startAt, ids.endAt) +
          `set session_replication_role='origin';`,
      );
      const r3 = await probe('3 same crid + different line → 409 payload_mismatch', {
        url: URL_LINE(ids.bookingId, line2.oliId),
        body: { reason: 'smoke_line_cancel' },
        clientRequestId: crid,
        expect: 'conflict',
      });
      if (r3.ok) {
        const mp = parseJsonSafe(r3.body);
        passAssertion('3: code=command_operations.payload_mismatch',
          mp?.code === 'command_operations.payload_mismatch', `code=${mp?.code}`);
        passAssertion('3: zero new writes (line2 still ordered)',
          oliStatus(line2.oliId) === 'ordered', `got=${oliStatus(line2.oliId)}`);
      }
    }
  } finally {
    await deleteFixtures([ids.bookingId]);
  }
}

async function probe4_fulfilledProtection(probe) {
  console.log('\n=== 4. fulfilled-line protection (confirmed → 422, zero writes) ===');
  const line = mkLine('f1', 'confirmed'); // protected (FULFILLED_STATUSES)
  const ids = seedBookingFixture({ tag: 'f1', dayOffset: FIXTURE_BASE_DAYS + 1, lines: [line] });
  try {
    const r = await probe('4 DELETE confirmed line → 422 line_already_fulfilled', {
      url: URL_LINE(ids.bookingId, line.oliId),
      body: { reason: 'x' },
      expect: 'unprocessable',
    });
    if (r.ok) {
      const mp = parseJsonSafe(r.body);
      passAssertion('4: code=cancel_order_lines_with_cascade.line_already_fulfilled',
        mp?.code === 'cancel_order_lines_with_cascade.line_already_fulfilled', `code=${mp?.code}`);
      passAssertion('4: zero writes (OLI still confirmed, AR still confirmed, WO still assigned)',
        oliStatus(line.oliId) === 'confirmed' && arStatus(line.arId) === 'confirmed' &&
          woState(line.woId).startsWith('assigned'),
        `oli=${oliStatus(line.oliId)} ar=${arStatus(line.arId)} wo=${woState(line.woId)}`);
      passAssertion('4: zero command_operations success rows',
        cmdOpRows(ids.bookingId) === 0, `count=${cmdOpRows(ids.bookingId)}`);
    }
  } finally {
    await deleteFixtures([ids.bookingId]);
  }
}

async function probe5_approvalRescope(probe) {
  console.log('\n=== 5. approval rescope correctness (2-line approval) ===');
  const lineA = mkLine('r5a', 'ordered');
  const lineB = mkLine('r5b', 'ordered');
  const ap = { id: crypto.randomUUID(), scopeOliIds: [lineA.oliId, lineB.oliId] };
  const ids = seedBookingFixture({
    tag: 'r5', dayOffset: FIXTURE_BASE_DAYS + 2, lines: [lineA, lineB], approvals: [ap],
  });
  try {
    passAssertion('5 setup: approval scope covers 2 OLIs, status pending',
      approvalScopeOliCount(ap.id) === 2 && approvalStatus(ap.id) === 'pending',
      `count=${approvalScopeOliCount(ap.id)} status=${approvalStatus(ap.id)}`);

    const r1 = await probe('5a cancel ONE of 2 scoped lines → 200', {
      url: URL_LINE(ids.bookingId, lineA.oliId),
      body: { reason: 'x' },
      clientRequestId: crypto.randomUUID(),
    });
    if (r1.ok) {
      passAssertion('5a: scope_breakdown shrank to 1 OLI',
        approvalScopeOliCount(ap.id) === 1, `count=${approvalScopeOliCount(ap.id)}`);
      passAssertion('5a: approval still pending (other entity remains)',
        approvalStatus(ap.id) === 'pending', `got=${approvalStatus(ap.id)}`);
    }
    const r2 = await probe('5b cancel the LAST scoped line → 200', {
      url: URL_LINE(ids.bookingId, lineB.oliId),
      body: { reason: 'x' },
      clientRequestId: crypto.randomUUID(),
    });
    if (r2.ok) {
      passAssertion('5b: approval → expired (scope fully drained)',
        approvalStatus(ap.id) === 'expired', `got=${approvalStatus(ap.id)}`);
    }
  } finally {
    await deleteFixtures([ids.bookingId]);
  }
}

async function probe6_bundleCancel(probe) {
  console.log('\n=== 6. bundle cancel (DELETE /bundle, p_line_ids null) ===');

  // 6a — pure-services booking (no fulfilled / no kept) → booking cancelled.
  const a1 = mkLine('b6a1', 'ordered');
  const a2 = mkLine('b6a2', 'ordered');
  const apA = { id: crypto.randomUUID(), scopeOliIds: [a1.oliId] };
  const idsA = seedBookingFixture({
    tag: 'b6a', dayOffset: FIXTURE_BASE_DAYS + 3, lines: [a1, a2], approvals: [apA],
  });
  try {
    const rA = await probe('6a DELETE /bundle (all cancellable) → 200', {
      url: URL_BUNDLE(idsA.bookingId),
      body: { reason: 'smoke_bundle_cancel' },
      clientRequestId: crypto.randomUUID(),
    });
    if (rA.ok) {
      passAssertion('6a: both OLIs → cancelled',
        oliStatus(a1.oliId) === 'cancelled' && oliStatus(a2.oliId) === 'cancelled',
        `a1=${oliStatus(a1.oliId)} a2=${oliStatus(a2.oliId)}`);
      passAssertion('6a: booking → cancelled (no fulfilled & no kept)',
        bookingStatus(idsA.bookingId) === 'cancelled', `got=${bookingStatus(idsA.bookingId)}`);
      passAssertion('6a: slot → cancelled',
        slotStatus(idsA.bookingId) === 'cancelled', `got=${slotStatus(idsA.bookingId)}`);
      passAssertion('6a: all pending approvals expired',
        approvalStatus(apA.id) === 'expired', `got=${approvalStatus(apA.id)}`);
      passAssertion('6a: bundle.services_cancelled outbox present (scoped to booking_id)',
        outboxCount(idsA.bookingId, 'bundle.services_cancelled') === 1,
        `count=${outboxCount(idsA.bookingId, 'bundle.services_cancelled')}`);
    }
  } finally {
    await deleteFixtures([idsA.bookingId]);
  }

  // 6b — booking with a fulfilled line → booking STAYS (weak-close false).
  const b1 = mkLine('b6b1', 'ordered');
  const b2 = mkLine('b6b2', 'confirmed'); // fulfilled — protected, stays
  const idsB = seedBookingFixture({
    tag: 'b6b', dayOffset: FIXTURE_BASE_DAYS + 4, lines: [b1, b2],
  });
  try {
    const rB = await probe('6b DELETE /bundle with a fulfilled line → 200', {
      url: URL_BUNDLE(idsB.bookingId),
      body: { reason: 'smoke_bundle_cancel' },
      clientRequestId: crypto.randomUUID(),
    });
    if (rB.ok) {
      passAssertion('6b: cancellable OLI → cancelled',
        oliStatus(b1.oliId) === 'cancelled', `got=${oliStatus(b1.oliId)}`);
      passAssertion('6b: fulfilled OLI PROTECTED (still confirmed)',
        oliStatus(b2.oliId) === 'confirmed', `got=${oliStatus(b2.oliId)}`);
      passAssertion('6b: booking STAYS confirmed (a fulfilled line remains alive)',
        bookingStatus(idsB.bookingId) === 'confirmed', `got=${bookingStatus(idsB.bookingId)}`);
      passAssertion('6b: slot STAYS confirmed',
        slotStatus(idsB.bookingId) === 'confirmed', `got=${slotStatus(idsB.bookingId)}`);
    }
  } finally {
    await deleteFixtures([idsB.bookingId]);
  }
}

async function probe7_atomicRollback(probe) {
  console.log('\n=== 7. atomic rollback — force REAL in-tx RAISE ⇒ zero partial rows ===');
  // The RPC is ONE plpgsql transaction (any RAISE aborts everything incl.
  // the `in_progress` command_operations insert). To PROVE rollback the
  // poison must genuinely trigger a mid-tx RAISE via the RPC's own jsonb
  // access pattern — NOT a no-op the cascade can skip past.
  //
  // The per-line rescope loop (00414:459-481) does, for each pending
  // approval on the booking:
  //   jsonb_array_elements_text(v_appr.scope_breakdown -> 'order_line_item_ids')
  //
  // Seed a pending approval whose `order_line_item_ids` KEY value is a
  // JSON STRING SCALAR (not an array):
  //   scope_breakdown = '{"order_line_item_ids":"POISON_NOT_AN_ARRAY"}'
  // Then  scope_breakdown -> 'order_line_item_ids'  =
  //   '"POISON_NOT_AN_ARRAY"'::jsonb  (a scalar) — so
  //   jsonb_array_elements_text(<scalar>)  RAISES
  //   `22023 cannot extract elements from a scalar`  mid-rescope
  // → the whole RPC tx (including the `in_progress` command_operations
  //   row + every cascade UPDATE) rolls back. NOT the old broken poison
  //   (`'"not-an-object"'::jsonb`) where `-> 'order_line_item_ids'`
  //   returned SQL NULL and `jsonb_array_elements_text(NULL)` yielded
  //   zero rows with NO error — that proved nothing.
  //
  // MUST use the PER-LINE route (`DELETE /services/:lineId`, p_line_ids
  // non-null): ONLY that path runs the jsonb rescope loop (00414:447);
  // the bundle path's expire-all (00414:520-530) does no jsonb extract.
  const line = mkLine('rb7', 'ordered');
  const poisoned = crypto.randomUUID();
  const ids = seedBookingFixture({ tag: 'rb7', dayOffset: FIXTURE_BASE_DAYS + 5, lines: [line] });
  try {
    // The RPC filters pending approvals by `target_entity_id = p_booking_id`
    // + `status='pending'` ONLY (00414:462-464); target_entity_type is set
    // to 'booking' to match the seed convention (seedBookingFixture +
    // probe1's approvals). scope_breakdown's order_line_item_ids value is
    // a JSON string scalar → jsonb_array_elements_text raises mid-rescope.
    runPsql(
      `set session_replication_role='replica';
       insert into public.approvals
         (id, tenant_id, target_entity_type, target_entity_id,
          approver_person_id, status, scope_breakdown)
       values
         ('${poisoned}'::uuid, '${TENANT_ID}'::uuid, 'booking',
          '${ids.bookingId}'::uuid, '${NOOR_PERSON}'::uuid, 'pending',
          '{"order_line_item_ids":"POISON_NOT_AN_ARRAY"}'::jsonb);
       set session_replication_role='origin';`,
    );
    const r = await probe('7 PER-LINE DELETE with array-scalar poison approval → error (no 2xx)', {
      url: URL_LINE(ids.bookingId, line.oliId),
      body: { reason: 'x' },
      clientRequestId: crypto.randomUUID(),
      // The poison forces a raw Postgres 22023 (cannot extract elements
      // from a scalar) mid-rescope — an UNMAPPED error, so it correctly
      // surfaces as 500/unknown.server_error (NOT a user-actionable 422;
      // the RPC's deliberate user raises like line_already_fulfilled ARE
      // 422). The atomicity PROOF is the 5 strict rollback assertions
      // below; the status only needs to be non-2xx. `expect:'error'`
      // (any 4xx/5xx) mirrors smoke-attach-services probe 6's rationale.
      expect: 'error',
    });
    // The request MUST error (not 2xx). The RAISE happens INSIDE the RPC
    // tx so PostgREST returns a 4xx/5xx and NOTHING is committed.
    passAssertion('7: request did NOT 2xx (in-tx RAISE, no partial commit) — status >= 400',
      r.status >= 400, `status=${r.status}`);
    passAssertion('7: OLI fulfillment_status still NOT cancelled (full rollback)',
      oliStatus(line.oliId) === 'ordered', `got=${oliStatus(line.oliId)}`);
    passAssertion('7: linked asset_reservation still confirmed (NOT cancelled — rollback)',
      arStatus(line.arId) === 'confirmed', `got=${arStatus(line.arId)}`);
    passAssertion('7: linked work_order still open (NOT closed — rollback)',
      woState(line.woId).startsWith('assigned'), `got=${woState(line.woId)}`);
    passAssertion('7: ZERO command_operations success rows (in_progress insert rolled back with the tx)',
      cmdOpRows(ids.bookingId) === 0, `count=${cmdOpRows(ids.bookingId)}`);
  } finally {
    // Clean up the seeded poison approval (deleteFixtures sweeps approvals
    // by target_entity_id IN (booking ids) so this is covered, but be
    // explicit + FK-safe in case the booking sweep is skipped).
    try {
      runPsql(
        `set session_replication_role='replica';
         delete from public.approvals
           where tenant_id='${TENANT_ID}'::uuid and id='${poisoned}'::uuid;
         set session_replication_role='origin';`,
      );
    } catch (e) {
      console.log(`  ! probe7 poison cleanup warn: ${e.message.slice(0, 160)}`);
    }
    await deleteFixtures([ids.bookingId]);
  }
}

async function probe8_crossTenant(probe) {
  console.log('\n=== 8. cross-tenant — REAL foreign-tenant booking → 404 + ZERO cross-tenant writes ===');
  // The load-bearing cross-tenant proof. We seed a REAL booking + one
  // cancellable OLI (+ its asset_reservation + setup work_order) under
  // OTHER_TENANT_ID, then — as the REAL tenant's Admin JWT (NO
  // X-Tenant-Id override; the JWT tenant claim can't be overridden
  // anyway) — attempt the per-line cancel on the foreign booking.
  //
  // It must be rejected with HTTP 404 and ZERO writes on the foreign
  // line. Defense-in-depth path: the controller's
  // `findOne(id, authUid)` visibility gate (reservation.service.ts:
  // 182-194 — `.eq('tenant_id', tenantId)` →
  // AppErrors.notFoundWithCode('booking_not_found')) rejects the
  // foreign-tenant booking under the caller's tenant BEFORE the RPC's
  // own `where id=p_booking_id and tenant_id=p_tenant_id FOR UPDATE`
  // (00414:266-276) `cancel_order_lines_with_cascade.booking_not_found`
  // guard is reached. Either gate is a correct cross-tenant rejection;
  // the load-bearing property is "404 + zero writes on the foreign
  // booking's line". We accept either error code.
  //
  // Also keep the ghost-uuid → 404 sub-probe as a cheap regression on
  // the same code path for a non-existent (vs foreign-tenant) id.
  const ft = seedForeignTenantFixture(FIXTURE_BASE_DAYS + 6);
  try {
    passAssertion('8 setup: foreign-tenant OLI/AR/WO seeded under OTHER_TENANT_ID',
      foreignOliStatus(ft.oliId) === 'ordered' &&
        foreignArStatus(ft.arId) === 'confirmed' &&
        foreignWoState(ft.woId) === 'assigned',
      `oli=${foreignOliStatus(ft.oliId)} ar=${foreignArStatus(ft.arId)} wo=${foreignWoState(ft.woId)}`);

    const r = await probe('8 PER-LINE DELETE on a foreign-tenant booking → 404', {
      url: URL_LINE(ft.bookingId, ft.oliId),
      body: { reason: 'x' },
      clientRequestId: crypto.randomUUID(),
      expect: 'notfound',
    });
    if (r.ok) {
      const mp = parseJsonSafe(r.body);
      // Accept EITHER gate's code (visibility gate fires first → plain
      // `booking_not_found`; RPC tenant scope behind it →
      // `cancel_order_lines_with_cascade.booking_not_found`).
      passAssertion('8: rejected as a booking-not-found cross-tenant 404',
        mp?.code === 'booking_not_found' ||
          mp?.code === 'cancel_order_lines_with_cascade.booking_not_found',
        `code=${mp?.code}`);
    }
    // Load-bearing: ZERO writes on the foreign booking's line + its
    // cascade entities, no booking flip.
    passAssertion('8: foreign OLI fulfillment_status UNCHANGED (no cross-tenant write)',
      foreignOliStatus(ft.oliId) === 'ordered', `got=${foreignOliStatus(ft.oliId)}`);
    passAssertion('8: foreign asset_reservation UNCHANGED (no cross-tenant cascade)',
      foreignArStatus(ft.arId) === 'confirmed', `got=${foreignArStatus(ft.arId)}`);
    passAssertion('8: foreign work_order UNCHANGED (no cross-tenant cascade)',
      foreignWoState(ft.woId) === 'assigned', `got=${foreignWoState(ft.woId)}`);
    passAssertion('8: foreign booking UNCHANGED (no cross-tenant close)',
      foreignBookingStatus(ft.bookingId) === 'confirmed',
      `got=${foreignBookingStatus(ft.bookingId)}`);
    passAssertion('8: ZERO command_operations success rows for the foreign booking id',
      cmdOpRowsForBooking(ft.bookingId) === 0,
      `count=${cmdOpRowsForBooking(ft.bookingId)}`);

    // Ghost-uuid regression: a uuid that doesn't exist in ANY tenant
    // (not just foreign) still 404s on the same path.
    const rGhost = await probe('8b ghost booking id (no such row) → 404', {
      url: URL_LINE(crypto.randomUUID(), ft.oliId),
      body: { reason: 'x' },
      clientRequestId: crypto.randomUUID(),
      expect: 'notfound',
    });
    if (rGhost.ok) {
      passAssertion('8b: foreign OLI STILL untouched after the ghost probe',
        foreignOliStatus(ft.oliId) === 'ordered', `got=${foreignOliStatus(ft.oliId)}`);
    }
  } finally {
    await deleteForeignTenantFixture(ft);
  }
}

async function probe9_missingCrid(probe) {
  console.log('\n=== 9. missing X-Client-Request-Id → 400 (producer-route guard) ===');
  const line = mkLine('mc9', 'ordered');
  const ids = seedBookingFixture({ tag: 'mc9', dayOffset: FIXTURE_BASE_DAYS + 7, lines: [line] });
  try {
    const r = await probe('9 DELETE /services/:lineId no crid → 400', {
      url: URL_LINE(ids.bookingId, line.oliId),
      body: { reason: 'x' },
      omitClientRequestId: true,
      expect: 'badrequest',
    });
    if (r.ok) {
      passAssertion('9: zero writes (OLI still ordered)',
        oliStatus(line.oliId) === 'ordered', `got=${oliStatus(line.oliId)}`);
    }
    const rB = await probe('9b DELETE /bundle no crid → 400', {
      url: URL_BUNDLE(ids.bookingId),
      body: { reason: 'x' },
      omitClientRequestId: true,
      expect: 'badrequest',
    });
    if (rB.ok) {
      passAssertion('9b: zero writes (booking still confirmed)',
        bookingStatus(ids.bookingId) === 'confirmed', `got=${bookingStatus(ids.bookingId)}`);
    }
  } finally {
    await deleteFixtures([ids.bookingId]);
  }
}

// ─────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Smoke-testing cancel_order_lines_with_cascade against ${API_BASE}`);

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

  // Pre-flight — the RPC must exist on remote (00414 pushed).
  try {
    const exists = runPsqlQuery(
      "select to_regprocedure('public.cancel_order_lines_with_cascade(uuid,uuid[],uuid[],uuid,uuid,text,text)') is not null",
    );
    if (exists !== 't') {
      console.error('✗ public.cancel_order_lines_with_cascade RPC is NOT on remote.');
      console.error('  Push migration 00414 first (psql fallback).');
      process.exit(1);
    }
    console.log('✓ pre-flight: cancel_order_lines_with_cascade RPC present on remote');
  } catch (e) {
    console.error(`✗ pre-flight query failed: ${e.message}`);
    process.exit(2);
  }

  let accessToken;
  try {
    accessToken = await mintAdminToken();
  } catch (e) {
    console.error(`✗ could not mint admin token: ${e.message}`);
    process.exit(2);
  }
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'X-Tenant-Id': TENANT_ID,
    'Content-Type': 'application/json',
  };
  const probe = makeProber(headers);

  try {
    await probe1_perLineCancel(probe);
    await probe4_fulfilledProtection(probe);
    await probe5_approvalRescope(probe);
    await probe6_bundleCancel(probe);
    await probe7_atomicRollback(probe);
    await probe8_crossTenant(probe);
    await probe9_missingCrid(probe);
  } catch (e) {
    console.error('smoke run errored mid-probe:', e);
    process.exit(2);
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

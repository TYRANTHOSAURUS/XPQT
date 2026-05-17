#!/usr/bin/env node
/**
 * scripts/smoke-attach-services.mjs
 *
 * Live-API smoke for the atomic post-booking service-attach RPC —
 * booking-audit remediation Slice 5 (audit
 * `docs/follow-ups/audits/03-booking-reservation.md` P1-3). This is the
 * P1-3 regression gate that was NOT shipped with commit f1085072 (the
 * RPC + wrapper + idempotency-key helper landed; the smoke gate did not).
 *
 * Hits `POST /api/reservations/:id/services` end-to-end against the
 * remote Supabase project with a real Admin JWT. Sibling to
 * smoke-create-multi-room.mjs / smoke-cancel-booking.mjs (identical
 * scaffolding: env loader, magiclink JWT mint, psql-seeded fixtures with
 * session_replication_role='replica', real HTTP probes, attach_operations
 * + DB-level row assertions scoped to THIS run's booking_id, FK-ordered
 * selective cleanup).
 *
 * The RPC under test — `attach_services_to_existing_booking`
 * (supabase/migrations/00412_attach_services_to_existing_booking_rpc.sql,
 * CONFIRMED on remote) — replaces the legacy non-atomic TS N-write +
 * reverse-order TS `Cleanup` undo-queue in
 * `apps/api/src/modules/booking-bundles/bundle.service.ts:246-364`. The
 * controller route is `apps/api/src/modules/reservations/
 * reservation.controller.ts:512-549` (RequireClientRequestIdGuard-gated;
 * the URL `:id` is a BOOKING id; body is `{ services: ServiceLineInput[] }`).
 *
 * What this probe defends against (each is a real failure class that
 * mocked-Supabase jest CANNOT catch — they only manifest against a real
 * Postgres):
 *   1. **Atomic attach** — POST /:id/services with a catering line lands
 *      orders + order_line_items (+ asset_reservation iff a linked_asset_id
 *      line is present), exact deltas keyed to THIS booking_id.
 *   2. **Idempotency replay** — same booking + same X-Client-Request-Id
 *      replay → cached attach_operations result, ZERO duplicate
 *      orders/OLIs/asset_reservations; exactly ONE attach_operations row
 *      with outcome=success for that key.
 *   3. **Payload-mismatch 409** — same X-Client-Request-Id, DIFFERENT
 *      services payload → the RPC's attach_operations hash gate raises
 *      `attach_operations.payload_mismatch` → HTTP 409
 *      (booking.idempotency_payload_mismatch); ZERO new rows.
 *   4. **Cross-tenant reject** — Tenant-A's JWT + a Tenant-B X-Tenant-Id
 *      header (the canonical cross-tenant attack, mirrors
 *      smoke-cross-tenant.mjs:304-307: global tenant binding rejects the
 *      JWT-claim≠header mismatch with 403); ZERO rows for the booking
 *      under the wrong tenant.
 *   5. **Missing CRID 400** — POST /:id/services with NO
 *      X-Client-Request-Id → 400 (RequireClientRequestIdGuard,
 *      reservation.controller.ts:513); ZERO new rows.
 *   6. **Atomic rollback (load-bearing P1-3 gate)** — a services payload
 *      that passes the controller DTO + the TS plan-builder
 *      (`assertAssetInTenant` passes: the asset IS in tenant) but fails
 *      INSIDE the RPC: the AV line's `linked_asset_id` points at an asset
 *      with a pre-seeded `confirmed` asset_reservations row overlapping
 *      the booking window, so the RPC's `INSERT into asset_reservations`
 *      trips the `asset_reservations_no_overlap` GiST exclusion
 *      (00142_asset_reservations.sql:27-30, 23P01) → the WHOLE tx rolls
 *      back. Assert ZERO partial rows for the booking (no orphan order,
 *      no OLI, no asset_reservation, no approval, the attach_operations
 *      marker rolled back too). This is the exact property that proves
 *      Postgres atomicity genuinely replaced the TS Cleanup queue. A
 *      partial row here is a REAL RPC BUG — the probe fails loudly and
 *      does NOT weaken.
 *   7. **Approval suppression** — attach a catering line whose seeded
 *      `service_rules` row (effect=require_approval, target_kind=
 *      catalog_item, always-true predicate) routes a `person` approver.
 *      Assert ≥1 `approvals` row (pending, booking-targeted) created AND
 *      the `setup_work_order.create_required` outbox event is SUPPRESSED
 *      for THIS booking_id (the RPC guards the emit on
 *      NOT any_pending_approval — 00412:330-358) until approval.
 *
 * USAGE:
 *   pnpm dev:api &      (or have the dev server already running)
 *   node apps/api/scripts/smoke-attach-services.mjs
 *
 *   exit 0 = all probes pass
 *   exit 1 = at least one regression
 *   exit 2 = infra error (API unreachable, fixture seed failed)
 *
 * Citations (every named symbol below was Read in this session):
 *   - supabase/migrations/00412_attach_services_to_existing_booking_rpc.sql
 *     (the RPC body — gate :169-188, booking SELECT :206-213, validators
 *     :235-236, INSERT orders/AR/OLI/approvals :238-324, guarded setup
 *     emit :330-358, finalize :375-377).
 *   - apps/api/src/modules/reservations/reservation.controller.ts:105-126
 *     (@Post() single create + RequireClientRequestIdGuard) and :512-549
 *     (@Post(':id/services') attach + RequireClientRequestIdGuard).
 *   - apps/api/src/modules/booking-bundles/bundle.service.ts:112-132
 *     (ServiceLineInput shape), :246-364 (attachServicesToBooking — the
 *     thin RPC wrapper), :389-428 (mapAttachRpcError — 409 / 422 / 404
 *     mapping), :1426-1473 (loadBooking projection), :582-785
 *     (buildAttachPlan: orders per service_type, AR iff linked_asset_id,
 *     service-rule resolver + approval router → approvals[]).
 *   - packages/shared/src/idempotency.ts:495-513
 *     (buildAttachServicesIdempotencyKey — `booking:attach:<bid>:<crid>`).
 *   - apps/api/src/modules/service-catalog/service-rule-resolver.service.ts
 *     :97-115 (fetchAllRules tenant+active), :221-242
 *     (extractApproverTargets: approval_config {approver_target:'person',
 *     person_id} → person target), :256-277 (bucketRulesBySpecificity:
 *     target_kind='catalog_item' & target_id=line.catalog_item_id → spec 1).
 *   - apps/api/src/modules/room-booking-rules/predicate-engine.service.ts
 *     :88-115 + :277-287 ({"op":"eq","left":1,"right":1} is a valid,
 *     deterministic always-true predicate — literals pass through
 *     resolveRef; empty {} would THROW invalid_predicate → no match).
 *   - apps/api/src/modules/orders/approval-routing.service.ts:169-219
 *     (assemblePlan → approvals rows: approver_person_id, status='pending',
 *     target_entity_type='booking').
 *   - supabase/migrations/00142_asset_reservations.sql:13-31
 *     (asset_reservations: time_range generated, exclude using gist
 *     (asset_id =, time_range &&) where status='confirmed' — the 23P01
 *     the rollback probe forces).
 *   - supabase/migrations/00299_outbox_foundation.sql:18-50
 *     (outbox.events: tenant_id, event_type, aggregate_type, aggregate_id,
 *     payload jsonb — the suppression assertion reads payload->>'booking_id').
 *   - supabase/migrations/00141_service_rules.sql:5-25 (service_rules
 *     schema — target_kind/target_id/applies_when/effect/approval_config).
 *   - apps/api/scripts/smoke-create-multi-room.mjs (sibling scaffold —
 *     env loader / psql helpers / mintAdminToken / makeProber /
 *     mintedIdempotencyKeys + selective cleanup).
 *   - apps/api/scripts/smoke-cross-tenant.mjs:304-307 (the canonical
 *     Tenant-A-JWT + Tenant-B-header 403 cross-tenant attack).
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

// Cross-tenant attack header. Mirrors smoke-cross-tenant.mjs:98 — a real
// (seeded-elsewhere or not) tenant id that is NOT tenant-1; the global
// tenant binding rejects the JWT-claim(tenant-1)≠header mismatch with 403
// BEFORE the booking is ever looked up, so no row can land under it.
const OTHER_TENANT_ID = '00000000-0000-0000-0000-0000000000b1';

// Fixture anchor. +150d future clears the cancel-booking (+140→142),
// create-multi-room (+145), and edit-booking (+130→133) windows so
// back-to-back smoke runs on the shared remote never collide on the
// dedicated rooms / assets this smoke seeds.
const FIXTURE_DAYS = 150;

// ─────────────────────────────────────────────────────────────────────
// Idempotency-key shape — mirrors packages/shared/src/idempotency.ts:508-513
// (`booking:attach:<booking_id>:<clientRequestId>`). bundle.service.ts:280
// constructs the byte-identical literal via buildAttachServicesIdempotencyKey.
// We record every key this run mints (deterministic from booking_id +
// crid) and delete ONLY those exact keys in cleanup — never a tenant-wide
// `like 'booking:attach:%'` sweep (would clobber sibling smokes' ledger
// rows on the shared remote).
// ─────────────────────────────────────────────────────────────────────

const mintedIdempotencyKeys = new Set();

function buildAttachServicesIdempotencyKey(bookingId, clientRequestId) {
  const key = `booking:attach:${bookingId}:${clientRequestId}`;
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
// psql helpers (mirror smoke-create-multi-room.mjs:161-205).
// ─────────────────────────────────────────────────────────────────────

function dbUrl() {
  return (
    env.SUPABASE_DB_URL ||
    'postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres'
  );
}

function runPsql(sql) {
  const dbPass = env.SUPABASE_DB_PASS;
  if (!dbPass) throw new Error('smoke-attach-services: SUPABASE_DB_PASS missing from .env');
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
  if (!dbPass) throw new Error('smoke-attach-services: SUPABASE_DB_PASS missing from .env');
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
// Fixture ids — one self-contained dedicated graph:
//   - 2 reservable test rooms in tenant-1 (the fixture booking's space +
//     a spare; the attach RPC does not create slots, so one room is
//     enough — the spare keeps the seed shape symmetric with siblings).
//   - 1 catering catalog_item (priced) → 1 order + 1 OLI.
//   - 1 AV asset (+ asset_type) + 1 AV catalog_item linked to it via
//     linked_asset_type_id → the service line's linked_asset_id makes
//     the RPC create 1 asset_reservation + the OLI link.
//   - probe 7: 1 service_rules row (effect=require_approval,
//     target_kind=catalog_item → the approval-catering item,
//     always-true predicate, approver_target=person → NOOR_PERSON).
// session_replication_role='replica' bypasses RLS + booking outbox
// triggers so we control timing.
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
       'Smoke AS ${tag} room ${i}', 20, true, true, 0, 0, false, 15);`,
    )
    .join('\n');
}

function mkFixtureIds(tag) {
  return {
    tag,
    cateringCatalogId: crypto.randomUUID(),
    avCatalogId: crypto.randomUUID(),
    apprCatalogId: crypto.randomUUID(),
    assetTypeId: crypto.randomUUID(),
    assetId: crypto.randomUUID(),
    rollbackAssetTypeId: crypto.randomUUID(),
    rollbackAssetId: crypto.randomUUID(),
    rollbackAvCatalogId: crypto.randomUUID(),
    approvalRuleId: crypto.randomUUID(),
  };
}

// Catalog + asset graph + the require_approval service rule.
function catalogSeedSql(ids) {
  return `
    insert into public.catalog_items
      (id, tenant_id, name, category, unit, price_per_unit,
       display_order, active, requires_return)
    values
      ('${ids.cateringCatalogId}'::uuid, '${TENANT_ID}'::uuid,
       'Smoke AS catering ${ids.tag}', 'food_and_drinks', 'per_person', 12.50,
       0, true, false),
      ('${ids.apprCatalogId}'::uuid, '${TENANT_ID}'::uuid,
       'Smoke AS approval catering ${ids.tag}', 'food_and_drinks', 'per_person', 9.00,
       3, true, false);

    insert into public.asset_types (id, tenant_id, name)
    values
      ('${ids.assetTypeId}'::uuid, '${TENANT_ID}'::uuid,
       'Smoke AS AV type ${ids.tag}'),
      ('${ids.rollbackAssetTypeId}'::uuid, '${TENANT_ID}'::uuid,
       'Smoke AS rollback AV type ${ids.tag}');
    insert into public.assets
      (id, tenant_id, asset_type_id, asset_role, name, status)
    values
      ('${ids.assetId}'::uuid, '${TENANT_ID}'::uuid,
       '${ids.assetTypeId}'::uuid, 'pooled',
       'Smoke AS projector ${ids.tag}', 'available'),
      ('${ids.rollbackAssetId}'::uuid, '${TENANT_ID}'::uuid,
       '${ids.rollbackAssetTypeId}'::uuid, 'pooled',
       'Smoke AS rollback projector ${ids.tag}', 'available');
    insert into public.catalog_items
      (id, tenant_id, name, category, unit, price_per_unit,
       display_order, active, requires_return, linked_asset_type_id)
    values
      ('${ids.avCatalogId}'::uuid, '${TENANT_ID}'::uuid,
       'Smoke AS AV ${ids.tag}', 'equipment', 'flat_rate', 75.00,
       1, true, true, '${ids.assetTypeId}'::uuid),
      ('${ids.rollbackAvCatalogId}'::uuid, '${TENANT_ID}'::uuid,
       'Smoke AS rollback AV ${ids.tag}', 'equipment', 'flat_rate', 75.00,
       2, true, true, '${ids.rollbackAssetTypeId}'::uuid);

    -- require_approval service rule for probe 7. target_kind=catalog_item
    -- + target_id=apprCatalogId → specificity bucket 1
    -- (service-rule-resolver.service.ts:267-269). applies_when is a valid
    -- deterministic always-true predicate ({"op":"eq","left":1,"right":1}
    -- — predicate-engine.service.ts:178-179 + :277-287; an empty {} would
    -- THROW invalid_predicate and the rule would never fire). approver
    -- routes to NOOR_PERSON via approval_config (extractApproverTargets
    -- service-rule-resolver.service.ts:227-229).
    insert into public.service_rules
      (id, tenant_id, name, target_kind, target_id, applies_when, effect,
       approval_config, priority, active)
    values
      ('${ids.approvalRuleId}'::uuid, '${TENANT_ID}'::uuid,
       'Smoke AS require-approval ${ids.tag}',
       'catalog_item', '${ids.apprCatalogId}'::uuid,
       '{"op":"eq","left":1,"right":1}'::jsonb,
       'require_approval',
       '{"approver_target":"person","person_id":"${NOOR_PERSON}"}'::jsonb,
       10, true);
  `;
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
// Cleanup — FK-ordered, best-effort. Sweeps ONLY this run's rows:
// the dedicated spaces / catalog / asset graph, the bookings created on
// them, and the attach_operations rows for the exact keys this run minted.
// ─────────────────────────────────────────────────────────────────────

async function deleteFixtures(state) {
  const fx = state.fixtureIds;
  const sl =
    state.allSpaceIds.map((id) => `'${id}'::uuid`).join(', ') ||
    `'00000000-0000-0000-0000-000000000000'::uuid`;
  const bookingIds =
    [...state.bookingIds].map((id) => `'${id}'::uuid`).join(', ') ||
    `'00000000-0000-0000-0000-000000000000'::uuid`;
  const catalogIds = fx
    ? [fx.cateringCatalogId, fx.avCatalogId, fx.apprCatalogId, fx.rollbackAvCatalogId]
        .map((id) => `'${id}'::uuid`)
        .join(', ')
    : `'00000000-0000-0000-0000-000000000000'::uuid`;
  const assetIds = fx
    ? [fx.assetId, fx.rollbackAssetId].map((id) => `'${id}'::uuid`).join(', ')
    : `'00000000-0000-0000-0000-000000000000'::uuid`;
  const assetTypeIds = fx
    ? [fx.assetTypeId, fx.rollbackAssetTypeId].map((id) => `'${id}'::uuid`).join(', ')
    : `'00000000-0000-0000-0000-000000000000'::uuid`;
  const ruleIds = fx ? `'${fx.approvalRuleId}'::uuid` : `'00000000-0000-0000-0000-000000000000'::uuid`;
  const idemKeyList =
    [...mintedIdempotencyKeys].map((k) => `'${k.replace(/'/g, "''")}'`).join(', ') ||
    `'__smoke_as_no_keys__'`;

  const sql = `
    set session_replication_role = 'replica';
    delete from public.audit_events
      where tenant_id = '${TENANT_ID}'::uuid
        and entity_type = 'booking'
        and entity_id in (${bookingIds});
    delete from public.domain_events
      where tenant_id = '${TENANT_ID}'::uuid
        and entity_type = 'booking'
        and entity_id in (${bookingIds});
    delete from outbox.events
      where tenant_id = '${TENANT_ID}'::uuid
        and aggregate_id in (${bookingIds});
    delete from outbox.events
      where tenant_id = '${TENANT_ID}'::uuid
        and event_type = 'setup_work_order.create_required'
        and (payload->>'booking_id') in (${[...state.bookingIds]
          .map((id) => `'${id}'`)
          .join(', ') || `'__none__'`});
    delete from public.approvals
      where tenant_id = '${TENANT_ID}'::uuid
        and target_entity_type = 'booking'
        and target_entity_id in (${bookingIds});
    delete from public.attach_operations
      where tenant_id = '${TENANT_ID}'::uuid
        and idempotency_key in (${idemKeyList});
    delete from public.asset_reservations
      where tenant_id = '${TENANT_ID}'::uuid
        and (booking_id in (${bookingIds}) or asset_id in (${assetIds}));
    delete from public.order_line_items
      where tenant_id = '${TENANT_ID}'::uuid
        and order_id in (select id from public.orders
                          where tenant_id = '${TENANT_ID}'::uuid
                            and booking_id in (${bookingIds}));
    delete from public.orders
      where tenant_id = '${TENANT_ID}'::uuid
        and booking_id in (${bookingIds});
    delete from public.booking_slots
      where tenant_id = '${TENANT_ID}'::uuid
        and booking_id in (${bookingIds});
    delete from public.bookings
      where tenant_id = '${TENANT_ID}'::uuid
        and id in (${bookingIds});
    delete from public.service_rule_versions
      where tenant_id = '${TENANT_ID}'::uuid and rule_id in (${ruleIds});
    delete from public.service_rules
      where tenant_id = '${TENANT_ID}'::uuid and id in (${ruleIds});
    delete from public.assets
      where tenant_id = '${TENANT_ID}'::uuid and id in (${assetIds});
    delete from public.catalog_items
      where tenant_id = '${TENANT_ID}'::uuid and id in (${catalogIds});
    delete from public.asset_types
      where tenant_id = '${TENANT_ID}'::uuid and id in (${assetTypeIds});
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
// Auth — mint a real Admin JWT (mirror smoke-create-multi-room.mjs:387-405).
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
// Probe runner (mirror smoke-create-multi-room.mjs:420-497).
// ─────────────────────────────────────────────────────────────────────

const results = { pass: 0, fail: 0, skip: 0, failed: [], skipped: [] };

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
      headerOverride,
    } = options;
    const xCid = !omitClientRequestId ? clientRequestId || crypto.randomUUID() : null;
    const probeHeaders = { ...(headerOverride ?? headers) };
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
      (expect === 'notfound' && r.status === 404) ||
      // probe 6: the RPC-internal failure surfaces as 409 (23P01
      // asset_conflict, bundle.service.ts:393-397) — but accept ANY 4xx/5xx
      // so the probe stays honest if the mapping shifts; what matters is
      // that it did NOT succeed AND nothing partial persisted.
      (expect === 'error' && r.status >= 400);
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

function skipProbe(name, reason) {
  results.skip += 1;
  results.skipped.push(`${name} — ${reason}`);
  console.log(`  ⊘ SKIP ${name} — ${reason}`);
}

function parseJsonSafe(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// DB introspection — all reads tenant-gated (#0) + scoped to THIS run's
// booking_id (multiple dev servers share this remote — never a global
// table count).
// ─────────────────────────────────────────────────────────────────────

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
function countOlisForQty(bookingId, qty) {
  return num(
    `select count(*) from public.order_line_items oli
       join public.orders o on o.id = oli.order_id
      where o.tenant_id='${TENANT_ID}'::uuid and o.booking_id='${bookingId}'::uuid
        and oli.quantity=${qty};`,
  );
}
function countAssetReservations(bookingId) {
  return num(
    `select count(*) from public.asset_reservations
      where tenant_id='${TENANT_ID}'::uuid and booking_id='${bookingId}'::uuid;`,
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
      where tenant_id='${TENANT_ID}'::uuid and idempotency_key='${idemKey.replace(/'/g, "''")}';`,
  );
}
function attachOpOutcome(idemKey) {
  return scalar(
    `select coalesce(outcome,'<none>') from public.attach_operations
      where tenant_id='${TENANT_ID}'::uuid and idempotency_key='${idemKey.replace(/'/g, "''")}';`,
  );
}
function bookingStatus(bookingId) {
  return scalar(
    `select coalesce(status,'<none>') from public.bookings where tenant_id='${TENANT_ID}'::uuid and id='${bookingId}'::uuid;`,
  );
}
// outbox setup_work_order.create_required scoped to THIS booking via the
// payload (the RPC sets aggregate_id = OLI id, NOT the booking id, so we
// MUST key on payload->>'booking_id' — never a global count). 00412:336.
function countSetupWoOutbox(bookingId) {
  return num(
    `select count(*) from outbox.events
      where tenant_id='${TENANT_ID}'::uuid
        and event_type='setup_work_order.create_required'
        and (payload->>'booking_id')='${bookingId}';`,
  );
}

// ─────────────────────────────────────────────────────────────────────
// Fixture booking — a fresh no-services single-room booking via
// POST /api/reservations (mirror create-multi-room probe g's single
// create → BookingFlowService.create → create_booking_with_attach_plan
// with zero services). RequireClientRequestIdGuard-gated, so mint a crid.
// ─────────────────────────────────────────────────────────────────────

async function createFixtureBooking(probe, spaceId, hourUtc, label) {
  const { start, end } = isoAnchor(FIXTURE_DAYS, hourUtc);
  const crid = crypto.randomUUID();
  const res = await probe(`Create no-services fixture booking (${label}) → 2xx`, {
    url: `${API_BASE}/api/reservations`,
    body: {
      reservation_type: 'room',
      space_id: spaceId,
      requester_person_id: THOMAS_PERSON,
      start_at: start,
      end_at: end,
      attendee_count: 8,
      source: 'desk',
    },
    clientRequestId: crid,
    expect: 'success',
  });
  if (!res.ok) return null;
  const parsed = parseJsonSafe(res.body);
  const bookingId =
    parsed?.booking?.id ??
    parsed?.booking_id ??
    parsed?.bundle?.id ??
    parsed?.id ??
    scalar(
      `select distinct booking_id from public.booking_slots
        where tenant_id='${TENANT_ID}'::uuid and space_id='${spaceId}'::uuid limit 1;`,
    );
  passAssertion(
    `fixture (${label}): booking row present + has no orders yet`,
    !!bookingId && bookingStatus(bookingId) !== '<none>' && countOrders(bookingId) === 0,
    `bookingId=${bookingId} status=${bookingId ? bookingStatus(bookingId) : 'n/a'} orders=${bookingId ? countOrders(bookingId) : 'n/a'}`,
  );
  return { bookingId, start, end };
}

// ─────────────────────────────────────────────────────────────────────
// Probes
// ─────────────────────────────────────────────────────────────────────

function cateringLine(fx) {
  return {
    catalog_item_id: fx.cateringCatalogId,
    quantity: 8,
    client_line_id: 'as-catering-1',
  };
}
function avLine(fx) {
  return {
    catalog_item_id: fx.avCatalogId,
    quantity: 1,
    linked_asset_id: fx.assetId,
    client_line_id: 'as-av-1',
  };
}

// (1) Atomic attach.
async function runAtomicAttachProbe(probe, fx, bk) {
  console.log('\n=== (1) atomic attach (catering + AV) ===');
  const ordersBefore = countOrders(bk.bookingId);
  const olisBefore = countOlis(bk.bookingId);
  const arsBefore = countAssetReservations(bk.bookingId);
  passAssertion(
    '(1) baseline: no orders/OLIs/AR on the fresh booking',
    ordersBefore === 0 && olisBefore === 0 && arsBefore === 0,
    `orders=${ordersBefore} olis=${olisBefore} ars=${arsBefore}`,
  );

  const crid = crypto.randomUUID();
  const idemKey = buildAttachServicesIdempotencyKey(bk.bookingId, crid);
  const res = await probe('Attach catering + AV → 2xx', {
    url: `${API_BASE}/api/reservations/${bk.bookingId}/services`,
    body: { services: [cateringLine(fx), avLine(fx)] },
    clientRequestId: crid,
    expect: 'success',
  });
  if (!res.ok) return null;

  passAssertion(
    '(1) ≥1 order created for THIS booking (delta exact)',
    countOrders(bk.bookingId) - ordersBefore >= 1,
    `before=${ordersBefore} after=${countOrders(bk.bookingId)}`,
  );
  passAssertion(
    '(1) exactly 2 OLIs created (catering qty=8 + AV qty=1)',
    countOlis(bk.bookingId) - olisBefore === 2 &&
      countOlisForQty(bk.bookingId, 8) === 1 &&
      countOlisForQty(bk.bookingId, 1) === 1,
    `before=${olisBefore} after=${countOlis(bk.bookingId)} q8=${countOlisForQty(bk.bookingId, 8)} q1=${countOlisForQty(bk.bookingId, 1)}`,
  );
  passAssertion(
    '(1) exactly 1 asset_reservation created (AV linked_asset_id)',
    countAssetReservations(bk.bookingId) - arsBefore === 1,
    `before=${arsBefore} after=${countAssetReservations(bk.bookingId)}`,
  );
  passAssertion(
    '(1) exactly 1 attach_operations row, outcome=success',
    countAttachOps(idemKey) === 1 && attachOpOutcome(idemKey) === 'success',
    `count=${countAttachOps(idemKey)} outcome=${attachOpOutcome(idemKey)}`,
  );
  // No service rule on the plain catering/AV items → no approval → the
  // booking is not put into approval and the setup-WO emit is NOT
  // suppressed by any_pending_approval (asserted positively in probe 7;
  // here we just confirm the no-approval baseline).
  passAssertion(
    '(1) no approval rows (plain items, no require_approval rule)',
    countApprovals(bk.bookingId) === 0,
    `approvals=${countApprovals(bk.bookingId)}`,
  );

  return { crid, idemKey };
}

// (2) Idempotency replay — no dup.
async function runIdempotencyProbe(probe, fx, bk, ctx) {
  console.log('\n=== (2) idempotency replay (same booking + same X-CRID) ===');
  const ordersBefore = countOrders(bk.bookingId);
  const olisBefore = countOlis(bk.bookingId);
  const arsBefore = countAssetReservations(bk.bookingId);

  const res = await probe('Replay identical attach (same crid) → 2xx cached', {
    url: `${API_BASE}/api/reservations/${bk.bookingId}/services`,
    body: { services: [cateringLine(fx), avLine(fx)] },
    clientRequestId: ctx.crid,
    expect: 'success',
  });
  if (!res.ok) return;

  passAssertion(
    '(2) no duplicate orders (count unchanged)',
    countOrders(bk.bookingId) === ordersBefore,
    `before=${ordersBefore} after=${countOrders(bk.bookingId)}`,
  );
  passAssertion(
    '(2) no duplicate OLIs (count unchanged)',
    countOlis(bk.bookingId) === olisBefore,
    `before=${olisBefore} after=${countOlis(bk.bookingId)}`,
  );
  passAssertion(
    '(2) no duplicate asset_reservations (count unchanged)',
    countAssetReservations(bk.bookingId) === arsBefore,
    `before=${arsBefore} after=${countAssetReservations(bk.bookingId)}`,
  );
  passAssertion(
    '(2) still exactly 1 attach_operations row, outcome=success',
    countAttachOps(ctx.idemKey) === 1 && attachOpOutcome(ctx.idemKey) === 'success',
    `count=${countAttachOps(ctx.idemKey)} outcome=${attachOpOutcome(ctx.idemKey)}`,
  );
}

// (3) Payload-mismatch 409.
async function runPayloadMismatchProbe(probe, fx, bk, ctx) {
  console.log('\n=== (3) same X-CRID, different payload → 409 payload_mismatch ===');
  const ordersBefore = countOrders(bk.bookingId);
  const olisBefore = countOlis(bk.bookingId);

  const res = await probe('Same crid, DIFFERENT services → 409', {
    url: `${API_BASE}/api/reservations/${bk.bookingId}/services`,
    body: {
      services: [
        { catalog_item_id: fx.cateringCatalogId, quantity: 99, client_line_id: 'as-catering-mismatch' },
      ],
    },
    clientRequestId: ctx.crid,
    expect: 'conflict',
  });
  if (res.ok) {
    const mp = parseJsonSafe(res.body);
    passAssertion(
      '(3) code=booking.idempotency_payload_mismatch',
      mp?.code === 'booking.idempotency_payload_mismatch',
      `code=${mp?.code} body=${res.body.slice(0, 160)}`,
    );
  }
  passAssertion(
    '(3) zero new orders (mismatch rejected before any write)',
    countOrders(bk.bookingId) === ordersBefore,
    `before=${ordersBefore} after=${countOrders(bk.bookingId)}`,
  );
  passAssertion(
    '(3) zero new OLIs',
    countOlis(bk.bookingId) === olisBefore,
    `before=${olisBefore} after=${countOlis(bk.bookingId)}`,
  );
  // No new OLI with the mismatch quantity (99) ever landed.
  passAssertion(
    '(3) no qty=99 OLI persisted (the mismatch payload was never applied)',
    countOlisForQty(bk.bookingId, 99) === 0,
    `q99=${countOlisForQty(bk.bookingId, 99)}`,
  );
}

// (4) Cross-tenant reject.
async function runCrossTenantProbe(headers, fx, bk) {
  console.log('\n=== (4) cross-tenant: Tenant-A JWT + Tenant-B header → reject, no rows ===');
  const ordersBefore = countOrders(bk.bookingId);
  // Reuse the Tenant-A bearer but flip X-Tenant-Id to a foreign tenant —
  // the global tenant binding rejects the JWT-claim≠header mismatch
  // (smoke-cross-tenant.mjs:304-307 + :329) BEFORE the booking is looked
  // up. A dedicated prober with the wrong-tenant header.
  const xtHeaders = { ...headers, 'X-Tenant-Id': OTHER_TENANT_ID };
  const probe = makeProber(xtHeaders);
  const res = await probe('Attach to Tenant-A booking under Tenant-B header → reject', {
    url: `${API_BASE}/api/reservations/${bk.bookingId}/services`,
    body: { services: [cateringLine(fx)] },
    clientRequestId: crypto.randomUUID(),
    expect: 'forbidden',
  });
  // If the global binding ever returns 404 (foreign booking invisible)
  // instead of 403, that is still a correct cross-tenant rejection; the
  // load-bearing assertion is "no rows written under the wrong tenant".
  if (!res.ok && (res.status === 404 || res.status === 401)) {
    results.fail -= 1; // makeProber counted a fail; reclassify as pass
    results.failed.pop();
    results.pass += 1;
    console.log(`  ✓ (reclassified) cross-tenant rejected with HTTP ${res.status} (still a correct reject)`);
  }
  passAssertion(
    '(4) zero orders written for the booking under the wrong tenant',
    countOrders(bk.bookingId) === ordersBefore,
    `before=${ordersBefore} after=${countOrders(bk.bookingId)}`,
  );
  // Also assert nothing landed under OTHER_TENANT_ID for this booking id.
  passAssertion(
    '(4) zero orders for this booking_id under OTHER_TENANT_ID',
    num(
      `select count(*) from public.orders where tenant_id='${OTHER_TENANT_ID}'::uuid and booking_id='${bk.bookingId}'::uuid;`,
    ) === 0,
    'a row leaked under the foreign tenant',
  );
}

// (5) Missing CRID 400.
async function runMissingCridProbe(probe, fx, bk) {
  console.log('\n=== (5) missing X-Client-Request-Id → 400 ===');
  const ordersBefore = countOrders(bk.bookingId);
  await probe('Attach with NO X-Client-Request-Id → 400', {
    url: `${API_BASE}/api/reservations/${bk.bookingId}/services`,
    body: { services: [cateringLine(fx)] },
    omitClientRequestId: true,
    expect: 'badrequest',
  });
  passAssertion(
    '(5) zero new orders (guard rejected before the service layer)',
    countOrders(bk.bookingId) === ordersBefore,
    `before=${ordersBefore} after=${countOrders(bk.bookingId)}`,
  );
}

// (6) Atomic rollback (load-bearing P1-3 gate).
async function runAtomicRollbackProbe(probe, fx, bk) {
  console.log('\n=== (6) RPC-internal failure → whole tx rolls back (ZERO partial rows) ===');
  // Pre-seed a CONFIRMED asset_reservations row for fx.rollbackAssetId
  // overlapping the booking window. The AV catalog item rollbackAvCatalogId
  // is linked to rollbackAssetId via linked_asset_type_id, so the attach
  // plan's AR row targets that asset for the booking window. TS
  // `assertAssetInTenant` (bundle.service.ts:629) passes — the asset IS in
  // tenant — so the payload is accepted by the controller + plan-builder.
  // Inside the RPC, `INSERT into public.asset_reservations` (00412:263-274,
  // status='confirmed') trips the asset_reservations_no_overlap GiST
  // exclusion (00142:27-30, 23P01) → the WHOLE transaction (orders + OLIs +
  // AR + the attach_operations marker) rolls back. This is the exact
  // property that proves Postgres atomicity replaced the TS Cleanup queue.
  const blockerAr = crypto.randomUUID();
  runPsql(`
    set session_replication_role='replica';
    insert into public.asset_reservations
      (id, tenant_id, asset_id, start_at, end_at, status, requester_person_id, booking_id)
    values
      ('${blockerAr}'::uuid, '${TENANT_ID}'::uuid, '${fx.rollbackAssetId}'::uuid,
       '${bk.start}'::timestamptz, '${bk.end}'::timestamptz, 'confirmed',
       '${THOMAS_PERSON}'::uuid, null);
    set session_replication_role='origin';
  `);

  const ordersBefore = countOrders(bk.bookingId);
  const olisBefore = countOlis(bk.bookingId);
  const arsBefore = countAssetReservations(bk.bookingId);
  const apprBefore = countApprovals(bk.bookingId);

  const crid = crypto.randomUUID();
  const idemKey = buildAttachServicesIdempotencyKey(bk.bookingId, crid);
  const res = await probe('Attach AV line whose asset is double-booked → error', {
    url: `${API_BASE}/api/reservations/${bk.bookingId}/services`,
    body: {
      services: [
        // catering line lands FIRST inside the RPC (orders/OLIs) — if the
        // tx were NOT atomic, this row would survive the later AR failure.
        { catalog_item_id: fx.cateringCatalogId, quantity: 5, client_line_id: 'as-rollback-catering' },
        {
          catalog_item_id: fx.rollbackAvCatalogId,
          quantity: 1,
          linked_asset_id: fx.rollbackAssetId,
          client_line_id: 'as-rollback-av',
        },
      ],
    },
    clientRequestId: crid,
    expect: 'error',
  });
  passAssertion(
    '(6) request did NOT succeed (RPC raised inside the tx)',
    !(res.status >= 200 && res.status < 300),
    `status=${res.status} body=${res.body.slice(0, 200)}`,
  );
  // THE load-bearing atomicity assertions: ZERO partial rows. The catering
  // order/OLI inserted BEFORE the AR failure must NOT survive.
  passAssertion(
    '(6) ZERO orphan orders (rolled-back tx left no order)',
    countOrders(bk.bookingId) === ordersBefore,
    `before=${ordersBefore} after=${countOrders(bk.bookingId)} — REAL RPC BUG if >before`,
  );
  passAssertion(
    '(6) ZERO orphan OLIs (the catering line did NOT survive the AR failure)',
    countOlis(bk.bookingId) === olisBefore && countOlisForQty(bk.bookingId, 5) === 0,
    `before=${olisBefore} after=${countOlis(bk.bookingId)} q5=${countOlisForQty(bk.bookingId, 5)} — REAL RPC BUG if any`,
  );
  passAssertion(
    '(6) ZERO new asset_reservations for the booking (the conflicting AR rolled back)',
    countAssetReservations(bk.bookingId) === arsBefore,
    `before=${arsBefore} after=${countAssetReservations(bk.bookingId)} — REAL RPC BUG if >before`,
  );
  passAssertion(
    '(6) ZERO new approvals',
    countApprovals(bk.bookingId) === apprBefore,
    `before=${apprBefore} after=${countApprovals(bk.bookingId)}`,
  );
  passAssertion(
    '(6) attach_operations marker rolled back (zero rows for this key)',
    countAttachOps(idemKey) === 0,
    `count=${countAttachOps(idemKey)} — the in_progress marker must roll back with the tx`,
  );
  // The pre-seeded blocker is swept by deleteFixtures via asset_id ∈ assetIds.
}

// (7) Approval suppression.
async function runApprovalSuppressionProbe(probe, fx, bk) {
  console.log('\n=== (7) require_approval service rule → approval rows + setup-WO outbox suppressed ===');
  // The seeded service_rules row (effect=require_approval,
  // target_kind=catalog_item, target_id=apprCatalogId, always-true
  // predicate, approver=NOOR_PERSON) makes the attach plan carry an
  // approvals[] row and any_pending_approval=true → the RPC's setup-WO
  // emit (00412:330-358) is suppressed for THIS booking.
  const apprBefore = countApprovals(bk.bookingId);
  const setupBefore = countSetupWoOutbox(bk.bookingId);

  const crid = crypto.randomUUID();
  const idemKey = buildAttachServicesIdempotencyKey(bk.bookingId, crid);
  const res = await probe('Attach require_approval catering line → 2xx (pending approval)', {
    url: `${API_BASE}/api/reservations/${bk.bookingId}/services`,
    body: {
      services: [
        { catalog_item_id: fx.apprCatalogId, quantity: 6, client_line_id: 'as-appr-1' },
      ],
    },
    clientRequestId: crid,
    expect: 'success',
  });
  if (!res.ok) {
    // The rule path is genuinely available (we seeded it). A failure here
    // is a real signal, not a fixture gap — let the failed HTTP probe
    // stand and skip the dependent DB assertions with an explicit label.
    skipProbe(
      '(7) approval + setup-WO suppression DB assertions',
      `attach HTTP probe did not succeed (status=${res.status}); cannot assert downstream state — investigate, do NOT treat as pass`,
    );
    return;
  }
  const parsed = parseJsonSafe(res.body);
  passAssertion(
    '(7) response carries any_pending_approval=true',
    parsed?.any_pending_approval === true,
    `any_pending_approval=${parsed?.any_pending_approval} body=${res.body.slice(0, 200)}`,
  );
  passAssertion(
    '(7) ≥1 approval row created (pending, booking-targeted)',
    countApprovals(bk.bookingId) - apprBefore >= 1 &&
      scalar(
        `select (count(*) = count(*) filter (where status='pending' and target_entity_type='booking'))::text
           from public.approvals
          where tenant_id='${TENANT_ID}'::uuid and target_entity_type='booking'
            and target_entity_id='${bk.bookingId}'::uuid;`,
      ) === 'true',
    `approvals before=${apprBefore} after=${countApprovals(bk.bookingId)}`,
  );
  passAssertion(
    '(7) the approval row approves to the rule-configured person (NOOR_PERSON)',
    num(
      `select count(*) from public.approvals
        where tenant_id='${TENANT_ID}'::uuid and target_entity_type='booking'
          and target_entity_id='${bk.bookingId}'::uuid
          and approver_person_id='${NOOR_PERSON}'::uuid;`,
    ) >= 1,
    'no approval row routed to the seeded approver',
  );
  passAssertion(
    '(7) setup_work_order.create_required outbox SUPPRESSED for this booking',
    countSetupWoOutbox(bk.bookingId) === setupBefore,
    `before=${setupBefore} after=${countSetupWoOutbox(bk.bookingId)} — emit must wait for approval (00412:330)`,
  );
}

// ─────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(
    `Smoke-testing attach_services_to_existing_booking (POST /reservations/:id/services) against ${API_BASE}`,
  );

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

  // Pre-flight — the attach RPC must exist on remote.
  try {
    const exists = runPsqlQuery(
      "select to_regprocedure('public.attach_services_to_existing_booking(uuid,jsonb,uuid,text)') is not null",
    );
    if (exists !== 't') {
      console.error('✗ public.attach_services_to_existing_booking RPC is NOT on remote.');
      process.exit(1);
    }
    console.log('✓ pre-flight: attach_services_to_existing_booking RPC present on remote');
  } catch (e) {
    console.error(`✗ pre-flight query failed: ${e.message}`);
    process.exit(2);
  }

  const state = { allSpaceIds: [], fixtureIds: null, bookingIds: new Set() };

  try {
    const fx = mkFixtureIds('main');
    state.fixtureIds = fx;
    const spaceIds = mkSpaceIds('main', 2);
    state.allSpaceIds.push(...spaceIds);

    runPsql(
      `set session_replication_role='replica';\n` +
        spaceSeedSql(spaceIds, 'main') +
        catalogSeedSql(fx) +
        `\nset session_replication_role='origin';`,
    );
    console.log(`Seeded 2 rooms + catering/AV/approval catalog + require_approval rule (+${FIXTURE_DAYS}d)…`);

    const accessToken = await mintAdminToken();
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'X-Tenant-Id': TENANT_ID,
      'Content-Type': 'application/json',
    };
    const probe = makeProber(headers);

    // Each probe gets its OWN fresh no-services booking so deltas are
    // clean and probes don't cross-contaminate. Different rooms / hours
    // so the slot inserts never collide on the shared remote.
    const bk1 = await createFixtureBooking(probe, spaceIds[0], 9, 'atomic+idem+mismatch');
    if (bk1) {
      state.bookingIds.add(bk1.bookingId);
      const ctx = await runAtomicAttachProbe(probe, fx, bk1);
      if (ctx) {
        await runIdempotencyProbe(probe, fx, bk1, ctx);
        await runPayloadMismatchProbe(probe, fx, bk1, ctx);
      }
    }

    const bk2 = await createFixtureBooking(probe, spaceIds[0], 11, 'cross-tenant');
    if (bk2) {
      state.bookingIds.add(bk2.bookingId);
      await runCrossTenantProbe(headers, fx, bk2);
    }

    const bk3 = await createFixtureBooking(probe, spaceIds[0], 13, 'missing-crid');
    if (bk3) {
      state.bookingIds.add(bk3.bookingId);
      await runMissingCridProbe(probe, fx, bk3);
    }

    const bk4 = await createFixtureBooking(probe, spaceIds[0], 15, 'atomic-rollback');
    if (bk4) {
      state.bookingIds.add(bk4.bookingId);
      await runAtomicRollbackProbe(probe, fx, bk4);
    }

    const bk5 = await createFixtureBooking(probe, spaceIds[0], 19, 'approval-suppression');
    if (bk5) {
      state.bookingIds.add(bk5.bookingId);
      await runApprovalSuppressionProbe(probe, fx, bk5);
    }
  } finally {
    console.log('\nCleaning up fixtures…');
    await deleteFixtures(state);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${results.pass} pass / ${results.fail} fail / ${results.skip} skip`);
  if (results.skip > 0) {
    console.log(`Skipped (NOT counted as pass — investigate):\n  - ${results.skipped.join('\n  - ')}`);
  }
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

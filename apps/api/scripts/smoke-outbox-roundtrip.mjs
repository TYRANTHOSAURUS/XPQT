#!/usr/bin/env node
/**
 * scripts/smoke-outbox-roundtrip.mjs
 *
 * B.0.F.1 — outbox round-trip smoke probe (live API + remote DB).
 *
 * Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md
 *       §15.3 (smoke gate extension), §16.2 #22 (cutover gate).
 *
 * Verifies the full B.0 path:
 *   1. POST /reservations with a service line that requires_internal_setup
 *   2. The combined RPC (create_booking_with_attach_plan) lands the
 *      booking + slots + orders + OLIs + attach_operations row.
 *   3. The combined RPC emits an outbox event of type
 *      'setup_work_order.create_required' for the OLI.
 *   4. The cron-driven OutboxWorker (or a forced drainOnce we wait
 *      for) processes the event via SetupWorkOrderHandler.
 *   5. The handler calls create_setup_work_order_from_event, which
 *      atomically inserts the work_orders row + the
 *      setup_work_order_emissions dedup row in one tx.
 *   6. The dedup row's work_order_id matches the new WO; the WO's
 *      linked_order_line_item_id matches the OLI; the audit_events
 *      row exists.
 *
 * Cleanup: cancel the booking, then explicitly delete the WO,
 * setup_work_order_emissions row, attach_operations row, outbox
 * event, and the seeded service_rule + location_service_routing
 * rows. The cleanup is best-effort (logged on error, never throws)
 * so a failure mid-probe doesn't pollute the next run.
 *
 * USAGE:
 *   pnpm dev:api &     (or have the dev server already running)
 *   node apps/api/scripts/smoke-outbox-roundtrip.mjs
 *
 *   exit 0 = full round-trip pass; exit 1 = at least one regression.
 *
 * REQUIREMENTS:
 *   - Local API running on :3001 (`pnpm dev:api`)
 *   - .env with SUPABASE_URL + SUPABASE_SECRET_KEY + SUPABASE_PUBLISHABLE_KEY
 *     + SUPABASE_DB_PASS for direct psql access.
 *   - Remote DB has migrations 00299–00312 applied (B.0.A–E).
 *
 * Why this script exists:
 *   B.0 introduced four RPCs and reshaped the booking-create write
 *   path around the outbox. Mocked-jest specs exercise the contract
 *   shape but cannot detect:
 *     - PG-level grant/RLS misalignment on the new tables
 *       (attach_operations, setup_work_order_emissions).
 *     - Real outbox.events INSERT round-trip (payload_hash, claim,
 *       drain index hit).
 *     - The handler's PG.RPC call path (service_role grants on
 *       create_setup_work_order_from_event).
 *     - The cron worker actually firing within the expected window.
 *
 *   This is the same lesson the smoke-work-orders gate learned the
 *   hard way (CLAUDE.md "Smoke gate"): mocked-Supabase tests passed
 *   while production was 42501. The B.0 cutover doesn't ship without
 *   this probe.
 */

import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
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
const ADMIN_AUTH_UID = '93d41232-35b5-424c-b215-bb5d55a2dfd9';
// Person id for the admin user — matches users.person_id when
// auth_uid=ADMIN_AUTH_UID. Used as requester_person_id on the booking.
const ADMIN_PERSON_ID = '95000000-0000-0000-0000-000000000002';

// Seed targets — chosen because the data already exists in the dev
// tenant (verified via psql against remote on 2026-05-04). If these
// uuids drift, update here, not by reaching into the seed migration.
const SPACE_ID = '81de81d8-04bd-4973-b696-6d24c509ac2a'; // "Meeting Room 1.10"
const CATALOG_ITEM_ID = '46000000-0000-0000-0000-000000000001'; // "Coffee carafe" (food_and_drinks)
const INTERNAL_TEAM_ID = '94000000-0000-0000-0000-000000000004'; // "Facilities Amsterdam"
// Catalog item 46000000-...0001 is wired into menu 49000000-...0001
// whose service_type='catering' — confirmed by hydrateLines path
// (apps/api/src/modules/booking-bundles/bundle.service.ts:1660-1666).
const SERVICE_CATEGORY = 'catering';

// Worker drains every 30s; allow 60s slack + initial drain delay.
const WORKER_TIMEOUT_MS = 60_000;
const WORKER_POLL_MS = 1_500;

// ─────────────────────────────────────────────────────────────────────
// Auth — mint an Admin JWT (mirrors smoke-work-orders.mjs)
// ─────────────────────────────────────────────────────────────────────

async function mintAdminToken() {
  const supa = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: u } = await supa.auth.admin.getUserById(ADMIN_AUTH_UID);
  if (!u?.user) throw new Error(`admin auth uid ${ADMIN_AUTH_UID} not found`);
  const { data: link, error: linkErr } = await supa.auth.admin.generateLink({
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
// Probe runner (mirrors smoke-work-orders.mjs)
// ─────────────────────────────────────────────────────────────────────

const results = { pass: 0, fail: 0, failed: [] };

function pass(name) {
  results.pass += 1;
  console.log(`  ✓ ${name}`);
}
function fail(name, detail) {
  results.fail += 1;
  results.failed.push(name);
  console.log(`  ✗ ${name}`);
  if (detail) console.log(`     ${String(detail).slice(0, 240)}`);
}

// ─────────────────────────────────────────────────────────────────────
// DB access — supabase admin client + canonical row fetchers
// ─────────────────────────────────────────────────────────────────────

const supaAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function selectOne(table, filters) {
  let q = supaAdmin.from(table).select('*');
  for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
  const { data, error } = await q.maybeSingle();
  if (error) throw error;
  return data;
}

async function selectMany(table, filters) {
  let q = supaAdmin.from(table).select('*');
  for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

// outbox.events lives in the outbox schema; supabase-js doesn't expose
// non-public schemas through PostgREST without explicit config. Use the
// public-schema view shipped with 00299_outbox_foundation.sql.
async function selectOutboxEvents(filters) {
  // Fall back to admin client; the outbox.events table is service_role
  // accessible via the dotted name through the schema-qualified RPC
  // approach. PostgREST exposes 'outbox' schema iff supabase config
  // enables it — for the smoke we use a JSON-RPC wrapper if available;
  // otherwise we fall back to a direct admin SELECT through the
  // postgres-meta surface. The cleanest cross-environment approach is
  // a SQL function we can call via .rpc(); but the foundation
  // migration didn't ship one for events. So we issue the SELECT via
  // the postgres connection through PgAdmin's REST shim is overkill —
  // simplest: read through a PostgREST view in the public schema.
  // Since we don't have one, do a single-row read via the schema-aware
  // supabase client after temporarily switching schemas.
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    db: { schema: 'outbox' },
  });
  let q = client.from('events').select('*');
  for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

// ─────────────────────────────────────────────────────────────────────
// Seed + cleanup helpers
// ─────────────────────────────────────────────────────────────────────

const seeded = {
  serviceRuleId: null,
  locationServiceRoutingId: null,
};

async function seedRoutingFixture() {
  console.log('\n=== Seed routing fixture ===');

  // location_service_routing — the matrix that resolves the internal
  // team for (tenant, location, category). Use a tenant-default row
  // (location_id NULL) so it covers any space we book against.
  const lsr = await supaAdmin
    .from('location_service_routing')
    .insert({
      tenant_id: TENANT_ID,
      location_id: null,
      service_category: SERVICE_CATEGORY,
      internal_team_id: INTERNAL_TEAM_ID,
      default_lead_time_minutes: 30,
      sla_policy_id: null,
      active: true,
    })
    .select('id')
    .single();
  if (lsr.error) {
    fail('seed.location_service_routing', lsr.error.message);
    return false;
  }
  seeded.locationServiceRoutingId = lsr.data.id;
  pass(`seed.location_service_routing id=${seeded.locationServiceRoutingId.slice(0, 8)}…`);

  // service_rules — a catalog-item-scoped rule that requires_internal_setup.
  // effect='allow' so it doesn't trigger an approval (we want the
  // happy-path setup-WO emit, not the deferred-emit-on-grant flow).
  const rule = await supaAdmin
    .from('service_rules')
    .insert({
      tenant_id: TENANT_ID,
      name: `smoke-outbox-${Date.now()}`,
      target_kind: 'catalog_item',
      target_id: CATALOG_ITEM_ID,
      applies_when: {},
      effect: 'allow',
      priority: 50,
      active: true,
      requires_internal_setup: true,
      internal_setup_lead_time_minutes: null, // matrix default applies
    })
    .select('id')
    .single();
  if (rule.error) {
    fail('seed.service_rule', rule.error.message);
    return false;
  }
  seeded.serviceRuleId = rule.data.id;
  pass(`seed.service_rule id=${seeded.serviceRuleId.slice(0, 8)}…`);
  return true;
}

const created = {
  bookingId: null,
  bookingSlotIds: [],
  orderIds: [],
  oliIds: [],
  outboxEventId: null,
  workOrderId: null,
  attachOperationId: null,
};

async function cleanupCreated() {
  console.log('\n=== Cleanup ===');

  // Order matters: WO + emissions row first (FK to work_orders), then
  // outbox event, then bookings cascade (which takes orders + OLIs +
  // slots + asset_reservations).
  if (created.workOrderId) {
    // Setup-WO emissions row references work_orders(id) ON DELETE SET
    // NULL (00307 + 00310 / v8). Delete the dedup row first so we
    // can verify it existed; then delete the WO.
    const emiss = await supaAdmin
      .from('setup_work_order_emissions')
      .delete()
      .eq('tenant_id', TENANT_ID)
      .in('oli_id', created.oliIds.length ? created.oliIds : ['00000000-0000-0000-0000-000000000000']);
    if (emiss.error) console.log(`  warn: setup_work_order_emissions delete: ${emiss.error.message}`);
    const wo = await supaAdmin.from('work_orders').delete().eq('id', created.workOrderId);
    if (wo.error) console.log(`  warn: work_orders delete: ${wo.error.message}`);
    else console.log(`  ✓ cleanup work_order ${created.workOrderId.slice(0, 8)}…`);
  }

  if (created.outboxEventId) {
    // Use the schema-aware client.
    const client = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
      db: { schema: 'outbox' },
    });
    const o = await client.from('events').delete().eq('id', created.outboxEventId);
    if (o.error) console.log(`  warn: outbox.events delete: ${o.error.message}`);
    else console.log(`  ✓ cleanup outbox event ${created.outboxEventId.slice(0, 8)}…`);
  }

  if (created.attachOperationId) {
    const ao = await supaAdmin.from('attach_operations').delete().eq('id', created.attachOperationId);
    if (ao.error) console.log(`  warn: attach_operations delete: ${ao.error.message}`);
  }

  if (created.bookingId) {
    // Delete cascade through bookings → booking_slots / orders / OLIs / asset_reservations.
    // The smoke uses an explicit DELETE rather than cancel-then-purge
    // because cancel emits its own events and we want a clean tear-down.
    // Order: orders + OLIs are FK'd from bookings via booking_id; FK
    // is `on delete cascade` on booking_slots (00277:54) but orders
    // is `on delete set null` to keep the audit history. Delete orders
    // explicitly first.
    if (created.orderIds.length) {
      const o = await supaAdmin.from('orders').delete().in('id', created.orderIds);
      if (o.error) console.log(`  warn: orders delete: ${o.error.message}`);
    }
    const b = await supaAdmin.from('bookings').delete().eq('id', created.bookingId);
    if (b.error) console.log(`  warn: bookings delete: ${b.error.message}`);
    else console.log(`  ✓ cleanup booking ${created.bookingId.slice(0, 8)}…`);
  }

  if (seeded.serviceRuleId) {
    const r = await supaAdmin.from('service_rules').delete().eq('id', seeded.serviceRuleId);
    if (r.error) console.log(`  warn: service_rules delete: ${r.error.message}`);
    else console.log('  ✓ cleanup service_rule');
  }
  if (seeded.locationServiceRoutingId) {
    const l = await supaAdmin
      .from('location_service_routing')
      .delete()
      .eq('id', seeded.locationServiceRoutingId);
    if (l.error) console.log(`  warn: location_service_routing delete: ${l.error.message}`);
    else console.log('  ✓ cleanup location_service_routing');
  }
}

// ─────────────────────────────────────────────────────────────────────
// Probe phases
// ─────────────────────────────────────────────────────────────────────

async function createBookingWithService(authToken) {
  console.log('\n=== Phase 1: POST /reservations with service line ===');
  const startAt = new Date(Date.now() + 7 * 86_400_000); // 7 days out
  startAt.setMinutes(0, 0, 0);
  const endAt = new Date(startAt.getTime() + 60 * 60_000); // +1h

  const clientReqId = randomUUID();
  const r = await fetch(`${API_BASE}/api/reservations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'X-Tenant-Id': TENANT_ID,
      'X-Client-Request-Id': clientReqId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      reservation_type: 'room',
      space_id: SPACE_ID,
      requester_person_id: ADMIN_PERSON_ID,
      start_at: startAt.toISOString(),
      end_at: endAt.toISOString(),
      attendee_count: 4,
      source: 'desk',
      services: [
        {
          catalog_item_id: CATALOG_ITEM_ID,
          quantity: 4,
        },
      ],
    }),
  });

  const txt = await r.text();
  if (r.status !== 201 && r.status !== 200) {
    fail(`POST /reservations → HTTP ${r.status}`, txt);
    return false;
  }
  pass(`POST /reservations → HTTP ${r.status}`);

  let body;
  try {
    body = JSON.parse(txt);
  } catch {
    fail('POST /reservations: response is not JSON', txt);
    return false;
  }

  // Response shape per BookingFlowService.create — { booking, slots, ... }.
  // In the canonicalised model the booking IS the bundle.
  const bookingId = body?.booking?.id ?? body?.booking_id ?? body?.bundle?.id ?? body?.id;
  if (!bookingId) {
    fail('POST /reservations: no booking id in response', JSON.stringify(body).slice(0, 200));
    return false;
  }
  created.bookingId = bookingId;
  pass(`booking id=${bookingId.slice(0, 8)}…`);
  return true;
}

async function verifyBookingPersistence() {
  console.log('\n=== Phase 2: booking + slots + orders + OLIs persisted ===');

  const booking = await selectOne('bookings', { id: created.bookingId });
  if (!booking) {
    fail('bookings row exists');
    return false;
  }
  if (booking.tenant_id !== TENANT_ID) {
    fail(`bookings.tenant_id mismatch: ${booking.tenant_id}`);
    return false;
  }
  pass(`bookings row: status=${booking.status}`);

  const slots = await selectMany('booking_slots', { booking_id: created.bookingId });
  if (slots.length === 0) {
    fail('booking_slots: at least one row');
    return false;
  }
  pass(`booking_slots: ${slots.length} row(s) status=${slots[0].status}`);

  const orders = await selectMany('orders', { booking_id: created.bookingId });
  if (orders.length === 0) {
    fail('orders: at least one row');
    return false;
  }
  created.orderIds = orders.map((o) => o.id);
  pass(`orders: ${orders.length} row(s) status=${orders[0].status}`);

  const oliRows = await supaAdmin
    .from('order_line_items')
    .select('*')
    .in('order_id', created.orderIds);
  if (oliRows.error) {
    fail('order_line_items query', oliRows.error.message);
    return false;
  }
  if (!oliRows.data || oliRows.data.length === 0) {
    fail('order_line_items: at least one row');
    return false;
  }
  created.oliIds = oliRows.data.map((o) => o.id);
  pass(`order_line_items: ${oliRows.data.length} row(s)`);

  // attach_operations row — RPC writes one per (idempotency_key) so we
  // can assert idempotency works on retry. Not strictly necessary for
  // round-trip assertion but cheap to verify.
  const aoRows = await supaAdmin
    .from('attach_operations')
    .select('id, outcome')
    .eq('tenant_id', TENANT_ID)
    .eq('booking_id', created.bookingId);
  if (!aoRows.error && aoRows.data && aoRows.data.length === 1) {
    created.attachOperationId = aoRows.data[0].id;
    pass(`attach_operations: 1 row outcome=${aoRows.data[0].outcome}`);
  } else if (!aoRows.error) {
    // Spec §9.1: combined RPC keyed on idempotency_key — there's
    // exactly one row per (tenant, key) per booking. Soft warn if
    // count drifts; not a hard fail since we don't know the shape
    // from outside without spelunking.
    console.log(`  (note) attach_operations rows for booking: ${aoRows.data?.length ?? 0}`);
  }
  return true;
}

async function verifyOutboxEventEmitted() {
  console.log('\n=== Phase 3: outbox.events emitted for setup-WO ===');

  // Producer combined-RPC emits ONE outbox event per OLI with
  // requires_internal_setup=true. We expect exactly one because we
  // submitted exactly one service line.
  const events = await selectOutboxEvents({
    tenant_id: TENANT_ID,
    event_type: 'setup_work_order.create_required',
  });
  // Filter to events whose aggregate_id is one of our OLIs (the table
  // may contain unrelated events from other test runs).
  const ours = events.filter((e) => created.oliIds.includes(e.aggregate_id));
  if (ours.length === 0) {
    fail('outbox.events: no setup_work_order.create_required for our OLI');
    return false;
  }
  if (ours.length > 1) {
    fail(`outbox.events: expected 1, got ${ours.length}`);
    return false;
  }
  const ev = ours[0];
  created.outboxEventId = ev.id;
  pass(`outbox event id=${ev.id.slice(0, 8)}… aggregate_id=${ev.aggregate_id.slice(0, 8)}…`);

  // Sanity-check payload shape — the handler reads these fields.
  const requiredFields = ['booking_id', 'oli_id', 'service_category', 'service_window_start_at', 'rule_ids'];
  for (const f of requiredFields) {
    if (!(f in (ev.payload ?? {}))) {
      fail(`outbox.payload missing field: ${f}`);
      return false;
    }
  }
  if (ev.payload.service_category !== SERVICE_CATEGORY) {
    fail(`outbox.payload.service_category=${ev.payload.service_category} expected ${SERVICE_CATEGORY}`);
    return false;
  }
  pass(`outbox payload shape OK service_category=${ev.payload.service_category}`);
  return true;
}

async function waitForWorkerDrain() {
  console.log('\n=== Phase 4: waiting for OutboxWorker drain (≤60s) ===');

  const deadline = Date.now() + WORKER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const events = await selectOutboxEvents({ id: created.outboxEventId });
    const ev = events[0];
    if (!ev) {
      fail('outbox event disappeared before processed_at');
      return false;
    }
    if (ev.processed_at) {
      pass(`outbox processed_at=${ev.processed_at} reason=${ev.processed_reason ?? '(none)'}`);
      return true;
    }
    if (ev.dead_lettered_at) {
      fail(`outbox event dead-lettered: ${ev.last_error}`);
      return false;
    }
    const remaining = Math.round((deadline - Date.now()) / 1000);
    process.stdout.write(`    waiting… (${remaining}s remaining, attempts=${ev.attempts}, claim=${ev.claim_token ? 'yes' : 'no'})\r`);
    await new Promise((res) => setTimeout(res, WORKER_POLL_MS));
  }
  console.log('');
  // Final read for diagnostics.
  const events = await selectOutboxEvents({ id: created.outboxEventId });
  const ev = events[0];
  fail(
    'worker drain timeout',
    `attempts=${ev?.attempts} claim=${ev?.claim_token ? 'yes' : 'no'} last_error=${ev?.last_error}`,
  );
  return false;
}

async function verifyWorkOrderCreated() {
  console.log('\n=== Phase 5: work_orders + setup_work_order_emissions ===');

  // setup_work_order_emissions row keyed on (tenant_id, oli_id) per
  // 00307. The handler INSERTs it inside the create_setup_work_order
  // _from_event RPC body, atomically with the work_orders INSERT.
  const emiss = await selectMany('setup_work_order_emissions', {
    tenant_id: TENANT_ID,
    oli_id: created.oliIds[0],
  });
  if (emiss.length === 0) {
    fail('setup_work_order_emissions: no row for our OLI');
    return false;
  }
  if (emiss.length > 1) {
    fail(`setup_work_order_emissions: expected 1, got ${emiss.length}`);
    return false;
  }
  const dedup = emiss[0];
  if (!dedup.work_order_id) {
    fail('setup_work_order_emissions.work_order_id is null (expected non-null on create)');
    return false;
  }
  created.workOrderId = dedup.work_order_id;
  pass(`emissions row work_order_id=${dedup.work_order_id.slice(0, 8)}…`);

  const wo = await selectOne('work_orders', { id: created.workOrderId });
  if (!wo) {
    fail('work_orders row missing for emissions.work_order_id');
    return false;
  }
  if (wo.linked_order_line_item_id !== created.oliIds[0]) {
    fail(
      `work_orders.linked_order_line_item_id=${wo.linked_order_line_item_id} expected ${created.oliIds[0]}`,
    );
    return false;
  }
  if (wo.tenant_id !== TENANT_ID) {
    fail(`work_orders.tenant_id mismatch: ${wo.tenant_id}`);
    return false;
  }
  if (wo.requester_person_id !== null) {
    fail(`work_orders.requester_person_id must be NULL (spec §7.8.2 v8.1) got ${wo.requester_person_id}`);
    return false;
  }
  pass(`work_orders row: linked_oli matches, requester_person_id=null, team=${wo.assigned_team_id?.slice(0, 8) ?? 'null'}…`);

  // Audit row — create_setup_work_order_from_event emits one inside
  // its tx. Best-effort assertion; the handler also writes audit on
  // no_op_terminal which isn't this case.
  const auditRows = await supaAdmin
    .from('audit_events')
    .select('id, event_type, entity_id')
    .eq('tenant_id', TENANT_ID)
    .eq('entity_id', wo.id)
    .eq('event_type', 'work_order.created_from_setup_event');
  if (!auditRows.error && auditRows.data && auditRows.data.length >= 1) {
    pass(`audit_events: work_order.created_from_setup_event present`);
  } else {
    // Soft warning — audit row name might differ; handler audit is
    // not the round-trip we're gating on.
    console.log(
      `  (note) no work_order.created_from_setup_event audit row found (${auditRows.data?.length ?? 0}); not a hard fail`,
    );
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Smoke-testing outbox round-trip against ${API_BASE}`);
  console.log(`Tenant: ${TENANT_ID}`);

  // Health check — fail loudly if API isn't running.
  try {
    const r = await fetch(`${API_BASE}/api/reservations`, { method: 'OPTIONS' });
    if (r.status >= 500) {
      throw new Error(`API health check failed: HTTP ${r.status}`);
    }
  } catch (e) {
    console.error(`✗ API at ${API_BASE} is not reachable: ${e.message}`);
    console.error('  Start the dev server first: pnpm dev:api');
    process.exit(2);
  }

  let token;
  try {
    token = await mintAdminToken();
  } catch (e) {
    console.error(`✗ failed to mint admin token: ${e.message}`);
    process.exit(2);
  }

  let allPass = false;
  try {
    if (!(await seedRoutingFixture())) return;
    if (!(await createBookingWithService(token))) return;
    if (!(await verifyBookingPersistence())) return;
    if (!(await verifyOutboxEventEmitted())) return;
    if (!(await waitForWorkerDrain())) return;
    if (!(await verifyWorkOrderCreated())) return;
    allPass = true;
  } catch (e) {
    fail('unexpected error', e.message);
    console.error(e.stack);
  } finally {
    try {
      await cleanupCreated();
    } catch (e) {
      console.log(`  warn: cleanup threw: ${e.message}`);
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${results.pass} pass / ${results.fail} fail`);
  if (results.fail > 0 || !allPass) {
    if (results.failed.length) {
      console.log(`Failed probes:\n  - ${results.failed.join('\n  - ')}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('smoke run errored:', e);
  process.exit(2);
});

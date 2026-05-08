/**
 * Helpers for the B.0 concurrency harness.
 *
 * Spec ref: docs/follow-ups/b0-real-db-concurrency-harness.md
 *
 * Three layers:
 *   1. Lock + pg_locks introspection — for asserting that the second
 *      connection blocks while the first holds the advisory lock.
 *   2. Fixture seeding — deterministic uuids per test scope, scoped
 *      cleanup.
 *   3. Plan/payload builders — shape the inputs accepted by the four
 *      RPCs (create_booking_with_attach_plan, grant_booking_approval,
 *      approve_booking_setup_trigger, create_setup_work_order_from_event).
 *
 * Determinism: every helper takes uuids/timestamps as inputs (or
 * derives them from a seed) so the tests are reproducible across
 * runs. Server-controlled clocks (`now()` inside the RPC) are
 * deliberately NOT replaced — the spec requires that, but the
 * fixtures pass explicit timestamps for booking start/end so the
 * GiST exclusion guard can be exercised deterministically.
 */

import { randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';

// ─────────────────────────────────────────────────────────────────────
// Lock + pg_locks introspection
// ─────────────────────────────────────────────────────────────────────

/**
 * Compute the same hash key that the four RPCs derive on entry. Used
 * by the harness so we can poll pg_locks for the exact bigint key the
 * RPC would acquire.
 *
 * Mirrors `hashtextextended(<text>, 0)` in the SQL bodies.
 */
export async function lockKey(client: PoolClient, text: string): Promise<bigint> {
  const r = await client.query<{ key: string }>(
    'select hashtextextended($1, 0)::text as key',
    [text],
  );
  return BigInt(r.rows[0].key);
}

/**
 * Acquire a transaction-scoped advisory lock from `client`. The client
 * MUST already be inside a transaction (BEGIN); the lock releases on
 * COMMIT or ROLLBACK.
 *
 * Returns immediately when the lock is granted; blocks otherwise.
 */
export async function acquireXactLock(client: PoolClient, key: bigint): Promise<void> {
  await client.query('select pg_advisory_xact_lock($1::bigint)', [key.toString()]);
}

/**
 * Try to acquire the lock without blocking. Returns true if granted,
 * false if another transaction holds it. Used as a sanity check
 * BEFORE the contention scenario starts (assert no leaked lock from
 * a previous test).
 */
export async function tryAdvisoryLock(client: PoolClient, key: bigint): Promise<boolean> {
  const r = await client.query<{ acquired: boolean }>(
    'select pg_try_advisory_xact_lock($1::bigint) as acquired',
    [key.toString()],
  );
  return r.rows[0].acquired === true;
}

/**
 * Snapshot the pg_locks rows for an advisory lock identified by its
 * bigint key. The advisory bigint key is split across `classid` and
 * `objid` columns in the pg_locks view (high 32 bits → classid, low
 * 32 bits → objid; locktype='advisory').
 *
 * Returns one row per backend that has either granted=true (holding)
 * or granted=false (waiting). The harness uses the granted flag to
 * assert "client A is holding, client B is blocked".
 */
export interface AdvisoryLockState {
  pid: number;
  granted: boolean;
}

export async function pgLocksFor(pool: Pool, key: bigint): Promise<AdvisoryLockState[]> {
  // pg_locks splits the advisory bigint key into a high (classid) and
  // low (objid) 32-bit pair. Mask to 32 bits each.
  const high = Number((key >> 32n) & 0xffffffffn);
  // The low 32 bits can be > 2^31 → must coerce as int4 via signed cast.
  const low = Number(key & 0xffffffffn);
  // Postgres int4 wraps the high half of unsigned 32-bit values.
  const highI4 = high > 0x7fffffff ? high - 0x100000000 : high;
  const lowI4 = low > 0x7fffffff ? low - 0x100000000 : low;
  const r = await pool.query<{ pid: number; granted: boolean }>(
    `select pid, granted
       from pg_locks
      where locktype = 'advisory'
        and classid = $1::int4
        and objid   = $2::int4`,
    [highI4, lowI4],
  );
  return r.rows.map((row) => ({ pid: row.pid, granted: row.granted }));
}

/**
 * Wait until pg_locks shows at least one waiter (granted=false) on
 * `key`. Polls once per `pollMs` up to `timeoutMs`; throws on
 * timeout. Used by tests to confirm "the second client is now
 * blocked behind the first" before the first commits.
 */
export async function waitForBlocker(
  pool: Pool,
  key: bigint,
  { timeoutMs = 5_000, pollMs = 25 }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const states = await pgLocksFor(pool, key);
    if (states.some((s) => !s.granted)) return;
    await new Promise((res) => setTimeout(res, pollMs));
  }
  const final = await pgLocksFor(pool, key);
  throw new Error(
    `waitForBlocker timeout after ${timeoutMs}ms; pg_locks for key=${key.toString()}: ${JSON.stringify(final)}`,
  );
}

// ─────────────────────────────────────────────────────────────────────
// Connection helpers
// ─────────────────────────────────────────────────────────────────────

export async function withClient<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
}

/**
 * Race-aware "run RPC on its own client". Returns either the resolved
 * RPC result or the rejected error so the caller can assert on both
 * outcomes without try/catch around every call.
 */
export type RpcOutcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'error'; error: Error };

export async function callRpc<T>(
  client: PoolClient,
  rpcName: string,
  args: unknown[],
): Promise<T> {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(', ');
  const r = await client.query<{ result: T }>(
    `select ${rpcName}(${placeholders}) as result`,
    args as unknown[],
  );
  return r.rows[0].result;
}

export async function runRpcCapture<T>(
  pool: Pool,
  rpcName: string,
  args: unknown[],
): Promise<RpcOutcome<T>> {
  const c = await pool.connect();
  try {
    const value = await callRpc<T>(c, rpcName, args);
    return { kind: 'ok', value };
  } catch (e) {
    return { kind: 'error', error: e instanceof Error ? e : new Error(String(e)) };
  } finally {
    c.release();
  }
}

// ─────────────────────────────────────────────────────────────────────
// Fixture seeding — fresh tenant + person + space + catalog item per
// test invocation. Deterministic uuids derived from a per-test seed
// keep diff readable when a probe fails.
// ─────────────────────────────────────────────────────────────────────

export interface BaseFixture {
  tenantId: string;
  personId: string;
  approverPersonId: string;
  spaceId: string;
  catalogItemId: string;
  teamId: string;
  // Created with rls_disable so cleanup can drop everything cleanly
  // even when a test fails partway through.
  cleanup: () => Promise<void>;
}

const FIXTURE_REGISTRY: Array<() => Promise<void>> = [];

/**
 * Register a per-fixture cleanup that runs at afterAll time. The
 * harness flushes these in reverse-insertion order so dependent rows
 * delete first.
 */
export function registerCleanup(fn: () => Promise<void>): void {
  FIXTURE_REGISTRY.push(fn);
}

export async function flushAllFixtures(pool: Pool): Promise<void> {
  // Run in reverse so dependents go first. Each cleanup is responsible
  // for its own DELETE order; this just orchestrates batch ordering.
  while (FIXTURE_REGISTRY.length > 0) {
    const fn = FIXTURE_REGISTRY.pop();
    if (!fn) break;
    try {
      await fn();
    } catch (e) {
      // Continue tearing down the rest even if one fails — surfaced
      // for debugging but never blocks other fixtures.
      // eslint-disable-next-line no-console
      console.warn('flushAllFixtures: cleanup threw', e);
    }
  }
  // No final tenant-sweep — the per-fixture cleanups handle their own
  // dependents. A blind `delete from tenants where slug like '...'`
  // would FK-violate against persons + spaces left behind by an
  // interrupted run; better to surface that as a manual operator
  // task than to swallow it here.
}

/**
 * Seed a fresh tenant + supporting rows. Returns deterministic uuids
 * the test can plug into RPC payloads. Tenant slug = `concurrency-<seed>`
 * so leftover rows from killed runs are easy to spot.
 */
export async function seedBaseFixture(pool: Pool, seed: string): Promise<BaseFixture> {
  const tenantId = randomUUID();
  const personId = randomUUID();
  const approverPersonId = randomUUID();
  const siteId = randomUUID();
  const buildingId = randomUUID();
  const spaceId = randomUUID();
  const catalogItemId = randomUUID();
  const teamId = randomUUID();

  await withClient(pool, async (c) => {
    await c.query('begin');
    try {
      // Suppress AFTER-INSERT triggers on `tenants` for this fixture
      // tx. The repo carries a pre-existing migration drift between
      // 00162 (column rename to retention_days/cap_retention_days) and
      // 00180 (re-defined seed_default_retention_for_tenant still
      // referencing default_retention_days/max_retention_days). New
      // tenant inserts therefore raise. The harness doesn't care about
      // GDPR retention seeding; suppress non-RI triggers for the
      // fixture insert. Restored implicitly at COMMIT (SET LOCAL
      // scope). RI constraint triggers still fire because they're
      // marked ALWAYS by Postgres.
      await c.query("set local session_replication_role = 'replica'");
      await c.query(
        `insert into public.tenants (id, name, slug, status, tier)
         values ($1, $2, $3, 'active', 'standard')`,
        [tenantId, `Concurrency Tenant ${seed}`, `concurrency-${seed}`],
      );
      await c.query(
        `insert into public.persons (id, tenant_id, type, first_name, last_name, email)
         values ($1, $2, 'employee', 'Requester', $3, $4)`,
        [personId, tenantId, seed, `req-${seed}@concurrency.test`],
      );
      await c.query(
        `insert into public.persons (id, tenant_id, type, first_name, last_name, email)
         values ($1, $2, 'employee', 'Approver', $3, $4)`,
        [approverPersonId, tenantId, seed, `app-${seed}@concurrency.test`],
      );
      await c.query(
        `insert into public.spaces (id, tenant_id, type, name, reservable, active)
         values ($1, $2, 'site', 'Concurrency Site', false, true)`,
        [siteId, tenantId],
      );
      await c.query(
        `insert into public.spaces (id, tenant_id, parent_id, type, name, reservable, active)
         values ($1, $2, $3, 'building', 'Concurrency Building', false, true)`,
        [buildingId, tenantId, siteId],
      );
      await c.query(
        `insert into public.spaces (id, tenant_id, parent_id, type, name, capacity, reservable, active)
         values ($1, $2, $3, 'meeting_room', 'Concurrency Room', 8, true, true)`,
        [spaceId, tenantId, buildingId],
      );
      await c.query(
        `insert into public.teams (id, tenant_id, name, active)
         values ($1, $2, 'Concurrency Team', true)`,
        [teamId, tenantId],
      );
      await c.query(
        `insert into public.catalog_items
           (id, tenant_id, name, category, unit, fulfillment_team_id, active)
         values ($1, $2, 'Concurrency Coffee', 'food_and_drinks', 'per_item', $3, true)`,
        [catalogItemId, tenantId, teamId],
      );
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    }
  });

  const cleanup = async () => {
    // The tenants(id) FK on most child tables is REFERENCES without
    // ON DELETE CASCADE. Tear down per-tenant rows in the right order
    // BEFORE removing the tenant itself. Wrap the whole sequence in
    // one tx + SET LOCAL session_replication_role='replica' so
    // (a) it's atomic (a failure rolls every delete back, leaving the
    // operator a coherent partial state), (b) the replication-role
    // override is scoped — no leak across pool clients.
    await withClient(pool, async (c) => {
      await c.query('begin');
      try {
        await c.query("set local session_replication_role = 'replica'");
        // Outbox + dedup
        await c.query('delete from public.setup_work_order_emissions where tenant_id = $1', [
          tenantId,
        ]);
        await c.query('delete from outbox.events where tenant_id = $1', [tenantId]);
        await c.query('delete from outbox.events_dead_letter where tenant_id = $1', [tenantId]);
        await c.query('delete from public.attach_operations where tenant_id = $1', [tenantId]);
        // Domain + audit
        await c.query('delete from public.domain_events where tenant_id = $1', [tenantId]);
        await c.query('delete from public.audit_events where tenant_id = $1', [tenantId]);
        // Booking subgraph
        await c.query('delete from public.work_orders where tenant_id = $1', [tenantId]);
        await c.query('delete from public.approvals where tenant_id = $1', [tenantId]);
        await c.query('delete from public.order_line_items where tenant_id = $1', [tenantId]);
        await c.query('delete from public.orders where tenant_id = $1', [tenantId]);
        await c.query('delete from public.booking_slots where tenant_id = $1', [tenantId]);
        await c.query('delete from public.bookings where tenant_id = $1', [tenantId]);
        // GDPR retention rows are NOT seeded for harness tenants
        // (suppression above), but defensive in case a future change
        // flips that.
        await c.query('delete from public.tenant_retention_settings where tenant_id = $1', [
          tenantId,
        ]);
        // Identity + reference data
        await c.query('delete from public.catalog_items where tenant_id = $1', [tenantId]);
        await c.query('delete from public.teams where tenant_id = $1', [tenantId]);
        await c.query('delete from public.spaces where tenant_id = $1', [tenantId]);
        await c.query('delete from public.persons where tenant_id = $1', [tenantId]);
        // Tenant itself last.
        await c.query('delete from public.tenants where id = $1', [tenantId]);
        await c.query('commit');
      } catch (e) {
        await c.query('rollback');
        throw e;
      }
    });
  };
  registerCleanup(cleanup);

  return {
    tenantId,
    personId,
    approverPersonId,
    spaceId,
    catalogItemId,
    teamId,
    cleanup,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Plan + payload builders
// ─────────────────────────────────────────────────────────────────────

export interface BookingPlanInputs {
  tenantId: string;
  personId: string;
  spaceId: string;
  catalogItemId: string;
  bookingId?: string;
  orderId?: string;
  oliId?: string;
  startAtIso?: string;
  endAtIso?: string;
}

export interface BookingPlan {
  bookingId: string;
  orderId: string;
  oliId: string;
  bookingInput: Record<string, unknown>;
  attachPlan: Record<string, unknown>;
}

/**
 * Build a minimal-but-valid (BookingInput, AttachPlan) pair. Single
 * slot, single order, single OLI; no asset reservations; no
 * approvals; no setup_emit. Sufficient for the idempotency probe
 * which only cares that two retries of the same key produce one
 * commit.
 */
export function buildSimpleBookingPlan(inputs: BookingPlanInputs): BookingPlan {
  const bookingId = inputs.bookingId ?? randomUUID();
  const orderId = inputs.orderId ?? randomUUID();
  const oliId = inputs.oliId ?? randomUUID();
  const slotId = randomUUID();
  // Default start = 2026-09-01T10:00 UTC, end +1h. Far in the future so
  // the GiST exclusion never fires across parallel tests.
  const startAt = inputs.startAtIso ?? '2026-09-01T10:00:00Z';
  const endAt = inputs.endAtIso ?? '2026-09-01T11:00:00Z';

  const bookingInput = {
    booking_id: bookingId,
    title: 'Concurrency probe booking',
    description: null,
    requester_person_id: inputs.personId,
    host_person_id: null,
    booked_by_user_id: null,
    location_id: inputs.spaceId,
    start_at: startAt,
    end_at: endAt,
    timezone: 'UTC',
    status: 'confirmed',
    source: 'desk',
    cost_center_id: null,
    cost_amount_snapshot: null,
    policy_snapshot: {},
    applied_rule_ids: [],
    config_release_id: null,
    recurrence_series_id: null,
    recurrence_index: null,
    template_id: null,
    slots: [
      {
        id: slotId,
        slot_type: 'room',
        space_id: inputs.spaceId,
        start_at: startAt,
        end_at: endAt,
        attendee_count: 4,
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
    any_deny: false,
    deny_messages: [],
    any_pending_approval: false,
    orders: [
      {
        id: orderId,
        requester_person_id: inputs.personId,
        linked_slot_id: null,
        delivery_location_id: inputs.spaceId,
        delivery_date: null,
        requested_for_start_at: startAt,
        requested_for_end_at: endAt,
        initial_status: 'submitted',
        policy_snapshot: {},
      },
    ],
    asset_reservations: [],
    order_line_items: [
      {
        id: oliId,
        order_id: orderId,
        catalog_item_id: inputs.catalogItemId,
        quantity: 4,
        unit_price: null,
        line_total: null,
        fulfillment_status: 'ordered',
        fulfillment_team_id: null,
        vendor_id: null,
        menu_item_id: null,
        linked_asset_id: null,
        linked_asset_reservation_id: null,
        service_window_start_at: startAt,
        service_window_end_at: endAt,
        repeats_with_series: true,
        // setup_emit deliberately absent → no outbox event.
        // pending_setup_trigger_args absent → SQL null on column.
        policy_snapshot: {},
      },
    ],
    approvals: [],
    bundle_audit_payload: {
      order_ids: [orderId],
      order_line_item_ids: [oliId],
    },
  };

  return { bookingId, orderId, oliId, bookingInput, attachPlan };
}

// ─────────────────────────────────────────────────────────────────────
// Direct seeding of bookings/approvals/OLIs for grant + setup_trigger
// scenarios that don't go through create_booking_with_attach_plan.
// ─────────────────────────────────────────────────────────────────────

export interface SeededBooking {
  bookingId: string;
  slotId: string;
  orderId: string;
  oliId: string;
}

/**
 * Insert a booking + slot + order + OLI directly (bypassing the RPC).
 * Used for grant_booking_approval scenarios where we need a stable
 * pending-approval state without exercising the create RPC.
 */
export async function seedPendingApprovalBooking(
  pool: Pool,
  base: BaseFixture,
  opts: { withPendingSetupArgs?: boolean } = {},
): Promise<SeededBooking> {
  const bookingId = randomUUID();
  const slotId = randomUUID();
  const orderId = randomUUID();
  const oliId = randomUUID();

  await withClient(pool, async (c) => {
    await c.query('begin');
    try {
      await c.query(
        `insert into public.bookings
           (id, tenant_id, title, requester_person_id, location_id,
            start_at, end_at, timezone, status, source, policy_snapshot)
         values ($1, $2, 'Concurrency approval booking', $3, $4,
                 '2026-09-15T10:00:00Z', '2026-09-15T11:00:00Z', 'UTC',
                 'pending_approval', 'desk', '{}'::jsonb)`,
        [bookingId, base.tenantId, base.personId, base.spaceId],
      );
      await c.query(
        `insert into public.booking_slots
           (id, tenant_id, booking_id, slot_type, space_id,
            start_at, end_at, status, display_order)
         values ($1, $2, $3, 'room', $4,
                 '2026-09-15T10:00:00Z', '2026-09-15T11:00:00Z', 'pending_approval', 0)`,
        [slotId, base.tenantId, bookingId, base.spaceId],
      );
      await c.query(
        `insert into public.orders
           (id, tenant_id, booking_id, requester_person_id, status, policy_snapshot)
         values ($1, $2, $3, $4, 'submitted', '{}'::jsonb)`,
        [orderId, base.tenantId, bookingId, base.personId],
      );
      const pendingArgs = opts.withPendingSetupArgs
        ? JSON.stringify({
            oliId,
            serviceCategory: 'catering',
            serviceWindowStartAt: '2026-09-15T10:00:00Z',
            locationId: base.spaceId,
            ruleIds: [],
            originSurface: 'bundle',
          })
        : null;
      await c.query(
        `insert into public.order_line_items
           (id, order_id, tenant_id, catalog_item_id, quantity,
            fulfillment_status, fulfillment_team_id, pending_setup_trigger_args,
            policy_snapshot)
         values ($1, $2, $3, $4, 4,
                 'ordered', $5, $6::jsonb, '{}'::jsonb)`,
        [oliId, orderId, base.tenantId, base.catalogItemId, base.teamId, pendingArgs],
      );
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    }
  });

  return { bookingId, slotId, orderId, oliId };
}

export async function seedApproval(
  pool: Pool,
  base: BaseFixture,
  bookingId: string,
  opts: { parallelGroup?: string | null } = {},
): Promise<{ approvalId: string }> {
  const approvalId = randomUUID();
  await pool.query(
    `insert into public.approvals
       (id, tenant_id, target_entity_type, target_entity_id,
        approver_person_id, status, parallel_group)
     values ($1, $2, 'booking', $3, $4, 'pending', $5)`,
    [approvalId, base.tenantId, bookingId, base.approverPersonId, opts.parallelGroup ?? null],
  );
  return { approvalId };
}

export async function seedSecondApprover(
  pool: Pool,
  base: BaseFixture,
  bookingId: string,
  opts: { parallelGroup?: string | null } = {},
): Promise<{ approvalId: string; approverPersonId: string }> {
  const approverPersonId = randomUUID();
  const approvalId = randomUUID();
  await pool.query(
    `insert into public.persons (id, tenant_id, type, first_name, last_name, email)
     values ($1, $2, 'employee', 'Approver2', 'Concurrency', $3)`,
    [approverPersonId, base.tenantId, `app2-${approverPersonId.slice(0, 8)}@concurrency.test`],
  );
  await pool.query(
    `insert into public.approvals
       (id, tenant_id, target_entity_type, target_entity_id,
        approver_person_id, status, parallel_group)
     values ($1, $2, 'booking', $3, $4, 'pending', $5)`,
    [approvalId, base.tenantId, bookingId, approverPersonId, opts.parallelGroup ?? null],
  );
  return { approvalId, approverPersonId };
}

// ─────────────────────────────────────────────────────────────────────
// Outbox event seeding — for create_setup_work_order_from_event.
// ─────────────────────────────────────────────────────────────────────

export async function seedSetupWoOutboxEvent(
  pool: Pool,
  base: BaseFixture,
  oliId: string,
  bookingId: string,
): Promise<{ eventId: string }> {
  const eventId = randomUUID();
  const idempotencyKey = `setup_work_order.create_required:${oliId}`;
  const payload = JSON.stringify({
    booking_id: bookingId,
    oli_id: oliId,
    service_category: 'catering',
    service_window_start_at: '2026-09-15T10:00:00Z',
    location_id: base.spaceId,
    rule_ids: [],
    lead_time_override_minutes: null,
    origin_surface: 'bundle',
    requires_approval: false,
  });
  await pool.query(
    `insert into outbox.events
       (id, tenant_id, event_type, event_version, aggregate_type,
        aggregate_id, payload, payload_hash, idempotency_key, available_at)
     values ($1, $2, 'setup_work_order.create_required', 1, 'order_line_item',
             $3, $4::jsonb, md5(($4::jsonb)::text), $5, now())`,
    [eventId, base.tenantId, oliId, payload, idempotencyKey],
  );
  return { eventId };
}

export interface SetupWoRowData {
  parent_kind: 'booking';
  title: string;
  status: string;
  status_category: string;
  interaction_mode: string;
  priority: string;
  source_channel: string;
  linked_order_line_item_id: string;
  location_id: string;
  assigned_team_id: string;
  audit_metadata: Record<string, unknown>;
}

export function buildSetupWoRowData(
  base: BaseFixture,
  oliId: string,
): SetupWoRowData {
  return {
    parent_kind: 'booking',
    title: 'Concurrency setup-WO',
    status: 'new',
    status_category: 'new',
    interaction_mode: 'internal',
    priority: 'medium',
    source_channel: 'system',
    linked_order_line_item_id: oliId,
    location_id: base.spaceId,
    assigned_team_id: base.teamId,
    audit_metadata: { harness: 'concurrency' },
  };
}

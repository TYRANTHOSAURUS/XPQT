/**
 * B.4.A.4 concurrency probe — edit_booking RPC v4.
 *
 * Spec ref: docs/follow-ups/b4-booking-edit-pipeline.md §3.2 + §3.4 + §3.6.5.
 * Migration: supabase/migrations/00364_edit_booking_rpc_v4.sql (supersedes 00363).
 *
 * Harness pattern mirrors create_booking_with_attach_plan.spec.ts (00309)
 * + grant_booking_approval.spec.ts (00310) + reclassify_ticket.spec.ts
 * (00354).
 *
 * Scenarios (against live local Supabase):
 *   1. Happy path — simple location swap commits cleanly; booking_slots
 *      + bookings rows updated; calendar_etag bumped; audit_events +
 *      domain_events rows written; one booking.location_changed outbox
 *      event emitted.
 *   2. Idempotent replay — same key + same payload returns cached_result;
 *      one bookings row update, one audit event, exactly the same outbox
 *      emit count after replay (v2 Fix 7).
 *   3. Payload mismatch — same key + different payload →
 *      'command_operations.payload_mismatch'.
 *   4. Stale resolution — bump room_booking_rules.updated_at between
 *      plan-build and RPC → 'automation_plan.stale_resolution'.
 *   5. Cross-tenant space — forge a space_id from tenant B's spaces →
 *      'validate_entity_in_tenant.space_not_in_tenant'.
 *   6. Cancelled booking — booking.status='cancelled' on entry → 422
 *      'booking.cancelled_cannot_edit'.
 *   7. §3.6.5 Row 2 — allow→require_approval (none) — insert chain;
 *      status='pending_approval'; emit booking.approval_required.
 *  18. §3.6.5 Row 3 — require_approval→allow (pending) — expire chain;
 *      status='confirmed'.
 *  19. §3.6.5 Row 6 — require_approval→require_approval (pending, same
 *      config) — preserve in-flight grants.
 *  20. §3.6.5 Row 7 — require_approval→require_approval (pending, diff
 *      config) — expire old chain + insert fresh chain; emit.
 *  21. §3.6.5 Row 8 (DANGEROUS GAP) — require_approval→require_approval
 *      (terminal_approved, diff config) — expire approved rows + insert
 *      fresh chain; status flips back to 'pending_approval'; emit.
 *  22. §3.6.5 Row 9 — terminal_rejected → booking.cancelled_cannot_edit.
 *  23. §3.6.5 Row 10 — new_outcome=deny → edit_booking.deny_on_edit.
 *  24. Cross-tenant person approver — validate_entity_in_tenant.person_not_in_tenant.
 *  25. Cross-tenant team approver — validate_entity_in_tenant.team_not_in_tenant.
 *  26. §3.6.5 Row 4 — require_approval→allow (terminal_approved) — preserve
 *      historical approved chain; status stays 'confirmed'; ZERO new rows;
 *      NO booking.approval_required emit.
 *   8. Booking not found — random uuid → 'edit_booking.not_found'.
 *   9. Invalid plan shape — missing booking object → 400
 *      'edit_booking.invalid_plan_shape'.
 *  10. F-CRIT-1 actor resolution — passing an unknown auth_uid →
 *      'edit_booking.actor_not_found'. Happy path with a real auth_uid
 *      writes domain_events.actor_user_id = users.id (NOT auth_uid).
 *  11. Cost delta — patch with new cost_amount_snapshot →
 *      booking.cost_changed outbox event emitted.
 *  12. Two concurrent edits on the same booking — second blocks via
 *      advisory lock, then commits (if different key) or returns the
 *      cached_result (if same key).
 *  13. v2 Fix 6 — work_order_sla_patches with needs_repoint=true emits a
 *      sla.timer_repointed_required outbox row with the canonical shape
 *      (work_order_id + started_at + source='edit_booking'). Producer-side
 *      assertion only; the handler is still ticket-specific until B.4.A.4.
 */

import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { buildEditBookingIdempotencyKey } from '@prequest/shared';
import {
  flushAllFixtures,
  lockKey,
  pgLocksFor,
  registerCleanup,
  runRpcCapture,
  seedBaseFixture,
  waitForBlocker,
  withClient,
  type BaseFixture,
} from './helpers';
import { endPool, getPool } from './pool';

interface SeededBooking {
  bookingId: string;
  slotId: string;
  orderId: string | null;
  initialEtag: string;
}

interface EditResult {
  booking: Record<string, unknown>;
  follow_ups: string[];
  slots_updated: number;
  orders_updated: number;
  assets_updated: number;
  wo_updated: number;
}

/**
 * Seed a confirmed booking with one room slot. Returns the ids so the
 * test can build EditPlan payloads. Cleanup is registered via
 * seedBaseFixture so we only need to track the rows added on top.
 */
async function seedConfirmedBooking(
  pool: Pool,
  base: BaseFixture,
  opts: { startAtIso?: string; endAtIso?: string; initialEtag?: string } = {},
): Promise<SeededBooking> {
  const bookingId = randomUUID();
  const slotId = randomUUID();
  const initialEtag = opts.initialEtag ?? `etag-${bookingId.slice(0, 8)}`;
  const startAt = opts.startAtIso ?? '2026-10-01T10:00:00Z';
  const endAt = opts.endAtIso ?? '2026-10-01T11:00:00Z';

  await withClient(pool, async (c) => {
    await c.query('begin');
    try {
      await c.query(
        `insert into public.bookings
           (id, tenant_id, title, requester_person_id, location_id,
            start_at, end_at, timezone, status, source, calendar_etag,
            cost_amount_snapshot, policy_snapshot, applied_rule_ids)
         values ($1, $2, 'Edit Booking Probe', $3, $4,
                 $5, $6, 'UTC', 'confirmed', 'desk', $7,
                 100.00, '{}'::jsonb, '{}'::uuid[])`,
        [bookingId, base.tenantId, base.personId, base.spaceId, startAt, endAt, initialEtag],
      );
      await c.query(
        `insert into public.booking_slots
           (id, tenant_id, booking_id, slot_type, space_id,
            start_at, end_at, status, display_order)
         values ($1, $2, $3, 'room', $4, $5, $6, 'confirmed', 0)`,
        [slotId, base.tenantId, bookingId, base.spaceId, startAt, endAt],
      );
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    }
  });

  return { bookingId, slotId, orderId: null, initialEtag };
}

/**
 * Seed an additional meeting_room in the same tenant so a location swap
 * has a target. The base fixture's space is meeting_room/parent=building
 * (helpers.ts:281-287) — that combination violates the
 * is_valid_space_parent rule (00113:51-55: building → wing|floor|common_area,
 * meeting_room only under floor), but the base fixture wraps its inserts in
 * `set local session_replication_role = 'replica'` which suppresses the
 * enforce_space_parent_rule trigger. Mirror that pattern here so the
 * insert succeeds.
 */
async function seedTargetMeetingRoom(
  pool: Pool,
  base: BaseFixture,
): Promise<string> {
  const targetSpaceId = randomUUID();
  await withClient(pool, async (c) => {
    await c.query('begin');
    try {
      await c.query("set local session_replication_role = 'replica'");
      await c.query(
        `insert into public.spaces (id, tenant_id, parent_id, type, name, capacity, reservable, active)
         select $1, $2, parent_id, 'meeting_room', 'Edit Target Room', 4, true, true
           from public.spaces where id = $3 and tenant_id = $2`,
        [targetSpaceId, base.tenantId, base.spaceId],
      );
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    }
  });
  return targetSpaceId;
}

/**
 * Seed a public.users row with auth_uid so the F-CRIT-1 resolution
 * scenarios exercise the auth_uid → users.id branch.
 */
async function seedAuthUser(
  pool: Pool,
  tenantId: string,
  personId: string,
): Promise<{ userId: string; authUid: string }> {
  const userId = randomUUID();
  const authUid = randomUUID();
  await pool.query(
    `insert into public.users
       (id, tenant_id, person_id, auth_uid, email, status)
     values ($1, $2, $3, $4, $5, 'active')`,
    [userId, tenantId, personId, authUid, `edit-actor-${userId.slice(0, 8)}@concurrency.test`],
  );
  registerCleanup(async () => {
    // domain_events / audit_events both FK actor_user_id to users.id with
    // no on-delete cascade; clear those rows first so the user delete
    // succeeds. The seedBaseFixture cleanup already deletes ALL the
    // tenant's domain_events/audit_events, but cleanup order is
    // reverse-insertion (helpers.ts:212) so this cleanup runs BEFORE
    // those — clean the actor's rows explicitly here to keep the
    // user delete from FK-violating.
    await pool.query('delete from public.domain_events where actor_user_id = $1', [userId]);
    await pool.query('delete from public.audit_events where actor_user_id = $1', [userId]);
    await pool.query('delete from public.users where id = $1', [userId]);
  });
  return { userId, authUid };
}

/**
 * Seed a second tenant + space so cross-tenant FK tests have something to
 * forge with.
 */
async function seedSecondTenantSpace(
  pool: Pool,
  seed: string,
): Promise<{ tenantId: string; spaceId: string }> {
  const tenantId = randomUUID();
  const siteId = randomUUID();
  const spaceId = randomUUID();
  await withClient(pool, async (c) => {
    await c.query('begin');
    try {
      await c.query("set local session_replication_role = 'replica'");
      await c.query(
        `insert into public.tenants (id, name, slug, status, tier)
         values ($1, $2, $3, 'active', 'standard')`,
        [tenantId, `Edit Booking Other ${seed}`, `edit-booking-other-${seed}`],
      );
      await c.query(
        `insert into public.spaces (id, tenant_id, type, name, reservable, active)
         values ($1, $2, 'site', 'Edit Booking Other Site', false, true)`,
        [siteId, tenantId],
      );
      await c.query(
        `insert into public.spaces (id, tenant_id, parent_id, type, name, capacity, reservable, active)
         values ($1, $2, $3, 'meeting_room', 'Edit Booking Other Room', 8, true, true)`,
        [spaceId, tenantId, siteId],
      );
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    }
  });
  registerCleanup(async () => {
    await withClient(pool, async (c) => {
      await c.query('begin');
      try {
        await c.query("set local session_replication_role = 'replica'");
        await c.query('delete from public.spaces where tenant_id = $1', [tenantId]);
        await c.query('delete from public.tenants where id = $1', [tenantId]);
        await c.query('commit');
      } catch (e) {
        await c.query('rollback');
        throw e;
      }
    });
  });
  return { tenantId, spaceId };
}

/**
 * Seed a room_booking_rules row so the stale_resolution gate has a row
 * whose updated_at can be bumped between plan-build and RPC. v3 added
 * optional target_scope + target_id to enable scenario 17 (destination-
 * room rule update triggering stale_resolution via the v3 dual-room gate).
 */
async function seedBookingRule(
  pool: Pool,
  tenantId: string,
  opts: { updatedAtIso?: string; targetScope?: 'tenant' | 'room'; targetId?: string } = {},
): Promise<{ ruleId: string; updatedAt: string }> {
  const ruleId = randomUUID();
  const updatedAt = opts.updatedAtIso ?? '2026-09-01T00:00:00Z';
  const targetScope = opts.targetScope ?? 'tenant';
  const targetId = opts.targetId ?? null;
  await pool.query(
    `insert into public.room_booking_rules
       (id, tenant_id, name, target_scope, target_id, applies_when, effect, active, created_at, updated_at)
     values ($1, $2, 'Edit Booking Rule', $3, $4, '{}'::jsonb, 'allow_override', true, $5, $5)`,
    [ruleId, tenantId, targetScope, targetId, updatedAt],
  );
  registerCleanup(async () => {
    await pool.query('delete from public.room_booking_rules where id = $1', [ruleId]);
  });
  return { ruleId, updatedAt };
}

/**
 * Seed a booking-anchored work_order for repoint scenarios. v3 (00363)
 * Critical 2 requires every work_order patch row to have
 * `booking_id = p_booking_id`. The single-parent CHECK on work_orders
 * (00213:42-45, post-rename in 00278:86 — column renamed booking_bundle_id
 * → booking_id; parent_kind enum literal updated to 'booking' per the live
 * remote schema) allows EITHER parent_kind='case' + parent_ticket_id, OR
 * parent_kind='booking' + booking_id, but never both. v2 (00362) test
 * seeded the case-anchored variant; v3 requires the booking-anchored
 * variant, so we drop the ticket fixture entirely and seed directly under
 * the booking.
 */
async function seedWorkOrderForRepoint(
  pool: Pool,
  base: BaseFixture,
  bookingId: string,
): Promise<{ workOrderId: string }> {
  const workOrderId = randomUUID();
  await pool.query(
    `insert into public.work_orders
       (id, tenant_id, parent_kind, booking_id,
        title, status, status_category, source_channel,
        planned_start_at)
     values ($1, $2, 'booking', $3,
             'Edit Booking Probe Setup WO', 'new', 'new', 'system',
             '2026-10-01T08:00:00Z'::timestamptz)`,
    [workOrderId, base.tenantId, bookingId],
  );
  // Base fixture's cleanup deletes all work_orders for the tenant; no
  // explicit cleanup needed here.
  return { workOrderId };
}

/**
 * Seed a second confirmed booking + a booking-anchored work_order under
 * THAT second booking. Used by the v3 cross-booking leak scenarios — the
 * test plans an edit on booking A and tries to patch booking B's child
 * row; the RPC must reject with *_not_in_booking.
 */
async function seedForeignBookingWithWorkOrder(
  pool: Pool,
  base: BaseFixture,
): Promise<{ foreignBookingId: string; foreignWorkOrderId: string }> {
  const foreignBookingId = randomUUID();
  const foreignSlotId = randomUUID();
  const foreignWorkOrderId = randomUUID();
  // Reuse the base fixture's space — the foreign booking just needs to
  // exist; its location doesn't matter for the leak-rejection assertion.
  await withClient(pool, async (c) => {
    await c.query('begin');
    try {
      await c.query(
        `insert into public.bookings
           (id, tenant_id, title, requester_person_id, location_id,
            start_at, end_at, timezone, status, source, calendar_etag,
            cost_amount_snapshot, policy_snapshot, applied_rule_ids)
         values ($1, $2, 'Foreign Booking', $3, $4,
                 $5, $6, 'UTC', 'confirmed', 'desk', $7,
                 100.00, '{}'::jsonb, '{}'::uuid[])`,
        [
          foreignBookingId,
          base.tenantId,
          base.personId,
          base.spaceId,
          '2026-10-02T10:00:00Z',
          '2026-10-02T11:00:00Z',
          `etag-foreign-${foreignBookingId.slice(0, 8)}`,
        ],
      );
      await c.query(
        `insert into public.booking_slots
           (id, tenant_id, booking_id, slot_type, space_id,
            start_at, end_at, status, display_order)
         values ($1, $2, $3, 'room', $4, $5, $6, 'confirmed', 0)`,
        [
          foreignSlotId,
          base.tenantId,
          foreignBookingId,
          base.spaceId,
          '2026-10-02T10:00:00Z',
          '2026-10-02T11:00:00Z',
        ],
      );
      await c.query(
        `insert into public.work_orders
           (id, tenant_id, parent_kind, booking_id,
            title, status, status_category, source_channel,
            planned_start_at)
         values ($1, $2, 'booking', $3,
                 'Foreign Booking WO', 'new', 'new', 'system',
                 '2026-10-02T08:00:00Z'::timestamptz)`,
        [foreignWorkOrderId, base.tenantId, foreignBookingId],
      );
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    }
  });
  // Base fixture cleans bookings + work_orders + booking_slots for the
  // tenant; no explicit cleanup needed.
  return { foreignBookingId, foreignWorkOrderId };
}

/**
 * Seed an order linked to a specific booking. Used by v3 scenario 15
 * (cross-booking order leak rejection). Returns the order id; caller
 * provides the booking id to anchor against.
 */
async function seedOrderForBooking(
  pool: Pool,
  base: BaseFixture,
  bookingId: string,
): Promise<{ orderId: string }> {
  const orderId = randomUUID();
  await pool.query(
    `insert into public.orders
       (id, tenant_id, requester_person_id, booking_id,
        status, policy_snapshot)
     values ($1, $2, $3, $4, 'submitted', '{}'::jsonb)`,
    [orderId, base.tenantId, base.personId, bookingId],
  );
  // Base fixture cleanup handles orders.
  return { orderId };
}

/**
 * Seed an asset_type + asset + asset_reservation linked to a specific
 * booking. Used by v3 scenario 16 (cross-booking asset_reservation leak
 * rejection). assets requires asset_type_id (NOT NULL, 00142 schema) +
 * asset_role + a valid status enum value ('available'|'assigned'|
 * 'in_maintenance'|'retired'|'disposed' per the CHECK constraint).
 * asset_types requires name + default_role. Cleanup not handled by
 * seedBaseFixture for asset_reservations / assets / asset_types, so
 * register explicit teardown.
 */
async function seedAssetReservationForBooking(
  pool: Pool,
  base: BaseFixture,
  bookingId: string,
): Promise<{ assetTypeId: string; assetId: string; reservationId: string }> {
  const assetTypeId = randomUUID();
  const assetId = randomUUID();
  const reservationId = randomUUID();
  await withClient(pool, async (c) => {
    await c.query('begin');
    try {
      await c.query("set local session_replication_role = 'replica'");
      await c.query(
        `insert into public.asset_types
           (id, tenant_id, name, default_role, active)
         values ($1, $2, 'Edit Probe Asset Type', 'fixed', true)`,
        [assetTypeId, base.tenantId],
      );
      await c.query(
        `insert into public.assets
           (id, tenant_id, asset_type_id, asset_role, name, status, lifecycle_state)
         values ($1, $2, $3, 'fixed', 'Edit Probe Asset', 'available', 'active')`,
        [assetId, base.tenantId, assetTypeId],
      );
      // asset_reservations.status CHECK constraint:
      //   status IN ('confirmed','cancelled','released')
      // 'reserved' is NOT a valid value — use 'confirmed'.
      await c.query(
        `insert into public.asset_reservations
           (id, tenant_id, asset_id, requester_person_id, booking_id,
            start_at, end_at, status)
         values ($1, $2, $3, $4, $5,
                 '2026-10-02T10:00:00Z'::timestamptz,
                 '2026-10-02T11:00:00Z'::timestamptz,
                 'confirmed')`,
        [reservationId, base.tenantId, assetId, base.personId, bookingId],
      );
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    }
  });
  // seedBaseFixture.cleanup (helpers.ts:307-355) does NOT delete
  // asset_reservations / assets / asset_types. Register them here so the
  // tenant teardown succeeds.
  registerCleanup(async () => {
    await withClient(pool, async (c) => {
      await c.query('begin');
      try {
        await c.query("set local session_replication_role = 'replica'");
        await c.query('delete from public.asset_reservations where id = $1', [reservationId]);
        await c.query('delete from public.assets where id = $1', [assetId]);
        await c.query('delete from public.asset_types where id = $1', [assetTypeId]);
        await c.query('commit');
      } catch (e) {
        await c.query('rollback');
        throw e;
      }
    });
  });
  return { assetTypeId, assetId, reservationId };
}

/**
 * Build an approval block for the EditPlan (v4 §3.6.5 contract). Defaults
 * to the no-op tuple (allow → allow, none, chain unchanged) so scenarios
 * that don't care about approvals exercise §3.6.5 Row 1.
 */
type ApproverSeed = { type: 'person' | 'team'; id: string };
type ApprovalOutcome = 'allow' | 'require_approval' | 'deny';

function buildApprovalBlock(opts: {
  oldOutcome?: ApprovalOutcome;
  newOutcome?: ApprovalOutcome;
  chainConfigChanged?: boolean;
  newChainConfig?: {
    requiredApprovers: ApproverSeed[];
    threshold?: 'all' | 'any';
  } | null;
}): Record<string, unknown> {
  const newChainConfig = opts.newChainConfig
    ? {
        required_approvers: opts.newChainConfig.requiredApprovers,
        threshold: opts.newChainConfig.threshold ?? 'all',
      }
    : null;
  return {
    old_outcome: opts.oldOutcome ?? 'allow',
    new_outcome: opts.newOutcome ?? 'allow',
    chain_config_changed: opts.chainConfigChanged ?? false,
    new_chain_config: newChainConfig,
  };
}

/**
 * Seed an approvals chain (single chain_id, N rows) anchored to a booking
 * with a given status. Used by the §3.6.5 scenarios so the RPC can classify
 * the pre-edit approvals state correctly. Tenant cleanup of approvals is
 * handled by seedBaseFixture.
 */
async function seedBookingApprovalChain(
  pool: Pool,
  base: BaseFixture,
  bookingId: string,
  rows: Array<{
    status: 'pending' | 'approved' | 'rejected' | 'delegated' | 'expired';
    approverPersonId?: string | null;
    approverTeamId?: string | null;
    parallelGroup?: string | null;
  }>,
): Promise<{ chainId: string }> {
  const chainId = randomUUID();
  for (const row of rows) {
    await pool.query(
      `insert into public.approvals
         (tenant_id, target_entity_type, target_entity_id,
          approval_chain_id, parallel_group,
          approver_person_id, approver_team_id, status)
       values ($1, 'booking', $2, $3, $4, $5, $6, $7)`,
      [
        base.tenantId,
        bookingId,
        chainId,
        row.parallelGroup ?? `parallel-${bookingId}`,
        row.approverPersonId ?? null,
        row.approverTeamId ?? null,
        row.status,
      ],
    );
  }
  return { chainId };
}

/**
 * Build a minimal-but-valid EditPlan that moves the slot's space (and
 * therefore bookings.location_id) to a target space, leaves the time
 * window intact, and bumps the calendar_etag. All optional arrays default
 * to empty so the test asserts the location-only branch in isolation.
 *
 * v4 (§3.6.5): replaces the boolean `approval_outcome_changed` with the
 * structured `approval` block. Default approval is allow→allow (Row 1
 * no-op) so existing scenarios stay untouched.
 */
function buildLocationSwapPlan(args: {
  bookingId: string;
  slotId: string;
  fromSpaceId: string;
  toSpaceId: string;
  resolutionAtIso: string;
  startAtIso?: string;
  endAtIso?: string;
  costAmountSnapshot?: number | null;
  costCenterId?: string | null;
  appliedRuleIds?: string[];
  calendarEtag?: string;
  approval?: Record<string, unknown>;
  clientRequestId?: string;
}): Record<string, unknown> {
  const startAt = args.startAtIso ?? '2026-10-01T10:00:00Z';
  const endAt = args.endAtIso ?? '2026-10-01T11:00:00Z';
  return {
    _resolution_at: args.resolutionAtIso,
    rule_outcome_fingerprint: 'fingerprint-test',
    client_request_id: args.clientRequestId ?? 'edit-test-crid',
    approval: args.approval ?? buildApprovalBlock({}),
    booking: {
      location_id: args.toSpaceId,
      start_at: startAt,
      end_at: endAt,
      cost_amount_snapshot: args.costAmountSnapshot ?? 100.0,
      policy_snapshot: { rules: [] },
      applied_rule_ids: args.appliedRuleIds ?? [],
      cost_center_id: args.costCenterId ?? null,
      calendar_etag: args.calendarEtag ?? `etag-${args.bookingId.slice(0, 8)}-edit`,
    },
    slot_patches: [
      {
        slot_id: args.slotId,
        space_id: args.toSpaceId,
        start_at: startAt,
        end_at: endAt,
        setup_buffer_minutes: 0,
        teardown_buffer_minutes: 0,
        attendee_count: null,
        attendee_person_ids: null,
      },
    ],
    asset_reservation_patches: [],
    order_patches: [],
    work_order_sla_patches: [],
  };
}

describe('edit_booking RPC v1 — concurrency + state-machine probes', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = getPool();
  });

  afterAll(async () => {
    await flushAllFixtures(pool);
    await endPool();
  });

  // ── Scenario 1: happy path ────────────────────────────────────────────
  it('happy path — location swap commits, audit + outbox row counts correct', async () => {
    const base = await seedBaseFixture(pool, `edit-happy-${Date.now()}`);
    const booking = await seedConfirmedBooking(pool, base);
    const targetSpaceId = await seedTargetMeetingRoom(pool, base);

    const plan = buildLocationSwapPlan({
      bookingId: booking.bookingId,
      slotId: booking.slotId,
      fromSpaceId: base.spaceId,
      toSpaceId: targetSpaceId,
      resolutionAtIso: '2026-09-15T00:00:00Z',
    });
    const idempotencyKey = buildEditBookingIdempotencyKey(booking.bookingId, 'crid-happy-1');

    const result = await runRpcCapture<EditResult>(pool, 'public.edit_booking', [
      booking.bookingId,
      plan,
      base.tenantId,
      null,
      idempotencyKey,
    ]);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    expect(result.value.slots_updated).toBe(1);
    expect(result.value.follow_ups).toContain('booking.location_changed');

    const slotRow = await pool.query<{ space_id: string }>(
      'select space_id from public.booking_slots where id = $1',
      [booking.slotId],
    );
    expect(slotRow.rows[0].space_id).toBe(targetSpaceId);

    const bookingRow = await pool.query<{ location_id: string; calendar_etag: string }>(
      'select location_id, calendar_etag from public.bookings where id = $1',
      [booking.bookingId],
    );
    expect(bookingRow.rows[0].location_id).toBe(targetSpaceId);
    expect(bookingRow.rows[0].calendar_etag).not.toBe(booking.initialEtag);

    const auditRows = await pool.query(
      `select event_type from public.audit_events
        where tenant_id = $1 and entity_id = $2`,
      [base.tenantId, booking.bookingId],
    );
    expect(auditRows.rows).toHaveLength(1);
    expect(auditRows.rows[0].event_type).toBe('booking.edited');

    const domainRows = await pool.query(
      `select event_type from public.domain_events
        where tenant_id = $1 and entity_id = $2`,
      [base.tenantId, booking.bookingId],
    );
    expect(domainRows.rows).toHaveLength(1);
    expect(domainRows.rows[0].event_type).toBe('booking.edited');

    const outboxRows = await pool.query(
      `select event_type from outbox.events
        where tenant_id = $1 and aggregate_id = $2`,
      [base.tenantId, booking.bookingId],
    );
    const eventTypes = outboxRows.rows.map((r) => r.event_type).sort();
    expect(eventTypes).toEqual(['booking.location_changed']);
  });

  // ── Scenario 2: idempotent replay ────────────────────────────────────
  it('idempotent replay — same key + same payload returns cached_result; one audit row', async () => {
    const base = await seedBaseFixture(pool, `edit-replay-${Date.now()}`);
    const booking = await seedConfirmedBooking(pool, base);
    const targetSpaceId = await seedTargetMeetingRoom(pool, base);

    const plan = buildLocationSwapPlan({
      bookingId: booking.bookingId,
      slotId: booking.slotId,
      fromSpaceId: base.spaceId,
      toSpaceId: targetSpaceId,
      resolutionAtIso: '2026-09-15T00:00:00Z',
    });
    const idempotencyKey = buildEditBookingIdempotencyKey(booking.bookingId, 'crid-replay-1');

    const first = await runRpcCapture<EditResult>(pool, 'public.edit_booking', [
      booking.bookingId,
      plan,
      base.tenantId,
      null,
      idempotencyKey,
    ]);
    expect(first.kind).toBe('ok');
    const second = await runRpcCapture<EditResult>(pool, 'public.edit_booking', [
      booking.bookingId,
      plan,
      base.tenantId,
      null,
      idempotencyKey,
    ]);
    expect(second.kind).toBe('ok');
    if (first.kind !== 'ok' || second.kind !== 'ok') return;

    expect(second.value).toEqual(first.value);
    const auditRows = await pool.query(
      `select count(*)::int as n from public.audit_events
        where tenant_id = $1 and entity_id = $2`,
      [base.tenantId, booking.bookingId],
    );
    expect(auditRows.rows[0].n).toBe(1);

    const cmdOpsRows = await pool.query(
      `select outcome from public.command_operations
        where tenant_id = $1 and idempotency_key = $2`,
      [base.tenantId, idempotencyKey],
    );
    expect(cmdOpsRows.rows).toHaveLength(1);
    expect(cmdOpsRows.rows[0].outcome).toBe('success');

    // v2 Fix 7 — replay must not double-emit. The RPC's idempotency gate
    // returns cached_result on the second call, but if it somehow ran
    // outbox.emit() a second time, the unique-key constraint on
    // outbox.events would either error or accept duplicates by event_type.
    // Assert the count seen after the second call equals the count seen
    // after the first.
    const outboxCount = await pool.query<{ n: number }>(
      `select count(*)::int as n from outbox.events
        where tenant_id = $1 and aggregate_id = $2`,
      [base.tenantId, booking.bookingId],
    );
    // First call had a location swap → exactly one booking.location_changed.
    // Second call (cached_result) must not add to that count.
    expect(outboxCount.rows[0].n).toBe(1);
  });

  // ── Scenario 3: payload mismatch ─────────────────────────────────────
  it('payload mismatch — same key + different payload raises command_operations.payload_mismatch', async () => {
    const base = await seedBaseFixture(pool, `edit-pmismatch-${Date.now()}`);
    const booking = await seedConfirmedBooking(pool, base);
    const targetSpaceId = await seedTargetMeetingRoom(pool, base);
    const planA = buildLocationSwapPlan({
      bookingId: booking.bookingId,
      slotId: booking.slotId,
      fromSpaceId: base.spaceId,
      toSpaceId: targetSpaceId,
      resolutionAtIso: '2026-09-15T00:00:00Z',
    });
    const planB = buildLocationSwapPlan({
      bookingId: booking.bookingId,
      slotId: booking.slotId,
      fromSpaceId: base.spaceId,
      toSpaceId: targetSpaceId,
      resolutionAtIso: '2026-09-15T00:00:00Z',
      calendarEtag: 'etag-different-payload',
    });
    const idempotencyKey = buildEditBookingIdempotencyKey(booking.bookingId, 'crid-pmismatch');

    const first = await runRpcCapture(pool, 'public.edit_booking', [
      booking.bookingId,
      planA,
      base.tenantId,
      null,
      idempotencyKey,
    ]);
    expect(first.kind).toBe('ok');
    const second = await runRpcCapture(pool, 'public.edit_booking', [
      booking.bookingId,
      planB,
      base.tenantId,
      null,
      idempotencyKey,
    ]);
    expect(second.kind).toBe('error');
    if (second.kind !== 'error') return;
    expect(second.error.message).toContain('command_operations.payload_mismatch');
  });

  // ── Scenario 4: stale_resolution ─────────────────────────────────────
  it('stale resolution — room_booking_rules.updated_at past plan._resolution_at raises automation_plan.stale_resolution', async () => {
    const base = await seedBaseFixture(pool, `edit-stale-${Date.now()}`);
    const booking = await seedConfirmedBooking(pool, base);
    const targetSpaceId = await seedTargetMeetingRoom(pool, base);
    // Seed a rule with updated_at AFTER the plan's _resolution_at to
    // trigger the gate.
    await seedBookingRule(pool, base.tenantId, { updatedAtIso: '2026-09-20T00:00:00Z' });
    const plan = buildLocationSwapPlan({
      bookingId: booking.bookingId,
      slotId: booking.slotId,
      fromSpaceId: base.spaceId,
      toSpaceId: targetSpaceId,
      resolutionAtIso: '2026-09-15T00:00:00Z',
    });
    const idempotencyKey = buildEditBookingIdempotencyKey(booking.bookingId, 'crid-stale');

    const result = await runRpcCapture(pool, 'public.edit_booking', [
      booking.bookingId,
      plan,
      base.tenantId,
      null,
      idempotencyKey,
    ]);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.message).toContain('automation_plan.stale_resolution');
  });

  // ── Scenario 5: cross-tenant space ───────────────────────────────────
  it('cross-tenant space — forged target space_id raises validate_entity_in_tenant.space_not_in_tenant', async () => {
    const base = await seedBaseFixture(pool, `edit-xtenant-${Date.now()}`);
    const booking = await seedConfirmedBooking(pool, base);
    const other = await seedSecondTenantSpace(pool, `xtenant-${Date.now()}`);
    const plan = buildLocationSwapPlan({
      bookingId: booking.bookingId,
      slotId: booking.slotId,
      fromSpaceId: base.spaceId,
      toSpaceId: other.spaceId,
      resolutionAtIso: '2026-09-15T00:00:00Z',
    });
    const idempotencyKey = buildEditBookingIdempotencyKey(booking.bookingId, 'crid-xtenant');

    const result = await runRpcCapture(pool, 'public.edit_booking', [
      booking.bookingId,
      plan,
      base.tenantId,
      null,
      idempotencyKey,
    ]);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.message).toContain('validate_entity_in_tenant.space_not_in_tenant');
  });

  // ── Scenario 6: cancelled booking ────────────────────────────────────
  it('cancelled booking — booking.status=cancelled raises booking.cancelled_cannot_edit', async () => {
    const base = await seedBaseFixture(pool, `edit-cancelled-${Date.now()}`);
    const booking = await seedConfirmedBooking(pool, base);
    await pool.query(`update public.bookings set status='cancelled' where id=$1`, [
      booking.bookingId,
    ]);
    const targetSpaceId = await seedTargetMeetingRoom(pool, base);
    const plan = buildLocationSwapPlan({
      bookingId: booking.bookingId,
      slotId: booking.slotId,
      fromSpaceId: base.spaceId,
      toSpaceId: targetSpaceId,
      resolutionAtIso: '2026-09-15T00:00:00Z',
    });
    const idempotencyKey = buildEditBookingIdempotencyKey(booking.bookingId, 'crid-cancelled');

    const result = await runRpcCapture(pool, 'public.edit_booking', [
      booking.bookingId,
      plan,
      base.tenantId,
      null,
      idempotencyKey,
    ]);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.message).toContain('booking.cancelled_cannot_edit');
  });

  // ── Scenario 7 (v4 §3.6.5 Row 2): allow → require_approval, none ─────
  // INSERT new approvals chain; bookings.status → 'pending_approval';
  // booking.approval_required outbox event emitted with chain_id +
  // approver_person_ids[] + approver_team_ids[] payload (v5 split shape).
  it('§3.6.5 Row 2 — allow→require_approval (none) inserts fresh chain + emits approval_required', async () => {
    const base = await seedBaseFixture(pool, `edit-row2-${Date.now()}`);
    const booking = await seedConfirmedBooking(pool, base);
    const targetSpaceId = await seedTargetMeetingRoom(pool, base);

    const plan = buildLocationSwapPlan({
      bookingId: booking.bookingId,
      slotId: booking.slotId,
      fromSpaceId: base.spaceId,
      toSpaceId: targetSpaceId,
      resolutionAtIso: '2026-09-15T00:00:00Z',
      approval: buildApprovalBlock({
        oldOutcome: 'allow',
        newOutcome: 'require_approval',
        chainConfigChanged: true,
        newChainConfig: {
          requiredApprovers: [{ type: 'person', id: base.personId }],
          threshold: 'all',
        },
      }),
    });
    const idempotencyKey = buildEditBookingIdempotencyKey(booking.bookingId, 'crid-row2');

    const result = await runRpcCapture<EditResult>(pool, 'public.edit_booking', [
      booking.bookingId,
      plan,
      base.tenantId,
      null,
      idempotencyKey,
    ]);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.follow_ups).toContain('booking.approval_required');

    // Booking status flipped to pending_approval.
    const bookingRow = await pool.query<{ status: string }>(
      'select status from public.bookings where id = $1',
      [booking.bookingId],
    );
    expect(bookingRow.rows[0].status).toBe('pending_approval');

    // Exactly one approvals row exists; pending; chain_id set; parallel_group set.
    const approvalRows = await pool.query<{
      status: string;
      approval_chain_id: string;
      parallel_group: string | null;
      approver_person_id: string | null;
      approver_team_id: string | null;
    }>(
      `select status, approval_chain_id, parallel_group, approver_person_id, approver_team_id
         from public.approvals
        where tenant_id = $1 and target_entity_id = $2 and target_entity_type = 'booking'`,
      [base.tenantId, booking.bookingId],
    );
    expect(approvalRows.rows).toHaveLength(1);
    expect(approvalRows.rows[0].status).toBe('pending');
    expect(approvalRows.rows[0].approval_chain_id).not.toBeNull();
    expect(approvalRows.rows[0].parallel_group).toBe(`parallel-${booking.bookingId}`);
    expect(approvalRows.rows[0].approver_person_id).toBe(base.personId);

    // Outbox event payload sanity.
    const outboxRows = await pool.query<{ event_type: string; payload: Record<string, unknown> }>(
      `select event_type, payload from outbox.events
        where tenant_id = $1 and aggregate_id = $2 and event_type = 'booking.approval_required'`,
      [base.tenantId, booking.bookingId],
    );
    expect(outboxRows.rows).toHaveLength(1);
    expect(outboxRows.rows[0].payload.booking_id).toBe(booking.bookingId);
    expect(outboxRows.rows[0].payload.chain_id).toBe(approvalRows.rows[0].approval_chain_id);
    // v5: split arrays — person approver populates approver_person_ids
    // (persons.id values, NOT user ids; sub-step D fans person → user via
    // users.person_id JOIN at dispatch). approver_team_ids stays []; v4's
    // mixed approver_ids is dropped.
    expect(Array.isArray(outboxRows.rows[0].payload.approver_person_ids)).toBe(true);
    expect(outboxRows.rows[0].payload.approver_person_ids).toEqual([base.personId]);
    expect(outboxRows.rows[0].payload.approver_team_ids).toEqual([]);
  });

  // ── Scenario 8: booking not found ────────────────────────────────────
  it('booking not found — random uuid raises edit_booking.not_found', async () => {
    const base = await seedBaseFixture(pool, `edit-nf-${Date.now()}`);
    const targetSpaceId = base.spaceId;
    const ghostBookingId = randomUUID();
    const ghostSlotId = randomUUID();
    const plan = buildLocationSwapPlan({
      bookingId: ghostBookingId,
      slotId: ghostSlotId,
      fromSpaceId: targetSpaceId,
      toSpaceId: targetSpaceId,
      resolutionAtIso: '2026-09-15T00:00:00Z',
    });
    const idempotencyKey = buildEditBookingIdempotencyKey(ghostBookingId, 'crid-nf');

    const result = await runRpcCapture(pool, 'public.edit_booking', [
      ghostBookingId,
      plan,
      base.tenantId,
      null,
      idempotencyKey,
    ]);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.message).toContain('edit_booking.not_found');
  });

  // ── Scenario 9: invalid plan shape ───────────────────────────────────
  it('invalid plan shape — missing booking key raises edit_booking.invalid_plan_shape', async () => {
    const base = await seedBaseFixture(pool, `edit-ips-${Date.now()}`);
    const booking = await seedConfirmedBooking(pool, base);
    const malformedPlan = {
      _resolution_at: '2026-09-15T00:00:00Z',
      approval: { old_outcome: 'allow', new_outcome: 'allow', chain_config_changed: false },
      slot_patches: [],
      // booking object intentionally missing — first check in §0 ordering
      // (the `booking` jsonb-object check fires before slot_patches /
      // approval shape checks per 00364:177-185).
    } as Record<string, unknown>;
    const idempotencyKey = buildEditBookingIdempotencyKey(booking.bookingId, 'crid-ips');

    const result = await runRpcCapture(pool, 'public.edit_booking', [
      booking.bookingId,
      malformedPlan,
      base.tenantId,
      null,
      idempotencyKey,
    ]);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.message).toContain('edit_booking.invalid_plan_shape');
  });

  // ── Scenario 10: F-CRIT-1 actor resolution ───────────────────────────
  it('F-CRIT-1 — unknown auth_uid raises edit_booking.actor_not_found; known auth_uid resolves to users.id', async () => {
    const base = await seedBaseFixture(pool, `edit-actor-${Date.now()}`);
    const booking = await seedConfirmedBooking(pool, base);
    const targetSpaceId = await seedTargetMeetingRoom(pool, base);

    // 10a — unknown auth_uid.
    const ghostAuthUid = randomUUID();
    const planMiss = buildLocationSwapPlan({
      bookingId: booking.bookingId,
      slotId: booking.slotId,
      fromSpaceId: base.spaceId,
      toSpaceId: targetSpaceId,
      resolutionAtIso: '2026-09-15T00:00:00Z',
    });
    const idempotencyKeyMiss = buildEditBookingIdempotencyKey(booking.bookingId, 'crid-actor-miss');
    const miss = await runRpcCapture(pool, 'public.edit_booking', [
      booking.bookingId,
      planMiss,
      base.tenantId,
      ghostAuthUid,
      idempotencyKeyMiss,
    ]);
    expect(miss.kind).toBe('error');
    if (miss.kind !== 'error') return;
    expect(miss.error.message).toContain('edit_booking.actor_not_found');

    // 10b — happy path with known auth_uid. domain_events.actor_user_id
    // must be users.id (NOT auth_uid).
    const { userId, authUid } = await seedAuthUser(pool, base.tenantId, base.personId);
    const planHappy = buildLocationSwapPlan({
      bookingId: booking.bookingId,
      slotId: booking.slotId,
      fromSpaceId: base.spaceId,
      toSpaceId: targetSpaceId,
      resolutionAtIso: '2026-09-15T00:00:00Z',
    });
    const idempotencyKey = buildEditBookingIdempotencyKey(booking.bookingId, 'crid-actor-ok');
    const happy = await runRpcCapture<EditResult>(pool, 'public.edit_booking', [
      booking.bookingId,
      planHappy,
      base.tenantId,
      authUid,
      idempotencyKey,
    ]);
    expect(happy.kind).toBe('ok');
    if (happy.kind !== 'ok') return;
    const domainRows = await pool.query<{ actor_user_id: string | null }>(
      `select actor_user_id from public.domain_events
        where tenant_id = $1 and entity_id = $2 and event_type = 'booking.edited'`,
      [base.tenantId, booking.bookingId],
    );
    expect(domainRows.rows[0].actor_user_id).toBe(userId);
    expect(domainRows.rows[0].actor_user_id).not.toBe(authUid);
  });

  // ── Scenario 11: cost delta ──────────────────────────────────────────
  it('cost delta — new cost_amount_snapshot emits booking.cost_changed outbox event', async () => {
    const base = await seedBaseFixture(pool, `edit-cost-${Date.now()}`);
    const booking = await seedConfirmedBooking(pool, base);
    const plan = buildLocationSwapPlan({
      bookingId: booking.bookingId,
      slotId: booking.slotId,
      fromSpaceId: base.spaceId,
      toSpaceId: base.spaceId, // same space → no location_changed event
      resolutionAtIso: '2026-09-15T00:00:00Z',
      costAmountSnapshot: 250.0, // pre-seed was 100.00 → delta non-zero
    });
    const idempotencyKey = buildEditBookingIdempotencyKey(booking.bookingId, 'crid-cost');
    const result = await runRpcCapture<EditResult>(pool, 'public.edit_booking', [
      booking.bookingId,
      plan,
      base.tenantId,
      null,
      idempotencyKey,
    ]);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.follow_ups).toContain('booking.cost_changed');
    expect(result.value.follow_ups).not.toContain('booking.location_changed');

    const outboxRows = await pool.query<{ event_type: string }>(
      `select event_type from outbox.events
        where tenant_id = $1 and aggregate_id = $2`,
      [base.tenantId, booking.bookingId],
    );
    const eventTypes = outboxRows.rows.map((r) => r.event_type).sort();
    expect(eventTypes).toEqual(['booking.cost_changed']);
  });

  // ── Scenario 12: concurrent edits ────────────────────────────────────
  it('two concurrent edits — second blocks on advisory lock and returns cached_result when same key', async () => {
    const base = await seedBaseFixture(pool, `edit-conc-${Date.now()}`);
    const booking = await seedConfirmedBooking(pool, base);
    const targetSpaceId = await seedTargetMeetingRoom(pool, base);

    const plan = buildLocationSwapPlan({
      bookingId: booking.bookingId,
      slotId: booking.slotId,
      fromSpaceId: base.spaceId,
      toSpaceId: targetSpaceId,
      resolutionAtIso: '2026-09-15T00:00:00Z',
    });
    const idempotencyKey = buildEditBookingIdempotencyKey(booking.bookingId, 'crid-conc');
    const probeKey = await withClient(pool, (c) =>
      lockKey(c, `${base.tenantId}:${idempotencyKey}`),
    );

    const clientA = await pool.connect();
    const clientB = await pool.connect();
    try {
      await clientA.query('begin');
      const aRes = await clientA.query<{ result: EditResult }>(
        `select public.edit_booking($1, $2::jsonb, $3, $4, $5) as result`,
        [booking.bookingId, JSON.stringify(plan), base.tenantId, null, idempotencyKey],
      );
      expect(aRes.rows[0].result.follow_ups).toContain('booking.location_changed');

      // A still holds the advisory lock (xact_lock — released on commit).
      const duringA = await pgLocksFor(pool, probeKey);
      expect(duringA.filter((l) => l.granted).length).toBeGreaterThanOrEqual(1);

      // B starts the RPC — should block.
      await clientB.query('begin');
      const bPromise = clientB.query<{ result: EditResult }>(
        `select public.edit_booking($1, $2::jsonb, $3, $4, $5) as result`,
        [booking.bookingId, JSON.stringify(plan), base.tenantId, null, idempotencyKey],
      );

      await waitForBlocker(pool, probeKey, { timeoutMs: 5_000 });

      await clientA.query('commit');
      const bRes = await bPromise;
      await clientB.query('commit');

      // B returned the cached_result; same shape as A.
      expect(bRes.rows[0].result).toEqual(aRes.rows[0].result);

      // Exactly one audit row → no double-write.
      const auditRows = await pool.query<{ n: number }>(
        `select count(*)::int as n from public.audit_events
          where tenant_id = $1 and entity_id = $2`,
        [base.tenantId, booking.bookingId],
      );
      expect(auditRows.rows[0].n).toBe(1);
    } finally {
      clientA.release();
      clientB.release();
    }
  });

  // ── Scenario 13 (v2 Fix 6, v3-corrected): needs_repoint outbox shape ─
  // v3 Critical 2: the work_order must be booking-anchored so the
  // booking-scope check (work_orders.booking_id = p_booking_id) passes.
  // v2 (00362) seeded a case-anchored WO with parent_ticket_id; that was
  // never actually scoped to this booking, so the assertion was locking
  // in the pre-v3 unsafe behavior. v3 seeds the WO under bookingId.
  it('needs_repoint WO patch — emits sla.timer_repointed_required with canonical payload', async () => {
    const base = await seedBaseFixture(pool, `edit-repoint-${Date.now()}`);
    const booking = await seedConfirmedBooking(pool, base);
    const { workOrderId } = await seedWorkOrderForRepoint(pool, base, booking.bookingId);

    const newStartAt = '2026-10-01T09:30:00Z';
    const newSlaDueAt = '2026-10-01T13:30:00Z';
    const plan: Record<string, unknown> = {
      _resolution_at: '2026-09-15T00:00:00Z',
      rule_outcome_fingerprint: 'fingerprint-repoint',
      client_request_id: 'edit-repoint-crid',
      approval: buildApprovalBlock({}),
      booking: {
        // Required keys (v2 Fix 2). Same space + same window → no
        // location_changed / cost_changed emits, so the outbox row count
        // for this booking remains zero. The repoint emit is keyed on
        // the work_order_id, not the booking.
        location_id: base.spaceId,
        start_at: '2026-10-01T10:00:00Z',
        end_at: '2026-10-01T11:00:00Z',
        cost_amount_snapshot: 100.0,
      },
      slot_patches: [
        {
          slot_id: booking.slotId,
          space_id: base.spaceId,
          start_at: '2026-10-01T10:00:00Z',
          end_at: '2026-10-01T11:00:00Z',
          setup_buffer_minutes: 0,
          teardown_buffer_minutes: 0,
          attendee_count: null,
          attendee_person_ids: null,
        },
      ],
      asset_reservation_patches: [],
      order_patches: [],
      work_order_sla_patches: [
        {
          id: workOrderId,
          planned_start_at: newStartAt,
          sla_due_at: newSlaDueAt,
          needs_repoint: true,
        },
      ],
    };
    const idempotencyKey = buildEditBookingIdempotencyKey(booking.bookingId, 'crid-repoint');

    const result = await runRpcCapture<EditResult>(pool, 'public.edit_booking', [
      booking.bookingId,
      plan,
      base.tenantId,
      null,
      idempotencyKey,
    ]);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.wo_updated).toBe(1);
    expect(result.value.follow_ups).toContain('sla.timer_repointed_required');

    // Producer-side outbox shape assertion. Handler is ticket-only per
    // sla-timer-repoint.handler.ts:74-100 — that's a B.4.A.4 follow-up;
    // here we just assert the emit fired with the right payload so the
    // future WO-side handler picks it up.
    const repointRows = await pool.query<{ event_type: string; payload: Record<string, unknown> }>(
      `select event_type, payload from outbox.events
        where tenant_id = $1
          and aggregate_type = 'work_order'
          and aggregate_id = $2`,
      [base.tenantId, workOrderId],
    );
    expect(repointRows.rows).toHaveLength(1);
    expect(repointRows.rows[0].event_type).toBe('sla.timer_repointed_required');
    expect(repointRows.rows[0].payload.work_order_id).toBe(workOrderId);
    expect(repointRows.rows[0].payload.source).toBe('edit_booking');
    expect(typeof repointRows.rows[0].payload.started_at).toBe('string');

    // Sanity check the actual work_orders row was rewritten.
    const woRow = await pool.query<{ planned_start_at: string; sla_resolution_due_at: string }>(
      'select planned_start_at, sla_resolution_due_at from public.work_orders where id = $1',
      [workOrderId],
    );
    expect(new Date(woRow.rows[0].planned_start_at).toISOString()).toBe(
      new Date(newStartAt).toISOString(),
    );
    expect(new Date(woRow.rows[0].sla_resolution_due_at).toISOString()).toBe(
      new Date(newSlaDueAt).toISOString(),
    );
  });

  // ── Scenario 14 (v3 Critical 2): work_order leak rejection ───────────
  // Booking A's edit references a work_order anchored to booking B. v2
  // tenant-only filtering would have rewritten booking B's WO; v3 must
  // raise edit_booking.work_order_not_in_booking and leave the row alone.
  it('cross-booking WO patch — raises edit_booking.work_order_not_in_booking + no row mutation', async () => {
    const base = await seedBaseFixture(pool, `edit-wo-leak-${Date.now()}`);
    const bookingA = await seedConfirmedBooking(pool, base);
    const { foreignBookingId, foreignWorkOrderId } = await seedForeignBookingWithWorkOrder(
      pool,
      base,
    );

    // Capture the foreign WO's planned_start_at BEFORE the RPC so we can
    // assert it didn't change after the (expected) error.
    const beforeRow = await pool.query<{ planned_start_at: string }>(
      'select planned_start_at from public.work_orders where id = $1',
      [foreignWorkOrderId],
    );
    const beforePlannedStart = beforeRow.rows[0].planned_start_at;

    // Plan edits booking A but smuggles a WO patch targeting booking B's WO.
    const plan: Record<string, unknown> = {
      _resolution_at: '2026-09-15T00:00:00Z',
      rule_outcome_fingerprint: 'fingerprint-wo-leak',
      client_request_id: 'edit-wo-leak-crid',
      approval: buildApprovalBlock({}),
      booking: {
        location_id: base.spaceId,
        start_at: '2026-10-01T10:00:00Z',
        end_at: '2026-10-01T11:00:00Z',
        cost_amount_snapshot: 100.0,
      },
      slot_patches: [
        {
          slot_id: bookingA.slotId,
          space_id: base.spaceId,
          start_at: '2026-10-01T10:00:00Z',
          end_at: '2026-10-01T11:00:00Z',
          setup_buffer_minutes: 0,
          teardown_buffer_minutes: 0,
          attendee_count: null,
          attendee_person_ids: null,
        },
      ],
      asset_reservation_patches: [],
      order_patches: [],
      work_order_sla_patches: [
        {
          id: foreignWorkOrderId,
          planned_start_at: '2099-01-01T00:00:00Z',
          needs_repoint: false,
        },
      ],
    };
    const idempotencyKey = buildEditBookingIdempotencyKey(bookingA.bookingId, 'crid-wo-leak');

    const result = await runRpcCapture(pool, 'public.edit_booking', [
      bookingA.bookingId,
      plan,
      base.tenantId,
      null,
      idempotencyKey,
    ]);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.message).toContain('edit_booking.work_order_not_in_booking');

    // Foreign WO untouched. pg returns timestamptz columns as JS Date
    // objects, not strings — compare as ISO to avoid identity mismatch.
    const afterRow = await pool.query<{ planned_start_at: string }>(
      'select planned_start_at from public.work_orders where id = $1',
      [foreignWorkOrderId],
    );
    expect(new Date(afterRow.rows[0].planned_start_at).toISOString()).toBe(
      new Date(beforePlannedStart).toISOString(),
    );

    // Foreign booking still exists (defensive sanity check).
    const foreignBookingRow = await pool.query<{ id: string }>(
      'select id from public.bookings where id = $1',
      [foreignBookingId],
    );
    expect(foreignBookingRow.rows).toHaveLength(1);
  });

  // ── Scenario 15 (v3 Critical 2): order leak rejection ─────────────────
  it('cross-booking order patch — raises edit_booking.order_not_in_booking + no row mutation', async () => {
    const base = await seedBaseFixture(pool, `edit-order-leak-${Date.now()}`);
    const bookingA = await seedConfirmedBooking(pool, base);
    // Seed a foreign booking + an order anchored to that foreign booking.
    const { foreignBookingId } = await seedForeignBookingWithWorkOrder(pool, base);
    const { orderId: foreignOrderId } = await seedOrderForBooking(
      pool,
      base,
      foreignBookingId,
    );

    const beforeRow = await pool.query<{ delivery_location_id: string | null }>(
      'select delivery_location_id from public.orders where id = $1',
      [foreignOrderId],
    );
    const beforeDeliveryLocation = beforeRow.rows[0].delivery_location_id;

    const plan: Record<string, unknown> = {
      _resolution_at: '2026-09-15T00:00:00Z',
      rule_outcome_fingerprint: 'fingerprint-order-leak',
      client_request_id: 'edit-order-leak-crid',
      approval: buildApprovalBlock({}),
      booking: {
        location_id: base.spaceId,
        start_at: '2026-10-01T10:00:00Z',
        end_at: '2026-10-01T11:00:00Z',
        cost_amount_snapshot: 100.0,
      },
      slot_patches: [
        {
          slot_id: bookingA.slotId,
          space_id: base.spaceId,
          start_at: '2026-10-01T10:00:00Z',
          end_at: '2026-10-01T11:00:00Z',
          setup_buffer_minutes: 0,
          teardown_buffer_minutes: 0,
          attendee_count: null,
          attendee_person_ids: null,
        },
      ],
      asset_reservation_patches: [],
      order_patches: [
        {
          id: foreignOrderId,
          delivery_location_id: base.spaceId, // try to flip the delivery loc
        },
      ],
      work_order_sla_patches: [],
    };
    const idempotencyKey = buildEditBookingIdempotencyKey(bookingA.bookingId, 'crid-order-leak');

    const result = await runRpcCapture(pool, 'public.edit_booking', [
      bookingA.bookingId,
      plan,
      base.tenantId,
      null,
      idempotencyKey,
    ]);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.message).toContain('edit_booking.order_not_in_booking');

    // Foreign order untouched.
    const afterRow = await pool.query<{ delivery_location_id: string | null }>(
      'select delivery_location_id from public.orders where id = $1',
      [foreignOrderId],
    );
    expect(afterRow.rows[0].delivery_location_id).toBe(beforeDeliveryLocation);
  });

  // ── Scenario 16 (v3 Critical 2): asset_reservation leak rejection ────
  it('cross-booking asset_reservation patch — raises edit_booking.asset_reservation_not_in_booking', async () => {
    const base = await seedBaseFixture(pool, `edit-asset-leak-${Date.now()}`);
    const bookingA = await seedConfirmedBooking(pool, base);
    const { foreignBookingId } = await seedForeignBookingWithWorkOrder(pool, base);
    const { reservationId: foreignReservationId } = await seedAssetReservationForBooking(
      pool,
      base,
      foreignBookingId,
    );

    const beforeRow = await pool.query<{ start_at: string }>(
      'select start_at from public.asset_reservations where id = $1',
      [foreignReservationId],
    );
    const beforeStart = beforeRow.rows[0].start_at;

    const plan: Record<string, unknown> = {
      _resolution_at: '2026-09-15T00:00:00Z',
      rule_outcome_fingerprint: 'fingerprint-asset-leak',
      client_request_id: 'edit-asset-leak-crid',
      approval: buildApprovalBlock({}),
      booking: {
        location_id: base.spaceId,
        start_at: '2026-10-01T10:00:00Z',
        end_at: '2026-10-01T11:00:00Z',
        cost_amount_snapshot: 100.0,
      },
      slot_patches: [
        {
          slot_id: bookingA.slotId,
          space_id: base.spaceId,
          start_at: '2026-10-01T10:00:00Z',
          end_at: '2026-10-01T11:00:00Z',
          setup_buffer_minutes: 0,
          teardown_buffer_minutes: 0,
          attendee_count: null,
          attendee_person_ids: null,
        },
      ],
      asset_reservation_patches: [
        {
          id: foreignReservationId,
          start_at: '2099-01-01T00:00:00Z',
          end_at: '2099-01-01T01:00:00Z',
        },
      ],
      order_patches: [],
      work_order_sla_patches: [],
    };
    const idempotencyKey = buildEditBookingIdempotencyKey(bookingA.bookingId, 'crid-asset-leak');

    const result = await runRpcCapture(pool, 'public.edit_booking', [
      bookingA.bookingId,
      plan,
      base.tenantId,
      null,
      idempotencyKey,
    ]);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.message).toContain('edit_booking.asset_reservation_not_in_booking');

    // Foreign reservation untouched.
    const afterRow = await pool.query<{ start_at: string }>(
      'select start_at from public.asset_reservations where id = $1',
      [foreignReservationId],
    );
    expect(new Date(afterRow.rows[0].start_at).toISOString()).toBe(
      new Date(beforeStart).toISOString(),
    );
    // Foreign booking still exists (defensive).
    expect(foreignBookingId).toBeTruthy();
  });

  // ── Scenario 17 (v3 Critical 1): destination-room rule gates stale_resolution
  // Booking starts in room A; we move it to room B. A `target_scope='room'
  // target_id=B` rule was updated AFTER plan._resolution_at. v2's gate
  // (room-scope filtered on origin only) would have missed this update;
  // v3 must see B's updated_at and raise automation_plan.stale_resolution.
  it('destination-room rule update — raises automation_plan.stale_resolution under v3 gate', async () => {
    const base = await seedBaseFixture(pool, `edit-dest-room-stale-${Date.now()}`);
    const booking = await seedConfirmedBooking(pool, base);
    const destinationRoomId = await seedTargetMeetingRoom(pool, base);

    // Plan-build resolution timestamp: T0. Rule on DESTINATION room
    // updated at T0+5d → must trigger stale_resolution under v3.
    await seedBookingRule(pool, base.tenantId, {
      targetScope: 'room',
      targetId: destinationRoomId,
      updatedAtIso: '2026-09-20T00:00:00Z',
    });

    // Sanity check: a rule on the ORIGIN room with updated_at BEFORE the
    // resolution timestamp must NOT trip the gate on its own — this
    // proves the assertion isn't passing by accident on the wrong rule.
    await seedBookingRule(pool, base.tenantId, {
      targetScope: 'room',
      targetId: base.spaceId,
      updatedAtIso: '2026-09-01T00:00:00Z',
    });

    const plan = buildLocationSwapPlan({
      bookingId: booking.bookingId,
      slotId: booking.slotId,
      fromSpaceId: base.spaceId,
      toSpaceId: destinationRoomId,
      resolutionAtIso: '2026-09-15T00:00:00Z',
    });
    const idempotencyKey = buildEditBookingIdempotencyKey(booking.bookingId, 'crid-dest-stale');

    const result = await runRpcCapture(pool, 'public.edit_booking', [
      booking.bookingId,
      plan,
      base.tenantId,
      null,
      idempotencyKey,
    ]);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.message).toContain('automation_plan.stale_resolution');

    // Booking row must NOT have been rewritten (the gate fires before the
    // write block).
    const bookingRow = await pool.query<{ location_id: string }>(
      'select location_id from public.bookings where id = $1',
      [booking.bookingId],
    );
    expect(bookingRow.rows[0].location_id).toBe(base.spaceId);
  });

  // ── Scenario 18 (§3.6.5 Row 3): require_approval → allow, pending ────
  it('§3.6.5 Row 3 — require_approval→allow (pending) expires chain + status=confirmed', async () => {
    const base = await seedBaseFixture(pool, `edit-row3-${Date.now()}`);
    const booking = await seedConfirmedBooking(pool, base);
    // Seed an in-flight approval row + flip booking to pending_approval
    // so the pre-edit state mirrors a real require_approval scenario.
    const { chainId } = await seedBookingApprovalChain(pool, base, booking.bookingId, [
      { status: 'pending', approverPersonId: base.personId, parallelGroup: 'old-parallel' },
    ]);
    await pool.query(`update public.bookings set status='pending_approval' where id=$1`, [
      booking.bookingId,
    ]);

    const plan = buildLocationSwapPlan({
      bookingId: booking.bookingId,
      slotId: booking.slotId,
      fromSpaceId: base.spaceId,
      toSpaceId: base.spaceId,
      resolutionAtIso: '2026-09-15T00:00:00Z',
      approval: buildApprovalBlock({
        oldOutcome: 'require_approval',
        newOutcome: 'allow',
        chainConfigChanged: true,
        newChainConfig: null,
      }),
    });
    const idempotencyKey = buildEditBookingIdempotencyKey(booking.bookingId, 'crid-row3');

    const result = await runRpcCapture<EditResult>(pool, 'public.edit_booking', [
      booking.bookingId,
      plan,
      base.tenantId,
      null,
      idempotencyKey,
    ]);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.follow_ups).not.toContain('booking.approval_required');

    // The original pending row is now 'expired' with the canonical
    // superseded_by_edit comment.
    const approvalRows = await pool.query<{
      status: string;
      approval_chain_id: string;
      comments: string | null;
    }>(
      `select status, approval_chain_id, comments
         from public.approvals
        where tenant_id = $1 and target_entity_id = $2`,
      [base.tenantId, booking.bookingId],
    );
    expect(approvalRows.rows).toHaveLength(1);
    expect(approvalRows.rows[0].status).toBe('expired');
    expect(approvalRows.rows[0].approval_chain_id).toBe(chainId);
    expect(approvalRows.rows[0].comments).toContain('superseded_by_edit');

    // Booking flipped to 'confirmed'.
    const bookingRow = await pool.query<{ status: string }>(
      'select status from public.bookings where id = $1',
      [booking.bookingId],
    );
    expect(bookingRow.rows[0].status).toBe('confirmed');
  });

  // ── Scenario 19 (§3.6.5 Row 6): same-config preserve ──────────────────
  it('§3.6.5 Row 6 — require_approval→require_approval (pending, same config) preserves chain', async () => {
    const base = await seedBaseFixture(pool, `edit-row6-${Date.now()}`);
    const booking = await seedConfirmedBooking(pool, base);
    const { chainId } = await seedBookingApprovalChain(pool, base, booking.bookingId, [
      { status: 'pending', approverPersonId: base.personId },
    ]);
    await pool.query(`update public.bookings set status='pending_approval' where id=$1`, [
      booking.bookingId,
    ]);

    // chain_config_changed=false → preserve. new_chain_config can be null;
    // RPC won't insert.
    const plan = buildLocationSwapPlan({
      bookingId: booking.bookingId,
      slotId: booking.slotId,
      fromSpaceId: base.spaceId,
      toSpaceId: base.spaceId,
      resolutionAtIso: '2026-09-15T00:00:00Z',
      approval: buildApprovalBlock({
        oldOutcome: 'require_approval',
        newOutcome: 'require_approval',
        chainConfigChanged: false,
        newChainConfig: null,
      }),
    });
    const idempotencyKey = buildEditBookingIdempotencyKey(booking.bookingId, 'crid-row6');

    const result = await runRpcCapture<EditResult>(pool, 'public.edit_booking', [
      booking.bookingId,
      plan,
      base.tenantId,
      null,
      idempotencyKey,
    ]);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.follow_ups).not.toContain('booking.approval_required');

    const approvalRows = await pool.query<{
      status: string;
      approval_chain_id: string;
    }>(
      `select status, approval_chain_id
         from public.approvals
        where tenant_id = $1 and target_entity_id = $2`,
      [base.tenantId, booking.bookingId],
    );
    expect(approvalRows.rows).toHaveLength(1);
    expect(approvalRows.rows[0].status).toBe('pending');
    expect(approvalRows.rows[0].approval_chain_id).toBe(chainId);

    const bookingRow = await pool.query<{ status: string }>(
      'select status from public.bookings where id = $1',
      [booking.bookingId],
    );
    expect(bookingRow.rows[0].status).toBe('pending_approval');
  });

  // ── Scenario 20 (§3.6.5 Row 7): pending, diff config → expire + insert ─
  it('§3.6.5 Row 7 — require_approval→require_approval (pending, diff config) expires + inserts fresh', async () => {
    const base = await seedBaseFixture(pool, `edit-row7-${Date.now()}`);
    const booking = await seedConfirmedBooking(pool, base);
    const { chainId: oldChainId } = await seedBookingApprovalChain(pool, base, booking.bookingId, [
      { status: 'pending', approverPersonId: base.personId, parallelGroup: 'old-parallel' },
    ]);
    await pool.query(`update public.bookings set status='pending_approval' where id=$1`, [
      booking.bookingId,
    ]);

    const plan = buildLocationSwapPlan({
      bookingId: booking.bookingId,
      slotId: booking.slotId,
      fromSpaceId: base.spaceId,
      toSpaceId: base.spaceId,
      resolutionAtIso: '2026-09-15T00:00:00Z',
      approval: buildApprovalBlock({
        oldOutcome: 'require_approval',
        newOutcome: 'require_approval',
        chainConfigChanged: true,
        newChainConfig: {
          requiredApprovers: [{ type: 'team', id: base.teamId }],
          threshold: 'all',
        },
      }),
    });
    const idempotencyKey = buildEditBookingIdempotencyKey(booking.bookingId, 'crid-row7');

    const result = await runRpcCapture<EditResult>(pool, 'public.edit_booking', [
      booking.bookingId,
      plan,
      base.tenantId,
      null,
      idempotencyKey,
    ]);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.follow_ups).toContain('booking.approval_required');

    const approvalRows = await pool.query<{
      status: string;
      approval_chain_id: string;
      approver_team_id: string | null;
      comments: string | null;
    }>(
      `select status, approval_chain_id, approver_team_id, comments
         from public.approvals
        where tenant_id = $1 and target_entity_id = $2
        order by status`,
      [base.tenantId, booking.bookingId],
    );
    // 2 rows total: 1 expired (old chain) + 1 pending (new chain).
    expect(approvalRows.rows).toHaveLength(2);
    const expired = approvalRows.rows.find((r) => r.status === 'expired');
    const pending = approvalRows.rows.find((r) => r.status === 'pending');
    expect(expired).toBeDefined();
    expect(pending).toBeDefined();
    expect(expired!.approval_chain_id).toBe(oldChainId);
    expect(expired!.comments).toContain('superseded_by_edit');
    expect(pending!.approval_chain_id).not.toBe(oldChainId);
    expect(pending!.approver_team_id).toBe(base.teamId);

    const bookingRow = await pool.query<{ status: string }>(
      'select status from public.bookings where id = $1',
      [booking.bookingId],
    );
    expect(bookingRow.rows[0].status).toBe('pending_approval');
  });

  // ── Scenario 21 (§3.6.5 Row 8 — DANGEROUS GAP): terminal_approved + diff
  // Approved chain must be expired (so the new chain owns the decision),
  // new chain inserted, status flips BACK to pending_approval.
  it('§3.6.5 Row 8 (DANGEROUS GAP) — terminal_approved + diff config expires approved rows + inserts fresh', async () => {
    const base = await seedBaseFixture(pool, `edit-row8-${Date.now()}`);
    const booking = await seedConfirmedBooking(pool, base);
    // Booking is confirmed; existing approved chain is the historical
    // approval. terminal_approved = zero pending/delegated/rejected, ≥1
    // approved.
    const { chainId: oldChainId } = await seedBookingApprovalChain(pool, base, booking.bookingId, [
      { status: 'approved', approverPersonId: base.personId },
    ]);

    const plan = buildLocationSwapPlan({
      bookingId: booking.bookingId,
      slotId: booking.slotId,
      fromSpaceId: base.spaceId,
      toSpaceId: base.spaceId,
      resolutionAtIso: '2026-09-15T00:00:00Z',
      approval: buildApprovalBlock({
        oldOutcome: 'require_approval',
        newOutcome: 'require_approval',
        chainConfigChanged: true,
        newChainConfig: {
          requiredApprovers: [{ type: 'team', id: base.teamId }],
          threshold: 'all',
        },
      }),
    });
    const idempotencyKey = buildEditBookingIdempotencyKey(booking.bookingId, 'crid-row8');

    const result = await runRpcCapture<EditResult>(pool, 'public.edit_booking', [
      booking.bookingId,
      plan,
      base.tenantId,
      null,
      idempotencyKey,
    ]);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.follow_ups).toContain('booking.approval_required');

    const approvalRows = await pool.query<{
      status: string;
      approval_chain_id: string;
      comments: string | null;
    }>(
      `select status, approval_chain_id, comments
         from public.approvals
        where tenant_id = $1 and target_entity_id = $2
        order by status`,
      [base.tenantId, booking.bookingId],
    );
    expect(approvalRows.rows).toHaveLength(2);
    const expired = approvalRows.rows.find((r) => r.status === 'expired');
    const pending = approvalRows.rows.find((r) => r.status === 'pending');
    expect(expired).toBeDefined();
    expect(pending).toBeDefined();
    // Dangerous-gap defining property: the historical 'approved' row was
    // flipped to 'expired' so the new chain owns the booking. Audit log
    // preserves it via the comment.
    expect(expired!.approval_chain_id).toBe(oldChainId);
    expect(expired!.comments).toContain('superseded_by_edit');
    expect(pending!.approval_chain_id).not.toBe(oldChainId);

    // Status flipped from 'confirmed' back to 'pending_approval'.
    const bookingRow = await pool.query<{ status: string }>(
      'select status from public.bookings where id = $1',
      [booking.bookingId],
    );
    expect(bookingRow.rows[0].status).toBe('pending_approval');
  });

  // ── Scenario 22 (§3.6.5 Row 9): terminal_rejected → cancelled_cannot_edit
  it('§3.6.5 Row 9 — terminal_rejected raises booking.cancelled_cannot_edit', async () => {
    const base = await seedBaseFixture(pool, `edit-row9-${Date.now()}`);
    const booking = await seedConfirmedBooking(pool, base);
    // Seed a rejected row but DON'T flip bookings.status to 'cancelled'
    // — this exercises the §3.6.5 row 9 defensive branch where the
    // approval-grant RPC's cascade hasn't caught up. Booking status stays
    // 'confirmed' but the approvals row says rejected.
    await seedBookingApprovalChain(pool, base, booking.bookingId, [
      { status: 'rejected', approverPersonId: base.personId },
    ]);

    const plan = buildLocationSwapPlan({
      bookingId: booking.bookingId,
      slotId: booking.slotId,
      fromSpaceId: base.spaceId,
      toSpaceId: base.spaceId,
      resolutionAtIso: '2026-09-15T00:00:00Z',
      approval: buildApprovalBlock({
        oldOutcome: 'require_approval',
        newOutcome: 'allow',
        chainConfigChanged: false,
        newChainConfig: null,
      }),
    });
    const idempotencyKey = buildEditBookingIdempotencyKey(booking.bookingId, 'crid-row9');

    const result = await runRpcCapture(pool, 'public.edit_booking', [
      booking.bookingId,
      plan,
      base.tenantId,
      null,
      idempotencyKey,
    ]);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.message).toContain('booking.cancelled_cannot_edit');
  });

  // ── Scenario 23 (§3.6.5 Row 10): deny → edit_booking.deny_on_edit ────
  it('§3.6.5 Row 10 — new_outcome=deny raises edit_booking.deny_on_edit', async () => {
    const base = await seedBaseFixture(pool, `edit-row10-${Date.now()}`);
    const booking = await seedConfirmedBooking(pool, base);
    const targetSpaceId = await seedTargetMeetingRoom(pool, base);

    const plan = buildLocationSwapPlan({
      bookingId: booking.bookingId,
      slotId: booking.slotId,
      fromSpaceId: base.spaceId,
      toSpaceId: targetSpaceId,
      resolutionAtIso: '2026-09-15T00:00:00Z',
      approval: buildApprovalBlock({
        oldOutcome: 'allow',
        newOutcome: 'deny',
        chainConfigChanged: false,
        newChainConfig: null,
      }),
    });
    const idempotencyKey = buildEditBookingIdempotencyKey(booking.bookingId, 'crid-row10');

    const result = await runRpcCapture(pool, 'public.edit_booking', [
      booking.bookingId,
      plan,
      base.tenantId,
      null,
      idempotencyKey,
    ]);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.message).toContain('edit_booking.deny_on_edit');

    // Booking row must NOT have been rewritten (the deny raise short-
    // circuits before §10 atomic writes).
    const bookingRow = await pool.query<{ location_id: string; status: string }>(
      'select location_id, status from public.bookings where id = $1',
      [booking.bookingId],
    );
    expect(bookingRow.rows[0].location_id).toBe(base.spaceId);
    expect(bookingRow.rows[0].status).toBe('confirmed');
  });

  // ── Scenario 24: cross-tenant person approver rejection ──────────────
  it('cross-tenant person approver — raises validate_entity_in_tenant.person_not_in_tenant', async () => {
    const base = await seedBaseFixture(pool, `edit-xtenant-person-${Date.now()}`);
    const booking = await seedConfirmedBooking(pool, base);
    // Forge a person id from another tenant. seedSecondTenantSpace doesn't
    // seed a person; for the leak shape what matters is the id IS valid
    // syntactically but doesn't exist in this tenant. A random uuid hits
    // the same code path (validate_entity_in_tenant.person_not_in_tenant)
    // because the FK lookup misses.
    const foreignPersonId = randomUUID();

    const plan = buildLocationSwapPlan({
      bookingId: booking.bookingId,
      slotId: booking.slotId,
      fromSpaceId: base.spaceId,
      toSpaceId: base.spaceId,
      resolutionAtIso: '2026-09-15T00:00:00Z',
      approval: buildApprovalBlock({
        oldOutcome: 'allow',
        newOutcome: 'require_approval',
        chainConfigChanged: true,
        newChainConfig: {
          requiredApprovers: [{ type: 'person', id: foreignPersonId }],
          threshold: 'all',
        },
      }),
    });
    const idempotencyKey = buildEditBookingIdempotencyKey(booking.bookingId, 'crid-xtenant-person');

    const result = await runRpcCapture(pool, 'public.edit_booking', [
      booking.bookingId,
      plan,
      base.tenantId,
      null,
      idempotencyKey,
    ]);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.message).toContain('validate_entity_in_tenant.person_not_in_tenant');

    // No approvals row inserted.
    const approvalRows = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.approvals
        where tenant_id = $1 and target_entity_id = $2`,
      [base.tenantId, booking.bookingId],
    );
    expect(approvalRows.rows[0].n).toBe(0);
  });

  // ── Scenario 25: cross-tenant team approver rejection ────────────────
  it('cross-tenant team approver — raises validate_entity_in_tenant.team_not_in_tenant', async () => {
    const base = await seedBaseFixture(pool, `edit-xtenant-team-${Date.now()}`);
    const booking = await seedConfirmedBooking(pool, base);
    const foreignTeamId = randomUUID();

    const plan = buildLocationSwapPlan({
      bookingId: booking.bookingId,
      slotId: booking.slotId,
      fromSpaceId: base.spaceId,
      toSpaceId: base.spaceId,
      resolutionAtIso: '2026-09-15T00:00:00Z',
      approval: buildApprovalBlock({
        oldOutcome: 'allow',
        newOutcome: 'require_approval',
        chainConfigChanged: true,
        newChainConfig: {
          requiredApprovers: [{ type: 'team', id: foreignTeamId }],
          threshold: 'all',
        },
      }),
    });
    const idempotencyKey = buildEditBookingIdempotencyKey(booking.bookingId, 'crid-xtenant-team');

    const result = await runRpcCapture(pool, 'public.edit_booking', [
      booking.bookingId,
      plan,
      base.tenantId,
      null,
      idempotencyKey,
    ]);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.message).toContain('validate_entity_in_tenant.team_not_in_tenant');

    const approvalRows = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.approvals
        where tenant_id = $1 and target_entity_id = $2`,
      [base.tenantId, booking.bookingId],
    );
    expect(approvalRows.rows[0].n).toBe(0);
  });

  // ── Scenario 26 (§3.6.5 Row 4): require_approval → allow, terminal_approved
  // The historical approved chain stands as audit; status stays 'confirmed';
  // ZERO new approval rows; NO booking.approval_required emit. This is the
  // no-op case Row 8 specifically inverts — Row 4 keeps the approved row
  // untouched because the new outcome is `allow` (the resolver says the
  // edited booking no longer needs approval, so the historical approval
  // simply stops mattering).
  it('§3.6.5 Row 4 — require_approval→allow (terminal_approved) preserves historical chain + no emit', async () => {
    const base = await seedBaseFixture(pool, `edit-row4-${Date.now()}`);
    const booking = await seedConfirmedBooking(pool, base);
    // terminal_approved = no pending/delegated/rejected rows; ≥1 approved.
    const { chainId: oldChainId } = await seedBookingApprovalChain(pool, base, booking.bookingId, [
      { status: 'approved', approverPersonId: base.personId },
    ]);

    // Pre-edit assertion: exactly one 'approved' row exists.
    const beforeRows = await pool.query<{ n: number; status: string }>(
      `select count(*)::int as n, max(status) as status
         from public.approvals
        where tenant_id = $1 and target_entity_id = $2`,
      [base.tenantId, booking.bookingId],
    );
    expect(beforeRows.rows[0].n).toBe(1);
    expect(beforeRows.rows[0].status).toBe('approved');

    const plan = buildLocationSwapPlan({
      bookingId: booking.bookingId,
      slotId: booking.slotId,
      fromSpaceId: base.spaceId,
      toSpaceId: base.spaceId,
      resolutionAtIso: '2026-09-15T00:00:00Z',
      approval: buildApprovalBlock({
        oldOutcome: 'require_approval',
        newOutcome: 'allow',
        chainConfigChanged: false,
        newChainConfig: null,
      }),
    });
    const idempotencyKey = buildEditBookingIdempotencyKey(booking.bookingId, 'crid-row4');

    const result = await runRpcCapture<EditResult>(pool, 'public.edit_booking', [
      booking.bookingId,
      plan,
      base.tenantId,
      null,
      idempotencyKey,
    ]);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    // Row 4 is a no-op for approvals: NO approval_required follow-up.
    expect(result.value.follow_ups).not.toContain('booking.approval_required');

    // Approval rows: still exactly 1, still 'approved', still on the
    // historical chain, comments NOT touched (no superseded_by_edit).
    const afterRows = await pool.query<{
      status: string;
      approval_chain_id: string;
      comments: string | null;
    }>(
      `select status, approval_chain_id, comments
         from public.approvals
        where tenant_id = $1 and target_entity_id = $2`,
      [base.tenantId, booking.bookingId],
    );
    expect(afterRows.rows).toHaveLength(1);
    expect(afterRows.rows[0].status).toBe('approved');
    expect(afterRows.rows[0].approval_chain_id).toBe(oldChainId);
    expect(afterRows.rows[0].comments ?? '').not.toContain('superseded_by_edit');

    // Booking status stays 'confirmed'.
    const bookingRow = await pool.query<{ status: string }>(
      'select status from public.bookings where id = $1',
      [booking.bookingId],
    );
    expect(bookingRow.rows[0].status).toBe('confirmed');

    // Outbox: ZERO booking.approval_required events for this booking.
    const outboxRows = await pool.query<{ n: number }>(
      `select count(*)::int as n from outbox.events
        where tenant_id = $1 and aggregate_id = $2
          and event_type = 'booking.approval_required'`,
      [base.tenantId, booking.bookingId],
    );
    expect(outboxRows.rows[0].n).toBe(0);
  });

  // ── Scenario 27 (B.4.A.5 sub-step B): inbox INSERT row count == approver count ─
  // Hybrid C invariant — flipping allow→require_approval on a fresh booking
  // writes one inbox_notifications row per person approver, atomically with
  // the approvals row, in the same RPC tx. Person approver path.
  it('B.4.A.5 — person approver inbox INSERT row count == approver count', async () => {
    const base = await seedBaseFixture(pool, `inbox-person-${Date.now()}`);
    const booking = await seedConfirmedBooking(pool, base);
    const targetSpaceId = await seedTargetMeetingRoom(pool, base);

    // Wire the approver person to a real users row so the RPC's
    // `users.person_id = v_approver_id` JOIN finds it. seedAuthUser
    // returns { userId, authUid }; we keep the user — the inbox INSERT
    // targets users.id, not auth_uid.
    const { userId: approverUserId } = await seedAuthUser(
      pool,
      base.tenantId,
      base.approverPersonId,
    );

    const plan = buildLocationSwapPlan({
      bookingId: booking.bookingId,
      slotId: booking.slotId,
      fromSpaceId: base.spaceId,
      toSpaceId: targetSpaceId,
      resolutionAtIso: '2026-09-15T00:00:00Z',
      approval: buildApprovalBlock({
        oldOutcome: 'allow',
        newOutcome: 'require_approval',
        chainConfigChanged: true,
        newChainConfig: {
          requiredApprovers: [{ type: 'person', id: base.approverPersonId }],
          threshold: 'all',
        },
      }),
    });
    const idempotencyKey = buildEditBookingIdempotencyKey(booking.bookingId, 'crid-inbox-p');

    const result = await runRpcCapture<EditResult>(pool, 'public.edit_booking', [
      booking.bookingId,
      plan,
      base.tenantId,
      null,
      idempotencyKey,
    ]);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    const chainRow = await pool.query<{ approval_chain_id: string }>(
      `select approval_chain_id from public.approvals
        where tenant_id = $1 and target_entity_id = $2 limit 1`,
      [base.tenantId, booking.bookingId],
    );
    const chainId = chainRow.rows[0].approval_chain_id;

    // Inbox row: exactly 1 (person approver = 1 user).
    const inboxRows = await pool.query<{
      user_id: string;
      event_kind: string;
      payload: Record<string, unknown>;
    }>(
      `select user_id, event_kind, payload
         from public.inbox_notifications
        where tenant_id = $1 and payload->>'chain_id' = $2`,
      [base.tenantId, chainId],
    );
    expect(inboxRows.rows).toHaveLength(1);
    expect(inboxRows.rows[0].user_id).toBe(approverUserId);
    expect(inboxRows.rows[0].event_kind).toBe('booking.approval_required');
    expect(inboxRows.rows[0].payload.booking_id).toBe(booking.bookingId);
    expect(inboxRows.rows[0].payload.chain_id).toBe(chainId);
    expect(inboxRows.rows[0].payload.approver_person_id).toBe(base.approverPersonId);
  });

  // ── Scenario 28 (B.4.A.5 sub-step B): ON CONFLICT replay preserves count ─
  // Same edit replayed via the same idempotency_key returns the cached
  // result — the inbox block does NOT re-execute (cached_result short-
  // circuits), and even if a future change re-executes the block (e.g.
  // ON CONFLICT survives via the partial unique index), the count stays
  // unchanged. Both paths are exercised here.
  it('B.4.A.5 — ON CONFLICT replay preserves inbox row count', async () => {
    const base = await seedBaseFixture(pool, `inbox-replay-${Date.now()}`);
    const booking = await seedConfirmedBooking(pool, base);
    const targetSpaceId = await seedTargetMeetingRoom(pool, base);
    await seedAuthUser(pool, base.tenantId, base.approverPersonId);

    const plan = buildLocationSwapPlan({
      bookingId: booking.bookingId,
      slotId: booking.slotId,
      fromSpaceId: base.spaceId,
      toSpaceId: targetSpaceId,
      resolutionAtIso: '2026-09-15T00:00:00Z',
      approval: buildApprovalBlock({
        oldOutcome: 'allow',
        newOutcome: 'require_approval',
        chainConfigChanged: true,
        newChainConfig: {
          requiredApprovers: [{ type: 'person', id: base.approverPersonId }],
          threshold: 'all',
        },
      }),
    });
    const idempotencyKey = buildEditBookingIdempotencyKey(booking.bookingId, 'crid-inbox-replay');

    const first = await runRpcCapture<EditResult>(pool, 'public.edit_booking', [
      booking.bookingId,
      plan,
      base.tenantId,
      null,
      idempotencyKey,
    ]);
    expect(first.kind).toBe('ok');

    const initialCount = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.inbox_notifications
        where tenant_id = $1 and event_kind = 'booking.approval_required'`,
      [base.tenantId],
    );
    expect(initialCount.rows[0].n).toBe(1);

    // Replay — same key, same payload → cached_result hit. No new inbox
    // row should be written (the replay short-circuits before the INSERT
    // block runs at all; the partial unique index would also catch any
    // re-execution).
    const second = await runRpcCapture<EditResult>(pool, 'public.edit_booking', [
      booking.bookingId,
      plan,
      base.tenantId,
      null,
      idempotencyKey,
    ]);
    expect(second.kind).toBe('ok');

    const replayedCount = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.inbox_notifications
        where tenant_id = $1 and event_kind = 'booking.approval_required'`,
      [base.tenantId],
    );
    expect(replayedCount.rows[0].n).toBe(1);
  });

  // ── Scenario 29 (B.4.A.5 sub-step B): team approver fan-out ──────────
  // Team approver path — RPC fans out via team_members.user_id JOIN public.users
  // (tenant-filtered both sides). N team members → N inbox rows.
  it('B.4.A.5 — team approver fan-out yields one inbox row per team member', async () => {
    const base = await seedBaseFixture(pool, `inbox-team-${Date.now()}`);
    const booking = await seedConfirmedBooking(pool, base);
    const targetSpaceId = await seedTargetMeetingRoom(pool, base);

    // Seed 3 users + add them to base.teamId. team_members joins on
    // user_id (00003:123).
    const member1 = await seedAuthUser(pool, base.tenantId, base.personId);
    const member2 = await seedAuthUser(pool, base.tenantId, base.approverPersonId);
    // Third member needs a fresh person row to satisfy users.person_id FK.
    const thirdPersonId = randomUUID();
    await pool.query(
      `insert into public.persons (id, tenant_id, type, first_name, last_name, email)
       values ($1, $2, 'employee', 'Team', 'Member3', $3)`,
      [thirdPersonId, base.tenantId, `team3-${thirdPersonId.slice(0, 8)}@concurrency.test`],
    );
    registerCleanup(async () => {
      await pool.query('delete from public.persons where id = $1', [thirdPersonId]);
    });
    const member3 = await seedAuthUser(pool, base.tenantId, thirdPersonId);

    for (const m of [member1, member2, member3]) {
      await pool.query(
        `insert into public.team_members (id, tenant_id, team_id, user_id)
         values ($1, $2, $3, $4)`,
        [randomUUID(), base.tenantId, base.teamId, m.userId],
      );
    }
    // team_members rows clean up via the seedBaseFixture cleanup.

    const plan = buildLocationSwapPlan({
      bookingId: booking.bookingId,
      slotId: booking.slotId,
      fromSpaceId: base.spaceId,
      toSpaceId: targetSpaceId,
      resolutionAtIso: '2026-09-15T00:00:00Z',
      approval: buildApprovalBlock({
        oldOutcome: 'allow',
        newOutcome: 'require_approval',
        chainConfigChanged: true,
        newChainConfig: {
          requiredApprovers: [{ type: 'team', id: base.teamId }],
          threshold: 'all',
        },
      }),
    });
    const idempotencyKey = buildEditBookingIdempotencyKey(booking.bookingId, 'crid-inbox-t');

    const result = await runRpcCapture<EditResult>(pool, 'public.edit_booking', [
      booking.bookingId,
      plan,
      base.tenantId,
      null,
      idempotencyKey,
    ]);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    const chainRow = await pool.query<{ approval_chain_id: string }>(
      `select approval_chain_id from public.approvals
        where tenant_id = $1 and target_entity_id = $2 limit 1`,
      [base.tenantId, booking.bookingId],
    );
    const chainId = chainRow.rows[0].approval_chain_id;

    // 3 team members → 3 inbox rows; one per user_id, all carrying the
    // same chain_id + approver_team_id.
    const inboxRows = await pool.query<{ user_id: string; payload: Record<string, unknown> }>(
      `select user_id, payload from public.inbox_notifications
        where tenant_id = $1 and payload->>'chain_id' = $2
        order by user_id`,
      [base.tenantId, chainId],
    );
    expect(inboxRows.rows).toHaveLength(3);
    const userIds = inboxRows.rows.map((r) => r.user_id).sort();
    const expected = [member1.userId, member2.userId, member3.userId].sort();
    expect(userIds).toEqual(expected);
    for (const row of inboxRows.rows) {
      expect(row.payload.chain_id).toBe(chainId);
      expect(row.payload.approver_team_id).toBe(base.teamId);
      expect(row.payload.booking_id).toBe(booking.bookingId);
    }

    // Outbox payload echoes the team id in approver_team_ids array;
    // approver_person_ids is empty (this booking has no person approver).
    const outboxRows = await pool.query<{ payload: Record<string, unknown> }>(
      `select payload from outbox.events
        where tenant_id = $1 and aggregate_id = $2
          and event_type = 'booking.approval_required'`,
      [base.tenantId, booking.bookingId],
    );
    expect(outboxRows.rows).toHaveLength(1);
    expect(outboxRows.rows[0].payload.approver_person_ids).toEqual([]);
    expect(outboxRows.rows[0].payload.approver_team_ids).toEqual([base.teamId]);
  });
});

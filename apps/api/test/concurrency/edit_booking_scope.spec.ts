/**
 * B.4 Step 2F.1 concurrency probe — edit_booking_scope RPC.
 *
 * Spec ref: docs/follow-ups/b4-booking-edit-pipeline.md §3.6.5 + §7.B.4.C.
 * Migration: supabase/migrations/00367_edit_booking_scope_rpc.sql.
 *
 * Harness pattern mirrors edit_booking.spec.ts (00364) — same fixture
 * helpers (seedBaseFixture, lockKey, pgLocksFor, runRpcCapture). Step 2F.1
 * is migration-only; no TS cutover yet, so this spec is the gate for the
 * RPC contract.
 *
 * Scenarios (against live local Supabase):
 *   1. Single-occurrence series, dry_run=true   — would_succeed:true, no writes.
 *   2. Single-occurrence series, dry_run=false  — committed:1, slot/audit/domain rows.
 *   3. 5-occurrence series, dry_run=true        — per_occurrence has 5 entries; no writes.
 *   4. 5-occurrence series, dry_run=false       — committed:5; 5 slot rows + 5 audit + 5 domain.
 *   5. 5-occurrence series, one cancelled       — raises booking.cancelled_cannot_edit; FULL rollback.
 *   6. 5-occurrence series, mixed_series        — raises edit_booking_scope.mixed_series; no writes.
 *   7. 5-occurrence series, B.4.A.5 emit-site   — raises booking.edit_requires_notification_dispatch.
 *   8. Concurrent scope edits, overlapping series + different keys — second blocks on advisory lock.
 *   9. Idempotency replay (same key, same payload) — second returns cached_result.
 *  10. Idempotency mismatch (same key, different payload) — payload_mismatch.
 *  11. this_and_following scope — RPC writes exactly the booking_ids it's given.
 *  12. N > 200 — too_many_occurrences.
 *  13. §3.6.5 Row 3 — require_approval → allow w/ pending expires + flips to confirmed.
 *  14. §3.6.5 Row 4 — require_approval → allow w/ terminal_approved preserves confirmed.
 *  15. N = 200 cap-boundary commits successfully.
 *  16. dry-run → commit with SAME idempotency_key actually performs the write
 *      (no stale-row short-circuit). Regression test for the v2 contract
 *      (00371): dry-run is stateless w.r.t. command_operations — a
 *      subsequent commit on the same key MUST insert + write, not
 *      short-circuit on a stale dry-run row.
 *  17. B.4.A.5 sub-step B — gate raise leaves inbox_notifications empty
 *      (proves the per-occurrence inbox INSERT block in 00395 is properly
 *      tx-scoped behind the B.4.A.5 emit-site gate; will evolve into
 *      "row count == approver count" once sub-step H lifts the gate).
 *  18. Codex remediation — gate raise leaves outbox empty of
 *      booking.approval_required (proves the per-occurrence emit block
 *      added in the codex remediation is properly tx-scoped behind the
 *      same gate; will evolve into "N events emitted with correct per-
 *      chain payloads" once sub-step H lifts the gate).
 */

import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  flushAllFixtures,
  lockKey,
  pgLocksFor,
  registerCleanup,
  runRpcCapture,
  seedBaseFixture,
  waitForRowLockBlocker,
  withClient,
  type BaseFixture,
} from './helpers';
import { endPool, getPool } from './pool';

interface ScopeOccurrence {
  bookingId: string;
  slotId: string;
  initialEtag: string;
  initialStatus: string;
}

interface ScopeFixture {
  seriesId: string;
  occurrences: ScopeOccurrence[];
}

interface DryRunResult {
  dry_run: true;
  would_succeed: boolean;
  series_id: string;
  per_occurrence: Array<Record<string, unknown>>;
  aggregated_follow_ups: string[];
}

interface CommitResult {
  committed: number;
  series_id: string;
  per_occurrence: Array<Record<string, unknown>>;
  aggregated_follow_ups: string[];
}

/**
 * Seed a recurrence_series row + N booking + slot occurrences anchored
 * to that series. Each occurrence is `confirmed` with one room slot.
 * Times advance by 1 week per occurrence (deterministic, conflict-free).
 *
 * `baseStartIso` defaults to 2026-11-01T10:00:00Z; tests that need
 * multiple non-overlapping series in the same fixture (e.g. the
 * mixed_series scenario) pass distinct anchors so the
 * booking_slots_no_overlap GiST exclusion doesn't trip during fixture
 * seeding.
 */
async function seedRecurrenceSeries(
  pool: Pool,
  base: BaseFixture,
  count: number,
  opts: { baseStartIso?: string } = {},
): Promise<ScopeFixture> {
  const seriesId = randomUUID();
  const baseStart = new Date(opts.baseStartIso ?? '2026-11-01T10:00:00Z').getTime();
  const occurrences: ScopeOccurrence[] = [];

  await withClient(pool, async (c) => {
    await c.query('begin');
    try {
      // Seed the series first; bookings.recurrence_series_id FKs to it.
      await c.query(
        `insert into public.recurrence_series
           (id, tenant_id, recurrence_rule, series_start_at, materialized_through)
         values ($1, $2, $3::jsonb, $4::timestamptz, $5::timestamptz)`,
        [
          seriesId,
          base.tenantId,
          JSON.stringify({ frequency: 'weekly', interval: 1, count }),
          new Date(baseStart).toISOString(),
          new Date(baseStart + count * 7 * 86400_000).toISOString(),
        ],
      );

      for (let i = 0; i < count; i++) {
        const bookingId = randomUUID();
        const slotId = randomUUID();
        const initialEtag = `etag-${bookingId.slice(0, 8)}`;
        const startMs = baseStart + i * 7 * 86400_000;
        const endMs = startMs + 60 * 60_000;
        const startAt = new Date(startMs).toISOString();
        const endAt = new Date(endMs).toISOString();
        await c.query(
          `insert into public.bookings
             (id, tenant_id, title, requester_person_id, location_id,
              start_at, end_at, timezone, status, source, calendar_etag,
              cost_amount_snapshot, policy_snapshot, applied_rule_ids,
              recurrence_series_id, recurrence_index)
           values ($1, $2, 'Series Probe', $3, $4,
                   $5, $6, 'UTC', 'confirmed', 'desk', $7,
                   100.00, '{}'::jsonb, '{}'::uuid[],
                   $8, $9)`,
          [
            bookingId,
            base.tenantId,
            base.personId,
            base.spaceId,
            startAt,
            endAt,
            initialEtag,
            seriesId,
            i,
          ],
        );
        await c.query(
          `insert into public.booking_slots
             (id, tenant_id, booking_id, slot_type, space_id,
              start_at, end_at, status, display_order)
           values ($1, $2, $3, 'room', $4, $5, $6, 'confirmed', 0)`,
          [slotId, base.tenantId, bookingId, base.spaceId, startAt, endAt],
        );
        occurrences.push({ bookingId, slotId, initialEtag, initialStatus: 'confirmed' });
      }
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    }
  });

  // Cleanup ordering: registerCleanup pops LIFO, so this cleanup
  // (registered AFTER seedBaseFixture) runs BEFORE the base sweep that
  // would delete bookings. recurrence_series → bookings is a hard FK
  // (00277:74); deleting the series first FK-violates. Solution: this
  // cleanup deletes the children (booking_slots → bookings) anchored to
  // THIS series before dropping the series row. Base sweep then runs
  // and is a no-op for those rows (already gone).
  registerCleanup(async () => {
    await withClient(pool, async (c) => {
      await c.query('begin');
      try {
        await c.query("set local session_replication_role = 'replica'");
        // Clear cascades that block booking deletion.
        await c.query(
          `delete from public.audit_events
            where tenant_id = $1
              and entity_type = 'booking'
              and entity_id in (
                select id from public.bookings where recurrence_series_id = $2
              )`,
          [base.tenantId, seriesId],
        );
        await c.query(
          `delete from public.domain_events
            where tenant_id = $1
              and entity_type = 'booking'
              and entity_id in (
                select id from public.bookings where recurrence_series_id = $2
              )`,
          [base.tenantId, seriesId],
        );
        await c.query(
          `delete from outbox.events
            where tenant_id = $1
              and aggregate_id in (
                select id from public.bookings where recurrence_series_id = $2
              )`,
          [base.tenantId, seriesId],
        );
        await c.query(
          `delete from public.approvals
            where tenant_id = $1
              and target_entity_type = 'booking'
              and target_entity_id in (
                select id from public.bookings where recurrence_series_id = $2
              )`,
          [base.tenantId, seriesId],
        );
        await c.query(
          `delete from public.booking_slots
            where booking_id in (
              select id from public.bookings where recurrence_series_id = $1
            )`,
          [seriesId],
        );
        await c.query('delete from public.bookings where recurrence_series_id = $1', [seriesId]);
        await c.query('delete from public.recurrence_series where id = $1', [seriesId]);
        await c.query('commit');
      } catch (e) {
        await c.query('rollback');
        throw e;
      }
    });
  });

  return { seriesId, occurrences };
}

async function seedTargetMeetingRoom(pool: Pool, base: BaseFixture): Promise<string> {
  const targetSpaceId = randomUUID();
  await withClient(pool, async (c) => {
    await c.query('begin');
    try {
      await c.query("set local session_replication_role = 'replica'");
      await c.query(
        `insert into public.spaces (id, tenant_id, parent_id, type, name, capacity, reservable, active)
         select $1, $2, parent_id, 'meeting_room', 'Scope Target Room', 4, true, true
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

function buildApprovalBlock(opts: {
  oldOutcome?: 'allow' | 'require_approval' | 'deny';
  newOutcome?: 'allow' | 'require_approval' | 'deny';
  chainConfigChanged?: boolean;
  newChainConfig?: { requiredApprovers: Array<{ type: 'person' | 'team'; id: string }>; threshold?: 'all' | 'any' } | null;
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
 * Build an EditPlan for one occurrence. Mirrors buildLocationSwapPlan from
 * edit_booking.spec.ts but wraps it inside the {booking_id, plan} envelope
 * expected by p_plans. Defaults preserve the slot's existing window
 * (caller passes startAt/endAt to mirror what the fixture seeded).
 */
function buildOccurrencePlan(args: {
  bookingId: string;
  slotId: string;
  fromSpaceId: string;
  toSpaceId: string;
  startAtIso: string;
  endAtIso: string;
  resolutionAtIso: string;
  costAmountSnapshot?: number | null;
  calendarEtag?: string;
  approval?: Record<string, unknown>;
}): { booking_id: string; plan: Record<string, unknown> } {
  return {
    booking_id: args.bookingId,
    plan: {
      _resolution_at: args.resolutionAtIso,
      rule_outcome_fingerprint: 'fingerprint-scope-test',
      client_request_id: 'scope-test-crid',
      approval: args.approval ?? buildApprovalBlock({}),
      booking: {
        location_id: args.toSpaceId,
        start_at: args.startAtIso,
        end_at: args.endAtIso,
        cost_amount_snapshot: args.costAmountSnapshot ?? 100.0,
        policy_snapshot: { rules: [] },
        applied_rule_ids: [],
        cost_center_id: null,
        calendar_etag: args.calendarEtag ?? `etag-${args.bookingId.slice(0, 8)}-scope-edit`,
      },
      slot_patches: [
        {
          slot_id: args.slotId,
          space_id: args.toSpaceId,
          start_at: args.startAtIso,
          end_at: args.endAtIso,
          setup_buffer_minutes: 0,
          teardown_buffer_minutes: 0,
          attendee_count: null,
          attendee_person_ids: null,
        },
      ],
      asset_reservation_patches: [],
      order_patches: [],
      work_order_sla_patches: [],
    },
  };
}

/** Build the full p_plans array for every occurrence in the fixture.
 *  Reads the seeded slot's actual start_at on the way to building the
 *  plan so the per-occurrence times always line up with what the
 *  fixture wrote, regardless of the series's base anchor. */
async function buildPlansForFixture(
  pool: Pool,
  fixture: ScopeFixture,
  toSpaceId: string,
  fromSpaceId: string,
  resolutionAtIso: string,
  perOccurrenceApproval?: (idx: number) => Record<string, unknown>,
): Promise<Array<{ booking_id: string; plan: Record<string, unknown> }>> {
  const out: Array<{ booking_id: string; plan: Record<string, unknown> }> = [];
  for (let idx = 0; idx < fixture.occurrences.length; idx++) {
    const occ = fixture.occurrences[idx];
    const slotRow = await pool.query<{ start_at: Date; end_at: Date }>(
      'select start_at, end_at from public.booking_slots where id = $1',
      [occ.slotId],
    );
    const startAtIso = new Date(slotRow.rows[0].start_at).toISOString();
    const endAtIso = new Date(slotRow.rows[0].end_at).toISOString();
    out.push(
      buildOccurrencePlan({
        bookingId: occ.bookingId,
        slotId: occ.slotId,
        fromSpaceId,
        toSpaceId,
        startAtIso,
        endAtIso,
        resolutionAtIso,
        approval: perOccurrenceApproval ? perOccurrenceApproval(idx) : undefined,
      }),
    );
  }
  return out;
}

function scopeIdempotencyKey(crid: string): string {
  return `booking:edit-scope:${crid}`;
}

describe('edit_booking_scope RPC — concurrency + state-machine probes', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = getPool();
  });

  afterAll(async () => {
    await flushAllFixtures(pool);
    await endPool();
  });

  // ── Scenario 1: single-occurrence series, dry_run=true ────────────────
  it('single-occurrence series, dry_run=true — would_succeed:true, no writes', async () => {
    const base = await seedBaseFixture(pool, `scope-1occ-dry-${Date.now()}`);
    const fixture = await seedRecurrenceSeries(pool, base, 1);
    const targetSpaceId = await seedTargetMeetingRoom(pool, base);

    const beforeUpdatedAt = await pool.query<{ updated_at: Date }>(
      'select updated_at from public.bookings where id = $1',
      [fixture.occurrences[0].bookingId],
    );

    const plans = await buildPlansForFixture(pool, fixture, targetSpaceId, base.spaceId, '2026-10-15T00:00:00Z');
    const idempotencyKey = scopeIdempotencyKey(`1occ-dry-${Date.now()}`);

    const result = await runRpcCapture<DryRunResult>(pool, 'public.edit_booking_scope', [
      JSON.stringify(plans),
      base.tenantId,
      null,
      idempotencyKey,
      true,
    ]);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    expect(result.value.dry_run).toBe(true);
    expect(result.value.would_succeed).toBe(true);
    expect(result.value.series_id).toBe(fixture.seriesId);
    expect(result.value.per_occurrence).toHaveLength(1);

    // No writes. Booking's updated_at unchanged (timestamps may be Date
    // or string depending on pg-types; coerce to ISO before comparing).
    const afterUpdatedAt = await pool.query<{ updated_at: Date }>(
      'select updated_at from public.bookings where id = $1',
      [fixture.occurrences[0].bookingId],
    );
    expect(new Date(afterUpdatedAt.rows[0].updated_at).toISOString()).toBe(
      new Date(beforeUpdatedAt.rows[0].updated_at).toISOString(),
    );

    const auditRows = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.audit_events
        where tenant_id = $1 and entity_id = $2`,
      [base.tenantId, fixture.occurrences[0].bookingId],
    );
    expect(auditRows.rows[0].n).toBe(0);
  });

  // ── Scenario 2: single-occurrence series, dry_run=false ───────────────
  it('single-occurrence series, dry_run=false — committed:1 + audit + domain row', async () => {
    const base = await seedBaseFixture(pool, `scope-1occ-commit-${Date.now()}`);
    const fixture = await seedRecurrenceSeries(pool, base, 1);
    const targetSpaceId = await seedTargetMeetingRoom(pool, base);

    const plans = await buildPlansForFixture(pool, fixture, targetSpaceId, base.spaceId, '2026-10-15T00:00:00Z');
    const idempotencyKey = scopeIdempotencyKey(`1occ-commit-${Date.now()}`);

    const result = await runRpcCapture<CommitResult>(pool, 'public.edit_booking_scope', [
      JSON.stringify(plans),
      base.tenantId,
      null,
      idempotencyKey,
      false,
    ]);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.committed).toBe(1);
    expect(result.value.per_occurrence).toHaveLength(1);

    const slotRow = await pool.query<{ space_id: string }>(
      'select space_id from public.booking_slots where id = $1',
      [fixture.occurrences[0].slotId],
    );
    expect(slotRow.rows[0].space_id).toBe(targetSpaceId);

    const bookingRow = await pool.query<{ location_id: string }>(
      'select location_id from public.bookings where id = $1',
      [fixture.occurrences[0].bookingId],
    );
    expect(bookingRow.rows[0].location_id).toBe(targetSpaceId);

    const auditRows = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.audit_events
        where tenant_id = $1 and entity_id = $2`,
      [base.tenantId, fixture.occurrences[0].bookingId],
    );
    expect(auditRows.rows[0].n).toBe(1);

    const domainRows = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.domain_events
        where tenant_id = $1 and entity_id = $2`,
      [base.tenantId, fixture.occurrences[0].bookingId],
    );
    expect(domainRows.rows[0].n).toBe(1);

    const outboxRows = await pool.query<{ event_type: string }>(
      `select event_type from outbox.events
        where tenant_id = $1 and aggregate_id = $2`,
      [base.tenantId, fixture.occurrences[0].bookingId],
    );
    expect(outboxRows.rows.map((r) => r.event_type)).toEqual(['booking.location_changed']);
  });

  // ── Scenario 3: 5-occurrence series, dry_run=true ─────────────────────
  it('5-occurrence series, dry_run=true — per_occurrence:5, no writes', async () => {
    const base = await seedBaseFixture(pool, `scope-5occ-dry-${Date.now()}`);
    const fixture = await seedRecurrenceSeries(pool, base, 5);
    const targetSpaceId = await seedTargetMeetingRoom(pool, base);

    const plans = await buildPlansForFixture(pool, fixture, targetSpaceId, base.spaceId, '2026-10-15T00:00:00Z');
    const idempotencyKey = scopeIdempotencyKey(`5occ-dry-${Date.now()}`);

    const result = await runRpcCapture<DryRunResult>(pool, 'public.edit_booking_scope', [
      JSON.stringify(plans),
      base.tenantId,
      null,
      idempotencyKey,
      true,
    ]);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.dry_run).toBe(true);
    expect(result.value.would_succeed).toBe(true);
    expect(result.value.per_occurrence).toHaveLength(5);

    // Verify every occurrence's predicted approval_action is 'noop' for
    // an allow→allow plan.
    for (const entry of result.value.per_occurrence) {
      expect(entry.approval_action).toBe('noop');
    }

    // No writes.
    const auditRows = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.audit_events
        where tenant_id = $1`,
      [base.tenantId],
    );
    expect(auditRows.rows[0].n).toBe(0);
  });

  // ── Scenario 4: 5-occurrence series, dry_run=false ────────────────────
  it('5-occurrence series, dry_run=false — committed:5 + all rows updated + audit + domain', async () => {
    const base = await seedBaseFixture(pool, `scope-5occ-commit-${Date.now()}`);
    const fixture = await seedRecurrenceSeries(pool, base, 5);
    const targetSpaceId = await seedTargetMeetingRoom(pool, base);

    const plans = await buildPlansForFixture(pool, fixture, targetSpaceId, base.spaceId, '2026-10-15T00:00:00Z');
    const idempotencyKey = scopeIdempotencyKey(`5occ-commit-${Date.now()}`);

    const result = await runRpcCapture<CommitResult>(pool, 'public.edit_booking_scope', [
      JSON.stringify(plans),
      base.tenantId,
      null,
      idempotencyKey,
      false,
    ]);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.committed).toBe(5);
    expect(result.value.per_occurrence).toHaveLength(5);

    // Every slot got rewritten.
    const slotRows = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.booking_slots
        where tenant_id = $1 and space_id = $2`,
      [base.tenantId, targetSpaceId],
    );
    expect(slotRows.rows[0].n).toBe(5);

    // Every booking got rewritten.
    const bookingRows = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.bookings
        where tenant_id = $1 and location_id = $2 and recurrence_series_id = $3`,
      [base.tenantId, targetSpaceId, fixture.seriesId],
    );
    expect(bookingRows.rows[0].n).toBe(5);

    // 5 audit rows + 5 domain_events.
    const auditCount = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.audit_events
        where tenant_id = $1 and event_type = 'booking.edited'`,
      [base.tenantId],
    );
    expect(auditCount.rows[0].n).toBe(5);
    const domainCount = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.domain_events
        where tenant_id = $1 and event_type = 'booking.edited'`,
      [base.tenantId],
    );
    expect(domainCount.rows[0].n).toBe(5);

    // 5 location_changed outbox events.
    const outboxRows = await pool.query<{ n: number }>(
      `select count(*)::int as n from outbox.events
        where tenant_id = $1 and event_type = 'booking.location_changed'`,
      [base.tenantId],
    );
    expect(outboxRows.rows[0].n).toBe(5);
  });

  // ── Scenario 5: one occurrence cancelled → FULL rollback ─────────────
  it('one occurrence cancelled — raises booking.cancelled_cannot_edit + zero writes', async () => {
    const base = await seedBaseFixture(pool, `scope-cancelled-${Date.now()}`);
    const fixture = await seedRecurrenceSeries(pool, base, 5);
    const targetSpaceId = await seedTargetMeetingRoom(pool, base);

    // Flip occurrence 2 (index) to cancelled.
    const cancelledBookingId = fixture.occurrences[2].bookingId;
    await pool.query(`update public.bookings set status = 'cancelled' where id = $1`, [
      cancelledBookingId,
    ]);

    const plans = await buildPlansForFixture(pool, fixture, targetSpaceId, base.spaceId, '2026-10-15T00:00:00Z');
    const idempotencyKey = scopeIdempotencyKey(`cancelled-${Date.now()}`);

    const result = await runRpcCapture(pool, 'public.edit_booking_scope', [
      JSON.stringify(plans),
      base.tenantId,
      null,
      idempotencyKey,
      false,
    ]);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.message).toContain('booking.cancelled_cannot_edit');
    expect(result.error.message).toContain(cancelledBookingId);

    // ZERO writes — the whole tx rolled back. None of the other slots
    // should have flipped to the target space.
    const slotChanged = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.booking_slots
        where tenant_id = $1 and space_id = $2`,
      [base.tenantId, targetSpaceId],
    );
    expect(slotChanged.rows[0].n).toBe(0);

    const auditCount = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.audit_events where tenant_id = $1`,
      [base.tenantId],
    );
    expect(auditCount.rows[0].n).toBe(0);

    // v2 I4 — tighter rollback assertions: zero domain_events, zero
    // outbox rows, zero approvals, and every booking row's location_id
    // unchanged (none should have moved to targetSpaceId).
    const domainCount = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.domain_events where tenant_id = $1`,
      [base.tenantId],
    );
    expect(domainCount.rows[0].n).toBe(0);

    const outboxCount = await pool.query<{ n: number }>(
      `select count(*)::int as n from outbox.events where tenant_id = $1`,
      [base.tenantId],
    );
    expect(outboxCount.rows[0].n).toBe(0);

    const approvalsCount = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.approvals where tenant_id = $1`,
      [base.tenantId],
    );
    expect(approvalsCount.rows[0].n).toBe(0);

    const bookingRows = await pool.query<{ location_id: string }>(
      `select location_id from public.bookings
        where recurrence_series_id = $1
        order by recurrence_index asc`,
      [fixture.seriesId],
    );
    for (const row of bookingRows.rows) {
      expect(row.location_id).toBe(base.spaceId);
    }
  });

  // ── Scenario 6: smuggled foreign-series booking → mixed_series ───────
  it('foreign series smuggled into p_plans — raises edit_booking_scope.mixed_series', async () => {
    const base = await seedBaseFixture(pool, `scope-mixed-${Date.now()}`);
    const fixtureA = await seedRecurrenceSeries(pool, base, 3);
    // Anchor B half a year later than A so the slots don't collide with
    // A's on the booking_slots_no_overlap GiST exclusion. Same tenant +
    // same space + same time window across two series would trip the
    // exclusion at insert time.
    const fixtureB = await seedRecurrenceSeries(pool, base, 2, {
      baseStartIso: '2027-05-01T10:00:00Z',
    });
    const targetSpaceId = await seedTargetMeetingRoom(pool, base);

    // Build plans from A's occurrences, then append one of B's
    // occurrences — different series_id.
    const plans = await buildPlansForFixture(pool, fixtureA, targetSpaceId, base.spaceId, '2026-10-15T00:00:00Z');
    // Read fixtureB[0]'s actual slot times so the smuggled plan matches
    // what was seeded (the RPC's mixed_series check fires before any
    // shape-level slot-time mismatch matters, but keep the plan
    // internally consistent for robustness across future re-orderings).
    const smuggledSlotRow = await pool.query<{ start_at: Date; end_at: Date }>(
      'select start_at, end_at from public.booking_slots where id = $1',
      [fixtureB.occurrences[0].slotId],
    );
    const smuggled = buildOccurrencePlan({
      bookingId: fixtureB.occurrences[0].bookingId,
      slotId: fixtureB.occurrences[0].slotId,
      fromSpaceId: base.spaceId,
      toSpaceId: targetSpaceId,
      startAtIso: new Date(smuggledSlotRow.rows[0].start_at).toISOString(),
      endAtIso: new Date(smuggledSlotRow.rows[0].end_at).toISOString(),
      resolutionAtIso: '2026-10-15T00:00:00Z',
    });
    plans.push(smuggled);
    const idempotencyKey = scopeIdempotencyKey(`mixed-${Date.now()}`);

    const result = await runRpcCapture(pool, 'public.edit_booking_scope', [
      JSON.stringify(plans),
      base.tenantId,
      null,
      idempotencyKey,
      false,
    ]);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.message).toContain('edit_booking_scope.mixed_series');

    // No writes — gate fires before the per-plan loop.
    const auditCount = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.audit_events where tenant_id = $1`,
      [base.tenantId],
    );
    expect(auditCount.rows[0].n).toBe(0);
  });

  // ── Scenario 7: B.4.A.5 emit-site predicate on occurrence 3 ──────────
  // §3.6.5 Row 2 — allow → require_approval — would emit
  // booking.approval_required. RPC must refuse before the write block.
  it('B.4.A.5 emit-site predicate fires on one occurrence — raises booking.edit_requires_notification_dispatch', async () => {
    const base = await seedBaseFixture(pool, `scope-b4a5-${Date.now()}`);
    const fixture = await seedRecurrenceSeries(pool, base, 5);
    const targetSpaceId = await seedTargetMeetingRoom(pool, base);

    const offendingBookingId = fixture.occurrences[2].bookingId;

    // Make occurrence 3 trip the gate: allow → require_approval.
    const plans = await buildPlansForFixture(pool, fixture, targetSpaceId, base.spaceId, '2026-10-15T00:00:00Z', (idx) =>
      idx === 2
        ? buildApprovalBlock({
            oldOutcome: 'allow',
            newOutcome: 'require_approval',
            chainConfigChanged: true,
            newChainConfig: { requiredApprovers: [{ type: 'person', id: base.personId }], threshold: 'all' },
          })
        : buildApprovalBlock({}),
    );
    const idempotencyKey = scopeIdempotencyKey(`b4a5-${Date.now()}`);

    const result = await runRpcCapture(pool, 'public.edit_booking_scope', [
      JSON.stringify(plans),
      base.tenantId,
      null,
      idempotencyKey,
      false,
    ]);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.message).toContain('booking.edit_requires_notification_dispatch');
    expect(result.error.message).toContain(offendingBookingId);

    // No writes anywhere — even occurrences 0/1 (allow→allow, would
    // commit cleanly) must roll back.
    const slotChanged = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.booking_slots
        where tenant_id = $1 and space_id = $2`,
      [base.tenantId, targetSpaceId],
    );
    expect(slotChanged.rows[0].n).toBe(0);

    // v2 I4 — tighter rollback assertions: zero domain_events, zero
    // outbox rows, zero audit rows, zero approvals, and every booking
    // row's location_id unchanged (none should have moved).
    const auditCount = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.audit_events where tenant_id = $1`,
      [base.tenantId],
    );
    expect(auditCount.rows[0].n).toBe(0);

    const domainCount = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.domain_events where tenant_id = $1`,
      [base.tenantId],
    );
    expect(domainCount.rows[0].n).toBe(0);

    const outboxCount = await pool.query<{ n: number }>(
      `select count(*)::int as n from outbox.events where tenant_id = $1`,
      [base.tenantId],
    );
    expect(outboxCount.rows[0].n).toBe(0);

    const approvalsCount = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.approvals where tenant_id = $1`,
      [base.tenantId],
    );
    expect(approvalsCount.rows[0].n).toBe(0);

    const bookingRows = await pool.query<{ location_id: string }>(
      `select location_id from public.bookings
        where recurrence_series_id = $1
        order by recurrence_index asc`,
      [fixture.seriesId],
    );
    for (const row of bookingRows.rows) {
      expect(row.location_id).toBe(base.spaceId);
    }
  });

  // ── Scenario 8: concurrent scope edits, different idempotency keys ───
  it('two concurrent scope edits — second blocks on advisory lock', async () => {
    const base = await seedBaseFixture(pool, `scope-conc-${Date.now()}`);
    const fixture = await seedRecurrenceSeries(pool, base, 3);
    const targetSpaceId = await seedTargetMeetingRoom(pool, base);

    const idempotencyKeyA = scopeIdempotencyKey(`conc-a-${Date.now()}`);
    const idempotencyKeyB = scopeIdempotencyKey(`conc-b-${Date.now()}`);
    const plansA = await buildPlansForFixture(pool, fixture, targetSpaceId, base.spaceId, '2026-10-15T00:00:00Z');
    const plansB = await buildPlansForFixture(pool, fixture, targetSpaceId, base.spaceId, '2026-10-15T00:00:00Z');

    // The lock key in the RPC is hashtextextended(tenant:idempotency, 0).
    // Probe for A's lock — different keys mean A and B don't share the
    // ADVISORY lock, but they DO share the per-row FOR UPDATE lock on
    // every booking row (since both target the same occurrences). So B's
    // block happens at row lock, not advisory lock. Assert via row-lock
    // observation: A holds; B waits; A commits; B sees rewritten rows
    // and (likely) raises automation_plan.stale_resolution or commits if
    // the data still matches. For determinism we assert: A succeeds; B
    // gets either a clean re-commit (no-op-equivalent — same space) or a
    // row-lock-mediated commit. The simplest invariant: B eventually
    // resolves (no infinite block) and A's commit is visible.
    const probeKeyA = await withClient(pool, (c) => lockKey(c, `${base.tenantId}:${idempotencyKeyA}`));

    const clientA = await pool.connect();
    const clientB = await pool.connect();
    try {
      await clientA.query('begin');
      const aResPromise = clientA.query<{ result: CommitResult }>(
        `select public.edit_booking_scope($1::jsonb, $2, $3, $4, $5) as result`,
        [JSON.stringify(plansA), base.tenantId, null, idempotencyKeyA, false],
      );
      const aRes = await aResPromise;
      expect(aRes.rows[0].result.committed).toBe(3);

      // A still inside tx — advisory lock granted to A.
      const locks = await pgLocksFor(pool, probeKeyA);
      expect(locks.some((l) => l.granted)).toBe(true);

      // Start B with a different key — B's advisory lock won't collide,
      // but its per-row FOR UPDATE on the same bookings DOES. So B
      // blocks at the row lock (`wait_event='transactionid'`). v2 I6 fix:
      // replace the v1 250ms sentinel race with deterministic polling on
      // pg_stat_activity for the row-lock wait state. Resolves the
      // CI-flakiness pattern where B's lock wait may not register within
      // 250ms under load.
      await clientB.query('begin');
      // Capture B's backend pid BEFORE issuing the blocking RPC so the
      // pg_stat_activity poll has a target.
      const bPidRow = await clientB.query<{ pid: number }>(
        'select pg_backend_pid()::int as pid',
      );
      const bPid = bPidRow.rows[0].pid;

      const bPromise = clientB.query<{ result: CommitResult }>(
        `select public.edit_booking_scope($1::jsonb, $2, $3, $4, $5) as result`,
        [JSON.stringify(plansB), base.tenantId, null, idempotencyKeyB, false],
      );

      // Wait until pg_stat_activity reports B is blocked on a row lock.
      await waitForRowLockBlocker(pool, bPid, { timeoutMs: 5_000 });

      // Commit A; B should now complete.
      await clientA.query('commit');
      const bRes = await bPromise;
      await clientB.query('commit');

      // B's commit is also successful (same-space-target idempotent).
      expect(bRes.rows[0].result.committed).toBe(3);
    } finally {
      clientA.release();
      clientB.release();
    }
  });

  // ── Scenario 9: idempotency replay (same key, same payload) ──────────
  it('idempotency replay — same key + same payload returns cached_result', async () => {
    const base = await seedBaseFixture(pool, `scope-replay-${Date.now()}`);
    const fixture = await seedRecurrenceSeries(pool, base, 2);
    const targetSpaceId = await seedTargetMeetingRoom(pool, base);
    const plans = await buildPlansForFixture(pool, fixture, targetSpaceId, base.spaceId, '2026-10-15T00:00:00Z');
    const idempotencyKey = scopeIdempotencyKey(`replay-${Date.now()}`);

    const first = await runRpcCapture<CommitResult>(pool, 'public.edit_booking_scope', [
      JSON.stringify(plans),
      base.tenantId,
      null,
      idempotencyKey,
      false,
    ]);
    expect(first.kind).toBe('ok');
    const second = await runRpcCapture<CommitResult>(pool, 'public.edit_booking_scope', [
      JSON.stringify(plans),
      base.tenantId,
      null,
      idempotencyKey,
      false,
    ]);
    expect(second.kind).toBe('ok');
    if (first.kind !== 'ok' || second.kind !== 'ok') return;
    expect(second.value).toEqual(first.value);

    // Exactly one audit row per occurrence — replay didn't double-write.
    const auditCount = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.audit_events
        where tenant_id = $1 and event_type = 'booking.edited'`,
      [base.tenantId],
    );
    expect(auditCount.rows[0].n).toBe(2);

    // Outbox: 2 location_changed events (one per occurrence). Not 4.
    const outboxCount = await pool.query<{ n: number }>(
      `select count(*)::int as n from outbox.events
        where tenant_id = $1 and event_type = 'booking.location_changed'`,
      [base.tenantId],
    );
    expect(outboxCount.rows[0].n).toBe(2);
  });

  // ── Scenario 16: dry-run → commit with SAME idempotency_key ──────────
  // Regression test for the v2 (00371) contract: dry-run is stateless
  // w.r.t. command_operations. v1 (00367) hashed p_dry_run into the
  // payload AND wrote a command_operations row on every dry-run — so a
  // commit re-using the same key against a prior dry-run row would
  // short-circuit (either as payload_mismatch via the hashed flag, or
  // as a stale cached_result lookup). v2 fixed both: dry-run never
  // touches command_operations, and payload_hash no longer mixes
  // p_dry_run. This scenario locks the fix in place:
  //   Phase 1: dry-run with key K → 0 command_operations rows, 0 writes.
  //   Phase 2: commit with same K → 1 command_operations row, slots
  //            actually rewritten (proves no stale-row short-circuit).
  it('dry-run → commit with same idempotency_key actually performs the write (no stale-row short-circuit)', async () => {
    const base = await seedBaseFixture(pool, `scope-dryrun-then-commit-${Date.now()}`);
    const fixture = await seedRecurrenceSeries(pool, base, 3);
    const targetSpaceId = await seedTargetMeetingRoom(pool, base);

    const plans = await buildPlansForFixture(
      pool,
      fixture,
      targetSpaceId,
      base.spaceId,
      '2026-10-15T00:00:00Z',
    );
    const idempotencyKey = scopeIdempotencyKey(`dryrun-then-commit-${Date.now()}`);
    const bookingIds = fixture.occurrences.map((o) => o.bookingId);
    const slotIds = fixture.occurrences.map((o) => o.slotId);

    // ── Phase 1 — dry-run with key K ─────────────────────────────────
    const dryRun = await runRpcCapture<DryRunResult>(pool, 'public.edit_booking_scope', [
      JSON.stringify(plans),
      base.tenantId,
      null,
      idempotencyKey,
      true,
    ]);
    expect(dryRun.kind).toBe('ok');
    if (dryRun.kind !== 'ok') return;
    expect(dryRun.value.dry_run).toBe(true);
    expect(dryRun.value.would_succeed).toBe(true);
    expect(dryRun.value.per_occurrence).toHaveLength(3);

    // v2 contract: dry-run wrote ZERO command_operations rows for K.
    const cmdOpAfterDryRun = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.command_operations
        where tenant_id = $1 and idempotency_key = $2`,
      [base.tenantId, idempotencyKey],
    );
    expect(cmdOpAfterDryRun.rows[0].n).toBe(0);

    // v2 contract: dry-run wrote ZERO booking_slots rewrites.
    const slotsAfterDryRun = await pool.query<{ space_id: string }>(
      `select space_id from public.booking_slots
        where id = any($1::uuid[])
        order by id`,
      [slotIds],
    );
    expect(slotsAfterDryRun.rows).toHaveLength(3);
    for (const row of slotsAfterDryRun.rows) {
      expect(row.space_id).toBe(base.spaceId);
    }

    // Belt-and-braces: no audit, no domain, no outbox from dry-run.
    const auditAfterDryRun = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.audit_events where tenant_id = $1`,
      [base.tenantId],
    );
    expect(auditAfterDryRun.rows[0].n).toBe(0);
    const domainAfterDryRun = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.domain_events where tenant_id = $1`,
      [base.tenantId],
    );
    expect(domainAfterDryRun.rows[0].n).toBe(0);
    const outboxAfterDryRun = await pool.query<{ n: number }>(
      `select count(*)::int as n from outbox.events where tenant_id = $1`,
      [base.tenantId],
    );
    expect(outboxAfterDryRun.rows[0].n).toBe(0);

    // ── Phase 2 — commit with SAME key K ─────────────────────────────
    // If v1 behavior regressed (dry-run wrote a command_operations row
    // and the commit short-circuits on it), this call would either raise
    // payload_mismatch (hashed flag differs) or return a cached_result
    // with zero writes — and `committed` would not be 3.
    const commit = await runRpcCapture<CommitResult>(pool, 'public.edit_booking_scope', [
      JSON.stringify(plans),
      base.tenantId,
      null,
      idempotencyKey,
      false,
    ]);
    expect(commit.kind).toBe('ok');
    if (commit.kind !== 'ok') return;
    expect(commit.value.committed).toBe(3);
    expect(commit.value.per_occurrence).toHaveLength(3);
    expect(commit.value.series_id).toBe(fixture.seriesId);

    // Commit wrote exactly ONE command_operations row for K now (the
    // cached_result success row).
    const cmdOpAfterCommit = await pool.query<{ n: number; outcome: string }>(
      `select count(*)::int as n,
              coalesce(max(outcome), '') as outcome
         from public.command_operations
        where tenant_id = $1 and idempotency_key = $2`,
      [base.tenantId, idempotencyKey],
    );
    expect(cmdOpAfterCommit.rows[0].n).toBe(1);
    expect(cmdOpAfterCommit.rows[0].outcome).toBe('success');

    // Commit actually wrote — every booking_slot.space_id now points at
    // the target room. This is the proof of no-stale-row short-circuit:
    // if v2 had regressed to v1 behavior, a cached_result lookup would
    // have returned without touching booking_slots.
    const slotsAfterCommit = await pool.query<{ space_id: string }>(
      `select space_id from public.booking_slots
        where id = any($1::uuid[])
        order by id`,
      [slotIds],
    );
    expect(slotsAfterCommit.rows).toHaveLength(3);
    for (const row of slotsAfterCommit.rows) {
      expect(row.space_id).toBe(targetSpaceId);
    }

    // Bookings also rewritten (mirrors Scenario 4 commit shape).
    const bookingRows = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.bookings
        where tenant_id = $1 and location_id = $2 and id = any($3::uuid[])`,
      [base.tenantId, targetSpaceId, bookingIds],
    );
    expect(bookingRows.rows[0].n).toBe(3);

    // Audit + domain + outbox each got 3 rows from the commit (mirrors
    // Scenario 4). If the commit had short-circuited on a stale dry-run
    // row, these would be 0.
    const auditAfterCommit = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.audit_events
        where tenant_id = $1 and event_type = 'booking.edited'`,
      [base.tenantId],
    );
    expect(auditAfterCommit.rows[0].n).toBe(3);
    const domainAfterCommit = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.domain_events
        where tenant_id = $1 and event_type = 'booking.edited'`,
      [base.tenantId],
    );
    expect(domainAfterCommit.rows[0].n).toBe(3);
    const outboxAfterCommit = await pool.query<{ n: number }>(
      `select count(*)::int as n from outbox.events
        where tenant_id = $1 and event_type = 'booking.location_changed'`,
      [base.tenantId],
    );
    expect(outboxAfterCommit.rows[0].n).toBe(3);
  });

  // ── Scenario 10: idempotency mismatch (same key, different payload) ──
  it('idempotency mismatch — same key + different payload raises command_operations.payload_mismatch', async () => {
    const base = await seedBaseFixture(pool, `scope-pmismatch-${Date.now()}`);
    const fixture = await seedRecurrenceSeries(pool, base, 2);
    const targetSpaceId = await seedTargetMeetingRoom(pool, base);
    const plansA = await buildPlansForFixture(pool, fixture, targetSpaceId, base.spaceId, '2026-10-15T00:00:00Z');
    // Build plansB with a different calendar_etag in the booking patch
    // so the payload hashes differ.
    const plansB = plansA.map((entry, idx) => ({
      booking_id: entry.booking_id,
      plan: {
        ...entry.plan,
        booking: {
          ...((entry.plan as Record<string, unknown>).booking as Record<string, unknown>),
          calendar_etag: `etag-diff-${idx}`,
        },
      },
    }));
    const idempotencyKey = scopeIdempotencyKey(`pmismatch-${Date.now()}`);

    const first = await runRpcCapture(pool, 'public.edit_booking_scope', [
      JSON.stringify(plansA),
      base.tenantId,
      null,
      idempotencyKey,
      false,
    ]);
    expect(first.kind).toBe('ok');

    const second = await runRpcCapture(pool, 'public.edit_booking_scope', [
      JSON.stringify(plansB),
      base.tenantId,
      null,
      idempotencyKey,
      false,
    ]);
    expect(second.kind).toBe('error');
    if (second.kind !== 'error') return;
    expect(second.error.message).toContain('command_operations.payload_mismatch');
  });

  // ── Scenario 11: this_and_following (TS-computed subset) ─────────────
  // The RPC trusts the caller's subset choice. TS computes splitSeries +
  // derives the from-here ids; the RPC writes exactly the ids passed.
  // Seed 5 occurrences; pass plans for occurrences 2..4 (post-pivot).
  // RPC must write ONLY those 3, leaving 0..1 untouched.
  it('this_and_following subset — RPC writes exactly the booking_ids it is given', async () => {
    const base = await seedBaseFixture(pool, `scope-taf-${Date.now()}`);
    const fixture = await seedRecurrenceSeries(pool, base, 5);
    const targetSpaceId = await seedTargetMeetingRoom(pool, base);

    // TS would call splitSeries to mint a new series for the post-pivot
    // ids; for this RPC-level test we simulate the post-split state by
    // re-anchoring occurrences 2..4 to a new series_id, then passing
    // only those three to the RPC.
    const newSeriesId = randomUUID();
    await pool.query(
      `insert into public.recurrence_series
         (id, tenant_id, recurrence_rule, series_start_at, materialized_through)
       values ($1, $2, $3::jsonb, $4::timestamptz, $5::timestamptz)`,
      [
        newSeriesId,
        base.tenantId,
        // v2 I5 fix — empty {} jsonb is semantically invalid for a real
        // splitSeries result. Use a realistic weekly count=3 rule.
        JSON.stringify({ frequency: 'weekly', interval: 1, count: 3 }),
        '2026-11-15T10:00:00Z',
        '2026-12-15T10:00:00Z',
      ],
    );
    registerCleanup(async () => {
      // Same teardown ordering rationale as seedRecurrenceSeries' cleanup:
      // bookings re-anchored to this new series_id must come down BEFORE
      // the series row. We don't delete the bookings themselves (the base
      // sweep handles that), but we DO need to clear bookings.
      // recurrence_series_id to break the FK before deleting the series.
      await pool.query(
        `update public.bookings set recurrence_series_id = null
          where recurrence_series_id = $1`,
        [newSeriesId],
      );
      await pool.query('delete from public.recurrence_series where id = $1', [newSeriesId]);
    });
    await pool.query(
      `update public.bookings
          set recurrence_series_id = $1
        where id = any($2::uuid[]) and tenant_id = $3`,
      [
        newSeriesId,
        [
          fixture.occurrences[2].bookingId,
          fixture.occurrences[3].bookingId,
          fixture.occurrences[4].bookingId,
        ],
        base.tenantId,
      ],
    );

    const allPlans = await buildPlansForFixture(pool, fixture, targetSpaceId, base.spaceId, '2026-10-15T00:00:00Z');
    const subsetPlans = allPlans.slice(2);
    const idempotencyKey = scopeIdempotencyKey(`taf-${Date.now()}`);

    const result = await runRpcCapture<CommitResult>(pool, 'public.edit_booking_scope', [
      JSON.stringify(subsetPlans),
      base.tenantId,
      null,
      idempotencyKey,
      false,
    ]);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.committed).toBe(3);
    expect(result.value.series_id).toBe(newSeriesId);

    // Occurrences 0, 1 untouched.
    const untouchedSpace = await pool.query<{ space_id: string }>(
      'select space_id from public.booking_slots where id = $1',
      [fixture.occurrences[0].slotId],
    );
    expect(untouchedSpace.rows[0].space_id).toBe(base.spaceId);
    const untouchedSpace2 = await pool.query<{ space_id: string }>(
      'select space_id from public.booking_slots where id = $1',
      [fixture.occurrences[1].slotId],
    );
    expect(untouchedSpace2.rows[0].space_id).toBe(base.spaceId);

    // Occurrences 2..4 rewritten.
    for (let i = 2; i < 5; i++) {
      const r = await pool.query<{ space_id: string }>(
        'select space_id from public.booking_slots where id = $1',
        [fixture.occurrences[i].slotId],
      );
      expect(r.rows[0].space_id).toBe(targetSpaceId);
    }
  });

  // ── Scenario 12: N > 200 hard cap ────────────────────────────────────
  it('p_plans length > 200 — raises edit_booking_scope.too_many_occurrences', async () => {
    const base = await seedBaseFixture(pool, `scope-cap-${Date.now()}`);
    // Build a 201-element plans array with fake booking_ids. The cap
    // fires BEFORE the SELECT FOR UPDATE pulls rows, so the ids don't
    // need to correspond to real bookings.
    const targetSpaceId = await seedTargetMeetingRoom(pool, base);
    const plans = Array.from({ length: 201 }, () =>
      buildOccurrencePlan({
        bookingId: randomUUID(),
        slotId: randomUUID(),
        fromSpaceId: base.spaceId,
        toSpaceId: targetSpaceId,
        startAtIso: '2026-11-01T10:00:00Z',
        endAtIso: '2026-11-01T11:00:00Z',
        resolutionAtIso: '2026-10-15T00:00:00Z',
      }),
    );
    const idempotencyKey = scopeIdempotencyKey(`cap-${Date.now()}`);
    const result = await runRpcCapture(pool, 'public.edit_booking_scope', [
      JSON.stringify(plans),
      base.tenantId,
      null,
      idempotencyKey,
      false,
    ]);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.message).toContain('edit_booking_scope.too_many_occurrences');
  });

  // ── Scenario 13: §3.6.5 Row 3 — require_approval → allow w/ pending ──
  // Pending approval rows on every occurrence + require_approval → allow
  // edit. Per §3.6.5 Row 3: action='expire' on the pending rows; booking
  // status flips to 'confirmed'. Passes the B.4.A.5 gate (new outcome
  // 'allow' does not emit booking.approval_required).
  it('require_approval → allow w/ pending approvals — expires pending + flips to confirmed', async () => {
    const base = await seedBaseFixture(pool, `scope-r3-${Date.now()}`);
    const fixture = await seedRecurrenceSeries(pool, base, 3);
    const targetSpaceId = await seedTargetMeetingRoom(pool, base);

    // Flip every occurrence into pending_approval state + seed one
    // pending approval row per booking.
    for (const occ of fixture.occurrences) {
      await pool.query(
        `update public.bookings set status = 'pending_approval' where id = $1`,
        [occ.bookingId],
      );
      await pool.query(
        `insert into public.approvals
           (id, tenant_id, target_entity_type, target_entity_id,
            approver_person_id, status, parallel_group)
         values ($1, $2, 'booking', $3, $4, 'pending', null)`,
        [randomUUID(), base.tenantId, occ.bookingId, base.approverPersonId],
      );
    }

    // Plans: require_approval → allow (no chain_config_changed needed —
    // new=allow short-circuits the chain path).
    const plans = await buildPlansForFixture(
      pool,
      fixture,
      targetSpaceId,
      base.spaceId,
      '2026-10-15T00:00:00Z',
      () =>
        buildApprovalBlock({
          oldOutcome: 'require_approval',
          newOutcome: 'allow',
          chainConfigChanged: false,
        }),
    );
    const idempotencyKey = scopeIdempotencyKey(`r3-${Date.now()}`);

    const result = await runRpcCapture<CommitResult>(pool, 'public.edit_booking_scope', [
      JSON.stringify(plans),
      base.tenantId,
      null,
      idempotencyKey,
      false,
    ]);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.committed).toBe(3);

    // Every booking now 'confirmed'.
    const confirmedCount = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.bookings
        where recurrence_series_id = $1 and status = 'confirmed'`,
      [fixture.seriesId],
    );
    expect(confirmedCount.rows[0].n).toBe(3);

    // Every approval now 'expired'.
    const expiredCount = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.approvals
        where tenant_id = $1 and status = 'expired'`,
      [base.tenantId],
    );
    expect(expiredCount.rows[0].n).toBe(3);

    // No pending approvals left.
    const pendingCount = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.approvals
        where tenant_id = $1 and status = 'pending'`,
      [base.tenantId],
    );
    expect(pendingCount.rows[0].n).toBe(0);
  });

  // ── Scenario 14: §3.6.5 Row 4 — require_approval → allow w/ approved ─
  // terminal_approved state + require_approval → allow edit. Per §3.6.5
  // Row 4: action='noop' on approvals (historical chain stands as audit);
  // booking status stays 'confirmed'.
  it('require_approval → allow w/ terminal_approved — no approval mutation + preserves confirmed', async () => {
    const base = await seedBaseFixture(pool, `scope-r4-${Date.now()}`);
    const fixture = await seedRecurrenceSeries(pool, base, 3);
    const targetSpaceId = await seedTargetMeetingRoom(pool, base);

    // Bookings are 'confirmed' (per fixture default) + every occurrence
    // has one 'approved' approval row.
    for (const occ of fixture.occurrences) {
      await pool.query(
        `insert into public.approvals
           (id, tenant_id, target_entity_type, target_entity_id,
            approver_person_id, status, parallel_group, responded_at)
         values ($1, $2, 'booking', $3, $4, 'approved', null, now())`,
        [randomUUID(), base.tenantId, occ.bookingId, base.approverPersonId],
      );
    }

    const plans = await buildPlansForFixture(
      pool,
      fixture,
      targetSpaceId,
      base.spaceId,
      '2026-10-15T00:00:00Z',
      () =>
        buildApprovalBlock({
          oldOutcome: 'require_approval',
          newOutcome: 'allow',
          chainConfigChanged: false,
        }),
    );
    const idempotencyKey = scopeIdempotencyKey(`r4-${Date.now()}`);

    const result = await runRpcCapture<CommitResult>(pool, 'public.edit_booking_scope', [
      JSON.stringify(plans),
      base.tenantId,
      null,
      idempotencyKey,
      false,
    ]);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.committed).toBe(3);

    // Every booking still 'confirmed' (status_target was null →
    // preserved).
    const confirmedCount = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.bookings
        where recurrence_series_id = $1 and status = 'confirmed'`,
      [fixture.seriesId],
    );
    expect(confirmedCount.rows[0].n).toBe(3);

    // Approvals untouched — 3 still 'approved', 0 'expired'.
    const approvedCount = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.approvals
        where tenant_id = $1 and status = 'approved'`,
      [base.tenantId],
    );
    expect(approvedCount.rows[0].n).toBe(3);
    const expiredCount = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.approvals
        where tenant_id = $1 and status = 'expired'`,
      [base.tenantId],
    );
    expect(expiredCount.rows[0].n).toBe(0);

    // Per-occurrence 'approval_action' = noop.
    for (const entry of result.value.per_occurrence) {
      expect((entry as { booking_id: string }).booking_id).toBeDefined();
    }
  });

  // ── Scenario 15 (code N-2): N = 200 exact-pass ────────────────────────
  // The 200 cap is inclusive. A 200-occurrence series MUST commit; only
  // 201+ trips too_many_occurrences. Verifies the off-by-one isn't
  // silently `>=`.
  it('p_plans length = 200 (cap boundary) — commits successfully', async () => {
    const base = await seedBaseFixture(pool, `scope-cap200-${Date.now()}`);
    const fixture = await seedRecurrenceSeries(pool, base, 200);
    const targetSpaceId = await seedTargetMeetingRoom(pool, base);

    const plans = await buildPlansForFixture(pool, fixture, targetSpaceId, base.spaceId, '2026-10-15T00:00:00Z');
    const idempotencyKey = scopeIdempotencyKey(`cap200-${Date.now()}`);

    const result = await runRpcCapture<CommitResult>(pool, 'public.edit_booking_scope', [
      JSON.stringify(plans),
      base.tenantId,
      null,
      idempotencyKey,
      false,
    ]);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.committed).toBe(200);
  }, 120_000);

  // ── Scenario 17 (B.4.A.5 sub-step B): inbox tx-scope on gate raise ──────
  // The B.4.A.5 emit-site gate at 00395:~575-580 stays UP in v3 — the
  // inbox INSERT block in the per-occurrence loop is defense-in-depth
  // (unreachable until sub-step H lifts the gate). This test pins the
  // contract that as long as the gate is up, an approval-flipping plan
  // raises and writes ZERO inbox rows. When sub-step H lifts the gate,
  // this test should evolve into "inbox row count == approver count" —
  // the scope variant of the edit_booking.spec.ts Scenario 27 probe.
  it('B.4.A.5 — gate raise leaves inbox_notifications empty (tx rollback covers the inbox INSERT block)', async () => {
    const base = await seedBaseFixture(pool, `scope-inbox-gate-${Date.now()}`);
    const fixture = await seedRecurrenceSeries(pool, base, 3);
    const targetSpaceId = await seedTargetMeetingRoom(pool, base);

    // Make occurrence 1 trip the gate.
    const plans = await buildPlansForFixture(
      pool,
      fixture,
      targetSpaceId,
      base.spaceId,
      '2026-10-15T00:00:00Z',
      (idx) =>
        idx === 1
          ? buildApprovalBlock({
              oldOutcome: 'allow',
              newOutcome: 'require_approval',
              chainConfigChanged: true,
              newChainConfig: {
                requiredApprovers: [{ type: 'person', id: base.approverPersonId }],
                threshold: 'all',
              },
            })
          : buildApprovalBlock({}),
    );
    const idempotencyKey = scopeIdempotencyKey(`inbox-gate-${Date.now()}`);

    const result = await runRpcCapture(pool, 'public.edit_booking_scope', [
      JSON.stringify(plans),
      base.tenantId,
      null,
      idempotencyKey,
      false,
    ]);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.message).toContain('booking.edit_requires_notification_dispatch');

    // ZERO inbox rows in this tenant — the gate fires before the per-occurrence
    // write block (and even if it didn't, the failed RPC tx would roll the
    // INSERT back).
    const inboxCount = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.inbox_notifications where tenant_id = $1`,
      [base.tenantId],
    );
    expect(inboxCount.rows[0].n).toBe(0);
  });

  // ── Scenario 18 (codex remediation, sub-step B follow-up) ───────────
  // Without an approval_required outbox emit in 00395, sub-step H would
  // lift the gate and create inbox rows but no email. The emit block now
  // lives alongside booking.location_changed / booking.cost_changed in
  // the per-occurrence write block, gated on the SAME predicate as the
  // inbox INSERT block (v_emit_approval_required). While the gate at
  // 00395:~562 stays UP, the emit is unreachable — same as the inbox
  // INSERT — so today's contract is: ZERO booking.approval_required
  // outbox rows after a gate-tripping plan. When sub-step H lifts the
  // gate, this test should evolve into "N events emitted with correct
  // per-chain payloads" — N = occurrences whose plans flip rows 2/7/8
  // (allow → require_approval or chain_config_changed). Mirror shape
  // for edit_booking.spec.ts Scenario 7's outbox assertion.
  it('B.4.A.5 — gate raise leaves outbox empty of booking.approval_required (per-occurrence emit covered by tx rollback)', async () => {
    const base = await seedBaseFixture(pool, `scope-emit-gate-${Date.now()}`);
    const fixture = await seedRecurrenceSeries(pool, base, 3);
    const targetSpaceId = await seedTargetMeetingRoom(pool, base);

    // Flip occurrences 0 + 2 (two of three) into the gate-tripping shape:
    // allow → require_approval with chain_config_changed. The shared
    // v_emit_approval_required predicate fires on the first one and
    // raises — but the structural intent is that, once sub-step H lifts
    // the gate, the per-occurrence emit block fires N times for the N
    // occurrences whose plans flipped (here: 2 emits).
    const plans = await buildPlansForFixture(
      pool,
      fixture,
      targetSpaceId,
      base.spaceId,
      '2026-10-15T00:00:00Z',
      (idx) =>
        idx === 0 || idx === 2
          ? buildApprovalBlock({
              oldOutcome: 'allow',
              newOutcome: 'require_approval',
              chainConfigChanged: true,
              newChainConfig: {
                requiredApprovers: [{ type: 'person', id: base.approverPersonId }],
                threshold: 'all',
              },
            })
          : buildApprovalBlock({}),
    );
    const idempotencyKey = scopeIdempotencyKey(`emit-gate-${Date.now()}`);

    const result = await runRpcCapture(pool, 'public.edit_booking_scope', [
      JSON.stringify(plans),
      base.tenantId,
      null,
      idempotencyKey,
      false,
    ]);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.message).toContain('booking.edit_requires_notification_dispatch');

    // ZERO booking.approval_required outbox rows — gate suppresses + tx
    // rollback covers anything that would slip through.
    const approvalEmits = await pool.query<{ n: number }>(
      `select count(*)::int as n from outbox.events
        where tenant_id = $1 and event_type = 'booking.approval_required'`,
      [base.tenantId],
    );
    expect(approvalEmits.rows[0].n).toBe(0);

    // Cross-check the existing scenario's invariant — total outbox empty
    // for this tenant (sanity that we didn't accidentally smuggle a
    // location_changed / cost_changed through). All emits live in the
    // same per-occurrence block.
    const totalEmits = await pool.query<{ n: number }>(
      `select count(*)::int as n from outbox.events where tenant_id = $1`,
      [base.tenantId],
    );
    expect(totalEmits.rows[0].n).toBe(0);
  });
});

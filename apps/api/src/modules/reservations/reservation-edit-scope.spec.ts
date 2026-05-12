/**
 * B.4 Step 2F.3 — `ReservationService.editScope` service spec.
 *
 * Covers the controller cutover from the legacy `BookingFlowService
 * .editScope` (bare UPDATE path, deleted) to the new `assembleScopeEditPlan`
 * + `edit_booking_scope` RPC pipeline.
 *
 * Five entry-shape scenarios per the Step 2F.3 plan:
 *   1. `scope='this'` → 400 wrong_endpoint (use PATCH /reservations/:id).
 *   2. `scope='series'` commit → assembles + RPC + visitor cascade + commit envelope.
 *   3. `scope='this_and_following'` commit → splitSeries + assembles + RPC +
 *      cascade + envelope with `new_series_id`.
 *   4. `scope='this_and_following'` dry-run → NO splitSeries; assembler called
 *      with `forwardOnlyFromStartAt`; RPC with `p_dry_run=true`; NO cascade;
 *      dry-run envelope.
 *   5. `dry_run: 'true'` (non-boolean) → 400 edit_booking_scope.invalid_plans.
 *
 * Plus:
 *   - 6. Pivot has no recurrence_series_id → 422 edit_booking_scope.not_recurring.
 *   - 7. Idempotency key uses (bookingId, crid, 'scope') — closes cross-op-collision.
 *   - 8. Visibility canEdit=false → 403 reservation_not_editable.
 */

import { AppError } from '../../common/errors';
import { ReservationService } from './reservation.service';
import { TenantContext } from '../../common/tenant-context';
import { buildEditBookingIdempotencyKey } from '@prequest/shared';
import type { ActorContext } from './dto/types';
import type { EditScopeDto } from './dto/dtos';

const TENANT = { id: 'T-scope', slug: 't-scope', tier: 'standard' as const };
const CLIENT_REQUEST_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const PIVOT_BOOKING_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const ORIGINAL_SERIES_ID = 'cccccccc-1111-4111-8111-cccccccccccc';
const NEW_SERIES_ID = 'dddddddd-1111-4111-8111-dddddddddddd';
const PIVOT_START_AT = '2026-06-01T09:00:00Z';
const PIVOT_END_AT = '2026-06-01T10:00:00Z';
const PIVOT_SPACE_ID = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee';
const NEW_SPACE_ID = 'ffffffff-1111-4111-8111-ffffffffffff';

function makeActor(): ActorContext {
  return {
    user_id: 'U',
    person_id: 'P',
    is_service_desk: false,
    has_override_rules: false,
  };
}

/**
 * The pivot booking row returned by `findByIdOrThrow`. The legacy
 * Reservation projection embeds the primary slot's space + start/end.
 * The editScope path reads `recurrence_series_id` + `start_at` off this
 * shape to decide split vs no-split + forward-only filter.
 */
function makePivotReservation(overrides?: {
  recurrence_series_id?: string | null;
  start_at?: string;
}) {
  return {
    id: PIVOT_BOOKING_ID,
    tenant_id: TENANT.id,
    space_id: PIVOT_SPACE_ID,
    start_at: overrides?.start_at ?? PIVOT_START_AT,
    end_at: PIVOT_END_AT,
    status: 'confirmed' as const,
    requester_person_id: 'P-req',
    booked_by_user_id: 'U',
    timezone: 'UTC',
    title: null,
    description: null,
    location_id: PIVOT_SPACE_ID,
    recurrence_series_id:
      overrides?.recurrence_series_id === undefined
        ? ORIGINAL_SERIES_ID
        : overrides.recurrence_series_id,
    cost_amount_snapshot: null,
    cost_center_id: null,
    policy_snapshot: { matched_rule_ids: [], effects_seen: [] },
    applied_rule_ids: [],
    config_release_id: null,
    setup_buffer_minutes: 0,
    teardown_buffer_minutes: 0,
    attendee_count: 0,
    attendee_person_ids: [],
    host_person_id: null,
    source: 'desk',
    recurrence_index: 0,
    recurrence_overridden: false,
    recurrence_skipped: false,
    template_id: null,
    calendar_event_id: null,
    calendar_provider: null,
    calendar_etag: null,
    calendar_last_synced_at: null,
    created_at: '2026-05-01T08:00:00Z',
    updated_at: '2026-05-01T08:00:00Z',
  };
}

/**
 * Supabase mock: three operations matter for editScope's TS layer.
 *
 *   1. The `bookings` read inside `findByIdOrThrow(pivotId, tenantId)`.
 *      Goes through the SLOT_WITH_BOOKING_SELECT projection by joining
 *      booking_slots to bookings — but since we stub the higher-level
 *      service.findByIdOrThrow via a private-method spy below, the
 *      from('bookings') / from('booking_slots') chain only needs to
 *      no-op cleanly for the rare paths that touch it.
 *   2. `supabase.rpc('edit_booking_scope', ...)` — what the spec asserts on.
 *   3. The `command_operations` read for the C1 self-review remediation
 *      pre-check: `from('command_operations').select().eq().eq().maybeSingle()`.
 *      Returns `{ data: null }` by default (no cached row → proceed
 *      normally); a test can override via `cachedRow` to exercise the
 *      short-circuit replay path.
 */
function makeSupabase(opts?: {
  rpcResponse?: { data: unknown; error: unknown };
  /** B.4 Step 2F.3 self-review C1 — cached_result pre-check seed. */
  cachedRow?:
    | { outcome: 'success'; cached_result: unknown }
    | { outcome: 'in_progress'; cached_result: null }
    | null;
  cachedError?: unknown;
}) {
  const calls = {
    rpc: [] as Array<{ fn: string; args: unknown }>,
    commandOpsReads: [] as Array<{ idempotencyKey: string; tenantId: string }>,
  };
  const rpcResponse = opts?.rpcResponse ?? {
    data: {
      committed: 3,
      series_id: NEW_SERIES_ID,
      per_occurrence: [
        // 3 occurrences — one moves room only, one moves time only, one neither.
        {
          booking_id: 'occ-1',
          space_id_before: PIVOT_SPACE_ID,
          space_id_after: NEW_SPACE_ID,
          start_at_before: PIVOT_START_AT,
          start_at_after: PIVOT_START_AT,
          slots_updated: 1,
          follow_ups: ['booking.location_changed'],
        },
        {
          booking_id: 'occ-2',
          space_id_before: PIVOT_SPACE_ID,
          space_id_after: NEW_SPACE_ID,
          start_at_before: PIVOT_START_AT,
          start_at_after: PIVOT_START_AT,
          slots_updated: 1,
          follow_ups: [],
        },
        {
          booking_id: 'occ-3',
          space_id_before: PIVOT_SPACE_ID,
          space_id_after: PIVOT_SPACE_ID,
          start_at_before: PIVOT_START_AT,
          start_at_after: PIVOT_START_AT,
          slots_updated: 1,
          follow_ups: [],
        },
      ],
      aggregated_follow_ups: ['booking.location_changed'],
    },
    error: null,
  };
  const admin = {
    rpc: (fn: string, args: unknown) => {
      calls.rpc.push({ fn, args });
      return Promise.resolve(rpcResponse);
    },
    from: (table: string) => {
      if (table === 'command_operations') {
        // C1 pre-check chain: .select().eq('tenant_id', _).eq('idempotency_key', _).maybeSingle()
        const filters: Record<string, unknown> = {};
        const builder = {
          select: () => builder,
          eq: (col: string, val: unknown) => {
            filters[col] = val;
            return builder;
          },
          maybeSingle: () => {
            calls.commandOpsReads.push({
              idempotencyKey: filters.idempotency_key as string,
              tenantId: filters.tenant_id as string,
            });
            return Promise.resolve({
              data: opts?.cachedRow ?? null,
              error: opts?.cachedError ?? null,
            });
          },
        };
        return builder as unknown;
      }
      // The TS path that exercises editScope calls findByIdOrThrow which
      // hits supabase.admin.from('booking_slots'). We override that via
      // a spy on the service instance directly, so this stub never
      // actually runs in the tested paths — but if a future change
      // tries to read tables directly we want a clear failure.
      throw new Error(
        `unexpected supabase.from('${table}') call — editScope service spec stubs findByIdOrThrow + assembler + RPC + command_operations pre-check`,
      );
    },
  };
  return { admin, calls } as never as {
    admin: typeof admin;
    calls: typeof calls;
  };
}

function makeVisibility(opts?: { canEdit?: boolean }) {
  const canEdit = opts?.canEdit ?? true;
  return {
    loadContextByUserId: jest.fn(async () => ({
      user_id: 'U',
      person_id: 'P',
      tenant_id: TENANT.id,
      has_read_all: false,
      has_write_all: true,
      has_admin: false,
    })),
    assertVisible: jest.fn(() => undefined),
    canEdit: jest.fn(() => canEdit),
  };
}

function makeConflictGuard() {
  return {
    isExclusionViolation: jest.fn((err: unknown) => {
      if (!err || typeof err !== 'object') return false;
      return (err as { code?: string }).code === '23P01';
    }),
  };
}

function makeRecurrence(opts?: { splitReturns?: string }) {
  return {
    splitSeries: jest.fn(async () => opts?.splitReturns ?? NEW_SERIES_ID),
  };
}

function makeAssembleEditPlan(opts?: {
  rpcPlanCount?: number;
  /** Captures the call so tests can assert `forwardOnlyFromStartAt`. */
  captured?: { args?: unknown };
}) {
  const planCount = opts?.rpcPlanCount ?? 3;
  const assembleScopeEditPlan = jest.fn(async (args: unknown) => {
    if (opts?.captured) opts.captured.args = args;
    return {
      series_id: (args as { effectiveSeriesId: string }).effectiveSeriesId,
      rpc_plans: Array.from({ length: planCount }, (_, i) => ({
        booking_id: `occ-${i + 1}`,
        plan: { _stub: true, idx: i } as never,
      })),
    };
  });
  return {
    assembleScopeEditPlan,
    // Not called by editScope but required by the DI typing.
    assembleEditPlan: jest.fn(),
  };
}

function makeBundleEventBus() {
  return { emit: jest.fn() };
}

function buildService(opts: {
  supabase: ReturnType<typeof makeSupabase>;
  visibility: ReturnType<typeof makeVisibility>;
  conflict: ReturnType<typeof makeConflictGuard>;
  recurrence: ReturnType<typeof makeRecurrence>;
  assemble: ReturnType<typeof makeAssembleEditPlan>;
  bundleEventBus?: ReturnType<typeof makeBundleEventBus>;
  pivot?: ReturnType<typeof makePivotReservation>;
}) {
  const svc = new ReservationService(
    opts.supabase as never,
    opts.conflict as never,
    opts.visibility as never,
    opts.recurrence as never,
    undefined, // notifications
    undefined, // bundleCascade
    opts.bundleEventBus as never,
    opts.assemble as never,
  );

  // Stub `findByIdOrThrow` (private) so we don't have to set up the full
  // booking_slots projection. The pivot Reservation is what the editScope
  // path actually reads (recurrence_series_id, start_at).
  const pivot = opts.pivot ?? makePivotReservation();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (svc as any).findByIdOrThrow = jest.fn(async () => pivot);

  return svc;
}

describe('ReservationService.editScope (B.4 Step 2F.3)', () => {
  it("rejects scope='this' with 400 wrong_endpoint (mirrors legacy)", async () => {
    const supabase = makeSupabase();
    const svc = buildService({
      supabase,
      visibility: makeVisibility(),
      conflict: makeConflictGuard(),
      recurrence: makeRecurrence(),
      assemble: makeAssembleEditPlan(),
    });

    await TenantContext.run(TENANT, async () => {
      await expect(
        svc.editScope(
          PIVOT_BOOKING_ID,
          { scope: 'this' as unknown as 'series' },
          makeActor(),
          CLIENT_REQUEST_ID,
        ),
      ).rejects.toMatchObject({
        code: 'wrong_endpoint',
        status: 400,
      });
    });

    // Defense-in-depth: no RPC fired.
    expect(supabase.calls.rpc).toHaveLength(0);
  });

  it("scope='series' commit: assembles + RPC + visitor cascade + returns commit envelope", async () => {
    const captured: { args?: unknown } = {};
    const supabase = makeSupabase();
    const recurrence = makeRecurrence();
    const assemble = makeAssembleEditPlan({ captured });
    const bundleEventBus = makeBundleEventBus();
    const svc = buildService({
      supabase,
      visibility: makeVisibility(),
      conflict: makeConflictGuard(),
      recurrence,
      assemble,
      bundleEventBus,
    });
    // Spy the cascade method directly. The cascade body reads visitors via
    // supabase.admin which our mock doesn't stub — verifying CALL count +
    // ARGS is what we care about (the cascade body itself is tested by
    // the editOne/editSlot specs).
    const cascadeSpy = jest
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(svc as any, 'emitVisitorCascadeForBundle')
      .mockResolvedValue(undefined);

    const body: EditScopeDto = {
      scope: 'series',
      space_id: NEW_SPACE_ID,
    };

    const result = await TenantContext.run(TENANT, async () =>
      svc.editScope(PIVOT_BOOKING_ID, body, makeActor(), CLIENT_REQUEST_ID),
    );

    // splitSeries NOT called on scope='series'.
    expect(recurrence.splitSeries).not.toHaveBeenCalled();

    // Assembler called with effectiveSeriesId = pivot's series id, no
    // forwardOnlyFromStartAt filter.
    expect(assemble.assembleScopeEditPlan).toHaveBeenCalledTimes(1);
    const assembleArgs = captured.args as {
      bookingId: string;
      tenantId: string;
      effectiveSeriesId: string;
      forwardOnlyFromStartAt?: string;
      patch: { kind: string; space_id?: string };
    };
    expect(assembleArgs.effectiveSeriesId).toBe(ORIGINAL_SERIES_ID);
    expect(assembleArgs.forwardOnlyFromStartAt).toBeUndefined();
    expect(assembleArgs.patch).toMatchObject({ kind: 'scope', space_id: NEW_SPACE_ID });

    // RPC called with p_dry_run=false + idempotency key uses 'scope' op.
    expect(supabase.calls.rpc).toHaveLength(1);
    const rpcArgs = supabase.calls.rpc[0].args as Record<string, unknown>;
    expect(supabase.calls.rpc[0].fn).toBe('edit_booking_scope');
    expect(rpcArgs.p_dry_run).toBe(false);
    expect(rpcArgs.p_idempotency_key).toBe(
      buildEditBookingIdempotencyKey(PIVOT_BOOKING_ID, CLIENT_REQUEST_ID, 'scope'),
    );

    // Visitor cascade fired for the 2 occurrences whose space changed
    // (occ-1, occ-2); occ-3 had no diff, so no emit. Default mock returns
    // 3 occurrences — 2 moved room.
    expect(cascadeSpy).toHaveBeenCalledTimes(2);
    // Calls carry the per-occurrence diff (oldSpaceId/newSpaceId) for the
    // changed-room occurrences.
    expect(cascadeSpy.mock.calls[0][0]).toMatchObject({
      bundleId: 'occ-1',
      oldSpaceId: PIVOT_SPACE_ID,
      newSpaceId: NEW_SPACE_ID,
    });

    expect(result.scope).toBe('series');
    expect(result.new_series_id).toBeUndefined();
    expect(result.dry_run).toBe(false);
    expect(result.committed).toBe(3);
  });

  it("scope='this_and_following' commit: splitSeries + assembles + RPC + cascade + new_series_id envelope", async () => {
    const captured: { args?: unknown } = {};
    const supabase = makeSupabase();
    const recurrence = makeRecurrence();
    const assemble = makeAssembleEditPlan({ captured });
    const bundleEventBus = makeBundleEventBus();
    const svc = buildService({
      supabase,
      visibility: makeVisibility(),
      conflict: makeConflictGuard(),
      recurrence,
      assemble,
      bundleEventBus,
    });
    const cascadeSpy = jest
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(svc as any, 'emitVisitorCascadeForBundle')
      .mockResolvedValue(undefined);

    const result = await TenantContext.run(TENANT, async () =>
      svc.editScope(
        PIVOT_BOOKING_ID,
        { scope: 'this_and_following', space_id: NEW_SPACE_ID },
        makeActor(),
        CLIENT_REQUEST_ID,
      ),
    );
    // Visitor cascade fired for the 2 occurrences whose space changed.
    expect(cascadeSpy).toHaveBeenCalledTimes(2);

    // splitSeries CALLED on the commit path; returns NEW_SERIES_ID.
    expect(recurrence.splitSeries).toHaveBeenCalledWith(PIVOT_BOOKING_ID);

    // Assembler sees the NEW series id, no forwardOnly filter (the new
    // series only has forward rows by construction).
    const assembleArgs = captured.args as {
      effectiveSeriesId: string;
      forwardOnlyFromStartAt?: string;
    };
    expect(assembleArgs.effectiveSeriesId).toBe(NEW_SERIES_ID);
    expect(assembleArgs.forwardOnlyFromStartAt).toBeUndefined();

    // Idempotency key is keyed on PIVOT bookingId (NOT new series id) —
    // structural defense against splitSeries-non-idempotent-retry hazard.
    const rpcArgs = supabase.calls.rpc[0].args as Record<string, unknown>;
    expect(rpcArgs.p_idempotency_key).toBe(
      buildEditBookingIdempotencyKey(PIVOT_BOOKING_ID, CLIENT_REQUEST_ID, 'scope'),
    );

    expect(result.new_series_id).toBe(NEW_SERIES_ID);
    expect(result.dry_run).toBe(false);
    expect(result.scope).toBe('this_and_following');
  });

  it("scope='this_and_following' dry-run: NO splitSeries; forwardOnlyFromStartAt set; RPC dry-run; NO cascade", async () => {
    const captured: { args?: unknown } = {};
    const supabase = makeSupabase({
      rpcResponse: {
        data: {
          dry_run: true,
          would_succeed: true,
          series_id: ORIGINAL_SERIES_ID,
          per_occurrence: [
            // dry-run shape: would_succeed + follow_ups_preview, NOT slots_updated
            {
              booking_id: 'occ-1',
              would_succeed: true,
              space_id_before: PIVOT_SPACE_ID,
              space_id_after: NEW_SPACE_ID,
              start_at_before: PIVOT_START_AT,
              start_at_after: PIVOT_START_AT,
              follow_ups_preview: ['booking.location_changed'],
              slots_to_update: 1,
            },
          ],
          aggregated_follow_ups: ['booking.location_changed'],
        },
        error: null,
      },
    });
    const recurrence = makeRecurrence();
    const assemble = makeAssembleEditPlan({ captured });
    const bundleEventBus = makeBundleEventBus();
    const svc = buildService({
      supabase,
      visibility: makeVisibility(),
      conflict: makeConflictGuard(),
      recurrence,
      assemble,
      bundleEventBus,
    });
    const cascadeSpy = jest
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(svc as any, 'emitVisitorCascadeForBundle')
      .mockResolvedValue(undefined);

    const result = await TenantContext.run(TENANT, async () =>
      svc.editScope(
        PIVOT_BOOKING_ID,
        { scope: 'this_and_following', space_id: NEW_SPACE_ID, dry_run: true },
        makeActor(),
        CLIENT_REQUEST_ID,
      ),
    );

    // splitSeries NOT called on dry-run (the critical guard — splitSeries
    // commits side effects).
    expect(recurrence.splitSeries).not.toHaveBeenCalled();

    // Assembler called with effectiveSeriesId = pivot's CURRENT series
    // (not split), forwardOnlyFromStartAt = pivot.start_at.
    const assembleArgs = captured.args as {
      effectiveSeriesId: string;
      forwardOnlyFromStartAt?: string;
    };
    expect(assembleArgs.effectiveSeriesId).toBe(ORIGINAL_SERIES_ID);
    expect(assembleArgs.forwardOnlyFromStartAt).toBe(PIVOT_START_AT);

    // RPC called with p_dry_run=true.
    const rpcArgs = supabase.calls.rpc[0].args as Record<string, unknown>;
    expect(rpcArgs.p_dry_run).toBe(true);

    // NO visitor cascade — dry-run committed nothing.
    expect(cascadeSpy).not.toHaveBeenCalled();
    // Defense-in-depth: even if the spy missed, raw emit not called.
    expect(bundleEventBus.emit).not.toHaveBeenCalled();

    // Envelope: dry_run=true, no new_series_id, would_succeed surfaced.
    expect(result.dry_run).toBe(true);
    expect(result.new_series_id).toBeUndefined();
    expect(result.would_succeed).toBe(true);
  });

  it('rejects non-boolean dry_run with 400 edit_booking_scope.invalid_plans', async () => {
    const supabase = makeSupabase();
    const svc = buildService({
      supabase,
      visibility: makeVisibility(),
      conflict: makeConflictGuard(),
      recurrence: makeRecurrence(),
      assemble: makeAssembleEditPlan(),
    });

    await TenantContext.run(TENANT, async () => {
      await expect(
        svc.editScope(
          PIVOT_BOOKING_ID,
          {
            scope: 'series',
            // string-coerced "true" — coverage of the body shape guard.
            dry_run: 'true' as unknown as boolean,
          },
          makeActor(),
          CLIENT_REQUEST_ID,
        ),
      ).rejects.toMatchObject({
        code: 'edit_booking_scope.invalid_plans',
        status: 400,
      });
    });

    expect(supabase.calls.rpc).toHaveLength(0);
  });

  it('rejects pivot without recurrence_series_id with 422 not_recurring', async () => {
    const supabase = makeSupabase();
    const svc = buildService({
      supabase,
      visibility: makeVisibility(),
      conflict: makeConflictGuard(),
      recurrence: makeRecurrence(),
      assemble: makeAssembleEditPlan(),
      pivot: makePivotReservation({ recurrence_series_id: null }),
    });

    await TenantContext.run(TENANT, async () => {
      await expect(
        svc.editScope(
          PIVOT_BOOKING_ID,
          { scope: 'series' },
          makeActor(),
          CLIENT_REQUEST_ID,
        ),
      ).rejects.toMatchObject({
        code: 'edit_booking_scope.not_recurring',
        status: 422,
      });
    });

    expect(supabase.calls.rpc).toHaveLength(0);
  });

  it('rejects canEdit=false with 403 reservation_not_editable', async () => {
    const supabase = makeSupabase();
    const svc = buildService({
      supabase,
      visibility: makeVisibility({ canEdit: false }),
      conflict: makeConflictGuard(),
      recurrence: makeRecurrence(),
      assemble: makeAssembleEditPlan(),
    });

    await TenantContext.run(TENANT, async () => {
      await expect(
        svc.editScope(
          PIVOT_BOOKING_ID,
          { scope: 'series' },
          makeActor(),
          CLIENT_REQUEST_ID,
        ),
      ).rejects.toMatchObject({
        code: 'reservation_not_editable',
        status: 403,
      });
    });

    expect(supabase.calls.rpc).toHaveLength(0);
  });

  it('idempotency key is keyed on (pivot bookingId, crid, scope) — NOT on new series id', async () => {
    // Structural defense against splitSeries-non-idempotent-retry hazard.
    // A retry that lands after splitSeries succeeded must hit the cached
    // command_operations row keyed on PIVOT id (stable), not new series
    // id (different every split). Documented in the editScope docstring;
    // this test locks the contract.
    const supabase = makeSupabase();
    const svc = buildService({
      supabase,
      visibility: makeVisibility(),
      conflict: makeConflictGuard(),
      recurrence: makeRecurrence(),
      assemble: makeAssembleEditPlan(),
      bundleEventBus: makeBundleEventBus(),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.spyOn(svc as any, 'emitVisitorCascadeForBundle').mockResolvedValue(undefined);

    await TenantContext.run(TENANT, async () =>
      svc.editScope(
        PIVOT_BOOKING_ID,
        { scope: 'this_and_following' },
        makeActor(),
        CLIENT_REQUEST_ID,
      ),
    );

    const rpcArgs = supabase.calls.rpc[0].args as Record<string, unknown>;
    // Must contain the pivot booking id, NOT the new series id.
    expect(rpcArgs.p_idempotency_key as string).toContain(PIVOT_BOOKING_ID);
    expect(rpcArgs.p_idempotency_key as string).not.toContain(NEW_SERIES_ID);
    // And must use the 'scope' op discriminator (closes cross-op-collision).
    expect(rpcArgs.p_idempotency_key as string).toContain(':scope:');
  });

  it('translates 23P01 (GiST exclusion) from the RPC into 409 booking.slot_conflict', async () => {
    const supabase = makeSupabase({
      rpcResponse: { data: null, error: { code: '23P01', message: 'gist conflict' } },
    });
    const svc = buildService({
      supabase,
      visibility: makeVisibility(),
      conflict: makeConflictGuard(),
      recurrence: makeRecurrence(),
      assemble: makeAssembleEditPlan(),
    });

    await TenantContext.run(TENANT, async () => {
      let caught: unknown;
      try {
        await svc.editScope(
          PIVOT_BOOKING_ID,
          { scope: 'series', space_id: NEW_SPACE_ID },
          makeActor(),
          CLIENT_REQUEST_ID,
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AppError);
      expect((caught as AppError).code).toBe('booking.slot_conflict');
      expect((caught as AppError).status).toBe(409);
    });
  });

  // ─── Self-review remediation (2026-05-12) ─────────────────────────────────
  // C1: splitSeries-then-RPC retry race.
  // C2-plan-rev: start_at / end_at smuggled in body silently dropped.
  // C2-code-rev: scope value never validated (garbage falls through to series).

  it('C1: command_operations cached_result short-circuits BEFORE splitSeries on retry', async () => {
    // Pre-seeded cached_result row. The first-attempt's RPC commit
    // succeeded and stored cached_result; the response was dropped (network
    // failure). On retry with the same crid, the service MUST detect the
    // cached row and return its content verbatim WITHOUT firing splitSeries
    // again (which would mint a phantom orphan series).
    const cachedResult = {
      committed: 3,
      series_id: NEW_SERIES_ID, // FIRST attempt's split-series id
      per_occurrence: [
        {
          booking_id: 'occ-1',
          space_id_before: PIVOT_SPACE_ID,
          space_id_after: NEW_SPACE_ID,
          start_at_before: PIVOT_START_AT,
          start_at_after: PIVOT_START_AT,
          slots_updated: 1,
          follow_ups: ['booking.location_changed'],
        },
      ],
      aggregated_follow_ups: ['booking.location_changed'],
    };
    const supabase = makeSupabase({
      cachedRow: { outcome: 'success', cached_result: cachedResult },
    });
    const recurrence = makeRecurrence();
    const assemble = makeAssembleEditPlan();
    const bundleEventBus = makeBundleEventBus();
    const svc = buildService({
      supabase,
      visibility: makeVisibility(),
      conflict: makeConflictGuard(),
      recurrence,
      assemble,
      bundleEventBus,
    });
    const cascadeSpy = jest
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(svc as any, 'emitVisitorCascadeForBundle')
      .mockResolvedValue(undefined);

    const result = await TenantContext.run(TENANT, async () =>
      svc.editScope(
        PIVOT_BOOKING_ID,
        { scope: 'this_and_following', space_id: NEW_SPACE_ID },
        makeActor(),
        CLIENT_REQUEST_ID,
      ),
    );

    // splitSeries MUST NOT fire (the C1 hazard — first attempt already
    // minted a series; the second mint would be orphan).
    expect(recurrence.splitSeries).not.toHaveBeenCalled();
    // Assembler MUST NOT fire (no plan to assemble — replay path).
    expect(assemble.assembleScopeEditPlan).not.toHaveBeenCalled();
    // RPC MUST NOT fire (cached_result IS the response).
    expect(supabase.calls.rpc).toHaveLength(0);
    // Cascade MUST NOT fire (already fanned out on first attempt).
    expect(cascadeSpy).not.toHaveBeenCalled();

    // Defensive: the pre-check read DID happen, with the expected key.
    expect(supabase.calls.commandOpsReads).toHaveLength(1);
    expect(supabase.calls.commandOpsReads[0].tenantId).toBe(TENANT.id);
    expect(supabase.calls.commandOpsReads[0].idempotencyKey).toBe(
      buildEditBookingIdempotencyKey(
        PIVOT_BOOKING_ID,
        CLIENT_REQUEST_ID,
        'scope',
      ),
    );

    // Response shape matches cached_result + recovers new_series_id from
    // cached.series_id (because scope='this_and_following' → first attempt
    // wrote effectiveSeriesId = newSeriesId into the RPC's series_id).
    expect(result.scope).toBe('this_and_following');
    expect(result.new_series_id).toBe(NEW_SERIES_ID);
    expect(result.dry_run).toBe(false);
    expect(result.committed).toBe(3);
    expect(result.series_id).toBe(NEW_SERIES_ID);
    expect(result.aggregated_follow_ups).toEqual(['booking.location_changed']);
  });

  it('C1: cached row with outcome=in_progress does NOT short-circuit', async () => {
    // Only outcome='success' triggers the replay path. A stale in_progress
    // row (which shouldn't materialise per the 00316 v6 contract — rolled
    // back by the RPC tx — but defense-in-depth) must still let the normal
    // flow proceed; the RPC's own advisory lock + payload_hash check will
    // serialize correctly.
    const supabase = makeSupabase({
      cachedRow: { outcome: 'in_progress', cached_result: null },
    });
    const recurrence = makeRecurrence();
    const assemble = makeAssembleEditPlan();
    const svc = buildService({
      supabase,
      visibility: makeVisibility(),
      conflict: makeConflictGuard(),
      recurrence,
      assemble,
      bundleEventBus: makeBundleEventBus(),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.spyOn(svc as any, 'emitVisitorCascadeForBundle').mockResolvedValue(undefined);

    await TenantContext.run(TENANT, async () =>
      svc.editScope(
        PIVOT_BOOKING_ID,
        { scope: 'this_and_following', space_id: NEW_SPACE_ID },
        makeActor(),
        CLIENT_REQUEST_ID,
      ),
    );

    // Normal flow proceeded: splitSeries + assemble + RPC all fired.
    expect(recurrence.splitSeries).toHaveBeenCalledTimes(1);
    expect(assemble.assembleScopeEditPlan).toHaveBeenCalledTimes(1);
    expect(supabase.calls.rpc).toHaveLength(1);
  });

  it("C2-plan-rev: rejects smuggled start_at with 422 time_shift_not_supported", async () => {
    const supabase = makeSupabase();
    const svc = buildService({
      supabase,
      visibility: makeVisibility(),
      conflict: makeConflictGuard(),
      recurrence: makeRecurrence(),
      assemble: makeAssembleEditPlan(),
    });

    await TenantContext.run(TENANT, async () => {
      await expect(
        svc.editScope(
          PIVOT_BOOKING_ID,
          // Smuggled time-shift fields — the typed DTO forbids these.
          // Pre-fix the service silently dropped them (only field-picked
          // space_id / attendee_count / attendee_person_ids / host_person_id).
          {
            scope: 'series',
            start_at: '2026-06-01T11:00:00Z',
          } as unknown as EditScopeDto,
          makeActor(),
          CLIENT_REQUEST_ID,
        ),
      ).rejects.toMatchObject({
        code: 'edit_booking_scope.time_shift_not_supported',
        status: 422,
      });
    });
    expect(supabase.calls.rpc).toHaveLength(0);
    expect(supabase.calls.commandOpsReads).toHaveLength(0);
  });

  it("C2-plan-rev: rejects smuggled end_at with 422 time_shift_not_supported", async () => {
    const supabase = makeSupabase();
    const svc = buildService({
      supabase,
      visibility: makeVisibility(),
      conflict: makeConflictGuard(),
      recurrence: makeRecurrence(),
      assemble: makeAssembleEditPlan(),
    });

    await TenantContext.run(TENANT, async () => {
      await expect(
        svc.editScope(
          PIVOT_BOOKING_ID,
          {
            scope: 'series',
            end_at: '2026-06-01T12:00:00Z',
          } as unknown as EditScopeDto,
          makeActor(),
          CLIENT_REQUEST_ID,
        ),
      ).rejects.toMatchObject({
        code: 'edit_booking_scope.time_shift_not_supported',
        status: 422,
      });
    });
    expect(supabase.calls.rpc).toHaveLength(0);
  });

  it("C2-code-rev: rejects scope='garbage' with 400 invalid_plans (no silent fall-through)", async () => {
    // Pre-fix only `scope==='this'` was explicitly rejected; any other
    // non-allowlist value (`'garbage'`, `null`, `undefined`) fell through
    // to the else branch and was silently executed as `'series'`.
    const supabase = makeSupabase();
    const svc = buildService({
      supabase,
      visibility: makeVisibility(),
      conflict: makeConflictGuard(),
      recurrence: makeRecurrence(),
      assemble: makeAssembleEditPlan(),
    });

    await TenantContext.run(TENANT, async () => {
      await expect(
        svc.editScope(
          PIVOT_BOOKING_ID,
          { scope: 'garbage' as unknown as 'series' },
          makeActor(),
          CLIENT_REQUEST_ID,
        ),
      ).rejects.toMatchObject({
        code: 'edit_booking_scope.invalid_plans',
        status: 400,
      });
    });
    expect(supabase.calls.rpc).toHaveLength(0);
  });

  it("C2-code-rev: rejects scope=null with 400 invalid_plans", async () => {
    const supabase = makeSupabase();
    const svc = buildService({
      supabase,
      visibility: makeVisibility(),
      conflict: makeConflictGuard(),
      recurrence: makeRecurrence(),
      assemble: makeAssembleEditPlan(),
    });

    await TenantContext.run(TENANT, async () => {
      await expect(
        svc.editScope(
          PIVOT_BOOKING_ID,
          { scope: null as unknown as 'series' },
          makeActor(),
          CLIENT_REQUEST_ID,
        ),
      ).rejects.toMatchObject({
        code: 'edit_booking_scope.invalid_plans',
        status: 400,
      });
    });
    expect(supabase.calls.rpc).toHaveLength(0);
  });
});

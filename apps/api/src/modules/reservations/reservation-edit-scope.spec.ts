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
 *
 * Booking-audit remediation Slice 4 (audit 03 P1-2) — split idempotency
 * MOVED to the RPC. The codex 2026-05-12 `skipSplitSeries`
 * command_operations pre-check is REMOVED. `RecurrenceService.splitSeries`
 * is now a thin wrapper over the atomic, idempotent
 * `split_recurrence_series` RPC (00411) keyed on the same (bookingId,
 * clientRequestId) editScope uses. The TS layer no longer pre-detects a
 * retry — every commit calls splitSeries, and the RPC's own
 * command_operations gate returns the same new_series_id on replay (no
 * orphan series). The five ex-pre-check specs are rewritten to assert
 * the NEW contract:
 *   - commit retry → splitSeries IS called (the RPC dedups, returns the
 *     same new_series_id); assembler + RPC still run.
 *   - dry-run → splitSeries NOT called (a preview commits nothing); no
 *     command_operations read happens in the TS layer at all.
 *   - same-crid / different-body retry → the edit_booking_scope RPC's
 *     payload_hash check raises command_operations.payload_mismatch
 *     (409 per map-rpc-error.ts). Unchanged contract; the split RPC has
 *     its own analogous gate.
 *
 * Tier B followup #6 (2026-05-12) — editScope now fans out cascades via
 * the BATCHED sibling `emitVisitorCascadesForBundles` (one .in() lookup
 * for N bundles). The existing cascade-call assertions assert ONE call
 * with an items[] of the moved occurrences, not N separate calls.
 * Plural method has its own dedicated spec at
 * `reservation-edit-scope-cascade-batch.spec.ts`.
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
    auth_uid: 'U',
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
 * Supabase mock: two operations matter for editScope's TS layer.
 *
 *   1. The `bookings` read inside `findByIdOrThrow(pivotId, tenantId)`.
 *      Goes through the SLOT_WITH_BOOKING_SELECT projection by joining
 *      booking_slots to bookings — but since we stub the higher-level
 *      service.findByIdOrThrow via a private-method spy below, the
 *      from('bookings') / from('booking_slots') chain only needs to
 *      no-op cleanly for the rare paths that touch it.
 *   2. `supabase.rpc('edit_booking_scope', ...)` — what the spec asserts on.
 *
 * Booking-audit remediation Slice 4 (audit 03 P1-2): the third operation
 * (the `command_operations` pre-check `from('command_operations')
 * .select().eq().eq().maybeSingle()`) is GONE. editScope no longer reads
 * command_operations in the TS layer — `RecurrenceService.splitSeries`
 * is now a thin wrapper over the `split_recurrence_series` RPC (00411)
 * which owns idempotency end-to-end. `makeRecurrence` mocks the wrapper
 * directly, so the split RPC's own command_operations gate is exercised
 * by the live smoke (smoke-edit-booking-scope.mjs), not this mock.
 */
function makeSupabase(opts?: {
  rpcResponse?: { data: unknown; error: unknown };
}) {
  const calls = {
    rpc: [] as Array<{ fn: string; args: unknown }>,
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
      if (fn === 'claim_producer_resolution_basis') {
        return Promise.resolve({
          data: '2026-05-01T08:00:00.000Z',
          error: null,
        });
      }
      calls.rpc.push({ fn, args });
      return Promise.resolve(rpcResponse);
    },
    from: (table: string) => {
      // The TS path that exercises editScope calls findByIdOrThrow which
      // hits supabase.admin.from('booking_slots'). We override that via
      // a spy on the service instance directly, so this stub never
      // actually runs in the tested paths — but if a future change
      // tries to read tables directly we want a clear failure.
      throw new Error(
        `unexpected supabase.from('${table}') call — editScope service spec stubs findByIdOrThrow + assembler + RPC (no command_operations pre-check after Slice 4)`,
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

// Slice 4: splitSeries is now `(bookingId, actor, clientRequestId)` —
// a thin wrapper over the idempotent split_recurrence_series RPC. The
// mock returns the new series id regardless of args; the RPC's own
// idempotency (same crid → same id on replay) is covered by the live
// smoke (smoke-edit-booking-scope.mjs), not this unit mock.
function makeRecurrence(opts?: { splitReturns?: string }) {
  return {
    splitSeries: jest.fn(
      async (_bookingId: string, _actor: unknown, _crid: string) =>
        opts?.splitReturns ?? NEW_SERIES_ID,
    ),
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
      .spyOn(svc as any, 'emitVisitorCascadesForBundles')
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

    // Tier B followup #6 (2026-05-12) — batched plural call. One
    // invocation carries an items[] of length 2 (occ-1, occ-2 moved room;
    // occ-3 unchanged, filtered out). Default mock returns 3 occurrences.
    expect(cascadeSpy).toHaveBeenCalledTimes(1);
    const cascadeItems = cascadeSpy.mock.calls[0][0] as Array<{
      bundleId: string;
      oldSpaceId: string | null;
      newSpaceId: string | null;
    }>;
    expect(cascadeItems).toHaveLength(2);
    expect(cascadeItems[0]).toMatchObject({
      bundleId: 'occ-1',
      oldSpaceId: PIVOT_SPACE_ID,
      newSpaceId: NEW_SPACE_ID,
    });
    expect(cascadeItems[1]).toMatchObject({
      bundleId: 'occ-2',
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
      .spyOn(svc as any, 'emitVisitorCascadesForBundles')
      .mockResolvedValue(undefined);

    const result = await TenantContext.run(TENANT, async () =>
      svc.editScope(
        PIVOT_BOOKING_ID,
        { scope: 'this_and_following', space_id: NEW_SPACE_ID },
        makeActor(),
        CLIENT_REQUEST_ID,
      ),
    );
    // Batched: one call carrying the 2 occurrences whose space changed.
    expect(cascadeSpy).toHaveBeenCalledTimes(1);
    expect(cascadeSpy.mock.calls[0][0] as Array<unknown>).toHaveLength(2);

    // splitSeries CALLED on the commit path with (bookingId, actor,
    // crid) — Slice 4 thin RPC wrapper signature. Returns NEW_SERIES_ID.
    expect(recurrence.splitSeries).toHaveBeenCalledWith(
      PIVOT_BOOKING_ID,
      expect.objectContaining({ auth_uid: 'U' }),
      CLIENT_REQUEST_ID,
    );

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
      .spyOn(svc as any, 'emitVisitorCascadesForBundles')
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
    jest.spyOn(svc as any, 'emitVisitorCascadesForBundles').mockResolvedValue(undefined);

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

  // ─── Booking-audit Slice 4 (audit 03 P1-2) ───────────────────────────────
  // Split idempotency moved INTO the split_recurrence_series RPC (00411).
  // The TS `skipSplitSeries` command_operations pre-check is REMOVED.
  // These specs (formerly "codex-revised C1/C2") now lock the NEW
  // contract: every commit calls splitSeries; the RPC's own
  // command_operations gate dedups a retry (returns the same
  // new_series_id, no orphan series); dry-run never calls splitSeries
  // and the TS layer never reads command_operations.
  // C2-plan-rev: start_at / end_at smuggled in body silently dropped.
  // C2-code-rev: scope value never validated (garbage falls through to series).

  it('Slice 4: retry on `this_and_following` commit RE-CALLS splitSeries (RPC dedups → same new_series_id); assembler+RPC still run', async () => {
    // First attempt: splitSeries → split_recurrence_series RPC minted the
    // new series + moved the pivot/forward bookings + cached its result
    // under `booking:recurrence:split:<bid>:<crid>`; edit_booking_scope
    // RPC committed + cached its envelope. Response dropped (network
    // failure). On retry the pivot now sits on the POST-SPLIT series
    // (the first split moved it). The TS layer NO LONGER pre-detects the
    // retry — it calls splitSeries again. The split RPC's own
    // command_operations gate cache-hits and returns the SAME
    // new_series_id (NEW_SERIES_ID — no second/orphan series). The mock
    // returns NEW_SERIES_ID regardless (the RPC dedup is exercised by
    // the live smoke). effectiveSeriesId = NEW_SERIES_ID; the assembler
    // runs against it; the edit_booking_scope RPC returns the cached
    // envelope verbatim (00371:266-267).
    const cachedEnvelope = {
      committed: 3,
      series_id: NEW_SERIES_ID,
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
      // RPC mock returns the cached envelope verbatim (what the real
      // edit_booking_scope RPC does on a payload_hash match — 00371:
      // 266-267).
      rpcResponse: { data: cachedEnvelope, error: null },
    });
    // The split RPC dedups on retry: same crid → same new_series_id.
    const recurrence = makeRecurrence({ splitReturns: NEW_SERIES_ID });
    const captured: { args?: unknown } = {};
    const assemble = makeAssembleEditPlan({ captured });
    const bundleEventBus = makeBundleEventBus();
    const svc = buildService({
      supabase,
      visibility: makeVisibility(),
      conflict: makeConflictGuard(),
      recurrence,
      assemble,
      bundleEventBus,
      // Post-split pivot: recurrence_series_id is the NEW series id
      // because the first attempt's split moved it there.
      pivot: makePivotReservation({ recurrence_series_id: NEW_SERIES_ID }),
    });
    const cascadeSpy = jest
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(svc as any, 'emitVisitorCascadesForBundles')
      .mockResolvedValue(undefined);

    const result = await TenantContext.run(TENANT, async () =>
      svc.editScope(
        PIVOT_BOOKING_ID,
        { scope: 'this_and_following', space_id: NEW_SPACE_ID },
        makeActor(),
        CLIENT_REQUEST_ID,
      ),
    );

    // splitSeries IS called on every commit (Slice 4 — the RPC owns
    // idempotency; the TS layer no longer suppresses the call). Same
    // (bookingId, actor, crid) as the first attempt → the RPC returns
    // the SAME new_series_id (no orphan series).
    expect(recurrence.splitSeries).toHaveBeenCalledTimes(1);
    expect(recurrence.splitSeries).toHaveBeenCalledWith(
      PIVOT_BOOKING_ID,
      expect.objectContaining({ auth_uid: 'U' }),
      CLIENT_REQUEST_ID,
    );

    // Assembler MUST fire — the RPC needs the assembled plans to compare
    // payload_hash against cached. effectiveSeriesId = the split's
    // returned new_series_id (NEW_SERIES_ID).
    expect(assemble.assembleScopeEditPlan).toHaveBeenCalledTimes(1);
    const assembleArgs = captured.args as {
      effectiveSeriesId: string;
      forwardOnlyFromStartAt?: string;
    };
    expect(assembleArgs.effectiveSeriesId).toBe(NEW_SERIES_ID);
    expect(assembleArgs.forwardOnlyFromStartAt).toBeUndefined();

    // edit_booking_scope RPC MUST fire — it owns the cached_result return.
    expect(supabase.calls.rpc).toHaveLength(1);
    const rpcArgs = supabase.calls.rpc[0].args as Record<string, unknown>;
    expect(rpcArgs.p_idempotency_key).toBe(
      buildEditBookingIdempotencyKey(PIVOT_BOOKING_ID, CLIENT_REQUEST_ID, 'scope'),
    );
    expect(rpcArgs.p_dry_run).toBe(false);

    // Response shape comes from RPC (cached envelope replayed verbatim).
    // new_series_id is the split's return (NEW_SERIES_ID) — matches what
    // the FIRST attempt's response advertised.
    expect(result.scope).toBe('this_and_following');
    expect(result.new_series_id).toBe(NEW_SERIES_ID);
    expect(result.dry_run).toBe(false);
    expect(result.committed).toBe(3);
    expect(result.series_id).toBe(NEW_SERIES_ID);
    expect(result.aggregated_follow_ups).toEqual(['booking.location_changed']);
  });

  it('Slice 4: dry-run does NOT call splitSeries and surfaces the dry-run envelope (not a prior commit)', async () => {
    // Dry-run is a stateless preview (00371 v2 contract). It must never
    // call splitSeries (a preview commits nothing) and must surface the
    // RPC's dry-run envelope. The legacy codex C1 hazard (a dry-run with
    // the same crid as a prior commit replaying the cached commit
    // envelope) cannot recur: there is no longer ANY TS-side
    // command_operations read, and dry-run never calls the split RPC.
    // This test locks the dry-run contract under the Slice 4 cutover.
    const supabase = makeSupabase({
      // Dry-run RPC returns the proper preview shape.
      rpcResponse: {
        data: {
          dry_run: true,
          would_succeed: true,
          series_id: ORIGINAL_SERIES_ID,
          per_occurrence: [
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
    const captured: { args?: unknown } = {};
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
      .spyOn(svc as any, 'emitVisitorCascadesForBundles')
      .mockResolvedValue(undefined);

    const result = await TenantContext.run(TENANT, async () =>
      svc.editScope(
        PIVOT_BOOKING_ID,
        { scope: 'this_and_following', space_id: NEW_SPACE_ID, dry_run: true },
        makeActor(),
        CLIENT_REQUEST_ID,
      ),
    );

    // splitSeries MUST NOT fire on dry-run (a preview commits nothing).
    expect(recurrence.splitSeries).not.toHaveBeenCalled();
    // Assembler MUST fire (with forwardOnlyFromStartAt for dry-run).
    expect(assemble.assembleScopeEditPlan).toHaveBeenCalledTimes(1);
    const assembleArgs = captured.args as {
      effectiveSeriesId: string;
      forwardOnlyFromStartAt?: string;
    };
    expect(assembleArgs.effectiveSeriesId).toBe(ORIGINAL_SERIES_ID);
    expect(assembleArgs.forwardOnlyFromStartAt).toBe(PIVOT_START_AT);
    // RPC MUST fire with p_dry_run=true.
    expect(supabase.calls.rpc).toHaveLength(1);
    const rpcArgs = supabase.calls.rpc[0].args as Record<string, unknown>;
    expect(rpcArgs.p_dry_run).toBe(true);
    // Cascade MUST NOT fire (dry-run committed nothing).
    expect(cascadeSpy).not.toHaveBeenCalled();

    // Response is the DRY-RUN envelope — would_succeed surfaced, no
    // committed count (preview only).
    expect(result.dry_run).toBe(true);
    expect(result.would_succeed).toBe(true);
    expect(result.committed).toBeUndefined();
    expect(result.aggregated_follow_ups).toEqual(['booking.location_changed']);
  });

  it('Slice 4: payload_mismatch on retry with a different body propagates from the edit_booking_scope RPC', async () => {
    // Same-crid / different-body retry. The split RPC dedups (returns
    // the same new_series_id — exercised by the live smoke); the
    // assembler then produces DIFFERENT plans for the changed body; the
    // edit_booking_scope RPC's payload_hash check (00371:268-274)
    // raises command_operations.payload_mismatch. The TS layer no
    // longer pre-checks command_operations — the RPC owns this end-to-
    // end. mapRpcErrorToAppError surfaces it as a 409.
    const supabase = makeSupabase({
      rpcResponse: {
        data: null,
        error: {
          code: 'P0001',
          message: 'command_operations.payload_mismatch',
        },
      },
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
      pivot: makePivotReservation({ recurrence_series_id: NEW_SERIES_ID }),
    });

    await TenantContext.run(TENANT, async () => {
      let caught: unknown;
      try {
        await svc.editScope(
          PIVOT_BOOKING_ID,
          {
            scope: 'this_and_following',
            space_id: NEW_SPACE_ID,
            attendee_count: 42, // different from first attempt's body
          },
          makeActor(),
          CLIENT_REQUEST_ID,
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AppError);
      // mapRpcErrorToAppError surfaces the RPC's payload_mismatch raise.
      // STATUS is 409 per map-rpc-error.ts:180 (canonical conflict class
      // — same crid + different payload is a duplicate-with-mismatch).
      expect((caught as AppError).code).toBe('command_operations.payload_mismatch');
      expect((caught as AppError).status).toBe(409);
    });

    // splitSeries IS called on the commit (Slice 4 — every commit calls
    // it; the split RPC dedups on the same crid). The edit RPC then
    // detects the mismatched body.
    expect(recurrence.splitSeries).toHaveBeenCalledTimes(1);
    // Assembler MUST fire (the RPC needs plans to compute payload_hash).
    expect(assemble.assembleScopeEditPlan).toHaveBeenCalledTimes(1);
    // edit_booking_scope RPC MUST fire (it detects payload_mismatch).
    expect(supabase.calls.rpc).toHaveLength(1);
  });

  // ─── Slice 4 removal note ─────────────────────────────────────────────────
  // Two ex-tests were DELETED here, not gutted:
  //   - "pre-check read error surfaces command_operations.unexpected_state"
  //   - "cached row with outcome=in_progress does NOT skip splitSeries"
  // Both asserted the internal behavior of the TS `skipSplitSeries`
  // command_operations pre-check, which is REMOVED by Booking-audit
  // Slice 4 (audit 03 P1-2). editScope no longer reads command_operations
  // in the TS layer at all — `split_recurrence_series` (00411) owns
  // idempotency end-to-end (its own gate handles the in_progress /
  // payload-hash / advisory-lock concerns those tests covered). The
  // RPC-level idempotency + no-orphan-series guarantees are now proved
  // by the live smoke (smoke-edit-booking-scope.mjs) which exercises a
  // real retry against the real RPC + asserts exactly one
  // recurrence_series row + command_operations split-row outcome.
  // Keeping mock-only assertions about deleted code would be a false
  // test. The retry-replay contract is still covered by the rewritten
  // "Slice 4: retry on `this_and_following` commit RE-CALLS splitSeries"
  // test above + the smoke.

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

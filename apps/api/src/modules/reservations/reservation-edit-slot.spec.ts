import { AppError } from '../../common/errors';
import { ReservationService } from './reservation.service';
import { TenantContext } from '../../common/tenant-context';
import type { ActorContext } from './dto/types';
import type {
  EditPlan,
  EditPlanApproval,
} from './edit-plan.types';
import { buildEditBookingIdempotencyKey } from '@prequest/shared';

// Phase 1.4 — Bug #2 (slot-first scheduler).
//
// Spec for ReservationService.editSlot — the slot-targeted edit path that
// replaces the booking-id PATCH /reservations/:id when geometry is being
// edited.
//
// B.4 step 2D-D — cutover from `edit_booking_slot` (00291) to
// `edit_booking` (00364) via AssembleEditPlanService. The mocks now stub
// `assembleEditPlan` + `supabase.rpc('edit_booking', ...)` instead of
// `edit_booking_slot`. Mocking the higher-level service (rather than its
// internals) keeps tests stable across future plan-builder refactors.
//
// Scenarios preserved:
//   1. Happy path: edit slot B (non-primary) of a multi-room booking →
//      RPC `edit_booking` called with the assembled plan + idempotency
//      key; returns the projected Reservation reflecting the new slot
//      times.
//   2. Slot not found → AppError booking_slot.not_found.
//   3. GiST conflict (SQLSTATE 23P01) → AppError booking.slot_conflict
//      (preserved special-case; the new RPC propagates 23P01 the same
//      way).
//   4. URL mismatch — bookingId ≠ slot.booking_id → AppError
//      booking_slot.url_mismatch.
//
// New scenario:
//   5. B.4.A.5 controller-vs-notification gate — edit whose plan would
//      emit `booking.approval_required` (rows 2/7/8 of §3.6.5) is
//      rejected 422 (was 503; self-review I1 corrected the status to
//      route through class 'validation' instead of class 'server').

const CLIENT_REQUEST_ID = 'cccccccc-1111-4111-8111-cccccccccccc';

/** Produce an EditPlan that AssembleEditPlanService might return for a
 * geometry-only slot edit. Tests override `approval` to exercise the
 * B.4.A.5 gate. */
function makeEditPlan(opts: {
  bookingId: string;
  slotId: string;
  spaceId: string;
  startAt: string;
  endAt: string;
  approval?: EditPlanApproval;
}): EditPlan {
  return {
    booking: {
      location_id: opts.spaceId,
      start_at: opts.startAt,
      end_at: opts.endAt,
      cost_amount_snapshot: null,
      policy_snapshot: { matched_rule_ids: [], effects_seen: [] },
      applied_rule_ids: [],
    },
    slot_patches: [
      {
        // self-review N-CODE-3 (B.4 step 2D-D) — mirror the full slot
        // patch shape AssembleEditPlanService.assembleEditPlan emits
        // (assemble-edit-plan.service.ts:310-318) so test mocks stay
        // honest about the contract the RPC consumes. Pre-fix we
        // omitted setup_buffer_minutes / teardown_buffer_minutes /
        // attendee_count / attendee_person_ids — a partial-shape mock
        // can pass while the real builder regresses on a missing key.
        slot_id: opts.slotId,
        space_id: opts.spaceId,
        start_at: opts.startAt,
        end_at: opts.endAt,
        setup_buffer_minutes: 0,
        teardown_buffer_minutes: 0,
        attendee_count: 0,
        attendee_person_ids: [],
      },
    ],
    asset_reservation_patches: [],
    order_patches: [],
    work_order_sla_patches: [],
    _resolution_at: '2026-05-01T08:00:00.000Z',
    approval: opts.approval ?? {
      old_outcome: 'allow',
      new_outcome: 'allow',
      chain_config_changed: false,
      new_chain_config: null,
    },
  };
}

describe('ReservationService.editSlot', () => {
  const TENANT = { id: 'T', slug: 't', tier: 'standard' as const };
  const BOOKING_ID = 'B-1';
  const SLOT_PRIMARY = 'slot-primary';
  const SLOT_B = 'slot-b';

  // Plan A.4 / Commit 7 (I3) — editSlot now runs assertTenantOwned on
  // patch.space_id BEFORE the RPC. Convert short ids to v4-uuids so the
  // pre-flight passes (or fails as the test intends) without short-
  // circuiting on UUID_RE.test.
  const UUID_PREFIX = '00000000-0000-4000-8000-';
  function uuidFor(short: string): string {
    const hex = Buffer.from(short).toString('hex').slice(0, 12).padEnd(12, '0');
    return UUID_PREFIX + hex;
  }
  const SPACE_ORIGINAL = uuidFor('spOrig');
  const SPACE_VALID = uuidFor('spValid');
  const SPACE_FOREIGN = uuidFor('spFrgn');

  function makeActor(overrides: Partial<ActorContext> = {}): ActorContext {
    return {
      user_id: 'U',
      person_id: 'P',
      is_service_desk: false,
      has_override_rules: false,
      ...overrides,
    };
  }

  function makeSlotRow(overrides: Partial<{ id: string; booking_id: string; space_id: string; start_at: string; end_at: string; status: string; display_order: number }> = {}) {
    return {
      id: SLOT_B,
      tenant_id: TENANT.id,
      booking_id: BOOKING_ID,
      slot_type: 'room' as const,
      space_id: SPACE_ORIGINAL,
      start_at: '2026-05-01T09:00:00Z',
      end_at: '2026-05-01T10:00:00Z',
      setup_buffer_minutes: 0,
      teardown_buffer_minutes: 0,
      effective_start_at: '2026-05-01T09:00:00Z',
      effective_end_at: '2026-05-01T10:00:00Z',
      time_range: null,
      attendee_count: 4,
      attendee_person_ids: [],
      status: 'confirmed',
      check_in_required: false,
      check_in_grace_minutes: 15,
      checked_in_at: null,
      released_at: null,
      cancellation_grace_until: null,
      display_order: 1,
      created_at: '2026-05-01T08:00:00Z',
      updated_at: '2026-05-01T08:00:00Z',
      ...overrides,
    };
  }

  function makeBookingRow(overrides: Partial<{ id: string; location_id: string; start_at: string; end_at: string; requester_person_id: string; booked_by_user_id: string | null }> = {}) {
    return {
      id: BOOKING_ID,
      tenant_id: TENANT.id,
      title: null,
      description: null,
      requester_person_id: 'P',
      host_person_id: null,
      booked_by_user_id: 'U',
      location_id: SPACE_ORIGINAL,
      start_at: '2026-05-01T09:00:00Z',
      end_at: '2026-05-01T10:00:00Z',
      timezone: 'UTC',
      status: 'confirmed',
      source: 'desk',
      cost_center_id: null,
      cost_amount_snapshot: null,
      policy_snapshot: { matched_rule_ids: [], effects_seen: [] },
      applied_rule_ids: [],
      config_release_id: null,
      calendar_event_id: null,
      calendar_provider: null,
      calendar_etag: null,
      calendar_last_synced_at: null,
      recurrence_series_id: null,
      recurrence_index: null,
      recurrence_overridden: false,
      recurrence_skipped: false,
      template_id: null,
      created_at: '2026-05-01T08:00:00Z',
      updated_at: '2026-05-01T08:00:00Z',
      ...overrides,
    };
  }

  /**
   * Mock SupabaseService.admin. Three table reads matter for editSlot:
   *
   *   1. booking_slots.select('booking_id').eq('tenant_id').eq('id') —
   *      pre-flight to look up the slot's booking_id (URL-mismatch + not-
   *      found gates).
   *   2. booking_slots.select(SLOT_WITH_BOOKING_SELECT)... .order().order().limit(1).maybeSingle() —
   *      findByIdOrThrow projection read after the RPC succeeds (used by
   *      auth + the response).
   *   3. supabase.rpc('edit_booking', {...}) — the atomic write
   *      (B.4 step 2D-D — replaces 'edit_booking_slot').
   *
   * Visibility / user lookup go through ReservationVisibilityService which
   * we mock separately. AssembleEditPlanService is mocked separately too —
   * the supabase mock no longer needs to satisfy the plan-builder's reads.
   */
  function makeSupabase(opts?: {
    slotPreflight?: { booking_id: string } | null;
    rpcResponse?: { data: unknown; error: unknown };
    projectionRow?: ReturnType<typeof makeSlotRow> & { bookings: ReturnType<typeof makeBookingRow> };
    // Plan A.4 / Commit 7 — list of in-tenant space uuids for the new
    // assertTenantOwned pre-flight on editSlot (default: SPACE_ORIGINAL +
    // SPACE_VALID; tests opt out by passing []).
    knownTenantSpaces?: string[];
  }) {
    const calls = {
      rpc: [] as Array<{ fn: string; args: unknown }>,
    };
    const projection = opts?.projectionRow ?? {
      ...makeSlotRow({ id: SLOT_B }),
      bookings: makeBookingRow(),
    };
    const slotPreflight = opts?.slotPreflight === undefined
      ? { booking_id: BOOKING_ID }
      : opts.slotPreflight;
    const rpcResponse = opts?.rpcResponse ?? {
      data: { slot: makeSlotRow({ id: SLOT_B }), booking: makeBookingRow() },
      error: null,
    };
    const knownSpaces = new Set(opts?.knownTenantSpaces ?? [SPACE_ORIGINAL, SPACE_VALID]);

    const admin = {
      rpc: (fn: string, args: unknown) => {
        calls.rpc.push({ fn, args });
        return Promise.resolve(rpcResponse);
      },
      from: (table: string) => {
        if (table === 'spaces') {
          // Plan A.4 / Commit 7 — assertTenantOwned probe path.
          // .select('id').eq('id', X).eq('tenant_id', T).eq('active', true)
          // .eq('reservable', true).maybeSingle().
          const filters: Record<string, unknown> = {};
          const chain: Record<string, unknown> = {
            select: () => chain,
            eq: (col: string, val: unknown) => {
              filters[col] = val;
              return chain;
            },
            maybeSingle: async () => {
              const id = filters.id as string;
              const tenantId = filters.tenant_id as string;
              if (id && tenantId === TENANT.id && knownSpaces.has(id)) {
                return { data: { id }, error: null };
              }
              return { data: null, error: null };
            },
          };
          return chain;
        }
        if (table === 'booking_slots') {
          // The slot pre-flight is `.select('booking_id').eq('tenant_id', T)
          // .eq('id', slotId).maybeSingle()` — exactly two .eq() calls then
          // .maybeSingle(). The projection read is `.select(SLOT_WITH_BOOKING_SELECT)
          // .eq('tenant_id').eq('booking_id').order().order().limit().maybeSingle()`.
          // We disambiguate by counting .order() calls.
          const filters: Array<[string, unknown]> = [];
          let hasOrder = false;
          const chain: any = {
            select: () => chain,
            eq: (col: string, val: unknown) => {
              filters.push([col, val]);
              return chain;
            },
            order: () => {
              hasOrder = true;
              return chain;
            },
            limit: () => chain,
            maybeSingle: () =>
              hasOrder
                ? Promise.resolve({ data: projection, error: null })
                : Promise.resolve({ data: slotPreflight, error: null }),
          };
          return chain;
        }
        if (table === 'audit_events') {
          return { insert: () => Promise.resolve({ data: null, error: null }) };
        }
        if (table === 'visitors') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => Promise.resolve({ data: [], error: null }),
              }),
            }),
          };
        }
        return {};
      },
    };
    return { admin, calls };
  }

  function makeVisibility(overrides?: { canEdit?: boolean }) {
    const canEdit = overrides?.canEdit ?? true;
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

  /**
   * AssembleEditPlanService mock factory. The default returns a passthrough
   * plan for an `allow → allow` edit; tests can override `approvalOverride`
   * to drive the B.4.A.5 gate.
   */
  function makeAssembleEditPlan(opts?: {
    approvalOverride?: EditPlanApproval;
    /** Force the assembler to throw — exercises the plan-build error
     * propagation path. */
    throwOnAssemble?: AppError;
  }) {
    const assembleEditPlan = jest.fn(async (args: {
      bookingId: string;
      tenantId: string;
      slotId: string;
      patch: { kind: 'slot'; space_id?: string; start_at?: string; end_at?: string };
    }) => {
      if (opts?.throwOnAssemble) throw opts.throwOnAssemble;
      return makeEditPlan({
        bookingId: args.bookingId,
        slotId: args.slotId,
        spaceId: args.patch.space_id ?? SPACE_ORIGINAL,
        startAt: args.patch.start_at ?? '2026-05-01T11:00:00Z',
        endAt: args.patch.end_at ?? '2026-05-01T12:00:00Z',
        approval: opts?.approvalOverride,
      });
    });
    return { assembleEditPlan };
  }

  function buildService(
    supabase: ReturnType<typeof makeSupabase>,
    visibility: ReturnType<typeof makeVisibility>,
    conflict: ReturnType<typeof makeConflictGuard>,
    assemble?: ReturnType<typeof makeAssembleEditPlan>,
  ) {
    const planMock = assemble ?? makeAssembleEditPlan();
    return new ReservationService(
      supabase as never,
      conflict as never,
      visibility as never,
      undefined, // recurrence
      undefined, // notifications
      undefined, // bundleCascade
      undefined, // bundleEventBus
      planMock as never,
    );
  }

  it('happy path: edits non-primary slot via edit_booking RPC + returns the projected Reservation', async () => {
    const updatedStart = '2026-05-01T11:00:00Z';
    const updatedEnd = '2026-05-01T12:00:00Z';
    const supabase = makeSupabase({
      projectionRow: {
        ...makeSlotRow({ id: SLOT_B, start_at: updatedStart, end_at: updatedEnd }),
        bookings: makeBookingRow({ start_at: updatedStart, end_at: updatedEnd }),
      },
    });
    const visibility = makeVisibility({ canEdit: true });
    const conflict = makeConflictGuard();
    const svc = buildService(supabase, visibility, conflict);

    const result = await TenantContext.run(TENANT, () =>
      svc.editSlot(BOOKING_ID, SLOT_B, makeActor(), CLIENT_REQUEST_ID, {
        start_at: updatedStart,
        end_at: updatedEnd,
      }),
    );

    // B.4 step 2D-D: the RPC is now `edit_booking` and the args carry
    // the assembled plan + the deterministic idempotency key built from
    // (bookingId, clientRequestId).
    const rpcCall = supabase.calls.rpc.find((c) => c.fn === 'edit_booking');
    expect(rpcCall).toBeDefined();
    const args = rpcCall!.args as Record<string, unknown>;
    expect(args.p_booking_id).toBe(BOOKING_ID);
    expect(args.p_tenant_id).toBe(TENANT.id);
    expect(args.p_actor_user_id).toBe('U');
    // self-review N-CODE-4 (B.4 step 2D-D) — derive via the helper
    // instead of inlining the format. Couples the test to the public
    // helper API rather than the internal `booking:edit:<bookingId>:<crid>`
    // string shape — if the helper changes prefix or separator, this
    // assertion still passes (and the wider contract tests for the
    // helper itself catch the format change in one place).
    expect(args.p_idempotency_key).toBe(
      buildEditBookingIdempotencyKey(BOOKING_ID, CLIENT_REQUEST_ID),
    );
    const plan = args.p_plan as EditPlan;
    expect(plan.slot_patches).toHaveLength(1);
    expect(plan.slot_patches[0]).toMatchObject({
      slot_id: SLOT_B,
      start_at: updatedStart,
      end_at: updatedEnd,
    });

    // Returned Reservation reflects the slot's new geometry. The
    // projection helper sets `id` = booking id and `slot_id` = slot id.
    expect(result.id).toBe(BOOKING_ID);
    expect(result.slot_id).toBe(SLOT_B);
    expect(result.start_at).toBe(updatedStart);
    expect(result.end_at).toBe(updatedEnd);
  });

  // B.4 step 2D-D — controller-vs-notification gate (B.4.A.5).
  // When the plan would emit booking.approval_required (rows 2/7/8 of
  // §3.6.5), the service rejects 422 BEFORE any RPC call. Verifies that
  // the gate fires for all three trigger conditions.
  // self-review I1 (2026-05-12): gate now returns 422 (validation),
  // not 503 (server). Rationale lives at map-rpc-error.ts STATUS_BY_CODE
  // entry for booking.edit_requires_notification_dispatch — 503 routed
  // to class 'server' with retry-loop-bait toast; 422 routes to class
  // 'validation' with the right inline-error UX for the actual user
  // mitigation (pick a different room or remove approval from this room).
  it('B.4.A.5 gate: allow → require_approval rejects 422 before RPC fires', async () => {
    const supabase = makeSupabase();
    const visibility = makeVisibility({ canEdit: true });
    const conflict = makeConflictGuard();
    const assemble = makeAssembleEditPlan({
      approvalOverride: {
        old_outcome: 'allow',
        new_outcome: 'require_approval',
        chain_config_changed: false,
        new_chain_config: {
          required_approvers: [{ type: 'person', id: 'P1' }],
          threshold: 'all',
        },
      },
    });
    const svc = buildService(supabase, visibility, conflict, assemble);

    let caught: unknown = null;
    try {
      await TenantContext.run(TENANT, () =>
        svc.editSlot(BOOKING_ID, SLOT_B, makeActor(), CLIENT_REQUEST_ID, {
          start_at: '2026-05-01T11:00:00Z',
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({
      code: 'booking.edit_requires_notification_dispatch',
      status: 422,
    });
    // Critical: no RPC fired. The whole point of the pre-flight is to
    // avoid producing the very event the gate is suppressing.
    expect(supabase.calls.rpc.filter((c) => c.fn === 'edit_booking')).toHaveLength(0);
  });

  it('B.4.A.5 gate: require_approval → require_approval with chain_config_changed rejects 422', async () => {
    const supabase = makeSupabase();
    const visibility = makeVisibility({ canEdit: true });
    const conflict = makeConflictGuard();
    const assemble = makeAssembleEditPlan({
      approvalOverride: {
        old_outcome: 'require_approval',
        new_outcome: 'require_approval',
        chain_config_changed: true,
        new_chain_config: {
          required_approvers: [{ type: 'team', id: 'TX' }],
          threshold: 'any',
        },
      },
    });
    const svc = buildService(supabase, visibility, conflict, assemble);

    let caught: unknown = null;
    try {
      await TenantContext.run(TENANT, () =>
        svc.editSlot(BOOKING_ID, SLOT_B, makeActor(), CLIENT_REQUEST_ID, {
          start_at: '2026-05-01T11:00:00Z',
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({
      code: 'booking.edit_requires_notification_dispatch',
      status: 422,
    });
    expect(supabase.calls.rpc.filter((c) => c.fn === 'edit_booking')).toHaveLength(0);
  });

  it('B.4.A.5 gate: require_approval → require_approval with SAME config (Row 6 preserve) PASSES', async () => {
    // Row 6 (preserve in-flight): no INSERT, no emit. The gate must NOT
    // fire — the edit proceeds normally.
    const supabase = makeSupabase();
    const visibility = makeVisibility({ canEdit: true });
    const conflict = makeConflictGuard();
    const assemble = makeAssembleEditPlan({
      approvalOverride: {
        old_outcome: 'require_approval',
        new_outcome: 'require_approval',
        chain_config_changed: false,
        new_chain_config: null,
      },
    });
    const svc = buildService(supabase, visibility, conflict, assemble);

    await TenantContext.run(TENANT, () =>
      svc.editSlot(BOOKING_ID, SLOT_B, makeActor(), CLIENT_REQUEST_ID, {
        start_at: '2026-05-01T11:00:00Z',
      }),
    );

    expect(supabase.calls.rpc.find((c) => c.fn === 'edit_booking')).toBeDefined();
  });

  it('throws NotFoundException(booking_slot.not_found) when the slot is not in this tenant', async () => {
    const supabase = makeSupabase({ slotPreflight: null });
    const visibility = makeVisibility();
    const conflict = makeConflictGuard();
    const svc = buildService(supabase, visibility, conflict);

    let caught: unknown = null;
    try {
      await TenantContext.run(TENANT, () =>
        svc.editSlot(BOOKING_ID, SLOT_B, makeActor(), CLIENT_REQUEST_ID, {
          start_at: '2026-05-01T11:00:00Z',
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({
      code: 'booking_slot.not_found',
      status: 404,
    });
    // RPC is never called when the pre-flight finds nothing — saves a
    // round-trip and prevents leaking nonexistent ids into the audit.
    expect(supabase.calls.rpc).toHaveLength(0);
  });

  it('maps GiST exclusion (23P01) to ConflictException(booking.slot_conflict)', async () => {
    // B.4 step 2D-D — the GiST exclusion is preserved as the only
    // TS-side special case post-cutover; the new RPC propagates 23P01
    // the same way 00291 did.
    const supabase = makeSupabase({
      rpcResponse: {
        data: null,
        error: { code: '23P01', message: 'booking_slots_no_overlap' },
      },
    });
    const visibility = makeVisibility();
    const conflict = makeConflictGuard();
    const svc = buildService(supabase, visibility, conflict);

    let caught: unknown = null;
    try {
      await TenantContext.run(TENANT, () =>
        svc.editSlot(BOOKING_ID, SLOT_B, makeActor(), CLIENT_REQUEST_ID, {
          start_at: '2026-05-01T11:00:00Z',
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({
      code: 'booking.slot_conflict',
      status: 409,
    });
  });

  it('throws BadRequestException(booking_slot.url_mismatch) when bookingId arg ≠ slot.booking_id', async () => {
    // Slot exists in the tenant but its parent booking is NOT the one in
    // the URL — common shape of a forged-id attack or a stale frontend.
    const supabase = makeSupabase({ slotPreflight: { booking_id: 'B-OTHER' } });
    const visibility = makeVisibility();
    const conflict = makeConflictGuard();
    const svc = buildService(supabase, visibility, conflict);

    let caught: unknown = null;
    try {
      await TenantContext.run(TENANT, () =>
        svc.editSlot(BOOKING_ID, SLOT_B, makeActor(), CLIENT_REQUEST_ID, {
          start_at: '2026-05-01T11:00:00Z',
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({
      code: 'booking_slot.url_mismatch',
      status: 400,
    });
    expect(supabase.calls.rpc).toHaveLength(0);
  });

  // B.4 step 2D-D — cross-tenant space-id validation post-cutover.
  //
  // The TS-layer assertTenantOwned pre-flight catches the cross-tenant
  // case before the RPC fires (preserved from pre-cutover). When the
  // RPC IS reached (race window or admin bypass), the new RPC raises
  // `validate_entity_in_tenant.space_not_in_tenant` (404) — surfaced via
  // mapRpcErrorToAppError. The legacy `booking.slot_space_invalid`
  // (400) raise is RETIRED; the cleaner 404 from the canonical
  // tenant-validate helper replaces it.
  it('maps RPC validate_entity_in_tenant.space_not_in_tenant to 404', async () => {
    const supabase = makeSupabase({
      rpcResponse: {
        data: null,
        error: {
          code: 'P0001',
          message: 'validate_entity_in_tenant.space_not_in_tenant',
        },
      },
    });
    const visibility = makeVisibility();
    const conflict = makeConflictGuard();
    const svc = buildService(supabase, visibility, conflict);

    let caught: unknown = null;
    try {
      await TenantContext.run(TENANT, () =>
        svc.editSlot(BOOKING_ID, SLOT_B, makeActor(), CLIENT_REQUEST_ID, {
          space_id: SPACE_VALID,
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({
      code: 'validate_entity_in_tenant.space_not_in_tenant',
      status: 404,
    });
  });

  it('happy path: valid same-tenant active reservable space_id passes through', async () => {
    const newSpace = SPACE_VALID;
    const supabase = makeSupabase({
      projectionRow: {
        ...makeSlotRow({ id: SLOT_B, space_id: newSpace }),
        bookings: makeBookingRow({ location_id: newSpace }),
      },
    });
    const visibility = makeVisibility({ canEdit: true });
    const conflict = makeConflictGuard();
    const svc = buildService(supabase, visibility, conflict);

    const result = await TenantContext.run(TENANT, () =>
      svc.editSlot(BOOKING_ID, SLOT_B, makeActor(), CLIENT_REQUEST_ID, {
        space_id: newSpace,
      }),
    );

    const rpcCall = supabase.calls.rpc.find((c) => c.fn === 'edit_booking');
    expect(rpcCall).toBeDefined();
    const args = rpcCall!.args as Record<string, unknown>;
    const plan = args.p_plan as EditPlan;
    expect(plan.slot_patches[0]).toMatchObject({
      slot_id: SLOT_B,
      space_id: newSpace,
    });
    expect(result.id).toBe(BOOKING_ID);
    expect(result.space_id).toBe(newSpace);
  });

  it('throws ForbiddenException(booking.edit_forbidden) when canEdit returns false', async () => {
    const supabase = makeSupabase();
    const visibility = makeVisibility({ canEdit: false });
    const conflict = makeConflictGuard();
    const svc = buildService(supabase, visibility, conflict);

    let caught: unknown = null;
    try {
      await TenantContext.run(TENANT, () =>
        svc.editSlot(BOOKING_ID, SLOT_B, makeActor(), CLIENT_REQUEST_ID, {
          start_at: '2026-05-01T11:00:00Z',
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({
      code: 'booking.edit_forbidden',
      status: 403,
    });
    expect(supabase.calls.rpc).toHaveLength(0);
  });
});

// /full-review v3 closure C2 regression — editOne(geometry) MUST go
// through the edit_booking RPC (B.4 step 2D-D), not write the slot row
// directly.
//
// Pre-fix behaviour:
//   editOne would UPDATE booking_slots[primary] SET start_at=X
//   and UPDATE bookings SET start_at=X.
// For multi-slot bookings that's wrong: bookings.start_at MUST be
// MIN(booking_slots.start_at). The RPC enforces that mirror inside the
// same transaction; the C2 fix routes editOne's geometry keys through
// editSlot → edit_booking RPC so the RPC owns the mirror recompute.
//
// Test verifies: a multi-slot booking edited via editOne with a
// start_at causes supabase.rpc('edit_booking', ...) to be called, AND
// no direct booking_slots.update for geometry columns happens, AND no
// direct bookings.update for start_at/end_at happens.
describe('ReservationService.editOne — geometry delegates to RPC (C2)', () => {
  const TENANT = { id: 'T-c2', slug: 't', tier: 'standard' as const };
  const BOOKING_ID = 'B-c2';
  const PRIMARY_SLOT = 'slot-primary-c2';

  function makeActor() {
    return {
      user_id: 'U',
      person_id: 'P',
      is_service_desk: false,
      has_override_rules: false,
      // B.4 step 2D-D — editOne forwards actor.client_request_id into
      // its editSlot delegation; without this the editOne path raises
      // command_operations.unexpected_state.
      client_request_id: CLIENT_REQUEST_ID,
    };
  }

  /** Default plan-builder mock for the C2 describe block — passthrough
   * allow→allow plan that lets the RPC fire. */
  function makeAssembleEditPlanC2() {
    return {
      assembleEditPlan: jest.fn(async (args: {
        bookingId: string;
        tenantId: string;
        slotId: string;
        patch: { kind: 'slot'; space_id?: string; start_at?: string; end_at?: string };
      }) => ({
        booking: {
          location_id: args.patch.space_id ?? 'space-orig',
          start_at: args.patch.start_at ?? '2026-05-01T09:00:00Z',
          end_at: args.patch.end_at ?? '2026-05-01T10:00:00Z',
          cost_amount_snapshot: null,
          policy_snapshot: { matched_rule_ids: [], effects_seen: [] },
          applied_rule_ids: [],
        },
        slot_patches: [
          {
            // Codex 2026-05-12 IMPORTANT — mirror the full shape
            // assemble-edit-plan.service.ts:310-318 emits.
            slot_id: args.slotId,
            space_id: args.patch.space_id ?? 'space-orig',
            start_at: args.patch.start_at ?? '2026-05-01T09:00:00Z',
            end_at: args.patch.end_at ?? '2026-05-01T10:00:00Z',
            setup_buffer_minutes: 0,
            teardown_buffer_minutes: 0,
            attendee_count: null,
            attendee_person_ids: [],
          },
        ],
        asset_reservation_patches: [],
        order_patches: [],
        work_order_sla_patches: [],
        _resolution_at: '2026-05-01T08:00:00Z',
        approval: {
          old_outcome: 'allow' as const,
          new_outcome: 'allow' as const,
          chain_config_changed: false,
          new_chain_config: null,
        },
      })),
    };
  }

  function makeSlotEmbed(overrides: { start_at?: string; end_at?: string; space_id?: string } = {}) {
    return {
      id: PRIMARY_SLOT,
      tenant_id: TENANT.id,
      booking_id: BOOKING_ID,
      slot_type: 'room',
      space_id: overrides.space_id ?? 'space-orig',
      start_at: overrides.start_at ?? '2026-05-01T09:00:00Z',
      end_at: overrides.end_at ?? '2026-05-01T10:00:00Z',
      setup_buffer_minutes: 0,
      teardown_buffer_minutes: 0,
      effective_start_at: overrides.start_at ?? '2026-05-01T09:00:00Z',
      effective_end_at: overrides.end_at ?? '2026-05-01T10:00:00Z',
      attendee_count: 4,
      attendee_person_ids: [],
      status: 'confirmed',
      check_in_required: false,
      check_in_grace_minutes: 15,
      checked_in_at: null,
      released_at: null,
      cancellation_grace_until: null,
      display_order: 0,
      created_at: '2026-05-01T08:00:00Z',
      updated_at: '2026-05-01T08:00:00Z',
      bookings: {
        id: BOOKING_ID,
        tenant_id: TENANT.id,
        title: null,
        description: null,
        requester_person_id: 'P',
        host_person_id: null,
        booked_by_user_id: 'U',
        location_id: overrides.space_id ?? 'space-orig',
        // Critical: this is what distinguishes the C2 fix. Pre-fix,
        // editOne wrote bookings.start_at = patch.start_at literally.
        // Post-fix, the RPC computes MIN over slots; for a multi-slot
        // booking with a slot at T0 (10:00) and another at T1 (08:00),
        // editing the T0 slot forward to T2 (12:00) leaves
        // bookings.start_at = T1 (08:00, MIN), NOT T2.
        // We don't simulate two slots here — we just assert the RPC
        // path is taken. The MIN-over-slots invariant is owned by the
        // RPC (00291 + 00293) and verified at the SQL layer.
        start_at: overrides.start_at ?? '2026-05-01T09:00:00Z',
        end_at: overrides.end_at ?? '2026-05-01T10:00:00Z',
        timezone: 'UTC',
        status: 'confirmed',
        source: 'desk',
        cost_center_id: null,
        cost_amount_snapshot: null,
        policy_snapshot: { matched_rule_ids: [], effects_seen: [] },
        applied_rule_ids: [],
        config_release_id: null,
        calendar_event_id: null,
        calendar_provider: null,
        calendar_etag: null,
        calendar_last_synced_at: null,
        recurrence_series_id: null,
        recurrence_index: null,
        recurrence_overridden: false,
        recurrence_skipped: false,
        template_id: null,
        created_at: '2026-05-01T08:00:00Z',
        updated_at: '2026-05-01T08:00:00Z',
      },
    };
  }

  function makeSupabase(opts?: { rpcResponse?: { data: unknown; error: unknown }; postRpcEmbed?: ReturnType<typeof makeSlotEmbed> }) {
    const calls = {
      rpc: [] as Array<{ fn: string; args: unknown }>,
      bookingSlotsUpdate: [] as Array<unknown>,
      bookingsUpdate: [] as Array<unknown>,
    };
    const initialEmbed = makeSlotEmbed();
    let currentEmbed: ReturnType<typeof makeSlotEmbed> = initialEmbed;
    const rpcResponse = opts?.rpcResponse ?? {
      data: { slot: { id: PRIMARY_SLOT }, booking: null },
      error: null,
    };

    const admin = {
      rpc: (fn: string, args: unknown) => {
        calls.rpc.push({ fn, args });
        // B.4 step 2D-D — RPC name is now `edit_booking`. Same swap-on-
        // success pattern.
        if (fn === 'edit_booking' && opts?.postRpcEmbed) {
          currentEmbed = opts.postRpcEmbed;
        }
        return Promise.resolve(rpcResponse);
      },
      from: (table: string) => {
        if (table === 'booking_slots') {
          let hasOrder = false;
          const chain: any = {
            select: () => chain,
            eq: () => chain,
            order: () => {
              hasOrder = true;
              return chain;
            },
            limit: () => chain,
            // Slot pre-flight in editSlot: .eq().eq().maybeSingle() (no order).
            // Projection reads: .order().order().limit().maybeSingle().
            maybeSingle: () =>
              hasOrder
                ? Promise.resolve({ data: currentEmbed, error: null })
                : Promise.resolve({ data: { booking_id: BOOKING_ID }, error: null }),
            update: (patch: unknown) => {
              calls.bookingSlotsUpdate.push(patch);
              const updateChain: any = {
                eq: () => updateChain,
                then: (resolve: (v: { error: unknown }) => unknown) =>
                  Promise.resolve({ error: null }).then(resolve),
              };
              return updateChain;
            },
          };
          return chain;
        }
        if (table === 'bookings') {
          return {
            update: (patch: unknown) => {
              calls.bookingsUpdate.push(patch);
              const chain: any = {
                eq: () => chain,
                then: (resolve: (v: { error: unknown }) => unknown) =>
                  Promise.resolve({ error: null }).then(resolve),
              };
              return chain;
            },
          };
        }
        if (table === 'audit_events') {
          return { insert: () => Promise.resolve({ data: null, error: null }) };
        }
        if (table === 'visitors') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => Promise.resolve({ data: [], error: null }),
              }),
            }),
          };
        }
        return {};
      },
    };
    return { admin, calls };
  }

  function makeVisibility() {
    return {
      loadContextByUserId: jest.fn(async () => ({
        user_id: 'U', person_id: 'P', tenant_id: TENANT.id,
        has_read_all: false, has_write_all: true, has_admin: false,
      })),
      assertVisible: jest.fn(() => undefined),
      canEdit: jest.fn(() => true),
    };
  }

  function makeConflictGuard() {
    return {
      isExclusionViolation: (err: unknown) => {
        if (!err || typeof err !== 'object') return false;
        return (err as { code?: string }).code === '23P01';
      },
    };
  }

  it('editOne with start_at delegates to edit_booking RPC (no direct slot/booking write of geometry)', async () => {
    const newStart = '2026-05-01T11:00:00Z';
    const supabase = makeSupabase({
      postRpcEmbed: makeSlotEmbed({ start_at: newStart }),
    });
    const visibility = makeVisibility();
    const conflict = makeConflictGuard();
    const assemble = makeAssembleEditPlanC2();
    const svc = new ReservationService(
      supabase as never,
      conflict as never,
      visibility as never,
      undefined, undefined, undefined, undefined,
      assemble as never,
    );

    await TenantContext.run(TENANT, () =>
      svc.editOne(BOOKING_ID, makeActor(), { start_at: newStart }),
    );

    // RPC must have fired through the new edit_booking path with the
    // assembled plan + idempotency key shape from
    // buildEditBookingIdempotencyKey.
    const rpcCalls = supabase.calls.rpc.filter((c) => c.fn === 'edit_booking');
    expect(rpcCalls).toHaveLength(1);
    const args = rpcCalls[0].args as Record<string, unknown>;
    expect(args.p_booking_id).toBe(BOOKING_ID);
    // self-review N-CODE-4 (B.4 step 2D-D) — derive via the helper
    // instead of inlining the format. Couples the test to the public
    // helper API rather than the internal `booking:edit:<bookingId>:<crid>`
    // string shape — if the helper changes prefix or separator, this
    // assertion still passes (and the wider contract tests for the
    // helper itself catch the format change in one place).
    expect(args.p_idempotency_key).toBe(
      buildEditBookingIdempotencyKey(BOOKING_ID, CLIENT_REQUEST_ID),
    );
    const plan = args.p_plan as EditPlan;
    expect(plan.slot_patches[0]).toMatchObject({
      slot_id: PRIMARY_SLOT,
      start_at: newStart,
    });

    // No direct booking_slots.update with geometry keys (those are now
    // owned by the RPC). Slot meta-only updates would be a separate
    // .update() — none expected for this patch shape.
    for (const patch of supabase.calls.bookingSlotsUpdate) {
      const p = patch as Record<string, unknown>;
      expect(p).not.toHaveProperty('start_at');
      expect(p).not.toHaveProperty('end_at');
      expect(p).not.toHaveProperty('space_id');
    }

    // No direct bookings.update writing start_at/end_at/location_id —
    // the RPC's mirror recompute is the only path that touches those.
    for (const patch of supabase.calls.bookingsUpdate) {
      const p = patch as Record<string, unknown>;
      expect(p).not.toHaveProperty('start_at');
      expect(p).not.toHaveProperty('end_at');
      expect(p).not.toHaveProperty('location_id');
    }
  });

  it('editOne with space_id delegates to RPC (multi-slot mirror correctness)', async () => {
    // Plan A.2 / Commit 6: editOne now does a TS-layer pre-flight that
    // requires a real uuid (assertTenantOwned rejects malformed strings
    // with reference.invalid_uuid). Use a real uuid here; the supabase
    // mock returns null for the spaces lookup by default — extend it to
    // return an active+reservable row for the new space so the
    // assertTenantOwned probe passes and we proceed to the RPC.
    const newSpace = '00000000-0000-4000-8000-00000000eeee';
    const supabase = makeSupabase({
      postRpcEmbed: makeSlotEmbed({ space_id: newSpace }),
    });
    // Patch in spaces support — the existing mock doesn't model spaces.
    const baseFrom = supabase.admin.from;
    supabase.admin.from = (table: string) => {
      if (table === 'spaces') {
        const filters: Record<string, unknown> = {};
        const chain: Record<string, unknown> = {
          eq: (col: string, val: unknown) => {
            filters[col] = val;
            return chain;
          },
          maybeSingle: async () => {
            if (
              filters.id === newSpace &&
              filters.tenant_id === TENANT.id &&
              filters.active === true &&
              filters.reservable === true
            ) {
              return { data: { id: newSpace }, error: null };
            }
            return { data: null, error: null };
          },
        };
        return { select: () => chain };
      }
      return baseFrom(table);
    };
    const visibility = makeVisibility();
    const conflict = makeConflictGuard();
    const assemble = makeAssembleEditPlanC2();
    const svc = new ReservationService(
      supabase as never,
      conflict as never,
      visibility as never,
      undefined, undefined, undefined, undefined,
      assemble as never,
    );

    await TenantContext.run(TENANT, () =>
      svc.editOne(BOOKING_ID, makeActor(), { space_id: newSpace }),
    );

    const rpcCalls = supabase.calls.rpc.filter((c) => c.fn === 'edit_booking');
    expect(rpcCalls).toHaveLength(1);
    const plan = (rpcCalls[0].args as Record<string, unknown>).p_plan as EditPlan;
    expect(plan.slot_patches[0]).toMatchObject({
      space_id: newSpace,
    });
  });

  // /full-review v3 closure I2 — preflight all validation before any write.
  //
  // Pre-fix order: geometry (RPC) → slot-meta (UPDATE booking_slots) →
  // booking-meta (UPDATE bookings). A combined patch with a valid
  // geometry key + an invalid meta key would commit the geometry RPC,
  // then fail meta validation downstream. Result: the slot moved but
  // attendee_count never updated — partial state.
  //
  // Post-fix: validation runs FIRST, before any write. -1 attendee_count
  // throws BadRequestException(booking.invalid_attendee_count) before
  // the RPC fires. No slot or booking row is mutated.
  it('I2 — combined patch with invalid attendee_count rejects BEFORE any write (RPC + UPDATEs do not fire)', async () => {
    const supabase = makeSupabase();
    const visibility = makeVisibility();
    const conflict = makeConflictGuard();
    const assemble = makeAssembleEditPlanC2();
    const svc = new ReservationService(
      supabase as never,
      conflict as never,
      visibility as never,
      undefined, undefined, undefined, undefined,
      assemble as never,
    );

    let caught: unknown = null;
    try {
      await TenantContext.run(TENANT, () =>
        svc.editOne(BOOKING_ID, makeActor(), {
          start_at: '2026-05-01T11:00:00Z', // valid, would succeed alone
          attendee_count: -1,                // invalid, sentinel
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({
      code: 'booking.invalid_attendee_count',
      status: 400,
    });

    // Critical: NEITHER geometry NOR meta committed. The pre-fix bug
    // was a half-applied write — geometry through the RPC, meta failed.
    // Assert no edit_booking RPC, no booking_slots UPDATE, no bookings
    // UPDATE.
    expect(supabase.calls.rpc.filter((c) => c.fn === 'edit_booking')).toHaveLength(0);
    expect(supabase.calls.bookingSlotsUpdate).toHaveLength(0);
    expect(supabase.calls.bookingsUpdate).toHaveLength(0);
  });

  it('I2 — invalid window (start_at >= end_at) rejects before any write', async () => {
    const supabase = makeSupabase();
    const visibility = makeVisibility();
    const conflict = makeConflictGuard();
    const assemble = makeAssembleEditPlanC2();
    const svc = new ReservationService(
      supabase as never,
      conflict as never,
      visibility as never,
      undefined, undefined, undefined, undefined,
      assemble as never,
    );

    let caught: unknown = null;
    try {
      await TenantContext.run(TENANT, () =>
        svc.editOne(BOOKING_ID, makeActor(), {
          start_at: '2026-05-01T12:00:00Z',
          end_at:   '2026-05-01T11:00:00Z', // ends before it starts
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({
      code: 'booking.invalid_window',
      status: 400,
    });
    expect(supabase.calls.rpc.filter((c) => c.fn === 'edit_booking')).toHaveLength(0);
    expect(supabase.calls.bookingSlotsUpdate).toHaveLength(0);
    expect(supabase.calls.bookingsUpdate).toHaveLength(0);
  });

  it('editOne with attendee_count only — meta path, no RPC', async () => {
    const supabase = makeSupabase();
    const visibility = makeVisibility();
    const conflict = makeConflictGuard();
    const assemble = makeAssembleEditPlanC2();
    const svc = new ReservationService(
      supabase as never,
      conflict as never,
      visibility as never,
      undefined, undefined, undefined, undefined,
      assemble as never,
    );

    await TenantContext.run(TENANT, () =>
      svc.editOne(BOOKING_ID, makeActor(), { attendee_count: 8 }),
    );

    // No RPC call — meta-only path doesn't touch geometry.
    expect(supabase.calls.rpc.filter((c) => c.fn === 'edit_booking')).toHaveLength(0);
    // The slot meta update DOES happen (legacy path stays).
    expect(supabase.calls.bookingSlotsUpdate.some((p) => {
      const obj = p as Record<string, unknown>;
      return obj.attendee_count === 8;
    })).toBe(true);
  });
});

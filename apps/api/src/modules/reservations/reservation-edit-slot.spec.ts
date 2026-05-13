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
    // B.4 Step 2F.3 — `'slot'` op discriminator (cross-op-collision
    // followup closure). editSlot mints the slot-namespaced key.
    expect(args.p_idempotency_key).toBe(
      buildEditBookingIdempotencyKey(BOOKING_ID, CLIENT_REQUEST_ID, 'slot'),
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

  // B.4.A.5 sub-step H (2026-05-13) lifted the controller-vs-notification
  // gate at editSlot. These tests previously asserted a 422 pre-flight
  // reject; post-H they assert the edit flows through to the RPC. The
  // RPC writes the inbox row + emits booking.approval_required atomically
  // (covered by the concurrency probes in apps/api/test/concurrency/
  // edit_booking.spec.ts Scenarios 27/28/29). At this service layer the
  // single observable behavioural change is that the RPC fires.
  it('B.4.A.5 post-H: allow → require_approval flows through to edit_booking RPC', async () => {
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

    await TenantContext.run(TENANT, () =>
      svc.editSlot(BOOKING_ID, SLOT_B, makeActor(), CLIENT_REQUEST_ID, {
        start_at: '2026-05-01T11:00:00Z',
      }),
    );

    // The edit_booking RPC fires exactly once — gate is lifted; inbox
    // INSERT + approval-row INSERT + outbox emit all happen inside the
    // RPC (covered by edit_booking.spec.ts Scenarios 27/28/29).
    const rpcCalls = supabase.calls.rpc.filter((c) => c.fn === 'edit_booking');
    expect(rpcCalls).toHaveLength(1);
    const args = rpcCalls[0].args as Record<string, unknown>;
    expect(args.p_booking_id).toBe(BOOKING_ID);
    expect(args.p_tenant_id).toBe(TENANT.id);
  });

  it('B.4.A.5 post-H: require_approval → require_approval with chain_config_changed flows through to RPC', async () => {
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

    await TenantContext.run(TENANT, () =>
      svc.editSlot(BOOKING_ID, SLOT_B, makeActor(), CLIENT_REQUEST_ID, {
        start_at: '2026-05-01T11:00:00Z',
      }),
    );

    const rpcCalls = supabase.calls.rpc.filter((c) => c.fn === 'edit_booking');
    expect(rpcCalls).toHaveLength(1);
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

  // Codex IMPORTANT-2 (2026-05-12): editSlot was missing the per-side
  // timestamp preflight entirely. A patch like `{ start_at:
  // 'invalid-date' }` reached the assembler and died in conflict-guard
  // at `new Date(...).toISOString()` with `RangeError: Invalid time
  // value` — a 500 server-class instead of a deterministic 400. Same
  // bug class as editOne; same fix.
  it('IMPORTANT-2: editSlot with start_at: invalid-date (only) rejects 400 booking.invalid_window — no RPC, no assembler', async () => {
    const supabase = makeSupabase();
    const visibility = makeVisibility({ canEdit: true });
    const conflict = makeConflictGuard();
    const assemble = makeAssembleEditPlan();
    const svc = buildService(supabase, visibility, conflict, assemble);

    let caught: unknown = null;
    try {
      await TenantContext.run(TENANT, () =>
        svc.editSlot(BOOKING_ID, SLOT_B, makeActor(), CLIENT_REQUEST_ID, {
          start_at: 'invalid-date',
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
    expect((caught as AppError).detail).toMatch(/start_at/);
    expect(supabase.calls.rpc.filter((c) => c.fn === 'edit_booking')).toHaveLength(0);
    expect(assemble.assembleEditPlan).not.toHaveBeenCalled();
  });

  it('IMPORTANT-2: editSlot with end_at: invalid-date (only) rejects 400 booking.invalid_window — no RPC, no assembler', async () => {
    const supabase = makeSupabase();
    const visibility = makeVisibility({ canEdit: true });
    const conflict = makeConflictGuard();
    const assemble = makeAssembleEditPlan();
    const svc = buildService(supabase, visibility, conflict, assemble);

    let caught: unknown = null;
    try {
      await TenantContext.run(TENANT, () =>
        svc.editSlot(BOOKING_ID, SLOT_B, makeActor(), CLIENT_REQUEST_ID, {
          end_at: 'invalid-date',
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
    expect((caught as AppError).detail).toMatch(/end_at/);
    expect(supabase.calls.rpc.filter((c) => c.fn === 'edit_booking')).toHaveLength(0);
    expect(assemble.assembleEditPlan).not.toHaveBeenCalled();
  });
});

// /full-review v3 closure C2 regression — editOne(geometry) MUST go
// through the edit_booking RPC, not write the slot row directly.
//
// Pre-fix behaviour:
//   editOne would UPDATE booking_slots[primary] SET start_at=X
//   and UPDATE bookings SET start_at=X.
// For multi-slot bookings that's wrong: bookings.start_at MUST be
// MIN(booking_slots.start_at). The RPC enforces that mirror inside the
// same transaction; the C2 fix routes geometry keys through the RPC.
//
// B.4 step 2E — editOne is now a producer route in its own right.
// Every patch (geometry OR meta OR booking-level host) flows through
// `assembleEditPlan({ kind: 'one' })` → `edit_booking` RPC. The legacy
// meta-only fast path (direct booking_slots / bookings UPDATEs) is
// retired. editOne takes `clientRequestId` as a positional argument
// (controller forwards from `req.clientRequestId` post-cutover).
describe('ReservationService.editOne — patch flows through edit_booking RPC (C2 + 2E)', () => {
  const TENANT = { id: 'T-c2', slug: 't', tier: 'standard' as const };
  const BOOKING_ID = 'B-c2';
  const PRIMARY_SLOT = 'slot-primary-c2';

  function makeActor() {
    return {
      user_id: 'U',
      person_id: 'P',
      is_service_desk: false,
      has_override_rules: false,
      // Pre-2E, editOne pulled crid from `actor.client_request_id`.
      // Post-2E it's a positional arg (`CLIENT_REQUEST_ID` constant
      // passed at every call site below). Leaving the field on the
      // actor stays harmless — the editOne service code no longer
      // reads it.
      client_request_id: CLIENT_REQUEST_ID,
    };
  }

  /** Default plan-builder mock for the C2 describe block — passthrough
   * allow→allow plan that lets the RPC fire. Accepts kind='one' patches
   * (the post-2E cutover shape).
   *
   * The mock mirrors the full shape AssembleEditPlanService emits at
   * assemble-edit-plan.service.ts:406-414 (slot patch) +
   * :387-414 (booking patch with host_person_id / recurrence_overridden
   * conditionally present). */
  function makeAssembleEditPlanC2() {
    return {
      assembleEditPlan: jest.fn(async (args: {
        bookingId: string;
        tenantId: string;
        slotId: string;
        patch: {
          kind: 'one';
          space_id?: string;
          start_at?: string;
          end_at?: string;
          attendee_count?: number | null;
          attendee_person_ids?: string[];
          host_person_id?: string | null;
        };
      }) => {
        const booking: Record<string, unknown> = {
          location_id: args.patch.space_id ?? 'space-orig',
          start_at: args.patch.start_at ?? '2026-05-01T09:00:00Z',
          end_at: args.patch.end_at ?? '2026-05-01T10:00:00Z',
          cost_amount_snapshot: null,
          policy_snapshot: { matched_rule_ids: [], effects_seen: [] },
          applied_rule_ids: [],
        };
        if (args.patch.host_person_id !== undefined) {
          booking.host_person_id = args.patch.host_person_id;
        }
        // Codex NIT-2b (2026-05-12): mirror the real assembler's
        // recurrence_overridden auto-set for kind='one' so tests can
        // assert the flag landed on the RPC plan. The real assembler
        // (assemble-edit-plan.service.ts:500-516) flips this when
        //   (i) auto_set_recurrence_overridden=true (always for 'one'),
        //   (ii) booking.recurrence_series_id is not null,
        //   (iii) any patched field would change state (geometry value-
        //        compare OR any meta key defined).
        // The mock can't see the booking row, so we approximate (iii)
        // via "any patch key present at all" — same predicate the
        // service-level no-op already filtered against, so by the time
        // the mock runs, at least one of these is by construction true.
        if (args.patch.kind === 'one') {
          const hasAnyPatchKey =
            args.patch.space_id !== undefined ||
            args.patch.start_at !== undefined ||
            args.patch.end_at !== undefined ||
            args.patch.attendee_count !== undefined ||
            args.patch.attendee_person_ids !== undefined ||
            args.patch.host_person_id !== undefined;
          if (hasAnyPatchKey) {
            booking.recurrence_overridden = true;
          }
        }
        return {
          booking,
          slot_patches: [
            {
              slot_id: args.slotId,
              space_id: args.patch.space_id ?? 'space-orig',
              start_at: args.patch.start_at ?? '2026-05-01T09:00:00Z',
              end_at: args.patch.end_at ?? '2026-05-01T10:00:00Z',
              setup_buffer_minutes: 0,
              teardown_buffer_minutes: 0,
              attendee_count: args.patch.attendee_count ?? null,
              attendee_person_ids: args.patch.attendee_person_ids ?? [],
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
        };
      }),
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
      svc.editOne(BOOKING_ID, makeActor(), { start_at: newStart }, CLIENT_REQUEST_ID),
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
    // string shape.
    // B.4 Step 2F.3 — `'one'` op discriminator (cross-op-collision
    // followup closure). editOne mints the one-namespaced key.
    expect(args.p_idempotency_key).toBe(
      buildEditBookingIdempotencyKey(BOOKING_ID, CLIENT_REQUEST_ID, 'one'),
    );
    const plan = args.p_plan as EditPlan;
    expect(plan.slot_patches[0]).toMatchObject({
      slot_id: PRIMARY_SLOT,
      start_at: newStart,
    });

    // Post-2E: NO direct booking_slots UPDATE at all (legacy meta path
    // retired). Geometry + meta + booking-level fields all flow through
    // the RPC.
    expect(supabase.calls.bookingSlotsUpdate).toHaveLength(0);
    expect(supabase.calls.bookingsUpdate).toHaveLength(0);
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
      svc.editOne(BOOKING_ID, makeActor(), { space_id: newSpace }, CLIENT_REQUEST_ID),
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
        svc.editOne(
          BOOKING_ID,
          makeActor(),
          {
            start_at: '2026-05-01T11:00:00Z', // valid, would succeed alone
            attendee_count: -1,                // invalid, sentinel
          },
          CLIENT_REQUEST_ID,
        ),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({
      code: 'booking.invalid_attendee_count',
      status: 400,
    });

    // Critical: preflight rejected BEFORE any write. The RPC + the
    // legacy direct UPDATEs (retired post-2E, but mock still tracks
    // them) all must show zero traffic.
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
        svc.editOne(
          BOOKING_ID,
          makeActor(),
          {
            start_at: '2026-05-01T12:00:00Z',
            end_at:   '2026-05-01T11:00:00Z', // ends before it starts
          },
          CLIENT_REQUEST_ID,
        ),
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

  // Codex IMPORTANT-2 (2026-05-12): single-side invalid timestamp must
  // surface 400 booking.invalid_window, not a 500 RangeError from
  // conflict-guard's `new Date(...).toISOString()`. Pre-fix the
  // preflight only checked the pair `start_at && end_at`; a single-
  // side invalid value slipped through.
  it('IMPORTANT-2: editOne with start_at: invalid-date (only) rejects 400 booking.invalid_window — no RPC, no assembler', async () => {
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
        svc.editOne(
          BOOKING_ID,
          makeActor(),
          { start_at: 'invalid-date' },
          CLIENT_REQUEST_ID,
        ),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({
      code: 'booking.invalid_window',
      status: 400,
    });
    expect((caught as AppError).detail).toMatch(/start_at/);
    expect(supabase.calls.rpc.filter((c) => c.fn === 'edit_booking')).toHaveLength(0);
    expect(assemble.assembleEditPlan).not.toHaveBeenCalled();
  });

  it('IMPORTANT-2: editOne with end_at: invalid-date (only) rejects 400 booking.invalid_window — no RPC, no assembler', async () => {
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
        svc.editOne(
          BOOKING_ID,
          makeActor(),
          { end_at: 'invalid-date' },
          CLIENT_REQUEST_ID,
        ),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({
      code: 'booking.invalid_window',
      status: 400,
    });
    expect((caught as AppError).detail).toMatch(/end_at/);
    expect(supabase.calls.rpc.filter((c) => c.fn === 'edit_booking')).toHaveLength(0);
    expect(assemble.assembleEditPlan).not.toHaveBeenCalled();
  });

  // Codex IMPORTANT-1 (2026-05-12): `space_id: null` and `space_id: ''`
  // are explicit rejections, not silent no-ops. The pre-cutover legacy
  // editOne treated them as no-ops via a truthy check; post-cutover the
  // no-op predicate would treat them as real edits and fail downstream
  // with an unclear `reference.invalid_uuid` (`''`) or null propagation.
  // Reject with a dedicated code so the UX message is actionable.
  it('IMPORTANT-1: editOne with space_id: null rejects 400 booking.invalid_space_id — no RPC, no no-op short-circuit', async () => {
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
        svc.editOne(
          BOOKING_ID,
          makeActor(),
          // `as unknown` cast: the editOne DTO doesn't allow null on
          // space_id, but JS clients may still send it. The preflight
          // defends at runtime.
          { space_id: null } as unknown as { space_id?: string },
          CLIENT_REQUEST_ID,
        ),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({
      code: 'booking.invalid_space_id',
      status: 400,
    });
    expect(supabase.calls.rpc.filter((c) => c.fn === 'edit_booking')).toHaveLength(0);
    expect(assemble.assembleEditPlan).not.toHaveBeenCalled();
  });

  it("IMPORTANT-1: editOne with space_id: '' rejects 400 booking.invalid_space_id — no RPC, no assembler", async () => {
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
        svc.editOne(
          BOOKING_ID,
          makeActor(),
          { space_id: '' },
          CLIENT_REQUEST_ID,
        ),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({
      code: 'booking.invalid_space_id',
      status: 400,
    });
    expect(supabase.calls.rpc.filter((c) => c.fn === 'edit_booking')).toHaveLength(0);
    expect(assemble.assembleEditPlan).not.toHaveBeenCalled();
  });

  // B.4 step 2E — replaces the pre-cutover "meta path, no RPC" test.
  // Post-cutover ALL editOne patches flow through the unified RPC
  // including meta-only edits (attendee_count, host_person_id).
  it('editOne with attendee_count only — flows through edit_booking RPC (no legacy direct UPDATE)', async () => {
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
      svc.editOne(BOOKING_ID, makeActor(), { attendee_count: 8 }, CLIENT_REQUEST_ID),
    );

    // RPC fires through the unified path with the attendee_count
    // carried on slot_patches[0] (the assembleEditPlan({kind:'one'})
    // mock above echoes it back).
    const rpcCalls = supabase.calls.rpc.filter((c) => c.fn === 'edit_booking');
    expect(rpcCalls).toHaveLength(1);
    const plan = (rpcCalls[0].args as Record<string, unknown>).p_plan as EditPlan;
    expect(plan.slot_patches[0]).toMatchObject({ attendee_count: 8 });
    // Legacy direct UPDATE path is retired — no booking_slots/bookings
    // UPDATE outside the RPC.
    expect(supabase.calls.bookingSlotsUpdate).toHaveLength(0);
    expect(supabase.calls.bookingsUpdate).toHaveLength(0);
  });

  // B.4 step 2E — host_person_id is the canonical booking-level field
  // editOne supports. Post-cutover it lands on booking_patch.host_person_id
  // inside the plan, not a direct bookings UPDATE.
  it('editOne with host_person_id flows through edit_booking RPC (booking_patch.host_person_id present)', async () => {
    const newHost = '00000000-0000-4000-8000-000000000777';
    const supabase = makeSupabase();
    // assertTenantOwned probes spaces; for host_person_id it probes
    // persons. Stub a positive match.
    const baseFrom = supabase.admin.from;
    supabase.admin.from = (table: string) => {
      if (table === 'persons') {
        const filters: Record<string, unknown> = {};
        const chain: Record<string, unknown> = {
          eq: (col: string, val: unknown) => {
            filters[col] = val;
            return chain;
          },
          maybeSingle: async () => {
            if (filters.id === newHost && filters.tenant_id === TENANT.id) {
              return { data: { id: newHost }, error: null };
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
      svc.editOne(BOOKING_ID, makeActor(), { host_person_id: newHost }, CLIENT_REQUEST_ID),
    );

    const rpcCalls = supabase.calls.rpc.filter((c) => c.fn === 'edit_booking');
    expect(rpcCalls).toHaveLength(1);
    const plan = (rpcCalls[0].args as Record<string, unknown>).p_plan as EditPlan;
    // host_person_id surfaces on booking_patch (the RPC applies via
    // case-when at 00364:763-767).
    expect(plan.booking).toMatchObject({ host_person_id: newHost });
    // No legacy direct bookings UPDATE.
    expect(supabase.calls.bookingsUpdate).toHaveLength(0);
  });

  // B.4.A.5 sub-step H (2026-05-13) lifted the editOne controller-vs-
  // notification gate. Was: assert 422 + no RPC call. Now: the plan
  // flows through to the RPC; chain rows + inbox rows + outbox emit
  // happen atomically inside 00393 (covered by edit_booking.spec.ts
  // Scenarios 27/28/29). Symmetric with the editSlot post-H invariant
  // earlier in this file.
  it('B.4.A.5 post-H: editOne with approval-flipping plan flows through to edit_booking RPC', async () => {
    const supabase = makeSupabase();
    const visibility = makeVisibility();
    const conflict = makeConflictGuard();
    // Plan-builder mock returns an approval block that would have
    // tripped the pre-H gate (new=require_approval AND old≠require_approval).
    // Post-H: the RPC fires.
    const assemble = {
      assembleEditPlan: jest.fn(async () => ({
        booking: {
          location_id: 'space-orig',
          start_at: '2026-05-01T09:00:00Z',
          end_at: '2026-05-01T10:00:00Z',
          cost_amount_snapshot: null,
          policy_snapshot: { matched_rule_ids: [], effects_seen: [] },
          applied_rule_ids: [],
        },
        slot_patches: [
          {
            slot_id: PRIMARY_SLOT,
            space_id: 'space-orig',
            start_at: '2026-05-01T09:00:00Z',
            end_at: '2026-05-01T10:00:00Z',
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
          new_outcome: 'require_approval' as const,
          chain_config_changed: false,
          new_chain_config: {
            required_approvers: [{ type: 'person' as const, id: 'P1' }],
            threshold: 'all' as const,
          },
        },
      })),
    };
    const svc = new ReservationService(
      supabase as never,
      conflict as never,
      visibility as never,
      undefined, undefined, undefined, undefined,
      assemble as never,
    );

    await TenantContext.run(TENANT, () =>
      svc.editOne(
        BOOKING_ID,
        makeActor(),
        { start_at: '2026-05-01T11:00:00Z' },
        CLIENT_REQUEST_ID,
      ),
    );

    // RPC fires exactly once — chain rows + inbox rows + outbox emit
    // committed atomically inside 00393.
    const rpcCalls = supabase.calls.rpc.filter((c) => c.fn === 'edit_booking');
    expect(rpcCalls).toHaveLength(1);
    expect((rpcCalls[0].args as Record<string, unknown>).p_booking_id).toBe(BOOKING_ID);
  });

  // B.4 step 2E — no-op patch (no keys, or all keys undefined) is
  // returned without touching the RPC.
  it('editOne with empty patch is a no-op (no RPC, no UPDATE)', async () => {
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
      svc.editOne(BOOKING_ID, makeActor(), {}, CLIENT_REQUEST_ID),
    );

    expect(supabase.calls.rpc.filter((c) => c.fn === 'edit_booking')).toHaveLength(0);
    // Plan-builder also wasn't called.
    expect(assemble.assembleEditPlan).not.toHaveBeenCalled();
  });

  // Self-review C-1 (2026-05-12) — asymmetric value/key parity at the
  // editOne entry-point no-op (reservation.service.ts:846-880). Geometry
  // value-compares against `r` (the primary-slot projection from
  // findByIdOrThrow); meta key-compares (any defined key counts as an
  // edit). These two tests pin the rule at the service layer; the
  // assembler-side parity for recurrence_overridden lives in
  // __tests__/assemble-edit-plan.service.spec.ts under the same C-1
  // banner.
  it('C-1: editOne with same-value start_at + no other fields short-circuits (no RPC, no assembler call)', async () => {
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

    // makeSlotEmbed().start_at === '2026-05-01T09:00:00Z' — the current
    // primary slot's value. The "frontend operator opens the form and
    // saves with no changes" patch shape. Pre-C-1 (Step 2E v1) this
    // slipped past the key-only no-op check, fired the RPC, and would
    // detach a series booking via recurrence_overridden=true.
    await TenantContext.run(TENANT, () =>
      svc.editOne(
        BOOKING_ID,
        makeActor(),
        { start_at: '2026-05-01T09:00:00Z' },
        CLIENT_REQUEST_ID,
      ),
    );

    expect(supabase.calls.rpc.filter((c) => c.fn === 'edit_booking')).toHaveLength(0);
    expect(assemble.assembleEditPlan).not.toHaveBeenCalled();
  });

  it('C-1: editOne with same-value start_at + a new attendee_count DOES call the RPC (meta path is key-compare)', async () => {
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

    // start_at matches current → hasGeometryChange=false. But
    // attendee_count is a defined meta key → hasMetaKey=true. Combined
    // predicate `!hasGeometryChange && !hasMetaKey` is false → the
    // no-op short-circuit does NOT fire; the RPC runs. This pins the
    // asymmetric parity: meta KEY-compare even when paired with same-
    // value geometry.
    await TenantContext.run(TENANT, () =>
      svc.editOne(
        BOOKING_ID,
        makeActor(),
        {
          start_at: '2026-05-01T09:00:00Z', // same-value geometry
          attendee_count: 8,                // new meta value
        },
        CLIENT_REQUEST_ID,
      ),
    );

    const rpcCalls = supabase.calls.rpc.filter((c) => c.fn === 'edit_booking');
    expect(rpcCalls).toHaveLength(1);
    expect(assemble.assembleEditPlan).toHaveBeenCalledTimes(1);

    // Codex NIT-2b (2026-05-12): close the service-level gap on the
    // asymmetric meta-key parity. The flip is unit-tested in
    // __tests__/assemble-edit-plan.service.spec.ts under "C-1: a
    // meta-key present (attendee_count) on a series booking AUTO-SETS
    // recurrence_overridden"; this asserts the booking-patch surfaces
    // the flag on the RPC plan once the assembler has emitted it. The
    // mock's auto-set predicate (above in makeAssembleEditPlanC2)
    // mirrors the real assembler's behaviour for kind='one' patches.
    const planArg = rpcCalls[0].args as Record<string, unknown>;
    const plan = planArg.p_plan as EditPlan;
    expect(plan.booking).toMatchObject({ recurrence_overridden: true });
  });

  // Self-review I-1 (2026-05-12) — host_person_id null clears the booking
  // host. The DTO widened to `string | null` at dto/dtos.ts:53-67; the
  // editOne signature mirrors. The assembler emits a literal null on
  // booking_patch which the RPC's `nullif(...,'')::uuid` at 00364:765
  // converts to SQL NULL.
  it('I-1: editOne with host_person_id=null calls the RPC and propagates null on booking_patch', async () => {
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
      svc.editOne(
        BOOKING_ID,
        makeActor(),
        { host_person_id: null },
        CLIENT_REQUEST_ID,
      ),
    );

    const rpcCalls = supabase.calls.rpc.filter((c) => c.fn === 'edit_booking');
    expect(rpcCalls).toHaveLength(1);
    const plan = (rpcCalls[0].args as Record<string, unknown>).p_plan as EditPlan;
    expect('host_person_id' in plan.booking).toBe(true);
    expect(plan.booking.host_person_id).toBeNull();
    // No assertTenantOwned call should have been issued — null means
    // "clear", there's no person id to validate. (We don't have a
    // persons mock here, so the supabase mock would surface as null →
    // reference.not_in_tenant if the preflight ran. The fact that the
    // RPC fired through proves the preflight was skipped.)
  });
});

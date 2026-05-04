import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ReservationService } from './reservation.service';
import { TenantContext } from '../../common/tenant-context';
import type { ActorContext } from './dto/types';

// Phase 1.4 — Bug #2 (slot-first scheduler).
//
// Spec for ReservationService.editSlot — the slot-targeted edit path that
// replaces the booking-id PATCH /reservations/:id when geometry is being
// edited. The four scenarios mirror the contract in
// docs/superpowers/plans/2026-05-04-architecture-phase-1-correctness-bugs.md
// "Phase 1.4 — Tests (TDD)":
//
//   1. Happy path: edit slot B (non-primary) of a multi-room booking. Asserts
//      RPC called with correct args (slot id, patch); returns the projected
//      Reservation reflecting the new slot times.
//   2. Slot not found → NotFoundException with code booking_slot.not_found.
//   3. GiST conflict (SQLSTATE 23P01) → ConflictException with code
//      booking.slot_conflict.
//   4. URL mismatch — bookingId in URL ≠ slot.booking_id from DB →
//      BadRequestException with code booking_slot.url_mismatch. The service
//      enforces this so the controller doesn't have to load the slot twice.

describe('ReservationService.editSlot', () => {
  const TENANT = { id: 'T', slug: 't', tier: 'standard' as const };
  const BOOKING_ID = 'B-1';
  const SLOT_PRIMARY = 'slot-primary';
  const SLOT_B = 'slot-b';

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
      space_id: 'space-original',
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
      location_id: 'space-original',
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
   *   3. supabase.rpc('edit_booking_slot', {...}) — the atomic write.
   *
   * Visibility / user lookup go through ReservationVisibilityService which
   * we mock separately.
   */
  function makeSupabase(opts?: {
    slotPreflight?: { booking_id: string } | null;
    rpcResponse?: { data: unknown; error: unknown };
    projectionRow?: ReturnType<typeof makeSlotRow> & { bookings: ReturnType<typeof makeBookingRow> };
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

    const admin = {
      rpc: (fn: string, args: unknown) => {
        calls.rpc.push({ fn, args });
        return Promise.resolve(rpcResponse);
      },
      from: (table: string) => {
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

  function buildService(supabase: ReturnType<typeof makeSupabase>, visibility: ReturnType<typeof makeVisibility>, conflict: ReturnType<typeof makeConflictGuard>) {
    return new ReservationService(
      supabase as never,
      conflict as never,
      visibility as never,
    );
  }

  it('happy path: edits non-primary slot via RPC and returns the projected Reservation', async () => {
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
      svc.editSlot(BOOKING_ID, SLOT_B, makeActor(), {
        start_at: updatedStart,
        end_at: updatedEnd,
      }),
    );

    // RPC was called with the exact contract: slot id + patch + tenant.
    const rpcCall = supabase.calls.rpc.find((c) => c.fn === 'edit_booking_slot');
    expect(rpcCall).toBeDefined();
    expect(rpcCall!.args).toMatchObject({
      p_slot_id: SLOT_B,
      p_patch: { start_at: updatedStart, end_at: updatedEnd },
      p_tenant_id: TENANT.id,
    });

    // Returned Reservation reflects the slot's new geometry. The
    // projection helper sets `id` = booking id and `slot_id` = slot id.
    expect(result.id).toBe(BOOKING_ID);
    expect(result.slot_id).toBe(SLOT_B);
    expect(result.start_at).toBe(updatedStart);
    expect(result.end_at).toBe(updatedEnd);
  });

  it('throws NotFoundException(booking_slot.not_found) when the slot is not in this tenant', async () => {
    const supabase = makeSupabase({ slotPreflight: null });
    const visibility = makeVisibility();
    const conflict = makeConflictGuard();
    const svc = buildService(supabase, visibility, conflict);

    let caught: unknown = null;
    try {
      await TenantContext.run(TENANT, () =>
        svc.editSlot(BOOKING_ID, SLOT_B, makeActor(), {
          start_at: '2026-05-01T11:00:00Z',
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NotFoundException);
    expect((caught as NotFoundException).getResponse()).toMatchObject({
      code: 'booking_slot.not_found',
    });
    // RPC is never called when the pre-flight finds nothing — saves a
    // round-trip and prevents leaking nonexistent ids into the audit.
    expect(supabase.calls.rpc).toHaveLength(0);
  });

  it('maps GiST exclusion (23P01) to ConflictException(booking.slot_conflict)', async () => {
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
        svc.editSlot(BOOKING_ID, SLOT_B, makeActor(), {
          start_at: '2026-05-01T11:00:00Z',
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConflictException);
    expect((caught as ConflictException).getResponse()).toMatchObject({
      code: 'booking.slot_conflict',
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
        svc.editSlot(BOOKING_ID, SLOT_B, makeActor(), {
          start_at: '2026-05-01T11:00:00Z',
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as BadRequestException).getResponse()).toMatchObject({
      code: 'booking_slot.url_mismatch',
    });
    expect(supabase.calls.rpc).toHaveLength(0);
  });

  it('throws ForbiddenException(booking.edit_forbidden) when canEdit returns false', async () => {
    const supabase = makeSupabase();
    const visibility = makeVisibility({ canEdit: false });
    const conflict = makeConflictGuard();
    const svc = buildService(supabase, visibility, conflict);

    let caught: unknown = null;
    try {
      await TenantContext.run(TENANT, () =>
        svc.editSlot(BOOKING_ID, SLOT_B, makeActor(), {
          start_at: '2026-05-01T11:00:00Z',
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ForbiddenException);
    expect((caught as ForbiddenException).getResponse()).toMatchObject({
      code: 'booking.edit_forbidden',
    });
    expect(supabase.calls.rpc).toHaveLength(0);
  });
});

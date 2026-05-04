import { BadRequestException, ConflictException } from '@nestjs/common';
import { MultiRoomBookingService } from './multi-room-booking.service';
import { InProcessBookingTransactionBoundary } from './booking-transaction-boundary';
import { TenantContext } from '../../common/tenant-context';
import type { ActorContext } from './dto/types';

// Booking-canonicalisation rewrite (2026-05-02):
//   - `multi_room_groups` table is GONE (00276_drop_legacy_booking_tables).
//   - `reservations` / `booking_bundles` replaced by `bookings` + `booking_slots`
//     (00277_create_canonical_booking_schema, 00278_retarget_sibling_tables).
//   - The service is now a thin wrapper around the atomic `create_booking`
//     RPC: ONE booking with N booking_slots. No fan-out, no per-room loop
//     of inserts, no rollback choreography (atomicity is a DB property —
//     the GiST exclusion fires inside the RPC transaction).
//
// The spec exercises the service as a pure orchestrator over its 4 collabs:
//   supabase.admin.rpc('create_booking', …)        — atomic write path
//   supabase.admin.from('booking_slots').select…   — read-back for response
//   supabase.admin.from('audit_events').insert…    — best-effort audit
//   conflict.snapshotBuffersForBooking             — per-room buffers
//   conflict.isExclusionViolation                  — race detection
//   ruleResolver.resolve                           — per-room rules
//   bundle.attachServicesToBooking                 — service lines (optional)
//   bundleCascade.cancelOrdersForReservation       — rollback for service attach

describe('MultiRoomBookingService.createGroup', () => {
  const TENANT = { id: 'T', slug: 't', tier: 'standard' as const };
  const BOOKING_ID = 'B-1';

  type RpcResponse = { data: unknown; error: unknown };

  function makeSupabase(opts?: {
    spaces?: Array<{
      id: string;
      type?: string;
      reservable?: boolean;
      active?: boolean;
      setup_buffer_minutes?: number | null;
      teardown_buffer_minutes?: number | null;
      check_in_required?: boolean | null;
      check_in_grace_minutes?: number | null;
    }>;
    rpcResponse?: RpcResponse;
    slotsRead?: { data: unknown; error: unknown };
  }) {
    const spaces = opts?.spaces ?? [];
    const rpcResponse: RpcResponse =
      opts?.rpcResponse ?? {
        data: { booking_id: BOOKING_ID, slot_ids: spaces.map((_, i) => `S-${i}`) },
        error: null,
      };

    const calls = {
      rpc: [] as Array<{ fn: string; args: unknown }>,
      auditInserts: [] as unknown[],
      slotReads: [] as Array<{ filters: Array<[string, unknown]> }>,
    };

    const admin = {
      rpc: (fn: string, args: unknown) => {
        calls.rpc.push({ fn, args });
        return Promise.resolve(rpcResponse);
      },
      from: (table: string) => {
        if (table === 'spaces') {
          // .select(...).eq('tenant_id', T).in('id', spaceIds)
          return {
            select: () => ({
              eq: () => ({
                in: () =>
                  Promise.resolve({
                    data: spaces.map((s) => ({
                      id: s.id,
                      type: s.type ?? 'room',
                      reservable: s.reservable ?? true,
                      active: s.active ?? true,
                      setup_buffer_minutes: s.setup_buffer_minutes ?? 0,
                      teardown_buffer_minutes: s.teardown_buffer_minutes ?? 0,
                      check_in_required: s.check_in_required ?? false,
                      check_in_grace_minutes: s.check_in_grace_minutes ?? 15,
                    })),
                    error: null,
                  }),
              }),
            }),
          };
        }
        if (table === 'booking_slots') {
          // Read-back chain: .select(SLOT_WITH_BOOKING_SELECT).eq('tenant_id',
          // T).eq('booking_id', BOOKING_ID).order('display_order', {…})
          const filters: Array<[string, unknown]> = [];
          const built = opts?.slotsRead ?? {
            data: spaces.map((s, i) => ({
              id: `slot-${i}`,
              tenant_id: TENANT.id,
              booking_id: BOOKING_ID,
              slot_type: 'room',
              space_id: s.id,
              start_at: '2026-05-01T09:00:00Z',
              end_at: '2026-05-01T10:00:00Z',
              setup_buffer_minutes: 0,
              teardown_buffer_minutes: 0,
              effective_start_at: '2026-05-01T09:00:00Z',
              effective_end_at: '2026-05-01T10:00:00Z',
              attendee_count: 4,
              attendee_person_ids: [],
              status: 'confirmed',
              check_in_required: false,
              check_in_grace_minutes: 15,
              checked_in_at: null,
              released_at: null,
              cancellation_grace_until: null,
              display_order: i,
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
                location_id: spaces[0]?.id ?? 'S1',
                start_at: '2026-05-01T09:00:00Z',
                end_at: '2026-05-01T10:00:00Z',
                timezone: 'UTC',
                status: 'confirmed',
                source: 'portal',
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
            })),
            error: null,
          };
          calls.slotReads.push({ filters });
          const chain: any = {
            select: () => chain,
            eq: (col: string, val: unknown) => {
              filters.push([col, val]);
              return chain;
            },
            order: () => Promise.resolve(built),
          };
          return chain;
        }
        if (table === 'audit_events') {
          return {
            insert: (row: unknown) => {
              calls.auditInserts.push(row);
              return Promise.resolve({ data: null, error: null });
            },
          };
        }
        return {};
      },
    };
    return { admin, calls };
  }

  function makeConflictGuard() {
    return {
      snapshotBuffersForBooking: jest.fn(async () => ({
        setup_buffer_minutes: 0,
        teardown_buffer_minutes: 0,
      })),
      isExclusionViolation: jest.fn((err: unknown) => {
        if (!err || typeof err !== 'object') return false;
        return (err as { code?: string }).code === '23P01';
      }),
    };
  }

  function makeRuleResolver(opts?: { final?: 'allow' | 'deny' | 'require_approval' }) {
    const final = opts?.final ?? 'allow';
    return {
      resolve: jest.fn(async () => ({
        effects: [],
        matchedRules: [],
        warnings: [],
        denialMessages: final === 'deny' ? ['Denied by rule'] : [],
        overridable: false,
        approvalConfig: null,
        final,
      })),
    };
  }

  function makeBundle() {
    return {
      attachServicesToBooking: jest.fn(async () => ({ bundle_id: BOOKING_ID, lines: [] })),
    };
  }

  function makeBundleCascade() {
    return { cancelOrdersForReservation: jest.fn(async () => undefined) };
  }

  function makeActor(overrides: Partial<ActorContext> = {}): ActorContext {
    return {
      user_id: 'U',
      person_id: 'P',
      is_service_desk: false,
      has_override_rules: false,
      ...overrides,
    };
  }

  it('creates one booking with N slots via the create_booking RPC', async () => {
    const supabase = makeSupabase({
      spaces: [{ id: 'S1' }, { id: 'S2' }, { id: 'S3' }],
    });
    const conflict = makeConflictGuard();
    const ruleResolver = makeRuleResolver();
    const bundle = makeBundle();
    const svc = new MultiRoomBookingService(
      supabase as never,
      conflict as never,
      ruleResolver as never,
      bundle as never,
    );

    const result = await TenantContext.run(TENANT, () =>
      svc.createGroup(
        {
          space_ids: ['S1', 'S2', 'S3'],
          requester_person_id: 'P',
          start_at: '2026-05-01T09:00:00Z',
          end_at: '2026-05-01T10:00:00Z',
          attendee_count: 4,
        },
        makeActor(),
      ),
    );

    // group_id is now the BOOKING id (the canonical grouping), not a
    // multi_room_groups row id.
    expect(result.group_id).toBe(BOOKING_ID);
    expect(result.reservations).toHaveLength(3);

    const rpcCall = supabase.calls.rpc.find((c) => c.fn === 'create_booking');
    expect(rpcCall).toBeDefined();
    const args = rpcCall!.args as { p_slots: unknown[]; p_status: string; p_location_id: string };
    expect(args.p_slots).toHaveLength(3);
    expect(args.p_status).toBe('confirmed');
    expect(args.p_location_id).toBe('S1');                  // primary slot anchor
    expect(ruleResolver.resolve).toHaveBeenCalledTimes(3);  // per-room
    expect(conflict.snapshotBuffersForBooking).toHaveBeenCalledTimes(3);
    expect(bundle.attachServicesToBooking).not.toHaveBeenCalled();
    // Audit best-effort write
    expect(supabase.calls.auditInserts).toHaveLength(1);
  });

  it('rejects single-room input', async () => {
    const supabase = makeSupabase({ spaces: [{ id: 'S1' }] });
    const svc = new MultiRoomBookingService(
      supabase as never,
      makeConflictGuard() as never,
      makeRuleResolver() as never,
      makeBundle() as never,
    );
    await expect(
      TenantContext.run(TENANT, () =>
        svc.createGroup(
          {
            space_ids: ['S1'],
            requester_person_id: 'P',
            start_at: '2026-05-01T09:00:00Z',
            end_at: '2026-05-01T10:00:00Z',
          },
          makeActor(),
        ),
      ),
    ).rejects.toThrow(/multi_room_requires_two|at least two/);
  });

  it('surfaces a 23P01 GiST race as a clean 409 — no partial bookings', async () => {
    // Atomicity is now a DB property — the RPC fails as a unit. We assert
    // the error is mapped to multi_room_booking_failed with the failed
    // space ids surfaced for the client picker.
    const supabase = makeSupabase({
      spaces: [{ id: 'S1' }, { id: 'S2' }, { id: 'S3' }],
      rpcResponse: { data: null, error: { code: '23P01', message: 'booking_slots_no_overlap' } },
    });
    const svc = new MultiRoomBookingService(
      supabase as never,
      makeConflictGuard() as never,
      makeRuleResolver() as never,
      makeBundle() as never,
    );

    await expect(
      TenantContext.run(TENANT, () =>
        svc.createGroup(
          {
            space_ids: ['S1', 'S2', 'S3'],
            requester_person_id: 'P',
            start_at: '2026-05-01T09:00:00Z',
            end_at: '2026-05-01T10:00:00Z',
          },
          makeActor(),
        ),
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'multi_room_booking_failed',
        failed_space_ids: ['S1', 'S2', 'S3'],
      },
    });
    // No audit emission on failure — the booking never landed.
  });

  it('runs service attach against the booking id when services are present', async () => {
    const supabase = makeSupabase({
      spaces: [{ id: 'S1' }, { id: 'S2' }],
    });
    const bundle = makeBundle();
    const compensation = { deleteBooking: jest.fn() };
    const svc = new MultiRoomBookingService(
      supabase as never,
      makeConflictGuard() as never,
      makeRuleResolver() as never,
      bundle as never,
      new InProcessBookingTransactionBoundary(),
      compensation as never,
    );

    await TenantContext.run(TENANT, () =>
      svc.createGroup(
        {
          space_ids: ['S1', 'S2'],
          requester_person_id: 'P',
          start_at: '2026-05-01T09:00:00Z',
          end_at: '2026-05-01T10:00:00Z',
          services: [{ catalog_item_id: 'C1', quantity: 4 }],
          bundle: { bundle_type: 'meeting' },
        },
        makeActor(),
      ),
    );

    expect(bundle.attachServicesToBooking).toHaveBeenCalledTimes(1);
    const call = bundle.attachServicesToBooking.mock.calls[0][0];
    expect(call.booking_id).toBe(BOOKING_ID);
    expect(call.services).toHaveLength(1);
    expect(call.bundle.bundle_type).toBe('meeting');
    // Phase 1.3: happy path doesn't invoke compensation; the legacy cascade
    // cleanup is no longer at this layer (it's owned by Cleanup inside
    // BundleService.attachServicesToBooking and by the compensation RPC).
    expect(compensation.deleteBooking).not.toHaveBeenCalled();
    // /full-review v3 — the cascade-not-invoked assertion was removed
    // along with `bundleCascade` from the service constructor; the
    // `cascade.cancelOrdersForReservation` stub is no longer reachable
    // from this layer, so asserting it wasn't called is trivially true.
  });

  it('rolls back the booking and re-throws original error when service attach fails (Phase 1.3)', async () => {
    // Booking + slots landed via create_booking RPC; service attach then
    // exploded. Phase 1.3 wraps the attach in a compensation boundary that
    // calls delete_booking_with_guard (00292) to atomically roll back. With
    // a 'rolled_back' outcome, the original error is re-thrown unchanged
    // (no longer the legacy "leave booking + cascade cleanup" behavior).
    const supabase = makeSupabase({
      spaces: [{ id: 'S1' }, { id: 'S2' }],
    });
    const bundle = {
      attachServicesToBooking: jest.fn(async () => {
        throw new Error('catalog_item_not_found');
      }),
    };
    const compensation = {
      deleteBooking: jest.fn(async (id: string) => ({ kind: 'rolled_back' as const, bookingId: id })),
    };
    const svc = new MultiRoomBookingService(
      supabase as never,
      makeConflictGuard() as never,
      makeRuleResolver() as never,
      bundle as never,
      new InProcessBookingTransactionBoundary(),
      compensation as never,
    );

    await expect(
      TenantContext.run(TENANT, () =>
        svc.createGroup(
          {
            space_ids: ['S1', 'S2'],
            requester_person_id: 'P',
            start_at: '2026-05-01T09:00:00Z',
            end_at: '2026-05-01T10:00:00Z',
            services: [{ catalog_item_id: 'C1', quantity: 4 }],
          },
          makeActor(),
        ),
      ),
    ).rejects.toThrow(/catalog_item_not_found/);

    expect(compensation.deleteBooking).toHaveBeenCalledTimes(1);
    expect(compensation.deleteBooking).toHaveBeenCalledWith(BOOKING_ID);
    // /full-review v3 — see same-named comment in earlier test; cascade
    // is no longer wired into the service so the assertion is moot.
  });

  it('throws BadRequestException(booking.partial_failure) when compensation reports a blocker (Phase 1.3)', async () => {
    const supabase = makeSupabase({
      spaces: [{ id: 'S1' }, { id: 'S2' }],
    });
    const bundle = {
      attachServicesToBooking: jest.fn(async () => {
        throw new Error('catalog_item_not_found');
      }),
    };
    const compensation = {
      deleteBooking: jest.fn(async (id: string) => ({
        kind: 'partial_failure' as const,
        bookingId: id,
        blockedBy: ['recurrence_series'],
      })),
    };
    const svc = new MultiRoomBookingService(
      supabase as never,
      makeConflictGuard() as never,
      makeRuleResolver() as never,
      bundle as never,
      new InProcessBookingTransactionBoundary(),
      compensation as never,
    );

    let caught: unknown = null;
    try {
      await TenantContext.run(TENANT, () =>
        svc.createGroup(
          {
            space_ids: ['S1', 'S2'],
            requester_person_id: 'P',
            start_at: '2026-05-01T09:00:00Z',
            end_at: '2026-05-01T10:00:00Z',
            services: [{ catalog_item_id: 'C1', quantity: 4 }],
          },
          makeActor(),
        ),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as BadRequestException).getResponse()).toMatchObject({
      code: 'booking.partial_failure',
      booking_id: BOOKING_ID,
      blocked_by: ['recurrence_series'],
    });
  });

  it('marks status pending_approval when any room rule requires approval', async () => {
    const supabase = makeSupabase({
      spaces: [{ id: 'S1' }, { id: 'S2' }],
    });
    const svc = new MultiRoomBookingService(
      supabase as never,
      makeConflictGuard() as never,
      makeRuleResolver({ final: 'require_approval' }) as never,
      makeBundle() as never,
    );

    await TenantContext.run(TENANT, () =>
      svc.createGroup(
        {
          space_ids: ['S1', 'S2'],
          requester_person_id: 'P',
          start_at: '2026-05-01T09:00:00Z',
          end_at: '2026-05-01T10:00:00Z',
        },
        makeActor(),
      ),
    );

    const rpc = supabase.calls.rpc.find((c) => c.fn === 'create_booking');
    expect((rpc!.args as { p_status: string }).p_status).toBe('pending_approval');
  });
});

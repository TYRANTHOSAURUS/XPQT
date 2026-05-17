import { AppError } from '../../common/errors';
import { MultiRoomBookingService } from './multi-room-booking.service';
import { TenantContext } from '../../common/tenant-context';
import type { ActorContext } from './dto/types';

// Booking-audit remediation Slice 3 (audit
// docs/follow-ups/audits/03-booking-reservation.md P1-1, :142-154):
//   - Multi-room create no longer rides legacy choreography
//     (`create_booking` RPC + `bundle.attachServicesToBooking` +
//     `BookingTransactionBoundary.runWithCompensation`).
//   - It now makes ONE atomic call to `create_booking_with_attach_plan`
//     (00309, live body 00315) — booking + N slots + orders + OLIs +
//     asset_reservations + approvals + outbox, all in one Postgres tx.
//   - There is NO TS-side compensation any more; atomicity is a DB
//     property (the combined RPC fails as a unit and the
//     attach_operations idempotency marker rolls back with it).
//   - `InProcessBookingTransactionBoundary` + `BookingCompensationService`
//     are no longer constructor collaborators of this service (the only
//     remaining live txBoundary caller is recurrence.service.ts:531 — a
//     separate slice, untouched).
//
// The spec exercises the service as a pure orchestrator over its collabs:
//   supabase.admin.rpc('create_booking_with_attach_plan', …)  — atomic write
//   supabase.admin.from('booking_slots').select…              — read-back
//   supabase.admin.from('approvals').insert…                  — approval rows
//   supabase.admin.from('audit_events').insert…               — best-effort
//   conflict.snapshotBuffersForBooking                         — per-room buffers
//   conflict.isExclusionViolation                              — race detection
//   ruleResolver.resolve                                       — per-room rules
//   bundle.buildAttachPlan                                     — service plan (optional)
//   workflowService.start                                      — approval workflow (optional)

describe('MultiRoomBookingService.createGroup (Slice 3 — combined atomic RPC)', () => {
  const TENANT = { id: 'T', slug: 't', tier: 'standard' as const };

  type RpcResponse = { data: unknown; error: unknown };

  function emptyAttachPlan(bookingId: string) {
    return {
      version: 1 as const,
      any_pending_approval: false,
      any_deny: false,
      deny_messages: [],
      orders: [],
      asset_reservations: [],
      order_line_items: [],
      approvals: [],
      bundle_audit_payload: {
        bundle_id: bookingId,
        booking_id: bookingId,
        order_ids: [],
        order_line_item_ids: [],
        asset_reservation_ids: [],
        approval_ids: [],
        any_pending_approval: false,
      },
    };
  }

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
    // The combined RPC returns the cached_result jsonb directly (not a
    // setof row array). booking_id/slot_ids are TS-pre-generated via
    // planUuid; the test doesn't need the exact uuids, only that the
    // service returns a non-empty booking_id and reads slots back.
    const rpcResponse: RpcResponse =
      opts?.rpcResponse ?? {
        data: {
          booking_id: 'B-1',
          slot_ids: spaces.map((_, i) => `S-${i}`),
          order_ids: [],
          order_line_item_ids: [],
          asset_reservation_ids: [],
          approval_ids: [],
          any_pending_approval: false,
        },
        error: null,
      };

    const calls = {
      rpc: [] as Array<{ fn: string; args: any }>,
      approvalInserts: [] as unknown[],
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
          const filters: Array<[string, unknown]> = [];
          const built = opts?.slotsRead ?? {
            data: spaces.map((s, i) => ({
              id: `slot-${i}`,
              tenant_id: TENANT.id,
              booking_id: 'B-1',
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
                id: 'B-1',
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
        if (table === 'approvals') {
          return {
            insert: (rows: unknown) => {
              calls.approvalInserts.push(rows);
              return Promise.resolve({ data: null, error: null });
            },
          };
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

  function makeRuleResolver(opts?: {
    final?: 'allow' | 'deny' | 'require_approval';
    approvalConfig?: {
      required_approvers?: Array<{ type: 'team' | 'person'; id: string }>;
      threshold?: 'all' | 'any';
    } | null;
    approvalWorkflowDefinitionId?: string | null;
  }) {
    const final = opts?.final ?? 'allow';
    return {
      resolve: jest.fn(async () => ({
        effects: [],
        matchedRules: [],
        warnings: [],
        denialMessages: final === 'deny' ? ['Denied by rule'] : [],
        overridable: false,
        approvalConfig:
          opts && 'approvalConfig' in opts
            ? opts.approvalConfig ?? null
            : final === 'require_approval'
              ? { required_approvers: [{ type: 'person' as const, id: 'APR-1' }], threshold: 'all' as const }
              : null,
        approvalWorkflowDefinitionId: opts?.approvalWorkflowDefinitionId ?? null,
        final,
      })),
    };
  }

  function makeBundle() {
    return {
      buildAttachPlan: jest.fn(async (args: { booking_id: string }) =>
        emptyAttachPlan(args.booking_id),
      ),
    };
  }

  function makeActor(overrides: Partial<ActorContext> = {}): ActorContext {
    return {
      user_id: 'U',
      auth_uid: 'U',
      person_id: 'P',
      is_service_desk: false,
      has_override_rules: false,
      client_request_id: 'crid-1',
      ...overrides,
    };
  }

  it('creates one booking with N slots via the create_booking_with_attach_plan RPC', async () => {
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

    const rpcCall = supabase.calls.rpc.find(
      (c) => c.fn === 'create_booking_with_attach_plan',
    );
    expect(rpcCall).toBeDefined();
    // ZERO legacy `create_booking` RPC calls — the choreography is gone.
    expect(supabase.calls.rpc.find((c) => c.fn === 'create_booking')).toBeUndefined();

    const args = rpcCall!.args as {
      p_booking_input: {
        booking_id: string;
        slots: unknown[];
        status: string;
        location_id: string;
        booked_by_user_id: string;
      };
      p_attach_plan: unknown;
      p_tenant_id: string;
      p_idempotency_key: string;
    };
    // group_id is the BOOKING id (the canonical atomic grouping). Under
    // the combined RPC the id is TS-pre-generated (deterministic planUuid)
    // and echoed back by the RPC — group_id === the booking_id we sent.
    expect(result.group_id).toBe(args.p_booking_input.booking_id);
    expect(result.reservations).toHaveLength(3);
    expect(args.p_booking_input.slots).toHaveLength(3);
    expect(args.p_booking_input.status).toBe('confirmed');
    expect(args.p_booking_input.location_id).toBe('S1'); // primary anchor
    // DIRECT passthrough (00315:135) — actor.user_id, NOT auth_uid.
    expect(args.p_booking_input.booked_by_user_id).toBe('U');
    expect(args.p_tenant_id).toBe('T');
    // Idempotency key mirrors single-room's inline literal shape.
    expect(args.p_idempotency_key).toBe('booking.create:U:crid-1');
    expect(ruleResolver.resolve).toHaveBeenCalledTimes(3); // per-room
    expect(conflict.snapshotBuffersForBooking).toHaveBeenCalledTimes(3);
    // No services → empty-plan built inline; buildAttachPlan NOT called.
    expect(bundle.buildAttachPlan).not.toHaveBeenCalled();
    // Audit best-effort write.
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
    // Atomicity is now a DB property — the combined RPC fails as a unit.
    // We assert the error maps to multi_room_booking_failed with the
    // failed room ids surfaced for the client picker.
    const supabase = makeSupabase({
      spaces: [{ id: 'S1' }, { id: 'S2' }, { id: 'S3' }],
      rpcResponse: {
        data: null,
        error: { code: '23P01', message: 'booking_slots_no_overlap' },
      },
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
    ).rejects.toMatchObject({ code: 'multi_room_booking_failed', status: 409 });
    // No audit emission on failure — the booking never landed.
  });

  it('maps attach_operations.payload_mismatch to a 409', async () => {
    const supabase = makeSupabase({
      spaces: [{ id: 'S1' }, { id: 'S2' }],
      rpcResponse: {
        data: null,
        error: { code: 'P0001', message: 'attach_operations.payload_mismatch' },
      },
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
            space_ids: ['S1', 'S2'],
            requester_person_id: 'P',
            start_at: '2026-05-01T09:00:00Z',
            end_at: '2026-05-01T10:00:00Z',
          },
          makeActor(),
        ),
      ),
    ).rejects.toMatchObject({
      code: 'booking.idempotency_payload_mismatch',
      status: 409,
    });
  });

  it('builds the attach plan via bundle.buildAttachPlan when services are present', async () => {
    const supabase = makeSupabase({
      spaces: [{ id: 'S1' }, { id: 'S2' }],
    });
    const bundle = makeBundle();
    const svc = new MultiRoomBookingService(
      supabase as never,
      makeConflictGuard() as never,
      makeRuleResolver() as never,
      bundle as never,
    );

    await TenantContext.run(TENANT, () =>
      svc.createGroup(
        {
          space_ids: ['S1', 'S2'],
          requester_person_id: 'P',
          start_at: '2026-05-01T09:00:00Z',
          end_at: '2026-05-01T10:00:00Z',
          services: [{ catalog_item_id: 'C1', quantity: 4, client_line_id: 'L1' }],
          bundle: { bundle_type: 'meeting' },
        },
        makeActor(),
      ),
    );

    expect(bundle.buildAttachPlan).toHaveBeenCalledTimes(1);
    const call = bundle.buildAttachPlan.mock.calls[0][0];
    expect(call.tenant_id).toBe('T');
    expect(call.services).toHaveLength(1);
    expect(call.services[0].client_line_id).toBe('L1');
    expect(call.bundle.bundle_type).toBe('meeting');
    // The plan's booking_id is the same TS-pre-generated id sent on the
    // booking input (deterministic via planUuid).
    const rpcCall = supabase.calls.rpc.find(
      (c) => c.fn === 'create_booking_with_attach_plan',
    )!;
    expect(call.booking_id).toBe(
      (rpcCall.args as { p_booking_input: { booking_id: string } }).p_booking_input.booking_id,
    );
    // The combined RPC carried BOTH payloads in ONE call (atomic).
    expect((rpcCall.args as { p_attach_plan: unknown }).p_attach_plan).toBeDefined();
  });

  it('marks status pending_approval AND creates approval rows when a room rule requires approval', async () => {
    // Pre-Slice-3 BUG (audit P1-1): legacy multi-room set
    // status=pending_approval but created ZERO approval rows — a
    // permanently-stuck booking. Slice 3 replicates single-room's
    // room-rule approval wiring so the rows ARE created.
    const supabase = makeSupabase({
      spaces: [{ id: 'S1' }, { id: 'S2' }],
    });
    const svc = new MultiRoomBookingService(
      supabase as never,
      makeConflictGuard() as never,
      makeRuleResolver({
        final: 'require_approval',
        approvalConfig: {
          required_approvers: [{ type: 'person', id: 'APR-1' }],
          threshold: 'all',
        },
      }) as never,
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

    const rpc = supabase.calls.rpc.find(
      (c) => c.fn === 'create_booking_with_attach_plan',
    )!;
    expect(
      (rpc.args as { p_booking_input: { status: string } }).p_booking_input.status,
    ).toBe('pending_approval');
    // The fix: approval rows ARE inserted (legacy path inserted none).
    expect(supabase.calls.approvalInserts).toHaveLength(1);
    const rows = supabase.calls.approvalInserts[0] as Array<{
      target_entity_type: string;
      approver_person_id: string | null;
      status: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].target_entity_type).toBe('booking');
    expect(rows[0].approver_person_id).toBe('APR-1');
    expect(rows[0].status).toBe('pending');
  });

  it('starts a workflow instead of legacy approval rows when the rule carries a workflow_definition_id', async () => {
    const supabase = makeSupabase({
      spaces: [{ id: 'S1' }, { id: 'S2' }],
    });
    const workflowService = { start: jest.fn(async () => undefined) };
    const svc = new MultiRoomBookingService(
      supabase as never,
      makeConflictGuard() as never,
      makeRuleResolver({
        final: 'require_approval',
        approvalConfig: {
          required_approvers: [{ type: 'person', id: 'APR-1' }],
          threshold: 'all',
        },
        approvalWorkflowDefinitionId: 'WF-DEF-1',
      }) as never,
      makeBundle() as never,
      workflowService as never,
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

    expect(workflowService.start).toHaveBeenCalledTimes(1);
    const startArgs = workflowService.start.mock.calls[0][0];
    expect(startArgs.definitionId).toBe('WF-DEF-1');
    expect(startArgs.entityKind).toBe('booking');
    expect(startArgs.tenantId).toBe('T');
    // Workflow owns approval rows — the legacy insert path is skipped.
    expect(supabase.calls.approvalInserts).toHaveLength(0);
  });

  it('throws server-class AppError when the combined RPC returns no booking_id', async () => {
    const supabase = makeSupabase({
      spaces: [{ id: 'S1' }, { id: 'S2' }],
      rpcResponse: { data: null, error: null },
    });
    const svc = new MultiRoomBookingService(
      supabase as never,
      makeConflictGuard() as never,
      makeRuleResolver() as never,
      makeBundle() as never,
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
          },
          makeActor(),
        ),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({ code: 'booking.unexpected_error', status: 500 });
  });

  it('uses the HIGHEST-priority require_approval rule across rooms, not the first in space order (FIX 2)', async () => {
    // Pre-FIX-2 BUG: multi-room kept the FIRST require_approval outcome in
    // SPACE ORDER, so a low-priority rule matching room A (space[0]) would
    // win the booking-level approver fan-out even when a HIGHER-priority
    // require_approval rule matched room B (space[1]). Single-room never
    // had this — the resolver itself picks the winner by
    // most-specific-then-highest-priority (rule-resolver.service.ts:541-542).
    // FIX 2 mirrors that comparator across the cross-room matched-rule set.
    //
    // Room A (S1, resolved first) → require_approval, specificity=4
    //   (tenant), priority=10, approvers=[LOW-APPROVER].
    // Room B (S2) → require_approval, SAME specificity=4, HIGHER
    //   priority=50, approvers=[HIGH-APPROVER].
    // Correct booking-level fan-out: HIGH-APPROVER (priority tie-break).
    const supabase = makeSupabase({ spaces: [{ id: 'S1' }, { id: 'S2' }] });

    const ruleFor = (spaceId: string) =>
      spaceId === 'S1'
        ? {
            id: 'RULE-LOW',
            effect: 'require_approval' as const,
            specificity: 4,
            priority: 10,
            approval_config: {
              required_approvers: [{ type: 'person' as const, id: 'LOW-APPROVER' }],
              threshold: 'all' as const,
            },
            workflow_definition_id: null,
          }
        : {
            id: 'RULE-HIGH',
            effect: 'require_approval' as const,
            specificity: 4,
            priority: 50,
            approval_config: {
              required_approvers: [{ type: 'person' as const, id: 'HIGH-APPROVER' }],
              threshold: 'all' as const,
            },
            workflow_definition_id: null,
          };

    const ruleResolver = {
      // Per-room resolve: each room matches its own require_approval rule.
      // `approvalConfig`/`approvalWorkflowDefinitionId` on the OUTCOME are
      // the resolver's per-resolve winner (here = that room's only rule);
      // FIX 2 must NOT consume those — it must re-aggregate across rooms
      // from `matchedRules` so the cross-room priority winner is chosen.
      resolve: jest.fn(async (scenario: { space_id: string }) => {
        const r = ruleFor(scenario.space_id);
        return {
          effects: ['require_approval'],
          matchedRules: [r],
          warnings: [],
          denialMessages: [],
          overridable: false,
          approvalConfig: r.approval_config,
          approvalWorkflowDefinitionId: null,
          final: 'require_approval' as const,
        };
      }),
    };

    await TenantContext.run(TENANT, () =>
      new MultiRoomBookingService(
        supabase as never,
        makeConflictGuard() as never,
        ruleResolver as never,
        makeBundle() as never,
      ).createGroup(
        {
          space_ids: ['S1', 'S2'],
          requester_person_id: 'P',
          start_at: '2026-05-01T09:00:00Z',
          end_at: '2026-05-01T10:00:00Z',
        },
        makeActor(),
      ),
    );

    expect(ruleResolver.resolve).toHaveBeenCalledTimes(2); // per-room
    const rpc = supabase.calls.rpc.find(
      (c) => c.fn === 'create_booking_with_attach_plan',
    )!;
    expect(
      (rpc.args as { p_booking_input: { status: string } }).p_booking_input.status,
    ).toBe('pending_approval');
    // The booking-level approval fan-out used the HIGHER-priority rule's
    // approvers, NOT room A's first-in-space-order LOW-APPROVER.
    expect(supabase.calls.approvalInserts).toHaveLength(1);
    const rows = supabase.calls.approvalInserts[0] as Array<{
      approver_person_id: string | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].approver_person_id).toBe('HIGH-APPROVER');
    // Pre-FIX-2 this would be 'LOW-APPROVER' (first require_approval
    // outcome in space order) — proving the spec fails pre-fix.
  });
});

import { AppError } from '../../common/errors';
import { BookingFlowService } from './booking-flow.service';
import { TenantContext } from '../../common/tenant-context';
import type { ActorContext, CreateReservationInput } from './dto/types';
import type { AttachPlan, BookingInput } from '../booking-bundles/attach-plan.types';
import { planUuid } from '../booking-bundles/plan-uuid';

/**
 * B.0.C.4 — `BookingFlowService.buildAttachPlan` is the pure plan-builder
 * for the combined-RPC path. These tests verify it returns deterministic
 * `{ bookingInput, attachPlan }` for the same input + idempotency key, and
 * delegates correctly to `BundleService.buildAttachPlan` when services are
 * present.
 */

describe('BookingFlowService.buildAttachPlan (B.0.C.4)', () => {
  const TENANT = { id: 'tenant-1', slug: 'acme', tier: 'standard' as const };
  const REQUESTER_PERSON = '11111111-1111-1111-1111-111111111111';
  const SPACE = '22222222-2222-2222-2222-222222222222';

  function makeSupabase() {
    const admin = {
      rpc: jest.fn(),
      from: (table: string) => {
        if (table === 'spaces') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () =>
                    Promise.resolve({
                      data: {
                        id: SPACE,
                        type: 'room',
                        reservable: true,
                        active: true,
                        capacity: 8,
                        setup_buffer_minutes: 0,
                        teardown_buffer_minutes: 0,
                        check_in_required: false,
                        check_in_grace_minutes: 15,
                        cost_per_hour: null,
                      },
                      error: null,
                    }),
                }),
              }),
            }),
          };
        }
        return {};
      },
    };
    return { admin };
  }

  function makeConflict() {
    return {
      snapshotBuffersForBooking: jest.fn(async () => ({
        setup_buffer_minutes: 0,
        teardown_buffer_minutes: 0,
      })),
      isExclusionViolation: jest.fn(() => false),
      preCheck: jest.fn(async () => []),
    };
  }

  function makeRules(final: 'allow' | 'deny' | 'require_approval' = 'allow') {
    return {
      resolve: jest.fn(async () => ({
        effects: [],
        matchedRules: [],
        warnings: [],
        denialMessages: final === 'deny' ? ['Denied by rule.'] : [],
        overridable: false,
        approvalConfig: null,
        final,
      })),
    };
  }

  function makeActor(overrides: Partial<ActorContext> = {}): ActorContext {
    return {
      user_id: 'user-1',
      auth_uid: 'user-1',
      person_id: REQUESTER_PERSON,
      is_service_desk: false,
      has_override_rules: false,
      ...overrides,
    };
  }

  function baseInput(overrides: Partial<CreateReservationInput> = {}): CreateReservationInput {
    return {
      space_id: SPACE,
      requester_person_id: REQUESTER_PERSON,
      start_at: '2026-05-04T09:00:00Z',
      end_at: '2026-05-04T10:00:00Z',
      attendee_count: 4,
      ...overrides,
    } as CreateReservationInput;
  }

  function makeBundle(plan: AttachPlan) {
    return {
      buildAttachPlan: jest.fn(async () => plan),
      attachServicesToBooking: jest.fn(),
    };
  }

  function emptyPlan(bookingId: string): AttachPlan {
    return {
      version: 1,
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

  it('rejects an empty idempotencyKey', async () => {
    const svc = new BookingFlowService(
      makeSupabase() as never,
      makeConflict() as never,
      makeRules() as never,
    );
    await TenantContext.run(TENANT, async () => {
      await expect(svc.buildAttachPlan(baseInput(), makeActor(), '')).rejects.toThrow(
        /idempotencyKey required/,
      );
    });
  });

  it('builds a deterministic BookingInput with pre-generated UUIDs', async () => {
    const svc = new BookingFlowService(
      makeSupabase() as never,
      makeConflict() as never,
      makeRules() as never,
    );

    const result = await TenantContext.run(TENANT, () =>
      svc.buildAttachPlan(baseInput(), makeActor(), 'idem-stable-1'),
    );

    expect(result.bookingInput.booking_id).toBe(planUuid('idem-stable-1', 'booking', '0'));
    expect(result.bookingInput.slot_ids).toEqual([planUuid('idem-stable-1', 'slot', '0')]);
    expect(result.bookingInput.location_id).toBe(SPACE);
    expect(result.bookingInput.status).toBe('confirmed');
    expect(result.bookingInput.source).toBe('portal');
    expect(result.bookingInput.slots).toHaveLength(1);
    expect(result.bookingInput.slots[0].id).toBe(result.bookingInput.slot_ids[0]);
    expect(result.bookingInput.slots[0].slot_type).toBe('room');
  });

  it('produces byte-identical output for the same input + key (full determinism)', async () => {
    const svc = new BookingFlowService(
      makeSupabase() as never,
      makeConflict() as never,
      makeRules() as never,
    );

    const a = await TenantContext.run(TENANT, () =>
      svc.buildAttachPlan(baseInput(), makeActor(), 'idem-1'),
    );
    const b = await TenantContext.run(TENANT, () =>
      svc.buildAttachPlan(baseInput(), makeActor(), 'idem-1'),
    );
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('produces an empty AttachPlan when no services are present', async () => {
    const svc = new BookingFlowService(
      makeSupabase() as never,
      makeConflict() as never,
      makeRules() as never,
    );
    const result = await TenantContext.run(TENANT, () =>
      svc.buildAttachPlan(baseInput(), makeActor(), 'idem-no-svc'),
    );
    expect(result.attachPlan.version).toBe(1);
    expect(result.attachPlan.orders).toEqual([]);
    expect(result.attachPlan.order_line_items).toEqual([]);
    expect(result.attachPlan.approvals).toEqual([]);
    expect(result.attachPlan.any_pending_approval).toBe(false);
    expect(result.attachPlan.any_deny).toBe(false);
  });

  it('delegates to BundleService.buildAttachPlan when services are present', async () => {
    const bookingId = planUuid('idem-with-svc', 'booking', '0');
    const bundle = makeBundle(emptyPlan(bookingId));
    const svc = new BookingFlowService(
      makeSupabase() as never,
      makeConflict() as never,
      makeRules() as never,
      undefined,
      undefined,
      bundle as never,
    );

    await TenantContext.run(TENANT, () =>
      svc.buildAttachPlan(
        baseInput({
          services: [
            { catalog_item_id: 'cat-1', quantity: 1, client_line_id: 'line-a' },
          ],
        }),
        makeActor(),
        'idem-with-svc',
      ),
    );

    expect(bundle.buildAttachPlan).toHaveBeenCalledTimes(1);
    const callArgs = bundle.buildAttachPlan.mock.calls[0][0];
    expect(callArgs.idempotency_key).toBe('idem-with-svc');
    expect(callArgs.booking_id).toBe(bookingId);
    expect(callArgs.tenant_id).toBe(TENANT.id);
    expect(callArgs.services).toHaveLength(1);
    expect(callArgs.services[0].client_line_id).toBe('line-a');
  });

  it('throws when services are present but BundleService is not injected', async () => {
    const svc = new BookingFlowService(
      makeSupabase() as never,
      makeConflict() as never,
      makeRules() as never,
      // No bundle.
    );
    await TenantContext.run(TENANT, async () => {
      await expect(
        svc.buildAttachPlan(
          baseInput({
            services: [{ catalog_item_id: 'c-1', quantity: 1, client_line_id: 'line-a' }],
          }),
          makeActor(),
          'idem-1',
        ),
      ).rejects.toThrow(/BundleService not injected/);
    });
  });

  it('honours rule deny: throws AppError when actor cannot override', async () => {
    const svc = new BookingFlowService(
      makeSupabase() as never,
      makeConflict() as never,
      makeRules('deny') as never,
    );
    await TenantContext.run(TENANT, async () => {
      await expect(svc.buildAttachPlan(baseInput(), makeActor(), 'idem-1')).rejects.toThrow(
        AppError,
      );
    });
  });

  it('honours rule deny override: requires override_reason', async () => {
    const svc = new BookingFlowService(
      makeSupabase() as never,
      makeConflict() as never,
      makeRules('deny') as never,
    );
    await TenantContext.run(TENANT, async () => {
      // has_override_rules but no overridable flag — same as can't override.
      await expect(
        svc.buildAttachPlan(
          baseInput(),
          makeActor({ has_override_rules: true }),
          'idem-1',
        ),
      ).rejects.toThrow(AppError);
    });
  });

  it('honours require_approval status on the BookingInput', async () => {
    const svc = new BookingFlowService(
      makeSupabase() as never,
      makeConflict() as never,
      makeRules('require_approval') as never,
    );
    const result = await TenantContext.run(TENANT, () =>
      svc.buildAttachPlan(baseInput(), makeActor(), 'idem-1'),
    );
    expect(result.bookingInput.status).toBe('pending_approval');
  });

  // Booking-audit Slice 8 (audit 03 P2-2, 2026-05-17): `'auto'` was removed
  // from `ReservationSource`. Resolution moved to the producers — the
  // recurrence materialiser passes `'recurrence'` directly
  // (recurrence.service.ts:514) and multi-room resolves `system:*` inline
  // (multi-room-booking.service.ts:320-326). `buildAttachPlan` is the
  // consumer: it must now pass an already-resolved DB-CHECK-valid source
  // through UNCHANGED (no actor-prefix re-derivation). These two cases
  // assert exactly the two resolved values the producers emit, proving the
  // consumer preserves them rather than re-coercing.
  it('passes a producer-resolved source="calendar_sync" through unchanged', async () => {
    const svc = new BookingFlowService(
      makeSupabase() as never,
      makeConflict() as never,
      makeRules() as never,
    );
    const result = await TenantContext.run(TENANT, () =>
      svc.buildAttachPlan(baseInput({ source: 'calendar_sync' }), makeActor(), 'idem-1'),
    );
    expect(result.bookingInput.source).toBe('calendar_sync');
  });

  it('passes a producer-resolved source="recurrence" through unchanged even when actor is system:recurrence:*', async () => {
    const svc = new BookingFlowService(
      makeSupabase() as never,
      makeConflict() as never,
      makeRules() as never,
    );
    const result = await TenantContext.run(TENANT, () =>
      svc.buildAttachPlan(
        // The recurrence materialiser now passes `'recurrence'` directly;
        // the consumer must NOT re-derive from the actor prefix.
        baseInput({ source: 'recurrence' }),
        makeActor({ user_id: 'system:recurrence:abc' }),
        'idem-1',
      ),
    );
    expect(result.bookingInput.source).toBe('recurrence');
  });

  it('returned BookingInput round-trips through JSON.stringify (jsonb wire shape)', async () => {
    const svc = new BookingFlowService(
      makeSupabase() as never,
      makeConflict() as never,
      makeRules() as never,
    );
    const result = await TenantContext.run(TENANT, () =>
      svc.buildAttachPlan(baseInput(), makeActor(), 'idem-1'),
    );
    const json = JSON.stringify(result.bookingInput);
    const parsed = JSON.parse(json) as BookingInput;
    expect(parsed).toEqual(result.bookingInput);
  });

  it('rejects basic input validation failures (mirrors create)', async () => {
    const svc = new BookingFlowService(
      makeSupabase() as never,
      makeConflict() as never,
      makeRules() as never,
    );
    await TenantContext.run(TENANT, async () => {
      await expect(
        svc.buildAttachPlan(
          baseInput({ end_at: '2026-05-04T08:00:00Z' /* before start */ }),
          makeActor(),
          'idem-1',
        ),
      ).rejects.toThrow(AppError);
    });
  });

  // ─── audit-03 P2-3 STEP C — no-services FLAT approval builder ─────────
  //
  // The no-services single-room path was cut over from the legacy
  // `create_booking` RPC + `createApprovalRows` onto the combined RPC.
  // `buildAttachPlan` must now emit the FLAT-case approval rows (mirroring
  // createApprovalRows OUTCOME) with HARD determinism so a same-intent
  // retry rebuilds a byte-identical plan (D-5/D-6) and the 00429 RPC
  // commits them in-transaction → inbox-notified.

  const APPROVER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const APPROVER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const APPROVER_TEAM = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const WF_DEF = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

  function makeApprovalRules(opts: {
    required_approvers: Array<{ type: 'team' | 'person'; id: string }>;
    threshold?: 'all' | 'any';
    workflowDefinitionId?: string | null;
  }) {
    return {
      resolve: jest.fn(async () => ({
        effects: [],
        matchedRules: [],
        warnings: [],
        denialMessages: [],
        overridable: false,
        approvalConfig: {
          required_approvers: opts.required_approvers,
          threshold: opts.threshold ?? 'all',
        },
        approvalWorkflowDefinitionId: opts.workflowDefinitionId ?? null,
        final: 'require_approval' as const,
      })),
    };
  }

  it('FLAT approval rule (no services) → approvals[] + any_pending_approval, deterministic ids', async () => {
    const svc = new BookingFlowService(
      makeSupabase() as never,
      makeConflict() as never,
      makeApprovalRules({
        // Deliberately UNSORTED to prove canonicalApproverSort is applied.
        required_approvers: [
          { type: 'person', id: APPROVER_B },
          { type: 'person', id: APPROVER_A },
        ],
        threshold: 'all',
      }) as never,
    );

    const run = () =>
      TenantContext.run(TENANT, () =>
        svc.buildAttachPlan(baseInput(), makeActor(), 'idem-flat-1'),
      );

    const r1 = await run();
    const r2 = await run();

    // any_pending_approval set in lockstep (top-level + bundle_audit_payload).
    expect(r1.attachPlan.any_pending_approval).toBe(true);
    expect(r1.attachPlan.bundle_audit_payload.any_pending_approval).toBe(true);
    expect(r1.attachPlan.approvals.length).toBe(2);
    // No services ⇒ empty service graph.
    expect(r1.attachPlan.orders).toEqual([]);
    expect(r1.attachPlan.order_line_items).toEqual([]);

    const bookingId = r1.bookingInput.booking_id;
    // canonicalApproverSort(['person:B','person:A']) → A before B.
    expect(r1.attachPlan.approvals.map((a) => a.approver_person_id)).toEqual([
      APPROVER_A,
      APPROVER_B,
    ]);

    // Deterministic row ids = planUuid(key, 'approval', approver.id).
    expect(r1.attachPlan.approvals[0].id).toBe(
      planUuid('idem-flat-1', 'approval', APPROVER_A),
    );
    expect(r1.attachPlan.approvals[1].id).toBe(
      planUuid('idem-flat-1', 'approval', APPROVER_B),
    );

    // ONE shared, deterministic approval_chain_id (NOT randomUUID).
    const chainId = planUuid('idem-flat-1', 'approval', '__chain__');
    expect(r1.attachPlan.approvals[0].approval_chain_id).toBe(chainId);
    expect(r1.attachPlan.approvals[1].approval_chain_id).toBe(chainId);
    // threshold==='all' ⇒ parallel_group = 'parallel-' + bookingId.
    expect(r1.attachPlan.approvals[0].parallel_group).toBe(
      `parallel-${bookingId}`,
    );
    expect(r1.attachPlan.approvals[0].chain_threshold).toBe('all');
    expect(r1.attachPlan.approvals[0].approver_team_id).toBeNull();
    expect(r1.attachPlan.approvals[0].status).toBe('pending');
    expect(r1.attachPlan.approvals[0].target_entity_type).toBe('booking');
    expect(r1.attachPlan.approvals[0].target_entity_id).toBe(bookingId);

    // Byte-identical across two same-key calls (D-6 idempotency discipline).
    expect(JSON.stringify(r2.attachPlan.approvals)).toBe(
      JSON.stringify(r1.attachPlan.approvals),
    );
    expect(r2.bookingInput.booking_id).toBe(bookingId);

    // FLAT case ⇒ no workflow-def post-RPC start.
    expect(r1.approvalCutover.status).toBe('pending_approval');
    expect(r1.approvalCutover.workflowDefinitionId).toBeNull();
  });

  it("FLAT rule threshold='any' → parallel_group null, chain_threshold 'any'", async () => {
    const svc = new BookingFlowService(
      makeSupabase() as never,
      makeConflict() as never,
      makeApprovalRules({
        required_approvers: [{ type: 'person', id: APPROVER_A }],
        threshold: 'any',
      }) as never,
    );
    const r = await TenantContext.run(TENANT, () =>
      svc.buildAttachPlan(baseInput(), makeActor(), 'idem-any-1'),
    );
    expect(r.attachPlan.approvals.length).toBe(1);
    expect(r.attachPlan.approvals[0].chain_threshold).toBe('any');
    expect(r.attachPlan.approvals[0].parallel_group).toBeNull();
    expect(r.attachPlan.approvals[0].approval_chain_id).toBe(
      planUuid('idem-any-1', 'approval', '__chain__'),
    );
  });

  it('FLAT rule with a TEAM approver → approver_team_id populated, approver_person_id null', async () => {
    const svc = new BookingFlowService(
      makeSupabase() as never,
      makeConflict() as never,
      makeApprovalRules({
        required_approvers: [{ type: 'team', id: APPROVER_TEAM }],
        threshold: 'all',
      }) as never,
    );
    const r = await TenantContext.run(TENANT, () =>
      svc.buildAttachPlan(baseInput(), makeActor(), 'idem-team-1'),
    );
    expect(r.attachPlan.approvals.length).toBe(1);
    const row = r.attachPlan.approvals[0];
    expect(row.approver_team_id).toBe(APPROVER_TEAM);
    expect(row.approver_person_id).toBeNull();
    expect(row.approval_chain_id).toBe(
      planUuid('idem-team-1', 'approval', '__chain__'),
    );
    expect(row.id).toBe(planUuid('idem-team-1', 'approval', APPROVER_TEAM));
    expect(r.attachPlan.any_pending_approval).toBe(true);
  });

  it('WORKFLOW-DEF approval rule (no services) → NO plan approvals, cutover surfaces the def id', async () => {
    const svc = new BookingFlowService(
      makeSupabase() as never,
      makeConflict() as never,
      makeApprovalRules({
        required_approvers: [{ type: 'person', id: APPROVER_A }],
        threshold: 'all',
        workflowDefinitionId: WF_DEF,
      }) as never,
    );
    const r = await TenantContext.run(TENANT, () =>
      svc.buildAttachPlan(baseInput(), makeActor(), 'idem-wf-1'),
    );
    // Engine owns the approval rows — plan emits NONE.
    expect(r.attachPlan.approvals).toEqual([]);
    expect(r.attachPlan.any_pending_approval).toBe(false);
    expect(r.attachPlan.bundle_audit_payload.any_pending_approval).toBe(false);
    // Cutover tells createWithAttachPlan to start the workflow POST-RPC.
    expect(r.approvalCutover.status).toBe('pending_approval');
    expect(r.approvalCutover.workflowDefinitionId).toBe(WF_DEF);
  });

  it('confirmed (no approval rule, no services) → empty plan, no cutover', async () => {
    const svc = new BookingFlowService(
      makeSupabase() as never,
      makeConflict() as never,
      makeRules('allow') as never,
    );
    const r = await TenantContext.run(TENANT, () =>
      svc.buildAttachPlan(baseInput(), makeActor(), 'idem-ok-1'),
    );
    expect(r.attachPlan.approvals).toEqual([]);
    expect(r.attachPlan.any_pending_approval).toBe(false);
    expect(r.approvalCutover.status).toBe('confirmed');
    expect(r.approvalCutover.workflowDefinitionId).toBeNull();
  });
});

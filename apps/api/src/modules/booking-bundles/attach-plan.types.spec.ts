import type {
  AttachPlan,
  AttachPlanApproval,
  AttachPlanAssetReservation,
  AttachPlanOrder,
  AttachPlanOrderLineItem,
  BookingInput,
  CreateBookingWithAttachPlanResult,
} from './attach-plan.types';

/**
 * AttachPlan + BookingInput type tests. The shapes are wire-protocol — they
 * round-trip through `JSON.stringify` → Postgres jsonb → SQL `->>` accesses
 * → response payload. Any drift between the TS shape and the RPC body
 * surfaces as a runtime cast error inside the RPC. These tests pin the
 * shape at the TS layer.
 */

describe('AttachPlan jsonb shape', () => {
  const fixedBookingInput: BookingInput = {
    booking_id: '00000000-0000-0000-0000-000000000001',
    slot_ids: ['00000000-0000-0000-0000-000000000010'],
    requester_person_id: '11111111-1111-1111-1111-111111111111',
    host_person_id: null,
    booked_by_user_id: null,
    location_id: '22222222-2222-2222-2222-222222222222',
    start_at: '2026-05-04T10:00:00Z',
    end_at: '2026-05-04T11:00:00Z',
    timezone: 'UTC',
    status: 'confirmed',
    source: 'portal',
    title: 'Test booking',
    description: null,
    cost_center_id: null,
    cost_amount_snapshot: null,
    policy_snapshot: { matched_rule_ids: [] },
    applied_rule_ids: [],
    config_release_id: null,
    recurrence_series_id: null,
    recurrence_index: null,
    template_id: null,
    slots: [
      {
        id: '00000000-0000-0000-0000-000000000010',
        slot_type: 'room',
        space_id: '22222222-2222-2222-2222-222222222222',
        start_at: '2026-05-04T10:00:00Z',
        end_at: '2026-05-04T11:00:00Z',
        attendee_count: 4,
        attendee_person_ids: [],
        setup_buffer_minutes: 0,
        teardown_buffer_minutes: 0,
        check_in_required: false,
        check_in_grace_minutes: 15,
        display_order: 0,
      },
    ],
  };

  const fixedOrder: AttachPlanOrder = {
    id: '33333333-3333-3333-3333-333333333333',
    service_type: 'catering',
    requester_person_id: fixedBookingInput.requester_person_id,
    delivery_location_id: fixedBookingInput.location_id,
    delivery_date: '2026-05-04',
    requested_for_start_at: fixedBookingInput.start_at,
    requested_for_end_at: fixedBookingInput.end_at,
    initial_status: 'approved',
    policy_snapshot: { service_type: 'catering' },
  };

  const fixedAssetReservation: AttachPlanAssetReservation = {
    id: '44444444-4444-4444-4444-444444444444',
    asset_id: '55555555-5555-5555-5555-555555555555',
    start_at: fixedBookingInput.start_at,
    end_at: fixedBookingInput.end_at,
    requester_person_id: fixedBookingInput.requester_person_id,
    booking_id: fixedBookingInput.booking_id,
    status: 'confirmed',
  };

  const fixedOli: AttachPlanOrderLineItem = {
    id: '66666666-6666-6666-6666-666666666666',
    client_line_id: 'line-form-key-aaa',
    order_id: fixedOrder.id,
    catalog_item_id: '77777777-7777-7777-7777-777777777777',
    quantity: 4,
    unit_price: 12.5,
    line_total: 50,
    fulfillment_status: 'ordered',
    fulfillment_team_id: null,
    vendor_id: null,
    menu_item_id: null,
    linked_asset_id: null,
    linked_asset_reservation_id: null,
    service_window_start_at: fixedBookingInput.start_at,
    service_window_end_at: fixedBookingInput.end_at,
    repeats_with_series: true,
    pending_setup_trigger_args: null,
    policy_snapshot: {
      menu_id: null,
      menu_item_id: null,
      unit: 'per_person',
      service_type: 'catering',
    },
    setup_emit: null,
  };

  const fixedApproval: AttachPlanApproval = {
    id: '88888888-8888-8888-8888-888888888888',
    target_entity_type: 'booking',
    target_entity_id: fixedBookingInput.booking_id,
    approver_person_id: '99999999-9999-9999-9999-999999999999',
    scope_breakdown: {
      reservation_ids: [fixedBookingInput.booking_id],
      order_ids: [fixedOrder.id],
      order_line_item_ids: [fixedOli.id],
      ticket_ids: [],
      asset_reservation_ids: [],
      reasons: [{ rule_id: 'rule-1', denial_message: null }],
    },
    status: 'pending',
  };

  const fixedPlan: AttachPlan = {
    version: 1,
    any_pending_approval: false,
    any_deny: false,
    deny_messages: [],
    orders: [fixedOrder],
    asset_reservations: [],
    order_line_items: [fixedOli],
    approvals: [],
    bundle_audit_payload: {
      bundle_id: fixedBookingInput.booking_id,
      booking_id: fixedBookingInput.booking_id,
      order_ids: [fixedOrder.id],
      order_line_item_ids: [fixedOli.id],
      asset_reservation_ids: [],
      approval_ids: [],
      any_pending_approval: false,
    },
  };

  it('round-trips through JSON.stringify without loss', () => {
    const json = JSON.stringify(fixedPlan);
    const parsed = JSON.parse(json) as AttachPlan;
    expect(parsed).toEqual(fixedPlan);
  });

  it('BookingInput round-trips through JSON.stringify', () => {
    const json = JSON.stringify(fixedBookingInput);
    const parsed = JSON.parse(json) as BookingInput;
    expect(parsed).toEqual(fixedBookingInput);
  });

  it('admits all enumerated row kinds (compile-time check)', () => {
    // No assertions — the assignment itself is the test. If the type
    // narrowed to disallow any of these, tsc would fail.
    expect(fixedOrder).toBeDefined();
    expect(fixedAssetReservation).toBeDefined();
    expect(fixedOli).toBeDefined();
    expect(fixedApproval).toBeDefined();
    expect(fixedPlan.bundle_audit_payload.any_pending_approval).toBe(false);
  });

  it('models setup_emit hint when present', () => {
    const oliWithEmit: AttachPlanOrderLineItem = {
      ...fixedOli,
      setup_emit: {
        service_category: 'catering',
        rule_ids: ['rule-1', 'rule-2'],
        lead_time_override_minutes: 30,
      },
    };
    expect(oliWithEmit.setup_emit?.rule_ids).toHaveLength(2);
  });

  it('rejects (compile-time) an approval with target_entity_type !== "booking"', () => {
    // The combined RPC canonicalises to 'booking' — the standalone-order
    // path uses the wider AssembleApprovalsArgs union. This @ts-expect-error
    // pins the narrow union in AttachPlan.
    // @ts-expect-error — should not compile if the union widens
    const wrong: AttachPlanApproval = { ...fixedApproval, target_entity_type: 'order' };
    expect(wrong).toBeDefined();
  });

  it('CreateBookingWithAttachPlanResult shape mirrors the RPC §7.6 step 13', () => {
    const result: CreateBookingWithAttachPlanResult = {
      booking_id: fixedBookingInput.booking_id,
      slot_ids: fixedBookingInput.slot_ids,
      order_ids: [fixedOrder.id],
      order_line_item_ids: [fixedOli.id],
      asset_reservation_ids: [],
      approval_ids: [],
      any_pending_approval: false,
    };
    const json = JSON.stringify(result);
    const parsed = JSON.parse(json) as CreateBookingWithAttachPlanResult;
    expect(parsed).toEqual(result);
  });
});

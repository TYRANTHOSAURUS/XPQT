import {
  SetupWorkOrderRowBuilder,
  type SetupWorkOrderBuildArgs,
  type SetupWorkOrderPayload,
} from './setup-work-order-row-builder.service';
import type { OutboxEvent } from '../outbox/outbox.types';

/**
 * B.0.C.5 — `SetupWorkOrderRowBuilder.build` tests.
 *
 * Pure builder: routing matrix lookup → lead-time math → row payload.
 * No INSERTs. The atomic write is the
 * `create_setup_work_order_from_event` RPC's responsibility.
 *
 * Spec §7.7 (v7) of docs/superpowers/specs/2026-05-04-domain-outbox-design.md.
 */

describe('SetupWorkOrderRowBuilder.build (B.0.C.5)', () => {
  const TENANT_ID = 'tenant-1';
  const BOOKING_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const OLI_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const SPACE_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const TEAM_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  const SLA_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

  function makeSupabase(opts: {
    routing?: Array<{
      internal_team_id: string | null;
      default_lead_time_minutes: number;
      sla_policy_id: string | null;
    }> | null;
    routingError?: { message: string };
  }) {
    const rpc = jest.fn(async (fn: string) => {
      if (fn === 'resolve_setup_routing') {
        if (opts.routingError) return { data: null, error: opts.routingError };
        return { data: opts.routing ?? null, error: null };
      }
      return { data: null, error: null };
    });
    return { admin: { rpc } } as never;
  }

  function baseArgs(): SetupWorkOrderBuildArgs {
    return {
      tenant_id: TENANT_ID,
      booking_id: BOOKING_ID,
      oli_id: OLI_ID,
      service_category: 'catering',
      service_window_start_at: '2026-05-04T12:00:00Z',
      location_id: SPACE_ID,
      rule_ids: ['rule-1', 'rule-2'],
      lead_time_override_minutes: null,
      origin_surface: 'bundle',
    };
  }

  it('builds wo_data on a valid routing match', async () => {
    const builder = new SetupWorkOrderRowBuilder(
      makeSupabase({
        routing: [
          {
            internal_team_id: TEAM_ID,
            default_lead_time_minutes: 30,
            sla_policy_id: SLA_ID,
          },
        ],
      }),
    );
    const result = await builder.build(baseArgs());

    expect(result.kind).toBe('wo_data');
    if (result.kind !== 'wo_data') return;
    const row = result.row;

    // Critical invariant (v8.1): requester_person_id MUST be null.
    expect(row.requester_person_id).toBeNull();

    // Identity threads through.
    expect(row.booking_id).toBe(BOOKING_ID);
    expect(row.linked_order_line_item_id).toBe(OLI_ID);
    expect(row.location_id).toBe(SPACE_ID);

    // Routing fields from matrix.
    expect(row.assigned_team_id).toBe(TEAM_ID);
    expect(row.sla_id).toBe(SLA_ID);
    expect(row.assigned_user_id).toBeNull();
    expect(row.assigned_vendor_id).toBeNull();

    // Lead-time math: target_due_at = service_window_start - lead_time_minutes.
    // 2026-05-04T12:00:00Z - 30min = 2026-05-04T11:30:00Z.
    expect(row.sla_resolution_due_at).toBe('2026-05-04T11:30:00.000Z');

    // Static framing.
    expect(row.parent_kind).toBe('booking');
    expect(row.parent_ticket_id).toBeNull();
    expect(row.interaction_mode).toBe('internal');
    expect(row.status).toBe('new');
    expect(row.status_category).toBe('assigned');
    expect(row.source_channel).toBe('system');
    expect(row.title).toBe('Internal setup — catering');

    // Audit metadata captures the rule + lead time + origin.
    expect(row.audit_metadata.triggered_by_rule_ids).toEqual(['rule-1', 'rule-2']);
    expect(row.audit_metadata.lead_time_minutes).toBe(30);
    expect(row.audit_metadata.service_category).toBe('catering');
    expect(row.audit_metadata.origin).toBe('bundle');
  });

  it('uses lead_time_override_minutes when provided', async () => {
    const builder = new SetupWorkOrderRowBuilder(
      makeSupabase({
        routing: [
          {
            internal_team_id: TEAM_ID,
            default_lead_time_minutes: 30,
            sla_policy_id: null,
          },
        ],
      }),
    );
    const result = await builder.build({
      ...baseArgs(),
      lead_time_override_minutes: 60,
    });
    expect(result.kind).toBe('wo_data');
    if (result.kind !== 'wo_data') return;
    expect(result.row.audit_metadata.lead_time_minutes).toBe(60);
    expect(result.row.sla_resolution_due_at).toBe('2026-05-04T11:00:00.000Z');
  });

  it('returns no_op_terminal/no_routing_match when matrix has no row', async () => {
    const builder = new SetupWorkOrderRowBuilder(makeSupabase({ routing: null }));
    const result = await builder.build(baseArgs());
    expect(result.kind).toBe('no_op_terminal');
    if (result.kind !== 'no_op_terminal') return;
    expect(result.reason).toBe('no_routing_match');
  });

  it('returns no_op_terminal/no_routing_match when matrix returns a row without internal_team_id', async () => {
    const builder = new SetupWorkOrderRowBuilder(
      makeSupabase({
        routing: [
          { internal_team_id: null, default_lead_time_minutes: 30, sla_policy_id: null },
        ],
      }),
    );
    const result = await builder.build(baseArgs());
    expect(result.kind).toBe('no_op_terminal');
    if (result.kind !== 'no_op_terminal') return;
    expect(result.reason).toBe('no_routing_match');
  });

  it('returns no_op_terminal/invalid_window on a NaN service_window_start_at', async () => {
    const builder = new SetupWorkOrderRowBuilder(
      makeSupabase({
        routing: [
          { internal_team_id: TEAM_ID, default_lead_time_minutes: 30, sla_policy_id: null },
        ],
      }),
    );
    const result = await builder.build({
      ...baseArgs(),
      service_window_start_at: 'not-a-date',
    });
    expect(result.kind).toBe('no_op_terminal');
    if (result.kind !== 'no_op_terminal') return;
    expect(result.reason).toBe('invalid_window');
  });

  it('throws (transient) when resolve_setup_routing returns an error', async () => {
    const builder = new SetupWorkOrderRowBuilder(
      makeSupabase({ routingError: { message: 'connection refused' } }),
    );
    await expect(builder.build(baseArgs())).rejects.toThrow(
      /resolve_setup_routing: connection refused/,
    );
  });

  it('uses booking_id from event.payload, not aggregate_id, in buildFromEvent', async () => {
    // The handler-side identity guard derives the OLI from aggregate_id;
    // the row builder uses payload fields. They should agree but the
    // builder doesn't enforce the cross-check (handler does).
    const builder = new SetupWorkOrderRowBuilder(
      makeSupabase({
        routing: [
          { internal_team_id: TEAM_ID, default_lead_time_minutes: 30, sla_policy_id: null },
        ],
      }),
    );
    const event: OutboxEvent<SetupWorkOrderPayload> = {
      id: 'event-1',
      tenant_id: TENANT_ID,
      event_type: 'setup_work_order.create_required',
      event_version: 1,
      aggregate_type: 'order_line_item',
      aggregate_id: OLI_ID,
      payload: {
        booking_id: BOOKING_ID,
        oli_id: OLI_ID,
        service_category: 'catering',
        service_window_start_at: '2026-05-04T12:00:00Z',
        location_id: SPACE_ID,
        rule_ids: ['rule-1'],
        lead_time_override_minutes: null,
        origin_surface: 'bundle',
        requires_approval: false,
      },
      payload_hash: 'hash',
      idempotency_key: 'setup_work_order.create_required:' + OLI_ID,
      enqueued_at: '2026-05-04T11:00:00Z',
      available_at: '2026-05-04T11:00:00Z',
      processed_at: null,
      processed_reason: null,
      claim_token: null,
      claimed_at: null,
      attempts: 0,
      last_error: null,
      dead_lettered_at: null,
    };
    const result = await builder.buildFromEvent(event);
    expect(result.kind).toBe('wo_data');
    if (result.kind !== 'wo_data') return;
    expect(result.row.booking_id).toBe(BOOKING_ID);
    expect(result.row.linked_order_line_item_id).toBe(OLI_ID);
  });

  it('hard-codes requester_person_id to null on every wo_data result (v8.1 invariant)', async () => {
    const builder = new SetupWorkOrderRowBuilder(
      makeSupabase({
        routing: [
          { internal_team_id: TEAM_ID, default_lead_time_minutes: 30, sla_policy_id: null },
        ],
      }),
    );
    const result = await builder.build(baseArgs());
    expect(result.kind).toBe('wo_data');
    if (result.kind !== 'wo_data') return;
    // TypeScript already pins the type to `null`, but defense in depth at
    // runtime catches a future careless edit.
    expect(result.row.requester_person_id).toBeNull();
  });
});

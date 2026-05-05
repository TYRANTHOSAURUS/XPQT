import { SetupWorkOrderHandler } from '../setup-work-order.handler';
import { DeadLetterError } from '../../dead-letter.error';
import {
  SetupWorkOrderRowBuilder,
  type SetupWorkOrderPayload,
  type SetupWorkOrderRowBuildResult,
} from '../../../service-routing/setup-work-order-row-builder.service';
import type { OutboxEvent } from '../../outbox.types';

/**
 * B.0.E.1 — `SetupWorkOrderHandler.handle` tests.
 *
 * Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md §7.8 / §7.8.2.
 *
 * Flow under test:
 *   1. OLI tenant guard (read order_line_items)
 *   2. Approval-pending guard (event.payload.requires_approval)
 *   3. Read-side dedup (read setup_work_order_emissions)
 *   4. Row-builder (delegated, mocked here as a fake)
 *   5. RPC create_setup_work_order_from_event (success or error)
 *   6. Error classification — terminal → DeadLetterError, transient → Error
 */

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const OLI_ID = '33333333-3333-4333-8333-333333333333';
const ORDER_ID = '44444444-4444-4444-8444-444444444444';
const BOOKING_ID = '55555555-5555-4555-8555-555555555555';
const TEAM_ID = '66666666-6666-4666-8666-666666666666';
const SLA_ID = '77777777-7777-4777-8777-777777777777';
const SPACE_ID = '88888888-8888-4888-8888-888888888888';
const WORK_ORDER_ID = '99999999-9999-4999-8999-999999999999';

function makeEvent(
  overrides: Partial<OutboxEvent<SetupWorkOrderPayload>> = {},
): OutboxEvent<SetupWorkOrderPayload> {
  return {
    id: EVENT_ID,
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
    ...overrides,
  };
}

interface FakeSupabaseOpts {
  oliRow?: { id: string; tenant_id: string; order_id: string } | null;
  oliError?: { message: string };
  emissionsRow?: { work_order_id: string | null } | null;
  emissionsError?: { message: string };
  rpcResponse?:
    | {
        kind: 'created' | 'already_created' | 'already_handled_tombstone';
        work_order_id: string | null;
      }
    | null;
  rpcError?: { code?: string; message: string };
  auditError?: { message: string };
}

interface CapturedCalls {
  fromTables: string[];
  rpcCalls: Array<{ fn: string; args: unknown }>;
  auditInserts: Array<Record<string, unknown>>;
}

function makeSupabase(opts: FakeSupabaseOpts) {
  const captured: CapturedCalls = {
    fromTables: [],
    rpcCalls: [],
    auditInserts: [],
  };

  const from = jest.fn((table: string) => {
    captured.fromTables.push(table);
    if (table === 'order_line_items') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: opts.oliRow ?? null,
              error: opts.oliError ?? null,
            }),
          }),
        }),
      };
    }
    if (table === 'setup_work_order_emissions') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: opts.emissionsRow ?? null,
                error: opts.emissionsError ?? null,
              }),
            }),
          }),
        }),
      };
    }
    if (table === 'audit_events') {
      return {
        insert: async (row: Record<string, unknown>) => {
          captured.auditInserts.push(row);
          return { error: opts.auditError ?? null };
        },
      };
    }
    throw new Error('unexpected table: ' + table);
  });

  const rpc = jest.fn(async (fn: string, args: unknown) => {
    captured.rpcCalls.push({ fn, args });
    if (opts.rpcError) return { data: null, error: opts.rpcError };
    return { data: opts.rpcResponse ?? null, error: null };
  });

  return {
    captured,
    service: {
      admin: { from, rpc },
    } as never,
  };
}

function makeRowBuilder(result: SetupWorkOrderRowBuildResult | Error) {
  const buildFromEvent = jest.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return {
    builder: { buildFromEvent } as unknown as SetupWorkOrderRowBuilder,
    buildFromEvent,
  };
}

function makeWoData(): SetupWorkOrderRowBuildResult {
  return {
    kind: 'wo_data',
    row: {
      parent_kind: 'booking',
      parent_ticket_id: null,
      booking_id: BOOKING_ID,
      linked_order_line_item_id: OLI_ID,
      title: 'Internal setup — catering',
      description: null,
      priority: 'medium',
      interaction_mode: 'internal',
      status: 'new',
      status_category: 'assigned',
      requester_person_id: null,
      location_id: SPACE_ID,
      assigned_team_id: TEAM_ID,
      assigned_user_id: null,
      assigned_vendor_id: null,
      sla_id: SLA_ID,
      sla_resolution_due_at: '2026-05-04T11:30:00.000Z',
      source_channel: 'system',
      audit_metadata: {
        triggered_by_rule_ids: ['rule-1'],
        lead_time_minutes: 30,
        service_window_start_at: '2026-05-04T12:00:00Z',
        service_category: 'catering',
        sla_policy_id: SLA_ID,
        origin: 'bundle',
      },
    },
  };
}

describe('SetupWorkOrderHandler.handle (B.0.E.1)', () => {
  describe('happy path', () => {
    it('builds the row, calls create_setup_work_order_from_event RPC, returns void on `created`', async () => {
      const supabase = makeSupabase({
        oliRow: { id: OLI_ID, tenant_id: TENANT_ID, order_id: ORDER_ID },
        emissionsRow: null,
        rpcResponse: { kind: 'created', work_order_id: WORK_ORDER_ID },
      });
      const { builder, buildFromEvent } = makeRowBuilder(makeWoData());
      const handler = new SetupWorkOrderHandler(supabase.service, builder);
      const event = makeEvent();

      await expect(handler.handle(event)).resolves.toBeUndefined();

      // Row-builder was called with the event (buildFromEvent path).
      expect(buildFromEvent).toHaveBeenCalledTimes(1);
      expect(buildFromEvent).toHaveBeenCalledWith(event);

      // RPC was called with the v8 contract args.
      expect(supabase.captured.rpcCalls).toHaveLength(1);
      const call = supabase.captured.rpcCalls[0];
      expect(call.fn).toBe('create_setup_work_order_from_event');
      expect(call.args).toMatchObject({
        p_event_id: EVENT_ID,
        p_tenant_id: TENANT_ID,
        p_idempotency_key: `setup_work_order:${OLI_ID}`,
      });
      // p_wo_row_data is the builder's row payload (identity fields will
      // be cross-checked + derived from outbox.events on the SQL side).
      const args = call.args as { p_wo_row_data: { linked_order_line_item_id: string; requester_person_id: null } };
      expect(args.p_wo_row_data.linked_order_line_item_id).toBe(OLI_ID);
      expect(args.p_wo_row_data.requester_person_id).toBeNull();
    });

    it('returns void on `already_created` (idempotent re-handling)', async () => {
      const supabase = makeSupabase({
        oliRow: { id: OLI_ID, tenant_id: TENANT_ID, order_id: ORDER_ID },
        emissionsRow: null,
        rpcResponse: { kind: 'already_created', work_order_id: WORK_ORDER_ID },
      });
      const { builder } = makeRowBuilder(makeWoData());
      const handler = new SetupWorkOrderHandler(supabase.service, builder);
      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();
    });

    it('returns void on `already_handled_tombstone` (admin deleted the WO post-creation)', async () => {
      const supabase = makeSupabase({
        oliRow: { id: OLI_ID, tenant_id: TENANT_ID, order_id: ORDER_ID },
        emissionsRow: null,
        rpcResponse: { kind: 'already_handled_tombstone', work_order_id: null },
      });
      const { builder } = makeRowBuilder(makeWoData());
      const handler = new SetupWorkOrderHandler(supabase.service, builder);
      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();
    });
  });

  describe('early-exit guards (return without RPC)', () => {
    it('returns void without RPC when the OLI was hard-deleted', async () => {
      const supabase = makeSupabase({ oliRow: null });
      const { builder, buildFromEvent } = makeRowBuilder(makeWoData());
      const handler = new SetupWorkOrderHandler(supabase.service, builder);
      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();
      expect(buildFromEvent).not.toHaveBeenCalled();
      expect(supabase.captured.rpcCalls).toHaveLength(0);
    });

    it('throws DeadLetterError when OLI tenant disagrees with event tenant', async () => {
      const supabase = makeSupabase({
        oliRow: {
          id: OLI_ID,
          tenant_id: '00000000-0000-4000-8000-000000000000',
          order_id: ORDER_ID,
        },
      });
      const { builder, buildFromEvent } = makeRowBuilder(makeWoData());
      const handler = new SetupWorkOrderHandler(supabase.service, builder);
      await expect(handler.handle(makeEvent())).rejects.toBeInstanceOf(DeadLetterError);
      expect(buildFromEvent).not.toHaveBeenCalled();
      expect(supabase.captured.rpcCalls).toHaveLength(0);
    });

    it('returns void without RPC when payload.requires_approval is true', async () => {
      const supabase = makeSupabase({
        oliRow: { id: OLI_ID, tenant_id: TENANT_ID, order_id: ORDER_ID },
      });
      const { builder, buildFromEvent } = makeRowBuilder(makeWoData());
      const handler = new SetupWorkOrderHandler(supabase.service, builder);
      const event = makeEvent({
        payload: { ...makeEvent().payload, requires_approval: true },
      });
      await expect(handler.handle(event)).resolves.toBeUndefined();
      expect(buildFromEvent).not.toHaveBeenCalled();
      expect(supabase.captured.rpcCalls).toHaveLength(0);
    });

    it('returns void without RPC when emissions dedup row exists (already_emitted)', async () => {
      const supabase = makeSupabase({
        oliRow: { id: OLI_ID, tenant_id: TENANT_ID, order_id: ORDER_ID },
        emissionsRow: { work_order_id: WORK_ORDER_ID },
      });
      const { builder, buildFromEvent } = makeRowBuilder(makeWoData());
      const handler = new SetupWorkOrderHandler(supabase.service, builder);
      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();
      expect(buildFromEvent).not.toHaveBeenCalled();
      expect(supabase.captured.rpcCalls).toHaveLength(0);
    });

    it('returns void without RPC on no_op_terminal builder result, with audit row', async () => {
      const supabase = makeSupabase({
        oliRow: { id: OLI_ID, tenant_id: TENANT_ID, order_id: ORDER_ID },
        emissionsRow: null,
      });
      const { builder } = makeRowBuilder({
        kind: 'no_op_terminal',
        reason: 'no_routing_match',
      });
      const handler = new SetupWorkOrderHandler(supabase.service, builder);
      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();
      expect(supabase.captured.rpcCalls).toHaveLength(0);
      expect(supabase.captured.auditInserts).toHaveLength(1);
      expect(supabase.captured.auditInserts[0]).toMatchObject({
        tenant_id: TENANT_ID,
        event_type: 'setup_work_order.no_routing_match',
        entity_type: 'order_line_item',
        entity_id: OLI_ID,
      });
    });
  });

  describe('RPC error classification (§7.8.2 v8.1)', () => {
    function expectDeadLetter(rpcError: { code?: string; message: string }) {
      return async () => {
        const supabase = makeSupabase({
          oliRow: { id: OLI_ID, tenant_id: TENANT_ID, order_id: ORDER_ID },
          emissionsRow: null,
          rpcError,
        });
        const { builder } = makeRowBuilder(makeWoData());
        const handler = new SetupWorkOrderHandler(supabase.service, builder);
        await expect(handler.handle(makeEvent())).rejects.toBeInstanceOf(DeadLetterError);
      };
    }

    it(
      'dead-letters on setup_wo.event_not_found (P0002)',
      expectDeadLetter({
        code: 'P0002',
        message: 'setup_wo.event_not_found event_id=… tenant_id=…',
      }),
    );

    it(
      'dead-letters on setup_wo.event_missing_aggregate (P0002)',
      expectDeadLetter({
        code: 'P0002',
        message: 'setup_wo.event_missing_aggregate event_id=…',
      }),
    );

    it(
      'dead-letters on setup_wo.oli_chain_invalid (P0002)',
      expectDeadLetter({
        code: 'P0002',
        message: 'setup_wo.oli_chain_invalid oli_id=… tenant_id=…',
      }),
    );

    it(
      'dead-letters on setup_wo.row_oli_missing (P0001)',
      expectDeadLetter({
        code: 'P0001',
        message: 'setup_wo.row_oli_missing',
      }),
    );

    it(
      'dead-letters on setup_wo.row_oli_mismatch (P0001)',
      expectDeadLetter({
        code: 'P0001',
        message: 'setup_wo.row_oli_mismatch row=… event_aggregate=…',
      }),
    );

    it(
      'dead-letters on setup_wo.row_booking_mismatch (P0001)',
      expectDeadLetter({
        code: 'P0001',
        message: 'setup_wo.row_booking_mismatch row=… chain=…',
      }),
    );

    it(
      'dead-letters on setup_wo.requester_person_id_not_allowed (P0001 — v8.1)',
      expectDeadLetter({
        code: 'P0001',
        message: 'setup_wo.requester_person_id_not_allowed',
      }),
    );

    it(
      'dead-letters on setup_wo.fk_invalid: assigned_team_id <uuid> (42501)',
      expectDeadLetter({
        code: '42501',
        message: 'setup_wo.fk_invalid: assigned_team_id 99999999-9999-4999-8999-999999999999',
      }),
    );

    it('throws plain Error (transient → outbox retries) on connection-class error', async () => {
      const supabase = makeSupabase({
        oliRow: { id: OLI_ID, tenant_id: TENANT_ID, order_id: ORDER_ID },
        emissionsRow: null,
        rpcError: { code: '08000', message: 'connection refused' },
      });
      const { builder } = makeRowBuilder(makeWoData());
      const handler = new SetupWorkOrderHandler(supabase.service, builder);
      await expect(handler.handle(makeEvent())).rejects.toThrow(/connection refused/);
      // Plain Error → NOT a DeadLetterError; worker treats as retry.
      await expect(handler.handle(makeEvent())).rejects.not.toBeInstanceOf(DeadLetterError);
    });

    it('dead-letters on a malformed RPC response (contract violation)', async () => {
      const supabase = makeSupabase({
        oliRow: { id: OLI_ID, tenant_id: TENANT_ID, order_id: ORDER_ID },
        emissionsRow: null,
        rpcResponse: null,
      });
      const { builder } = makeRowBuilder(makeWoData());
      const handler = new SetupWorkOrderHandler(supabase.service, builder);
      await expect(handler.handle(makeEvent())).rejects.toBeInstanceOf(DeadLetterError);
    });
  });

  describe('transient supabase-js read errors (worker retries)', () => {
    it('throws plain Error when order_line_items lookup fails (not DeadLetterError)', async () => {
      const supabase = makeSupabase({ oliError: { message: 'connection wobble' } });
      const { builder } = makeRowBuilder(makeWoData());
      const handler = new SetupWorkOrderHandler(supabase.service, builder);
      await expect(handler.handle(makeEvent())).rejects.toThrow(/connection wobble/);
      await expect(handler.handle(makeEvent())).rejects.not.toBeInstanceOf(DeadLetterError);
    });

    it('throws plain Error when emissions dedup lookup fails (not DeadLetterError)', async () => {
      const supabase = makeSupabase({
        oliRow: { id: OLI_ID, tenant_id: TENANT_ID, order_id: ORDER_ID },
        emissionsError: { message: 'lock timeout' },
      });
      const { builder } = makeRowBuilder(makeWoData());
      const handler = new SetupWorkOrderHandler(supabase.service, builder);
      await expect(handler.handle(makeEvent())).rejects.toThrow(/lock timeout/);
      await expect(handler.handle(makeEvent())).rejects.not.toBeInstanceOf(DeadLetterError);
    });
  });
});

import { OutboxService } from '../outbox.service';

/**
 * OutboxService unit tests.
 *
 * Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md §3.2 + §11.1.
 *
 * Scope: assert that the TS-side helpers map correctly onto the PostgREST
 * RPC wrappers (outbox_emit_via_rpc + outbox_mark_consumed_via_rpc) per
 * spec §14, and honour the failure semantics — emit() never throws,
 * markConsumed() throws on RPC error.
 */

describe('OutboxService', () => {
  const TENANT = 'a1b2c3d4-e5f6-4789-9abc-def012345678';
  const AGGREGATE = 'b1b2c3d4-e5f6-4789-9abc-def012345678';

  function makeSupabase(rpcResponses: Array<{ data: unknown; error: unknown }>) {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    let i = 0;
    const admin = {
      rpc: (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        const r = rpcResponses[i++] ?? { data: null, error: null };
        return Promise.resolve(r);
      },
    };
    return { admin, calls };
  }

  describe('emit()', () => {
    it('calls outbox_emit_via_rpc with the deterministic idempotency key', async () => {
      const supabase = makeSupabase([{ data: 'event-id', error: null }]);
      const svc = new OutboxService(supabase as never);

      await svc.emit({
        tenantId: TENANT,
        eventType: 'booking.create_attempted',
        aggregateType: 'booking',
        aggregateId: AGGREGATE,
        payload: { x: 1 },
        operationId: 'op-1',
      });

      expect(supabase.calls).toHaveLength(1);
      expect(supabase.calls[0].fn).toBe('outbox_emit_via_rpc');
      // Idempotency key = `<eventType>:<aggregateId>:<operationId>` per §3.2
      expect(supabase.calls[0].args).toEqual({
        p_tenant_id: TENANT,
        p_event_type: 'booking.create_attempted',
        p_aggregate_type: 'booking',
        p_aggregate_id: AGGREGATE,
        p_payload: { x: 1 },
        p_idempotency_key: `booking.create_attempted:${AGGREGATE}:op-1`,
        p_event_version: 1,
      });
    });

    it('defaults payload to {} and event_version to 1', async () => {
      const supabase = makeSupabase([{ data: 'event-id', error: null }]);
      const svc = new OutboxService(supabase as never);

      await svc.emit({
        tenantId: TENANT,
        eventType: 'notification.send_required',
        aggregateType: 'ticket',
        aggregateId: AGGREGATE,
        operationId: 'op-2',
      });

      expect(supabase.calls[0].args.p_payload).toEqual({});
      expect(supabase.calls[0].args.p_event_version).toBe(1);
    });

    it('respects an explicit event_version', async () => {
      const supabase = makeSupabase([{ data: 'event-id', error: null }]);
      const svc = new OutboxService(supabase as never);

      await svc.emit({
        tenantId: TENANT,
        eventType: 'booking.service_attached',
        aggregateType: 'booking',
        aggregateId: AGGREGATE,
        operationId: 'op-3',
        eventVersion: 2,
      });

      expect(supabase.calls[0].args.p_event_version).toBe(2);
    });

    it('logs and SWALLOWS RPC errors — never throws', async () => {
      const supabase = makeSupabase([
        { data: null, error: { message: 'connection lost' } },
      ]);
      const svc = new OutboxService(supabase as never);
      const logSpy = jest
        .spyOn((svc as unknown as { log: { error: jest.Mock } }).log, 'error')
        .mockImplementation(() => undefined);

      await expect(
        svc.emit({
          tenantId: TENANT,
          eventType: 'notification.send_required',
          aggregateType: 'ticket',
          aggregateId: AGGREGATE,
          operationId: 'op-err',
        }),
      ).resolves.toBeUndefined();

      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls[0][0]).toMatch(/outbox emit failed/);
    });

    it('logs and SWALLOWS thrown RPC exceptions — never throws', async () => {
      const admin = {
        rpc: () => {
          throw new Error('network down');
        },
      };
      const svc = new OutboxService({ admin } as never);
      const logSpy = jest
        .spyOn((svc as unknown as { log: { error: jest.Mock } }).log, 'error')
        .mockImplementation(() => undefined);

      await expect(
        svc.emit({
          tenantId: TENANT,
          eventType: 'notification.send_required',
          aggregateType: 'ticket',
          aggregateId: AGGREGATE,
          operationId: 'op-throw',
        }),
      ).resolves.toBeUndefined();

      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls[0][0]).toMatch(/outbox emit threw/);
    });
  });

  describe('markConsumed()', () => {
    it('calls outbox_mark_consumed_via_rpc and returns true when a row was updated', async () => {
      const supabase = makeSupabase([{ data: true, error: null }]);
      const svc = new OutboxService(supabase as never);

      const result = await svc.markConsumed({
        tenantId: TENANT,
        idempotencyKey: 'booking.create_attempted:abc',
        reason: 'attached',
      });

      expect(result).toBe(true);
      expect(supabase.calls[0].fn).toBe('outbox_mark_consumed_via_rpc');
      expect(supabase.calls[0].args).toEqual({
        p_tenant_id: TENANT,
        p_idempotency_key: 'booking.create_attempted:abc',
        p_reason: 'attached',
      });
    });

    it('returns false when the row was already consumed (idempotent)', async () => {
      const supabase = makeSupabase([{ data: false, error: null }]);
      const svc = new OutboxService(supabase as never);

      const result = await svc.markConsumed({
        tenantId: TENANT,
        idempotencyKey: 'booking.create_attempted:abc',
        reason: 'attached',
      });

      expect(result).toBe(false);
    });

    it('THROWS on RPC error so callers do not silently leave a lease open', async () => {
      const supabase = makeSupabase([
        { data: null, error: { message: 'rpc failed' } },
      ]);
      const svc = new OutboxService(supabase as never);

      await expect(
        svc.markConsumed({
          tenantId: TENANT,
          idempotencyKey: 'booking.create_attempted:abc',
          reason: 'attached',
        }),
      ).rejects.toMatchObject({ message: 'rpc failed' });
    });
  });
});

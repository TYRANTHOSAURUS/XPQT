// B.0.D.4 — `BundleService.onApprovalDecided` cuts over to the
// `approve_booking_setup_trigger` RPC (00311 / spec §7.9).
//
// Pre-cutover this method ran a five-step TS pipeline (load orders,
// flip orders.status, expire sibling approvals on rejection, claim
// RPC, triggerMany). v6 §7.9 called that out as a non-atomic split-
// write that lost deferred setup work on a crash between the claim
// and the trigger HTTP calls. v7+ collapses ALL of it into the new
// RPC, which reads + emits + clears in ONE Postgres transaction.
//
// The TS service is now a thin dispatcher:
//   - approved: call approve_booking_setup_trigger; log summary
//   - rejected: clear pending_setup_trigger_args (admin batch path)
//
// The pre-cutover persist-failure marker, cancel-race guard, sibling
// approval expiration, and orders-status flip have all moved into the
// RPC (or are subsumed by grant_booking_approval which now drives
// the booking-target approval path). The TS-side test surface
// shrinks accordingly.

import { BundleService } from './bundle.service';
import { TenantContext } from '../../common/tenant-context';

const TENANT = '11111111-1111-4111-8111-111111111111';
const BUNDLE = 'bbbb1111-1111-4111-8111-111111111111';

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

function makeService(opts: {
  /** Stub for the new approve_booking_setup_trigger RPC outcome. */
  approveRpcResult?: { data: unknown; error: { code?: string; message?: string } | null };
  /** Orders that the rejection branch's clear-args helper finds. */
  ordersForBooking?: Array<{ id: string }>;
}) {
  const rpcCalls: RpcCall[] = [];
  const updates: Array<{ table: string; patch: Record<string, unknown> }> = [];
  const auditInserts: Array<Record<string, unknown>> = [];

  const supabase = {
    admin: {
      rpc: jest.fn(async (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push({ fn, args });
        if (fn === 'approve_booking_setup_trigger') {
          return (
            opts.approveRpcResult ?? {
              data: { emitted_count: 0, skipped_cancelled: 0, skipped_no_args: 0 },
              error: null,
            }
          );
        }
        return { data: null, error: null };
      }),
      from: jest.fn((table: string) => {
        if (table === 'orders') {
          // Used by the rejection branch's clear-args helper to
          // resolve order ids for the booking.
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  then: (
                    resolve: (v: { data: Array<{ id: string }>; error: null }) => unknown,
                  ) =>
                    resolve({
                      data: opts.ordersForBooking ?? [],
                      error: null,
                    }),
                }),
              }),
            }),
          };
        }
        if (table === 'order_line_items') {
          // Rejection clear path: update().eq().not().in()
          return {
            update: (patch: Record<string, unknown>) => ({
              eq: () => ({
                not: () => ({
                  in: () => {
                    updates.push({ table, patch });
                    return Promise.resolve({ data: null, error: null });
                  },
                }),
              }),
            }),
          };
        }
        if (table === 'audit_events') {
          return {
            insert: (row: Record<string, unknown>) => {
              auditInserts.push(row);
              return Promise.resolve({ data: null, error: null });
            },
          };
        }
        throw new Error(`unexpected table in mock: ${table}`);
      }),
    },
  };

  const setupTrigger = {
    trigger: jest.fn(),
    triggerMany: jest.fn(),
  };

  // Unused on the onApprovalDecided path post-cutover.
  const resolver = {} as unknown;
  const approvalRouter = {} as unknown;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new BundleService(
    supabase as any,
    resolver as any,
    approvalRouter as any,
    setupTrigger as any,
  );

  return { service, rpcCalls, updates, auditInserts };
}

function withTenant<T>(fn: () => Promise<T>): Promise<T> {
  return TenantContext.run({ id: TENANT, subdomain: 't1' } as never, fn);
}

describe('BundleService.onApprovalDecided (B.0.D.4)', () => {
  describe('approved decision', () => {
    it('calls approve_booking_setup_trigger RPC with the right args', async () => {
      const { service, rpcCalls } = makeService({
        approveRpcResult: {
          data: { emitted_count: 2, skipped_cancelled: 0, skipped_no_args: 0 },
          error: null,
        },
      });

      await withTenant(() =>
        service.onApprovalDecided(BUNDLE, 'approved', 'user-1', 'idem-key-1'),
      );

      expect(rpcCalls).toHaveLength(1);
      expect(rpcCalls[0].fn).toBe('approve_booking_setup_trigger');
      expect(rpcCalls[0].args).toEqual({
        p_booking_id: BUNDLE,
        p_tenant_id: TENANT,
        p_actor_user_id: 'user-1',
        p_idempotency_key: 'idem-key-1',
      });
    });

    it('defaults idempotency_key when not provided', async () => {
      const { service, rpcCalls } = makeService({});

      await withTenant(() => service.onApprovalDecided(BUNDLE, 'approved'));

      expect(rpcCalls[0].args.p_idempotency_key).toBe(
        `approval_grant_setup:${BUNDLE}:system`,
      );
      expect(rpcCalls[0].args.p_actor_user_id).toBeNull();
    });

    it('logs a high-severity audit when the RPC errors', async () => {
      const { service, rpcCalls, auditInserts } = makeService({
        approveRpcResult: {
          data: null,
          error: { code: 'P0001', message: 'setup_wo.rule_id_invalid' },
        },
      });

      await withTenant(() => service.onApprovalDecided(BUNDLE, 'approved'));

      expect(rpcCalls).toHaveLength(1);
      expect(
        auditInserts.find(
          (a) => a.event_type === 'bundle.deferred_setup_emit_failed',
        ),
      ).toBeDefined();
      const failureRow = auditInserts.find(
        (a) => a.event_type === 'bundle.deferred_setup_emit_failed',
      ) as { details: { severity: string; error_code: string } };
      expect(failureRow.details.severity).toBe('high');
      expect(failureRow.details.error_code).toBe('P0001');
    });

    it('does not throw when the RPC returns no data', async () => {
      const { service } = makeService({
        approveRpcResult: { data: null, error: null },
      });

      await expect(
        withTenant(() => service.onApprovalDecided(BUNDLE, 'approved')),
      ).resolves.toBeUndefined();
    });
  });

  describe('rejected decision', () => {
    it('does NOT call approve_booking_setup_trigger', async () => {
      const { service, rpcCalls } = makeService({
        ordersForBooking: [{ id: 'order-1' }],
      });

      await withTenant(() => service.onApprovalDecided(BUNDLE, 'rejected'));

      expect(rpcCalls).toHaveLength(0);
    });

    it('clears pending_setup_trigger_args on order_line_items', async () => {
      const { service, updates, auditInserts } = makeService({
        ordersForBooking: [{ id: 'order-1' }, { id: 'order-2' }],
      });

      await withTenant(() => service.onApprovalDecided(BUNDLE, 'rejected'));

      const cleared = updates.find((u) => u.table === 'order_line_items');
      expect(cleared).toBeDefined();
      expect(cleared!.patch).toEqual({ pending_setup_trigger_args: null });

      // Audit row recorded.
      expect(
        auditInserts.some(
          (a) => a.event_type === 'bundle.deferred_setup_dropped_on_rejection',
        ),
      ).toBe(true);
    });

    it('does not throw when the booking has zero orders', async () => {
      const { service } = makeService({ ordersForBooking: [] });

      await expect(
        withTenant(() => service.onApprovalDecided(BUNDLE, 'rejected')),
      ).resolves.toBeUndefined();
    });
  });
});

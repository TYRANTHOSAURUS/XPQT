// Tests for BundleService.onApprovalDecided — the Slice 2 closeout that
// re-fires deferred internal-setup work orders once a booking_bundle's
// approval is granted, and clears the persisted args on grant or rejection.
//
// Construction note: BundleService.onApprovalDecided only uses
// `supabase.admin` + `setupTrigger.triggerMany`. We pass minimal mocks for
// `resolver` and `approvalRouter` since they're injected but unused on
// this path.

import { BundleService } from './bundle.service';
import { TenantContext } from '../../common/tenant-context';

const TENANT = '11111111-1111-4111-8111-111111111111';
const BUNDLE = 'bbbb1111-1111-4111-8111-111111111111';

interface OrderRow {
  id: string;
  status: 'submitted' | 'approved' | 'cancelled' | 'draft' | 'confirmed' | 'fulfilled';
}
interface OliRow {
  id: string;
  pending_setup_trigger_args: Record<string, unknown> | null;
}

interface UpdateCapture {
  table: string;
  patch: Record<string, unknown>;
  filters: Array<{ kind: 'in' | 'eq'; col: string; val: unknown }>;
}

function makeService(opts: {
  orders: OrderRow[];
  olis: OliRow[];
  rpcResult?: { data: Array<{ oli_id: string; args: Record<string, unknown> | null }>; error: { message: string } | null };
  /** OLIs that the post-trigger defensive-close lookup should report as
   *  cancelled (i.e. the cancel cascade ran during the approve flow). */
  staleOliIds?: string[];
  /** Tickets the defensive close should claim. */
  closedTicketIds?: string[];
}) {
  const updates: UpdateCapture[] = [];
  const auditInserts: Array<Record<string, unknown>> = [];
  const triggerCalls: Array<unknown[]> = [];
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

  const ordersResult = { data: opts.orders, error: null };
  // The new RPC mock derives default behaviour from `olis`: each OLI with
  // non-null args becomes a claimed row. Tests can override via rpcResult.
  const defaultRpcResult = {
    data: opts.olis
      .filter((o) => o.pending_setup_trigger_args !== null)
      .map((o) => ({ oli_id: o.id, args: o.pending_setup_trigger_args! })),
    error: null,
  };

  const supabase = {
    admin: {
      rpc: jest.fn(async (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push({ fn, args });
        if (fn === 'claim_deferred_setup_trigger_args') {
          return opts.rpcResult ?? defaultRpcResult;
        }
        return { data: null, error: null };
      }),
      from: jest.fn((table: string) => {
        if (table === 'orders') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => Promise.resolve(ordersResult),
              }),
            }),
            update: (patch: Record<string, unknown>) => {
              const filters: UpdateCapture['filters'] = [];
              return {
                in: (col: string, val: unknown) => {
                  filters.push({ kind: 'in', col, val });
                  return {
                    eq: (col2: string, val2: unknown) => {
                      filters.push({ kind: 'eq', col: col2, val: val2 });
                      updates.push({ table, patch, filters });
                      return Promise.resolve({ data: null, error: null });
                    },
                  };
                },
              };
            },
          };
        }
        if (table === 'order_line_items') {
          // Defensive cancel/approve race lookup: select OLIs that are now
          // fulfillment_status='cancelled' from the just-fired set.
          return {
            select: () => ({
              in: () => ({
                eq: () => Promise.resolve({
                  data: (opts.staleOliIds ?? []).map((id) => ({ id })),
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'tickets') {
          // Defensive close of any work order that was just inserted for an
          // OLI that's already cancelled. Returns the closed ticket ids.
          return {
            update: (patch: Record<string, unknown>) => {
              const filters: UpdateCapture['filters'] = [];
              return {
                in: (col: string, val: unknown) => {
                  filters.push({ kind: 'in', col, val });
                  return {
                    eq: (c2: string, v2: unknown) => {
                      filters.push({ kind: 'eq', col: c2, val: v2 });
                      return {
                        eq: (c3: string, v3: unknown) => {
                          filters.push({ kind: 'eq', col: c3, val: v3 });
                          return {
                            in: (c4: string, v4: unknown) => {
                              filters.push({ kind: 'in', col: c4, val: v4 });
                              updates.push({ table, patch, filters });
                              return {
                                select: () => Promise.resolve({
                                  data: (opts.closedTicketIds ?? []).map((id) => ({ id })),
                                  error: null,
                                }),
                              };
                            },
                          };
                        },
                      };
                    },
                  };
                },
              };
            },
          };
        }
        if (table === 'approvals') {
          return {
            update: (patch: Record<string, unknown>) => {
              const filters: UpdateCapture['filters'] = [];
              return {
                eq: (c1: string, v1: unknown) => {
                  filters.push({ kind: 'eq', col: c1, val: v1 });
                  return {
                    eq: (c2: string, v2: unknown) => {
                      filters.push({ kind: 'eq', col: c2, val: v2 });
                      return {
                        eq: (c3: string, v3: unknown) => {
                          filters.push({ kind: 'eq', col: c3, val: v3 });
                          updates.push({ table, patch, filters });
                          return Promise.resolve({ data: null, error: null });
                        },
                      };
                    },
                  };
                },
              };
            },
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
    triggerMany: jest.fn(async (args: unknown[]) => {
      triggerCalls.push(args);
    }),
    trigger: jest.fn(),
  };

  // Unused on the onApprovalDecided path.
  const resolver = {} as unknown;
  const approvalRouter = {} as unknown;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new BundleService(
    supabase as any,
    resolver as any,
    approvalRouter as any,
    setupTrigger as any,
  );

  return { service, updates, auditInserts, triggerCalls, setupTrigger, rpcCalls };
}

function withTenant<T>(fn: () => Promise<T>): Promise<T> {
  return TenantContext.run({ id: TENANT, subdomain: 't1' }, fn);
}

const SAMPLE_TRIGGER_ARGS = {
  tenantId: TENANT,
  bundleId: BUNDLE,
  oliId: 'oli-1',
  serviceCategory: 'av_equipment',
  serviceWindowStartAt: '2026-05-01T10:00:00Z',
  locationId: 'loc-1',
  ruleIds: ['rule-1'],
  leadTimeOverride: null,
  originSurface: 'bundle' as const,
};

describe('BundleService.onApprovalDecided', () => {
  describe('approved decision', () => {
    it('flips submitted orders to approved, atomically claims deferred args, fires trigger', async () => {
      const { service, updates, triggerCalls, auditInserts, rpcCalls } = makeService({
        orders: [
          { id: 'order-1', status: 'submitted' },
          { id: 'order-2', status: 'submitted' },
        ],
        olis: [
          { id: 'oli-1', pending_setup_trigger_args: SAMPLE_TRIGGER_ARGS },
          {
            id: 'oli-2',
            pending_setup_trigger_args: { ...SAMPLE_TRIGGER_ARGS, oliId: 'oli-2' },
          },
        ],
      });

      await withTenant(() => service.onApprovalDecided(BUNDLE, 'approved'));

      // Order status flip.
      const orderUpdate = updates.find((u) => u.table === 'orders');
      expect(orderUpdate).toBeDefined();
      expect(orderUpdate!.patch).toEqual({ status: 'approved' });
      expect(orderUpdate!.filters).toContainEqual({
        kind: 'eq',
        col: 'status',
        val: 'submitted',
      });

      // Atomic claim via RPC, scoped to this tenant + the bundle's orders.
      expect(rpcCalls).toContainEqual({
        fn: 'claim_deferred_setup_trigger_args',
        args: { p_tenant_id: TENANT, p_order_ids: ['order-1', 'order-2'] },
      });

      // Trigger fired with both claimed args.
      expect(triggerCalls).toHaveLength(1);
      expect(triggerCalls[0]).toHaveLength(2);
      expect((triggerCalls[0] as Array<{ oliId: string }>)[0].oliId).toBe('oli-1');
      expect((triggerCalls[0] as Array<{ oliId: string }>)[1].oliId).toBe('oli-2');

      // No JS-side OLI clear update — the RPC does the clear atomically
      // inside SELECT FOR UPDATE.
      expect(updates.find((u) => u.table === 'order_line_items')).toBeUndefined();

      // Audit emitted.
      expect(auditInserts.some(
        (a) => a.event_type === 'bundle.deferred_setup_fired_on_approval',
      )).toBe(true);
    });

    it('flips orders even when no setup work was deferred (no requires_internal_setup lines)', async () => {
      const { service, updates, triggerCalls, auditInserts } = makeService({
        orders: [{ id: 'order-1', status: 'submitted' }],
        olis: [],
      });

      await withTenant(() => service.onApprovalDecided(BUNDLE, 'approved'));

      // Order status still flips.
      const orderUpdate = updates.find((u) => u.table === 'orders');
      expect(orderUpdate!.patch).toEqual({ status: 'approved' });

      // No trigger fire, no OLI clear.
      expect(triggerCalls).toHaveLength(0);
      expect(updates.find((u) => u.table === 'order_line_items')).toBeUndefined();

      // Marker audit so the timeline shows the approval was observed.
      expect(auditInserts.some(
        (a) => a.event_type === 'bundle.approval_approved_no_deferred_setup',
      )).toBe(true);
    });
  });

  describe('rejected decision', () => {
    it('flips submitted orders to cancelled, RPC clears args atomically, no trigger fire', async () => {
      const { service, updates, triggerCalls, auditInserts, rpcCalls } = makeService({
        orders: [{ id: 'order-1', status: 'submitted' }],
        olis: [
          { id: 'oli-1', pending_setup_trigger_args: SAMPLE_TRIGGER_ARGS },
        ],
      });

      await withTenant(() => service.onApprovalDecided(BUNDLE, 'rejected'));

      const orderUpdate = updates.find((u) => u.table === 'orders');
      expect(orderUpdate!.patch).toEqual({ status: 'cancelled' });

      // Trigger NOT fired on rejection — even though the RPC claimed args,
      // the rejection branch records the drop instead of firing.
      expect(triggerCalls).toHaveLength(0);

      // The RPC was still called — it atomically clears args so a stale
      // entry can't double-fire later. No JS-side OLI update.
      expect(rpcCalls.some((c) => c.fn === 'claim_deferred_setup_trigger_args')).toBe(true);
      expect(updates.find((u) => u.table === 'order_line_items')).toBeUndefined();

      expect(auditInserts.some(
        (a) => a.event_type === 'bundle.deferred_setup_dropped_on_rejection',
      )).toBe(true);
    });

    it('expires sibling pending approval rows on rejection', async () => {
      // Multi-approver bundle: when one approver rejects, the other peers'
      // pending rows should auto-expire so they don't sit in the approver's
      // queue forever.
      const { service, updates } = makeService({
        orders: [{ id: 'order-1', status: 'submitted' }],
        olis: [],
      });

      await withTenant(() => service.onApprovalDecided(BUNDLE, 'rejected'));

      const expireUpdate = updates.find((u) => u.table === 'approvals');
      expect(expireUpdate).toBeDefined();
      expect(expireUpdate!.patch).toMatchObject({ status: 'expired' });
      // Filter is scoped to (tenant, target=bundle, status='pending').
      expect(expireUpdate!.filters).toContainEqual({
        kind: 'eq',
        col: 'target_entity_id',
        val: BUNDLE,
      });
      expect(expireUpdate!.filters).toContainEqual({
        kind: 'eq',
        col: 'status',
        val: 'pending',
      });
    });

    it('does NOT expire sibling approvals on approval (peers were already approved by definition)', async () => {
      const { service, updates } = makeService({
        orders: [{ id: 'order-1', status: 'submitted' }],
        olis: [],
      });

      await withTenant(() => service.onApprovalDecided(BUNDLE, 'approved'));

      const expireUpdate = updates.find((u) => u.table === 'approvals');
      expect(expireUpdate).toBeUndefined();
    });
  });

  describe('idempotency / edge cases', () => {
    it('emits a marker audit when no orders are linked to the bundle', async () => {
      const { service, updates, triggerCalls, auditInserts } = makeService({
        orders: [],
        olis: [],
      });

      await withTenant(() => service.onApprovalDecided(BUNDLE, 'approved'));

      // No state changes.
      expect(updates).toHaveLength(0);
      expect(triggerCalls).toHaveLength(0);

      // Defensive marker so we can spot misrouted approvals in audit.
      expect(auditInserts.some(
        (a) => a.event_type === 'bundle.approval_approved_no_orders',
      )).toBe(true);
    });
  });

  describe('cancel/approve race (codex round 2)', () => {
    it('closes work orders that were created for OLIs cancelled mid-approve', async () => {
      // Race scenario:
      //   1. Approval grants → claim RPC commits (args nulled).
      //   2. cancelLine runs → closes existing tickets (none yet) → cancels OLI.
      //   3. triggerMany inserts a NEW ticket linked to the now-cancelled OLI.
      // Defensive close re-runs the close clause against fulfillment_status=
      // 'cancelled' OLIs to catch the orphaned ticket.
      const { service, updates, auditInserts } = makeService({
        orders: [{ id: 'order-1', status: 'submitted' }],
        olis: [
          { id: 'oli-1', pending_setup_trigger_args: SAMPLE_TRIGGER_ARGS },
        ],
        // Cancel cascade landed mid-flow; OLI is now cancelled.
        staleOliIds: ['oli-1'],
        closedTicketIds: ['ticket-orphaned-1'],
      });

      await withTenant(() => service.onApprovalDecided(BUNDLE, 'approved'));

      // Defensive close ran against tickets table.
      const ticketClose = updates.find((u) => u.table === 'tickets');
      expect(ticketClose).toBeDefined();
      expect(ticketClose!.patch).toMatchObject({ status_category: 'closed' });

      // Audit emits the race-detected event (medium severity for ops triage).
      expect(auditInserts.some(
        (a) => a.event_type === 'bundle.deferred_setup_closed_after_concurrent_cancel',
      )).toBe(true);
    });

    it('does NOT close anything when no OLI is cancelled (no race happened)', async () => {
      const { service, updates, auditInserts } = makeService({
        orders: [{ id: 'order-1', status: 'submitted' }],
        olis: [
          { id: 'oli-1', pending_setup_trigger_args: SAMPLE_TRIGGER_ARGS },
        ],
        staleOliIds: [],   // no cancellation in flight
      });

      await withTenant(() => service.onApprovalDecided(BUNDLE, 'approved'));

      expect(updates.find((u) => u.table === 'tickets')).toBeUndefined();
      expect(auditInserts.some(
        (a) => a.event_type === 'bundle.deferred_setup_closed_after_concurrent_cancel',
      )).toBe(false);
    });
  });
});

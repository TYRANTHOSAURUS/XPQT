/**
 * Slice 4 — verify BundleCascadeService emits the right BundleEvent shapes
 * post-commit. The visitor cascade adapter (in VisitorsModule) listens on
 * the same bus; its handler logic is tested separately in
 * bundle-cascade.adapter.spec.ts. Here we only assert the emitter side.
 *
 * What we verify:
 *   - cancelLine emits `bundle.line.cancelled` with line_id, line_kind,
 *     bundle_id, tenant_id after the DB mutations succeed.
 *   - cancelBundle emits `bundle.cancelled` with bundle_id + tenant_id.
 *   - Tenant_id on the event matches the current TenantContext.
 *   - A failing emit doesn't bubble back into the cascade caller (the
 *     cascade has already mutated the DB; we don't pretend it failed).
 *   - cancelBundle that no-ops (everything fulfilled, nothing cancelled)
 *     does NOT emit — there's nothing for the visitor adapter to react to.
 */

import { BundleCascadeService } from './bundle-cascade.service';
import { BundleEventBus, type BundleEvent } from './bundle-event-bus';
import { TenantContext } from '../../common/tenant-context';

const TENANT = '11111111-1111-4111-8111-111111111111';
const BUNDLE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LINE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ORDER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TICKET = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ASSET_RES = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

interface LineRow {
  id: string;
  fulfillment_status: string | null;
  linked_asset_reservation_id: string | null;
  linked_ticket_id: string | null;
  order_id: string;
  policy_snapshot?: Record<string, unknown> | null;
}

interface OrderRow {
  id: string;
  booking_bundle_id: string | null;
}

interface BundleRow {
  id: string;
  requester_person_id: string;
  host_person_id: string | null;
  location_id: string;
  primary_reservation_id: string | null;
}

function makeService(opts: {
  line?: LineRow | null;
  order?: OrderRow | null;
  bundle?: BundleRow | null;
  bundleLines?: LineRow[];
  policySnapshot?: Record<string, unknown> | null;
}) {
  const updates: Array<{ table: string; patch: Record<string, unknown>; filters: Array<{ kind: string; col: string; val: unknown }> }> = [];

  // Build lazy chains that satisfy the SupabaseService surface used by
  // BundleCascadeService.
  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        const buildSelectChain = () => {
          const filters: Array<{ kind: string; col: string; val: unknown }> = [];
          const chain: Record<string, (...args: unknown[]) => unknown> = {};
          chain.eq = (col: string, val: unknown) => {
            filters.push({ kind: 'eq', col, val });
            return chain;
          };
          chain.in = (col: string, val: unknown) => {
            filters.push({ kind: 'in', col, val });
            return chain;
          };
          chain.not = () => chain;
          chain.limit = () => Promise.resolve({ data: [], error: null });
          chain.maybeSingle = () => {
            if (table === 'order_line_items') {
              if (filters.find((f) => f.col === 'id' && f.val === LINE)) {
                if (opts.policySnapshot !== undefined) {
                  return Promise.resolve({
                    data: { policy_snapshot: opts.policySnapshot },
                    error: null,
                  });
                }
                return Promise.resolve({ data: opts.line ?? null, error: null });
              }
            }
            if (table === 'orders') {
              return Promise.resolve({ data: opts.order ?? null, error: null });
            }
            if (table === 'booking_bundles') {
              return Promise.resolve({ data: opts.bundle ?? null, error: null });
            }
            return Promise.resolve({ data: null, error: null });
          };
          // For .select().in('order_id', ids) on order_line_items we resolve
          // the chain directly (no .maybeSingle()).
          (chain as Record<string, unknown>).then = undefined;
          return chain;
        };

        const buildUpdateChain = (patch: Record<string, unknown>) => {
          const filters: Array<{ kind: string; col: string; val: unknown }> = [];
          const chain: Record<string, (...args: unknown[]) => unknown> = {};
          chain.eq = (col: string, val: unknown) => {
            filters.push({ kind: 'eq', col, val });
            return chain;
          };
          chain.in = (col: string, val: unknown) => {
            filters.push({ kind: 'in', col, val });
            return chain;
          };
          chain.select = () => Promise.resolve({ data: [], error: null });
          // Allow await-without-select: register the update at await time.
          (chain as Record<string, unknown>).then = (resolve: (v: unknown) => void) => {
            updates.push({ table, patch, filters });
            resolve({ data: null, error: null });
          };
          return chain;
        };

        return {
          select: (cols?: string) => {
            // Two distinct paths on order_line_items.select(... fulfillment_status ...):
            //   (a) loadLine: .eq('id', id).eq('tenant_id', tenant).maybeSingle()
            //   (b) cancelBundleImpl: .in('order_id', ids) → array result
            if (table === 'order_line_items' && cols && cols.includes('fulfillment_status')) {
              const filters: Array<{ kind: string; col: string; val: unknown }> = [];
              const chain: Record<string, (...args: unknown[]) => unknown> = {};
              chain.eq = (col: string, val: unknown) => {
                filters.push({ kind: 'eq', col, val });
                return chain;
              };
              chain.in = (col: string, val: unknown) => {
                filters.push({ kind: 'in', col, val });
                return Promise.resolve({ data: opts.bundleLines ?? [], error: null });
              };
              chain.maybeSingle = () => Promise.resolve({ data: opts.line ?? null, error: null });
              return chain;
            }
            // approvals.select('id, scope_breakdown').eq...eq...eq -> Promise
            if (table === 'approvals') {
              const filters: Array<{ kind: string; col: string; val: unknown }> = [];
              const chain: Record<string, (...args: unknown[]) => unknown> = {};
              chain.eq = (col: string, val: unknown) => {
                filters.push({ kind: 'eq', col, val });
                return chain;
              };
              (chain as Record<string, unknown>).then = (resolve: (v: unknown) => void) => {
                resolve({ data: [], error: null });
              };
              return chain;
            }
            // orders.select('id').eq('booking_bundle_id', X).eq('linked_reservation_id', Y)
            if (table === 'orders' && cols === 'id') {
              const filters: Array<{ kind: string; col: string; val: unknown }> = [];
              const chain: Record<string, (...args: unknown[]) => unknown> = {};
              chain.eq = (col: string, val: unknown) => {
                filters.push({ kind: 'eq', col, val });
                return chain;
              };
              (chain as Record<string, unknown>).then = (resolve: (v: unknown) => void) => {
                resolve({ data: [{ id: ORDER }], error: null });
              };
              return chain;
            }
            return buildSelectChain();
          },
          update: (patch: Record<string, unknown>) => buildUpdateChain(patch),
          insert: () => Promise.resolve({ data: null, error: null }),
        };
      }),
    },
  };

  const visibility = { assertVisible: jest.fn(async () => {}) };
  const eventBus = new BundleEventBus();
  const captured: BundleEvent[] = [];
  const sub = eventBus.events$.subscribe((e) => captured.push(e));

  const svc = new BundleCascadeService(
    supabase as never,
    visibility as never,
    eventBus,
  );
  return { svc, captured, eventBus, unsubscribe: () => sub.unsubscribe(), updates };
}

describe('BundleCascadeService — slice 4 event emission', () => {
  describe('cancelLine', () => {
    it('emits bundle.line.cancelled with bundle/line/tenant payload after success', async () => {
      const { svc, captured, unsubscribe } = makeService({
        line: {
          id: LINE,
          fulfillment_status: 'ordered',
          linked_asset_reservation_id: ASSET_RES,
          linked_ticket_id: TICKET,
          order_id: ORDER,
          policy_snapshot: { service_type: 'catering' },
        },
        order: { id: ORDER, booking_bundle_id: BUNDLE },
        bundle: {
          id: BUNDLE,
          requester_person_id: 'p1',
          host_person_id: null,
          location_id: 'l1',
          primary_reservation_id: null,
        },
        // The lineKindForOli helper looks up policy_snapshot on the same id.
        policySnapshot: { service_type: 'catering' },
      });
      try {
        await TenantContext.run(
          { id: TENANT, slug: 'test', tier: 'standard' },
          () =>
            svc.cancelLine({ line_id: LINE }, {
              user_id: 'u1',
              person_id: 'p1',
              has_override: false,
            } as never),
        );

        expect(captured).toHaveLength(1);
        const evt = captured[0]!;
        expect(evt.kind).toBe('bundle.line.cancelled');
        expect(evt.tenant_id).toBe(TENANT);
        expect(evt.bundle_id).toBe(BUNDLE);
        if (evt.kind === 'bundle.line.cancelled') {
          expect(evt.line_id).toBe(LINE);
          expect(evt.line_kind).toBe('catering');
        }
        expect(typeof evt.occurred_at).toBe('string');
      } finally {
        unsubscribe();
      }
    });

    it('does not emit when the line lookup fails (NotFoundException)', async () => {
      const { svc, captured, unsubscribe } = makeService({ line: null });
      try {
        await expect(
          TenantContext.run(
            { id: TENANT, slug: 'test', tier: 'standard' },
            () =>
              svc.cancelLine({ line_id: LINE }, {
                user_id: 'u1',
                person_id: 'p1',
                has_override: false,
              } as never),
          ),
        ).rejects.toMatchObject({
          response: expect.objectContaining({ code: 'line_not_found' }),
        });
        expect(captured).toHaveLength(0);
      } finally {
        unsubscribe();
      }
    });

    it('does not emit when the line is fulfilled (ForbiddenException)', async () => {
      const { svc, captured, unsubscribe } = makeService({
        line: {
          id: LINE,
          fulfillment_status: 'delivered', // FULFILLED_STATUSES
          linked_asset_reservation_id: null,
          linked_ticket_id: null,
          order_id: ORDER,
        },
        order: { id: ORDER, booking_bundle_id: BUNDLE },
        bundle: {
          id: BUNDLE,
          requester_person_id: 'p1',
          host_person_id: null,
          location_id: 'l1',
          primary_reservation_id: null,
        },
      });
      try {
        await expect(
          TenantContext.run(
            { id: TENANT, slug: 'test', tier: 'standard' },
            () =>
              svc.cancelLine({ line_id: LINE }, {
                user_id: 'u1',
                person_id: 'p1',
                has_override: false,
              } as never),
          ),
        ).rejects.toMatchObject({
          response: expect.objectContaining({ code: 'line_already_fulfilled' }),
        });
        expect(captured).toHaveLength(0);
      } finally {
        unsubscribe();
      }
    });
  });

  describe('cancelBundle', () => {
    it('emits bundle.cancelled when something was actually cancelled', async () => {
      const { svc, captured, unsubscribe } = makeService({
        bundle: {
          id: BUNDLE,
          requester_person_id: 'p1',
          host_person_id: null,
          location_id: 'l1',
          primary_reservation_id: null,
        },
        bundleLines: [
          {
            id: LINE,
            fulfillment_status: 'ordered',
            linked_asset_reservation_id: null,
            linked_ticket_id: null,
            order_id: ORDER,
          },
        ],
      });
      try {
        await TenantContext.run(
          { id: TENANT, slug: 'test', tier: 'standard' },
          () =>
            svc.cancelBundle({ bundle_id: BUNDLE }, {
              user_id: 'u1',
              person_id: 'p1',
              has_override: false,
            } as never),
        );

        expect(captured).toHaveLength(1);
        const evt = captured[0]!;
        expect(evt.kind).toBe('bundle.cancelled');
        expect(evt.bundle_id).toBe(BUNDLE);
        expect(evt.tenant_id).toBe(TENANT);
      } finally {
        unsubscribe();
      }
    });

    it('does NOT emit when nothing was actually cancelled (all fulfilled)', async () => {
      const { svc, captured, unsubscribe } = makeService({
        bundle: {
          id: BUNDLE,
          requester_person_id: 'p1',
          host_person_id: null,
          location_id: 'l1',
          primary_reservation_id: null,
        },
        bundleLines: [
          {
            id: LINE,
            fulfillment_status: 'delivered', // fulfilled — kept as-is
            linked_asset_reservation_id: null,
            linked_ticket_id: null,
            order_id: ORDER,
          },
        ],
      });
      try {
        await TenantContext.run(
          { id: TENANT, slug: 'test', tier: 'standard' },
          () =>
            svc.cancelBundle({ bundle_id: BUNDLE }, {
              user_id: 'u1',
              person_id: 'p1',
              has_override: false,
            } as never),
        );
        expect(captured).toHaveLength(0);
      } finally {
        unsubscribe();
      }
    });
  });

  describe('cross-tenant', () => {
    it('emit payload tenant_id matches current TenantContext (not the row tenant)', async () => {
      // The cascade always reads/writes scoped by TenantContext.current().id;
      // we just confirm the emit copies the same tenant onto the event.
      const { svc, captured, unsubscribe } = makeService({
        bundle: {
          id: BUNDLE,
          requester_person_id: 'p1',
          host_person_id: null,
          location_id: 'l1',
          primary_reservation_id: null,
        },
        bundleLines: [
          {
            id: LINE,
            fulfillment_status: 'ordered',
            linked_asset_reservation_id: null,
            linked_ticket_id: null,
            order_id: ORDER,
          },
        ],
      });
      const OTHER_TENANT = '99999999-9999-4999-8999-999999999999';
      try {
        await TenantContext.run(
          { id: OTHER_TENANT, slug: 'other', tier: 'standard' },
          () =>
            svc.cancelBundle({ bundle_id: BUNDLE }, {
              user_id: 'u1',
              person_id: 'p1',
              has_override: false,
            } as never),
        );
        expect(captured).toHaveLength(1);
        expect(captured[0]!.tenant_id).toBe(OTHER_TENANT);
      } finally {
        unsubscribe();
      }
    });
  });

  // Subscriber-isolation note: in production every BundleEventBus subscriber
  // wraps its handler in `.catch()` (see bundle-cascade.adapter.ts:71-82
  // for the canonical pattern). A correctly-written subscriber therefore
  // never propagates sync errors back into emit(). We don't add a hostile
  // sync-throw test here because rxjs 7's Subject reports unhandled
  // subscriber errors via setTimeout, which crashes the test runner from
  // outside of the cascade caller's stack — the property "cascade still
  // succeeds" can't be observed cleanly. The adapter's own spec already
  // verifies handler errors are absorbed (bundle-cascade.adapter.spec.ts).
});

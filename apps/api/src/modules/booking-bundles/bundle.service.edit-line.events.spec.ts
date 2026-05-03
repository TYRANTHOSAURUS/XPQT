/**
 * Slice 4 — verify BundleService.editLine emits `bundle.line.moved` when the
 * service window's start time shifts. Sister test to
 * bundle.service.edit-line.spec.ts (which covers the patch surface) and to
 * bundle-cascade.service.events.spec.ts (which covers cascade emits).
 *
 * What we verify:
 *   - Start-time shift on a bundle-attached line emits bundle.line.moved
 *     with old/new times + tenant_id + bundle_id + line_kind from policy
 *     snapshot.
 *   - No emit when the patch doesn't change the start time (quantity-only,
 *     notes-only, etc.).
 *   - No emit when the line isn't bundle-attached (orders.booking_id
 *     is null per 00278:109) — visitor cascade has nothing to react to.
 *   - The emit fires AFTER the UPDATE returns; a failed UPDATE doesn't emit.
 */

import { BundleService } from './bundle.service';
import { BundleEventBus, type BundleEvent } from './bundle-event-bus';
import { TenantContext } from '../../common/tenant-context';

const TENANT = '11111111-1111-4111-8111-111111111111';
const LINE_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ORDER_ID = 'cccccccc-1111-4111-8111-cccccccccccc';
const BUNDLE_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';

type LineRow = {
  id: string;
  tenant_id: string;
  order_id: string;
  quantity: number;
  unit_price: number | null;
  line_total: number | null;
  service_window_start_at: string | null;
  service_window_end_at: string | null;
  requester_notes: string | null;
  updated_at: string;
  fulfillment_status: string;
  linked_ticket_id: string | null;
};

function row(overrides: Partial<LineRow> = {}): LineRow {
  return {
    id: LINE_ID,
    tenant_id: TENANT,
    order_id: ORDER_ID,
    quantity: 5,
    unit_price: 10,
    line_total: 50,
    service_window_start_at: '2026-05-01T10:00:00.000Z',
    service_window_end_at: '2026-05-01T11:00:00.000Z',
    requester_notes: null,
    updated_at: '2026-04-30T10:00:00.000Z',
    fulfillment_status: 'ordered',
    linked_ticket_id: null,
    ...overrides,
  };
}

function makeService(opts: {
  loaded: LineRow | null;
  updated: LineRow | null;
  bundleId?: string | null;
  policySnapshot?: Record<string, unknown> | null;
  updateError?: Error;
}) {
  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        if (table === 'order_line_items') {
          return {
            select: (cols?: string) => {
              // policy_snapshot lookup → lineKindForOli helper
              if (cols && cols.includes('policy_snapshot')) {
                return {
                  eq: () => ({
                    eq: () => ({
                      maybeSingle: () =>
                        Promise.resolve({
                          data: { policy_snapshot: opts.policySnapshot ?? null },
                          error: null,
                        }),
                    }),
                  }),
                };
              }
              // initial loaded line — full select
              return {
                eq: () => ({
                  eq: () => ({
                    maybeSingle: () =>
                      Promise.resolve({ data: opts.loaded ?? null, error: null }),
                  }),
                }),
              };
            },
            update: () => {
              const chain: Record<string, (...args: unknown[]) => unknown> = {};
              chain.eq = () => chain;
              chain.select = () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: opts.updated ?? null,
                    error: opts.updateError ?? null,
                  }),
              });
              return chain;
            },
          };
        }
        if (table === 'orders') {
          // bundleIdForOrder reads `orders.booking_id` (column renamed
          // from `booking_bundle_id` in 00278:109; service:1691).
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () =>
                    Promise.resolve({
                      data: opts.bundleId === undefined
                        ? { booking_id: BUNDLE_ID }
                        : { booking_id: opts.bundleId },
                      error: null,
                    }),
                }),
              }),
            }),
          };
        }
        if (table === 'work_orders') {
          // window-shift SLA-cascade lookup (service:738) reads
          // work_orders directly post-cutover; tickets is no longer
          // touched here. Return empty so the cascade no-ops.
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  in: () => Promise.resolve({ data: [], error: null }),
                }),
              }),
            }),
          };
        }
        if (table === 'audit_events') {
          return { insert: () => Promise.resolve({ data: null, error: null }) };
        }
        throw new Error(`unexpected table in edit-line events test: ${table}`);
      }),
    },
  };

  const eventBus = new BundleEventBus();
  const captured: BundleEvent[] = [];
  const sub = eventBus.events$.subscribe((e) => captured.push(e));

  const svc = new BundleService(
    supabase as never,
    {} as never,
    {} as never,
    {} as never,
    eventBus,
  );
  return { svc, captured, eventBus, unsubscribe: () => sub.unsubscribe() };
}

describe('BundleService.editLine — slice 4 event emission', () => {
  it('emits bundle.line.moved with old/new expected_at when start_at changes', async () => {
    const oldStart = '2026-05-01T10:00:00.000Z';
    const newStart = '2026-05-01T14:00:00.000Z';
    const { svc, captured, unsubscribe } = makeService({
      loaded: row({ service_window_start_at: oldStart }),
      updated: row({ service_window_start_at: newStart }),
      policySnapshot: { service_type: 'catering' },
    });
    try {
      await TenantContext.run(
        { id: TENANT, slug: 'test', tier: 'standard' },
        () =>
          svc.editLine({
            line_id: LINE_ID,
            patch: { service_window_start_at: newStart },
          }),
      );

      expect(captured).toHaveLength(1);
      const evt = captured[0]!;
      expect(evt.kind).toBe('bundle.line.moved');
      expect(evt.tenant_id).toBe(TENANT);
      expect(evt.bundle_id).toBe(BUNDLE_ID);
      if (evt.kind === 'bundle.line.moved') {
        expect(evt.line_id).toBe(LINE_ID);
        expect(evt.line_kind).toBe('catering');
        expect(evt.old_expected_at).toBe(oldStart);
        expect(evt.new_expected_at).toBe(newStart);
      }
    } finally {
      unsubscribe();
    }
  });

  it('does not emit when patch leaves start_at unchanged (quantity-only)', async () => {
    const { svc, captured, unsubscribe } = makeService({
      loaded: row({ quantity: 5 }),
      updated: row({ quantity: 7, line_total: 70 }),
    });
    try {
      await TenantContext.run(
        { id: TENANT, slug: 'test', tier: 'standard' },
        () =>
          svc.editLine({
            line_id: LINE_ID,
            patch: { quantity: 7 },
          }),
      );
      expect(captured).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });

  it('does not emit when the line is not attached to a bundle', async () => {
    const oldStart = '2026-05-01T10:00:00.000Z';
    const newStart = '2026-05-01T14:00:00.000Z';
    const { svc, captured, unsubscribe } = makeService({
      loaded: row({ service_window_start_at: oldStart }),
      updated: row({ service_window_start_at: newStart }),
      bundleId: null, // order has no booking_bundle_id
    });
    try {
      await TenantContext.run(
        { id: TENANT, slug: 'test', tier: 'standard' },
        () =>
          svc.editLine({
            line_id: LINE_ID,
            patch: { service_window_start_at: newStart },
          }),
      );
      expect(captured).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });

  it('does not emit when the UPDATE was rejected (CAS / line moved underneath)', async () => {
    const oldStart = '2026-05-01T10:00:00.000Z';
    const newStart = '2026-05-01T14:00:00.000Z';
    // Updated returns null → simulates 0-row CAS-rejected write.
    const { svc, captured, unsubscribe } = makeService({
      loaded: row({ service_window_start_at: oldStart }),
      updated: null,
    });
    try {
      await expect(
        TenantContext.run(
          { id: TENANT, slug: 'test', tier: 'standard' },
          () =>
            svc.editLine({
              line_id: LINE_ID,
              patch: { service_window_start_at: newStart },
            }),
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'line_state_changed' }),
      });
      expect(captured).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });
});

/**
 * Booking-audit Slice 6 (audit 03 P1-4) — full rewrite.
 *
 * Pre-Slice-6 this spec asserted the in-process BundleEventBus emit shapes
 * (`bundle.line.cancelled` / `bundle.cancelled`). Those are GONE:
 * `cancelLine` / `cancelBundle` are now THIN wrappers over the atomic
 * `cancel_order_lines_with_cascade` RPC (00414), which owns the entire
 * cascade + (bundle path only) emits a DURABLE `bundle.services_cancelled`
 * outbox event IN-TX. The lossy in-process bus emit was removed (per-line:
 * a verified visitor no-op → dropped, no replacement; bundle: replaced by
 * the durable outbox event drained by BundleServicesCancelledCascadeHandler).
 *
 * What we verify here (the emitter/wrapper side):
 *   - cancelLine calls the RPC with p_line_ids=[line_id], p_keep_line_ids
 *     null, p_booking_id = the resolved bundle id, the tenant, and the
 *     threaded client_request_id (idempotency boundary).
 *   - cancelBundle calls the RPC with p_line_ids=null, p_keep_line_ids =
 *     args.keep_line_ids ?? null.
 *   - The return shape is preserved (legacy callers/controller unchanged).
 *   - Pre-checks still fire: line_not_found / bundle.line_not_in_bundle /
 *     missing client_request_id (server-class).
 *   - An RPC raise is mapped through mapRpcErrorToAppError (recognised
 *     dotted code → its registered status; unrecognised →
 *     booking.cancel_failed 500).
 *   - The durable outbox event is the RPC's job (in-tx) — there is NO
 *     in-process bus emit anymore. We assert the in-process bus is never
 *     touched (the wrapper no longer depends on it).
 */

import { BundleCascadeService } from './bundle-cascade.service';
import { TenantContext } from '../../common/tenant-context';

const TENANT = '11111111-1111-4111-8111-111111111111';
const BUNDLE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LINE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ORDER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CRID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
// Slice 6 fix-cycle (Fix C): the caller's auth_uid (JWT subject) — the
// controller threads req.user.id; the wrapper forwards it to the RPC as
// p_actor_user_id (F-CRIT-1 00414:192-205 resolves it to users.id).
const ACTOR_AUTH_UID = 'eeeeeeee-2222-4222-8222-eeeeeeeeeeee';

interface LineRow {
  id: string;
  fulfillment_status: string | null;
  linked_asset_reservation_id: string | null;
  linked_ticket_id: string | null;
  order_id: string;
}

interface OrderRow {
  id: string;
  booking_id: string | null;
}

interface BundleRow {
  id: string;
  requester_person_id: string;
  host_person_id: string | null;
  location_id: string;
}

function makeService(opts: {
  line?: LineRow | null;
  order?: OrderRow | null;
  bundle?: BundleRow | null;
  rpcResult?: Record<string, unknown>;
  rpcError?: { code?: string; message?: string } | null;
}) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

  const supabase = {
    admin: {
      rpc: jest.fn((fn: string, args: Record<string, unknown>) => {
        rpcCalls.push({ fn, args });
        return Promise.resolve({
          data:
            opts.rpcResult ??
            {
              cancelled_line_ids: [LINE],
              cascaded: { ticket_ids: [], asset_reservation_ids: [] },
              rescoped_approval_ids: [],
              expired_approval_ids: [],
              booking_cancelled: false,
              fulfilled_line_ids: [],
              kept_line_ids: [],
            },
          error: opts.rpcError ?? null,
        });
      }),
      from: jest.fn((table: string) => {
        const chain: Record<string, (...a: unknown[]) => unknown> = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.maybeSingle = () => {
          if (table === 'order_line_items') {
            return Promise.resolve({ data: opts.line ?? null, error: null });
          }
          if (table === 'orders') {
            return Promise.resolve({ data: opts.order ?? null, error: null });
          }
          if (table === 'bookings') {
            return Promise.resolve({ data: opts.bundle ?? null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        };
        return chain;
      }),
    },
  };

  const visibility = { assertVisible: jest.fn(async () => {}) };
  const svc = new BundleCascadeService(supabase as never, visibility as never);
  return { svc, rpcCalls, supabase };
}

const CTX = { user_id: 'u1', person_id: 'p1', has_override: false } as never;

describe('BundleCascadeService — Slice 6 RPC wrapper', () => {
  describe('cancelLine', () => {
    it('calls cancel_order_lines_with_cascade with the line id + threaded crid', async () => {
      const { svc, rpcCalls } = makeService({
        line: {
          id: LINE,
          fulfillment_status: 'ordered',
          linked_asset_reservation_id: null,
          linked_ticket_id: null,
          order_id: ORDER,
        },
        order: { id: ORDER, booking_id: BUNDLE },
        bundle: {
          id: BUNDLE,
          requester_person_id: 'p1',
          host_person_id: null,
          location_id: 'l1',
        },
      });

      const res = await TenantContext.run(
        { id: TENANT, slug: 'test', tier: 'standard' },
        () => svc.cancelLine({ line_id: LINE, client_request_id: CRID }, CTX),
      );

      expect(rpcCalls).toHaveLength(1);
      expect(rpcCalls[0]!.fn).toBe('cancel_order_lines_with_cascade');
      const a = rpcCalls[0]!.args;
      expect(a.p_booking_id).toBe(BUNDLE);
      expect(a.p_line_ids).toEqual([LINE]);
      expect(a.p_keep_line_ids).toBeNull();
      expect(a.p_tenant_id).toBe(TENANT);
      // No actor_auth_uid supplied (internal/system caller) → null;
      // F-CRIT-1 (00414:192) skips resolution on null.
      expect(a.p_actor_user_id).toBeNull();
      // booking:lines:cancel:<booking>:<crid>
      expect(a.p_idempotency_key).toBe(`booking:lines:cancel:${BUNDLE}:${CRID}`);

      // Legacy return shape preserved.
      expect(res.line_id).toBe(LINE);
      expect(res.cascaded).toEqual({ ticket_ids: [], asset_reservation_ids: [] });
      expect(res.closed_approval_ids).toEqual([]);
    });

    it('threads actor_auth_uid → p_actor_user_id (Fix C — F-CRIT-1 actor)', async () => {
      const { svc, rpcCalls } = makeService({
        line: {
          id: LINE,
          fulfillment_status: 'ordered',
          linked_asset_reservation_id: null,
          linked_ticket_id: null,
          order_id: ORDER,
        },
        order: { id: ORDER, booking_id: BUNDLE },
        bundle: {
          id: BUNDLE,
          requester_person_id: 'p1',
          host_person_id: null,
          location_id: 'l1',
        },
      });

      await TenantContext.run(
        { id: TENANT, slug: 'test', tier: 'standard' },
        () =>
          svc.cancelLine(
            { line_id: LINE, client_request_id: CRID, actor_auth_uid: ACTOR_AUTH_UID },
            CTX,
          ),
      );

      expect(rpcCalls).toHaveLength(1);
      // The wrapper forwards the controller's authUid as p_actor_user_id
      // (NOT users.id) — the RPC's F-CRIT-1 resolves it tenant-side.
      expect(rpcCalls[0]!.args.p_actor_user_id).toBe(ACTOR_AUTH_UID);
    });

    it('rejects line_not_found before touching the RPC', async () => {
      const { svc, rpcCalls } = makeService({ line: null });
      await expect(
        TenantContext.run(
          { id: TENANT, slug: 'test', tier: 'standard' },
          () => svc.cancelLine({ line_id: LINE, client_request_id: CRID }, CTX),
        ),
      ).rejects.toMatchObject({ code: 'line_not_found', status: 404 });
      expect(rpcCalls).toHaveLength(0);
    });

    it('rejects bundle.line_not_in_bundle when the line has no booking link', async () => {
      const { svc, rpcCalls } = makeService({
        line: {
          id: LINE,
          fulfillment_status: 'ordered',
          linked_asset_reservation_id: null,
          linked_ticket_id: null,
          order_id: ORDER,
        },
        order: { id: ORDER, booking_id: null },
      });
      await expect(
        TenantContext.run(
          { id: TENANT, slug: 'test', tier: 'standard' },
          () => svc.cancelLine({ line_id: LINE, client_request_id: CRID }, CTX),
        ),
      ).rejects.toMatchObject({ code: 'bundle.line_not_in_bundle', status: 404 });
      expect(rpcCalls).toHaveLength(0);
    });

    it('hard-fails (server-class) when no client_request_id is threaded', async () => {
      const { svc, rpcCalls } = makeService({
        line: {
          id: LINE,
          fulfillment_status: 'ordered',
          linked_asset_reservation_id: null,
          linked_ticket_id: null,
          order_id: ORDER,
        },
        order: { id: ORDER, booking_id: BUNDLE },
        bundle: {
          id: BUNDLE,
          requester_person_id: 'p1',
          host_person_id: null,
          location_id: 'l1',
        },
      });
      await expect(
        TenantContext.run(
          { id: TENANT, slug: 'test', tier: 'standard' },
          () => svc.cancelLine({ line_id: LINE }, CTX),
        ),
      ).rejects.toMatchObject({
        code: 'command_operations.unexpected_state',
        status: 500,
      });
      expect(rpcCalls).toHaveLength(0);
    });

    it('maps a recognised RPC raise through mapRpcErrorToAppError', async () => {
      const { svc } = makeService({
        line: {
          id: LINE,
          fulfillment_status: 'ordered',
          linked_asset_reservation_id: null,
          linked_ticket_id: null,
          order_id: ORDER,
        },
        order: { id: ORDER, booking_id: BUNDLE },
        bundle: {
          id: BUNDLE,
          requester_person_id: 'p1',
          host_person_id: null,
          location_id: 'l1',
        },
        rpcError: {
          code: 'P0001',
          message:
            'cancel_order_lines_with_cascade.line_already_fulfilled: line=x has been fulfilled',
        },
      });
      await expect(
        TenantContext.run(
          { id: TENANT, slug: 'test', tier: 'standard' },
          () => svc.cancelLine({ line_id: LINE, client_request_id: CRID }, CTX),
        ),
      ).rejects.toMatchObject({
        code: 'cancel_order_lines_with_cascade.line_already_fulfilled',
        status: 422,
      });
    });

    it('maps an unrecognised RPC raise to the booking.cancel_failed 500 fallback', async () => {
      const { svc } = makeService({
        line: {
          id: LINE,
          fulfillment_status: 'ordered',
          linked_asset_reservation_id: null,
          linked_ticket_id: null,
          order_id: ORDER,
        },
        order: { id: ORDER, booking_id: BUNDLE },
        bundle: {
          id: BUNDLE,
          requester_person_id: 'p1',
          host_person_id: null,
          location_id: 'l1',
        },
        rpcError: { code: 'XX000', message: 'some unmapped postgres error' },
      });
      await expect(
        TenantContext.run(
          { id: TENANT, slug: 'test', tier: 'standard' },
          () => svc.cancelLine({ line_id: LINE, client_request_id: CRID }, CTX),
        ),
      ).rejects.toMatchObject({ code: 'booking.cancel_failed', status: 500 });
    });
  });

  describe('cancelBundle', () => {
    it('calls the RPC with p_line_ids=null + p_keep_line_ids from args', async () => {
      const { svc, rpcCalls } = makeService({
        bundle: {
          id: BUNDLE,
          requester_person_id: 'p1',
          host_person_id: null,
          location_id: 'l1',
        },
        rpcResult: {
          cancelled_line_ids: [LINE],
          cascaded: { ticket_ids: ['t1'], asset_reservation_ids: ['ar1'] },
          rescoped_approval_ids: [],
          expired_approval_ids: ['ap1'],
          booking_cancelled: true,
          fulfilled_line_ids: [],
          kept_line_ids: [],
        },
      });

      const res = await TenantContext.run(
        { id: TENANT, slug: 'test', tier: 'standard' },
        () =>
          svc.cancelBundle(
            {
              bundle_id: BUNDLE,
              keep_line_ids: ['keep1'],
              client_request_id: CRID,
              actor_auth_uid: ACTOR_AUTH_UID,
            },
            CTX,
          ),
      );

      expect(rpcCalls).toHaveLength(1);
      const a = rpcCalls[0]!.args;
      expect(a.p_booking_id).toBe(BUNDLE);
      expect(a.p_line_ids).toBeNull();
      expect(a.p_keep_line_ids).toEqual(['keep1']);
      // Fix C: actor_auth_uid threads to p_actor_user_id.
      expect(a.p_actor_user_id).toBe(ACTOR_AUTH_UID);
      expect(a.p_idempotency_key).toBe(`booking:lines:cancel:${BUNDLE}:${CRID}`);

      // booking_cancelled → cancelled_reservation_ids carries the booking id.
      expect(res.cancelled_reservation_ids).toEqual([BUNDLE]);
      expect(res.cancelled_ticket_ids).toEqual(['t1']);
      expect(res.cancelled_asset_reservation_ids).toEqual(['ar1']);
      expect(res.closed_approval_ids).toEqual(['ap1']);
      expect(res.cancelled_line_ids).toEqual([LINE]);
    });

    it('passes p_keep_line_ids=null when no keep_line_ids supplied', async () => {
      const { svc, rpcCalls } = makeService({
        bundle: {
          id: BUNDLE,
          requester_person_id: 'p1',
          host_person_id: null,
          location_id: 'l1',
        },
        rpcResult: {
          cancelled_line_ids: [],
          cascaded: { ticket_ids: [], asset_reservation_ids: [] },
          rescoped_approval_ids: [],
          expired_approval_ids: [],
          booking_cancelled: false,
          fulfilled_line_ids: [],
          kept_line_ids: [],
        },
      });
      const res = await TenantContext.run(
        { id: TENANT, slug: 'test', tier: 'standard' },
        () => svc.cancelBundle({ bundle_id: BUNDLE, client_request_id: CRID }, CTX),
      );
      expect(rpcCalls[0]!.args.p_keep_line_ids).toBeNull();
      // booking not cancelled → no reservation id echoed.
      expect(res.cancelled_reservation_ids).toEqual([]);
    });

    it('hard-fails when no client_request_id is threaded', async () => {
      const { svc, rpcCalls } = makeService({
        bundle: {
          id: BUNDLE,
          requester_person_id: 'p1',
          host_person_id: null,
          location_id: 'l1',
        },
      });
      await expect(
        TenantContext.run(
          { id: TENANT, slug: 'test', tier: 'standard' },
          () => svc.cancelBundle({ bundle_id: BUNDLE }, CTX),
        ),
      ).rejects.toMatchObject({
        code: 'command_operations.unexpected_state',
        status: 500,
      });
      expect(rpcCalls).toHaveLength(0);
    });
  });

  describe('cross-tenant', () => {
    it('threads the current TenantContext id as p_tenant_id (not a row tenant)', async () => {
      const OTHER = '99999999-9999-4999-8999-999999999999';
      const { svc, rpcCalls } = makeService({
        bundle: {
          id: BUNDLE,
          requester_person_id: 'p1',
          host_person_id: null,
          location_id: 'l1',
        },
        rpcResult: {
          cancelled_line_ids: [],
          cascaded: { ticket_ids: [], asset_reservation_ids: [] },
          rescoped_approval_ids: [],
          expired_approval_ids: [],
          booking_cancelled: false,
          fulfilled_line_ids: [],
          kept_line_ids: [],
        },
      });
      await TenantContext.run(
        { id: OTHER, slug: 'other', tier: 'standard' },
        () => svc.cancelBundle({ bundle_id: BUNDLE, client_request_id: CRID }, CTX),
      );
      expect(rpcCalls[0]!.args.p_tenant_id).toBe(OTHER);
    });
  });
});

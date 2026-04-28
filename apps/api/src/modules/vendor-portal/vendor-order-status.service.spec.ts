import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AuditOutboxService } from '../privacy-compliance/audit-outbox.service';
import {
  VendorOrderStatusService,
  isVendorTransitionStatus,
} from './vendor-order-status.service';

const TENANT = 'a1b2c3d4-e5f6-4789-9abc-def012345678';
const VENDOR = 'b2c3d4e5-f6a7-4b89-8cde-f0123456789a';
const VENDOR_USER = 'd4e5f6a7-b8c9-4d0e-8f01-23456789abcd';
const ORDER_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

interface FakeOptions {
  /** Lines returned by the snapshot SELECT inside the tx. */
  lines?: Array<{ id: string; fulfillment_status: string }>;
}

function makeFakeDb(opts: FakeOptions = {}) {
  const captured: Array<{ sql: string; params?: unknown[]; tx?: boolean }> = [];

  const lines = opts.lines ?? [
    { id: 'line-1', fulfillment_status: 'ordered' },
    { id: 'line-2', fulfillment_status: 'ordered' },
  ];

  const txClient = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params, tx: true });

      // Snapshot select with FOR UPDATE
      if (sql.includes('select id, fulfillment_status') && sql.includes('for update')) {
        return { rows: lines, rowCount: lines.length };
      }
      // Status UPDATE returning changed rows
      if (sql.includes('update order_line_items') && sql.includes('set fulfillment_status')) {
        const newStatus = params?.[3];
        const changed = lines
          .filter((l) => l.fulfillment_status !== newStatus)
          .map((l) => ({ id: l.id, prior_status: newStatus as string }));
        return { rows: changed, rowCount: changed.length };
      }
      // Decline UPDATE
      if (sql.includes('update order_line_items') && sql.includes("set fulfillment_status      = 'cancelled'")) {
        const declinable = lines
          .filter((l) => l.fulfillment_status !== 'delivered' && l.fulfillment_status !== 'cancelled')
          .map((l) => ({ id: l.id }));
        return { rows: declinable, rowCount: declinable.length };
      }
      if (sql.includes('insert into vendor_order_status_events')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('insert into audit_outbox')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };

  return {
    captured,
    txClient,
    query: jest.fn(),
    queryOne: jest.fn(),
    queryMany: jest.fn(),
    rpc: jest.fn(),
    tx: jest.fn(async (fn: (c: typeof txClient) => Promise<unknown>) => fn(txClient)),
  };
}

function buildSvc(opts: FakeOptions = {}) {
  const db = makeFakeDb(opts);
  return { db, svc: new VendorOrderStatusService(db as never, new AuditOutboxService(db as never)) };
}

// =====================================================================
// isVendorTransitionStatus — closed enum guard
// =====================================================================

describe('isVendorTransitionStatus', () => {
  it.each(['confirmed', 'preparing', 'en_route', 'delivered'])(
    'accepts %s', (s) => { expect(isVendorTransitionStatus(s)).toBe(true); });

  it.each(['ordered', 'cancelled', 'pwned', '', 'CONFIRMED'])(
    'rejects %s', (s) => { expect(isVendorTransitionStatus(s)).toBe(false); });
});

// =====================================================================
// updateStatus — happy path + invalid transitions
// =====================================================================

describe('VendorOrderStatusService.updateStatus', () => {
  it('rejects an invalid target status with a 400', async () => {
    const { svc } = buildSvc();
    await expect(svc.updateStatus({
      tenantId: TENANT, vendorId: VENDOR, orderId: ORDER_ID,
      newStatus: 'delivered_xyz', vendorUserId: VENDOR_USER,
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws 404 when no lines for this vendor on the order', async () => {
    const { svc } = buildSvc({ lines: [] });
    await expect(svc.updateStatus({
      tenantId: TENANT, vendorId: VENDOR, orderId: ORDER_ID,
      newStatus: 'preparing', vendorUserId: VENDOR_USER,
    })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('happy path ordered → preparing transitions every line + emits one audit event', async () => {
    const { svc, db } = buildSvc({
      lines: [
        { id: 'L1', fulfillment_status: 'ordered' },
        { id: 'L2', fulfillment_status: 'ordered' },
      ],
    });
    const r = await svc.updateStatus({
      tenantId: TENANT, vendorId: VENDOR, orderId: ORDER_ID,
      newStatus: 'preparing', vendorUserId: VENDOR_USER,
    });
    expect(r.lines_updated).toBe(2);
    expect(r.to_status).toBe('preparing');

    const txSqls = db.captured.filter((c) => c.tx).map((c) => c.sql);
    expect(txSqls.some((s) => s.includes('update order_line_items'))).toBe(true);
    // Exactly N status_events rows + 1 audit emit
    const events = db.captured.filter((c) => c.tx && c.sql.includes('insert into vendor_order_status_events'));
    expect(events).toHaveLength(2);
    const audits = db.captured.filter((c) => c.tx && c.sql.includes('insert into audit_outbox'));
    expect(audits).toHaveLength(1);
    expect(audits[0].params?.[1]).toBe('vendor.order_status_updated');
  });

  it('rejects backward transition (delivered → preparing)', async () => {
    const { svc } = buildSvc({
      lines: [{ id: 'L1', fulfillment_status: 'delivered' }],
    });
    await expect(svc.updateStatus({
      tenantId: TENANT, vendorId: VENDOR, orderId: ORDER_ID,
      newStatus: 'preparing', vendorUserId: VENDOR_USER,
    })).rejects.toThrow(/Cannot transition/);
  });

  it('rejects when ANY line is in an incompatible state', async () => {
    const { svc } = buildSvc({
      lines: [
        { id: 'L1', fulfillment_status: 'ordered' },
        { id: 'L2', fulfillment_status: 'cancelled' },     // can't move out of cancelled
      ],
    });
    await expect(svc.updateStatus({
      tenantId: TENANT, vendorId: VENDOR, orderId: ORDER_ID,
      newStatus: 'preparing', vendorUserId: VENDOR_USER,
    })).rejects.toThrow(/Cannot transition.*cancelled/);
  });

  it('allows leap from ordered to delivered (one-tap accept-and-complete)', async () => {
    const { svc } = buildSvc({
      lines: [{ id: 'L1', fulfillment_status: 'ordered' }],
    });
    const r = await svc.updateStatus({
      tenantId: TENANT, vendorId: VENDOR, orderId: ORDER_ID,
      newStatus: 'delivered', vendorUserId: VENDOR_USER,
    });
    expect(r.to_status).toBe('delivered');
    expect(r.lines_updated).toBe(1);
  });

  it('treats already-at-target as no-op for that line; updates the rest', async () => {
    const { svc, db } = buildSvc({
      lines: [
        { id: 'L1', fulfillment_status: 'preparing' },     // already there
        { id: 'L2', fulfillment_status: 'ordered' },        // needs to advance
      ],
    });
    const r = await svc.updateStatus({
      tenantId: TENANT, vendorId: VENDOR, orderId: ORDER_ID,
      newStatus: 'preparing', vendorUserId: VENDOR_USER,
    });
    expect(r.lines_updated).toBe(1);
    // Only the line that actually changed gets a status_events row.
    const events = db.captured.filter((c) => c.tx && c.sql.includes('insert into vendor_order_status_events'));
    expect(events).toHaveLength(1);
  });
});

// =====================================================================
// decline
// =====================================================================

describe('VendorOrderStatusService.decline', () => {
  it('rejects short reasons', async () => {
    const { svc } = buildSvc();
    await expect(svc.decline({
      tenantId: TENANT, vendorId: VENDOR, orderId: ORDER_ID,
      reason: 'short', vendorUserId: VENDOR_USER,
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when ANY line is already terminal', async () => {
    const { svc } = buildSvc({
      lines: [
        { id: 'L1', fulfillment_status: 'ordered' },
        { id: 'L2', fulfillment_status: 'delivered' },
      ],
    });
    await expect(svc.decline({
      tenantId: TENANT, vendorId: VENDOR, orderId: ORDER_ID,
      reason: 'kitchen out of stock for the requested item',
      vendorUserId: VENDOR_USER,
    })).rejects.toThrow(/already in terminal state/);
  });

  it('throws 404 when no lines for this vendor on the order', async () => {
    const { svc } = buildSvc({ lines: [] });
    await expect(svc.decline({
      tenantId: TENANT, vendorId: VENDOR, orderId: ORDER_ID,
      reason: 'kitchen out of stock for the requested item',
      vendorUserId: VENDOR_USER,
    })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('happy path cancels every non-terminal line + flags requires_phone_followup + emits audit', async () => {
    const { svc, db } = buildSvc({
      lines: [
        { id: 'L1', fulfillment_status: 'ordered' },
        { id: 'L2', fulfillment_status: 'preparing' },
      ],
    });
    const r = await svc.decline({
      tenantId: TENANT, vendorId: VENDOR, orderId: ORDER_ID,
      reason: 'kitchen out of stock for the requested item',
      vendorUserId: VENDOR_USER,
    });
    expect(r.to_status).toBe('cancelled');
    expect(r.lines_declined).toBe(2);
    expect(r.requires_phone_followup).toBe(true);

    const update = db.captured.find((c) => c.tx && c.sql.includes('update order_line_items'));
    expect(update?.sql).toMatch(/requires_phone_followup\s*=\s*true/);

    const audits = db.captured.filter((c) => c.tx && c.sql.includes('insert into audit_outbox'));
    expect(audits).toHaveLength(1);
    expect(audits[0].params?.[1]).toBe('vendor.order_declined');
  });
});

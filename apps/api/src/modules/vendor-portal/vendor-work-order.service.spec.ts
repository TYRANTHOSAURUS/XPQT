import {
  VendorWorkOrderService,
  type VendorWorkOrderListItem,
} from './vendor-work-order.service';

const TENANT = 'a1b2c3d4-e5f6-4789-9abc-def012345678';
const VENDOR_A = 'b2c3d4e5-f6a7-4b89-8cde-f0123456789a';
const VENDOR_B = 'c3d4e5f6-a7b8-4c9d-9ef0-123456789abc';

interface CapturedQuery {
  sql: string;
  params?: unknown[];
}

function makeFakeDb(rowsByVendor: Record<string, VendorWorkOrderListItem[]>) {
  const captured: CapturedQuery[] = [];
  const queryMany = jest.fn(async <T>(sql: string, params?: unknown[]) => {
    captured.push({ sql, params });
    const vendorId = params?.[0] as string | undefined;
    return ((vendorId && rowsByVendor[vendorId]) ?? []) as T[];
  });
  return {
    db: { queryMany } as unknown as ConstructorParameters<typeof VendorWorkOrderService>[0],
    captured,
  };
}

function makeWorkOrder(overrides: Partial<VendorWorkOrderListItem> = {}): VendorWorkOrderListItem {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    external_ref: '11111111-1111-4111-8111-111111111111',
    due_at: '2026-04-30T10:00:00.000Z',
    location: 'Boardroom · 1F · HQ',
    label: 'AV setup',
    status: 'assigned',
    priority: 'medium',
    sla_at_risk: false,
    ...overrides,
  };
}

describe('VendorWorkOrderService', () => {
  it('scopes results to (tenant, vendor) via tickets_visible_for_vendor', async () => {
    const myRow = makeWorkOrder({ id: 'mine' });
    const otherRow = makeWorkOrder({ id: 'other' });
    const { db, captured } = makeFakeDb({
      [VENDOR_A]: [myRow],
      [VENDOR_B]: [otherRow],
    });
    const svc = new VendorWorkOrderService(db);

    const result = await svc.listForVendor({
      tenantId: TENANT,
      vendorId: VENDOR_A,
      fromDate: '2026-04-29',
      toDate: '2026-05-13',
    });

    expect(result).toEqual([myRow]);
    expect(captured).toHaveLength(1);
    expect(captured[0].sql).toContain('public.tickets_visible_for_vendor($1::uuid, $2::uuid)');
    expect(captured[0].params).toEqual([
      VENDOR_A,
      TENANT,
      '2026-04-29',
      '2026-05-13',
      null,
    ]);
  });

  it('returns empty array when the vendor has no assignments', async () => {
    const { db } = makeFakeDb({});
    const svc = new VendorWorkOrderService(db);
    const result = await svc.listForVendor({
      tenantId: TENANT,
      vendorId: VENDOR_A,
      fromDate: '2026-04-29',
      toDate: '2026-05-13',
    });
    expect(result).toEqual([]);
  });

  it('passes a recognised status filter through', async () => {
    const { db, captured } = makeFakeDb({});
    const svc = new VendorWorkOrderService(db);
    await svc.listForVendor({
      tenantId: TENANT,
      vendorId: VENDOR_A,
      fromDate: '2026-04-29',
      toDate: '2026-05-13',
      statusFilter: 'in_progress',
    });
    expect(captured[0].params?.[4]).toBe('in_progress');
  });

  it('drops an unrecognised status filter to null (no SQL leakage)', async () => {
    const { db, captured } = makeFakeDb({});
    const svc = new VendorWorkOrderService(db);
    await svc.listForVendor({
      tenantId: TENANT,
      vendorId: VENDOR_A,
      fromDate: '2026-04-29',
      toDate: '2026-05-13',
      statusFilter: "'; drop table tickets; --",
    });
    expect(captured[0].params?.[4]).toBeNull();
  });

  it('does not include any PII columns in the projection', async () => {
    const { db, captured } = makeFakeDb({});
    const svc = new VendorWorkOrderService(db);
    await svc.listForVendor({
      tenantId: TENANT,
      vendorId: VENDOR_A,
      fromDate: '2026-04-29',
      toDate: '2026-05-13',
    });
    const sql = captured[0].sql;
    // Whitelist of columns we explicitly project. Anything else means a
    // PII leak through projection drift — fail the test so a reviewer is
    // forced to update the whitelist consciously.
    const PROJECTED_COLUMNS = [
      'id',
      'external_ref',
      'due_at',
      'location',
      'label',
      'status',
      'priority',
      'sla_at_risk',
    ];
    for (const col of PROJECTED_COLUMNS) {
      expect(sql).toContain(`as ${col}`);
    }
    // PII fields and free-text columns that must NOT appear:
    for (const banned of [
      't.title',                  // operator-authored, can carry PII
      'requester_person_id',
      'watchers',
      'assigned_user_id',
      'description',
      'form_data',
      'satisfaction_rating',
      'satisfaction_comment',
    ]) {
      expect(sql).not.toContain(banned);
    }
  });
});

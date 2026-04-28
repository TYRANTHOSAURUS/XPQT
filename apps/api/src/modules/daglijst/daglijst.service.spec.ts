import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AuditOutboxService } from '../privacy-compliance/audit-outbox.service';
import { DaglijstService } from './daglijst.service';
import { PdfRendererService } from './pdf-renderer.service';

/**
 * Sprint 2 added: SupabaseService + PdfRenderer + DaglijstMailer to the
 * constructor. Sprint 1 tests only exercised assemble + record, neither
 * of which touches Storage / PDF / mail — so we pass minimal stubs.
 */
const stubSupabase = { admin: { storage: { from: () => ({}) } } } as never;
const stubPdfRenderer = { renderDaglijst: jest.fn() } as unknown as PdfRendererService;
const stubMailer = { sendDaglijst: jest.fn() } as never;

function buildSvc(db: unknown) {
  return new DaglijstService(
    db as never,
    stubSupabase,
    new AuditOutboxService(db as never),
    stubPdfRenderer,
    stubMailer,
  );
}

const TENANT = 'a1b2c3d4-e5f6-4789-9abc-def012345678';
const VENDOR = 'b2c3d4e5-f6a7-4b89-8cde-f0123456789a';
const BUILDING = 'c3d4e5f6-a7b8-4c9d-9ef0-123456789abc';
const USER = 'd4e5f6a7-b8c9-4d0e-8f01-23456789abcd';
const LIST_DATE = '2026-05-01';

interface VendorOverrides {
  fulfillment_mode?: 'portal' | 'paper_only' | 'hybrid';
  daglijst_email?: string | null;
  name?: string;
}

interface FakeSetup {
  vendor?: VendorOverrides | null;
  lines?: Array<{
    line_id?: string;
    catalog_item_name?: string;
    quantity?: number;
    requester_first_name?: string | null;
  }>;
  /** Existing max version for the bucket; default 0 (no prior). */
  existingVersion?: number;
}

function makeFakeDb(setup: FakeSetup = {}) {
  const captured: Array<{ sql: string; params?: unknown[]; tx?: boolean }> = [];

  const vendor = setup.vendor === null
    ? null
    : {
        id: VENDOR,
        name: setup.vendor?.name ?? 'Acme Catering',
        fulfillment_mode: setup.vendor?.fulfillment_mode ?? 'paper_only',
        daglijst_email: setup.vendor?.daglijst_email ?? 'orders@acme.example',
        daglijst_language: 'nl',
        daglijst_cutoff_offset_minutes: 180,
        daglijst_send_clock_time: null,
      };

  const lines = (setup.lines ?? [
    { line_id: 'line-1', catalog_item_name: 'Sandwiches', quantity: 12, requester_first_name: 'Jan' },
    { line_id: 'line-2', catalog_item_name: 'Coffee carafe', quantity: 2, requester_first_name: 'Maria' },
  ]).map((l) => ({
    line_id: l.line_id ?? `line-${Math.random()}`,
    order_id: 'order-1',
    catalog_item_id: 'ci-1',
    catalog_item_name: l.catalog_item_name ?? 'Item',
    quantity: l.quantity ?? 1,
    dietary_notes: null,
    fulfillment_status: 'ordered',
    service_window_start_at: null,
    service_window_end_at: null,
    menu_item_id: null,
    delivery_location_id: BUILDING,
    delivery_date: LIST_DATE,
    delivery_time: '12:00',
    headcount: null,
    requested_for_start_at: null,
    requested_for_end_at: null,
    requester_first_name: l.requester_first_name ?? null,
    delivery_location_name: 'Boardroom 4',
  }));

  const txClient = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params, tx: true });
      // pg_advisory_xact_lock — no-op return.
      if (sql.includes('pg_advisory_xact_lock')) {
        return { rows: [], rowCount: 0 };
      }
      // max(version) for the bucket
      if (sql.includes('select max(version)')) {
        return { rows: [{ version: setup.existingVersion ?? 0 }], rowCount: 1 };
      }
      // recipient email lookup inside tx
      if (sql.includes('select daglijst_email from vendors')) {
        return { rows: [{ daglijst_email: vendor?.daglijst_email ?? null }], rowCount: 1 };
      }
      // insert daglijst row
      if (sql.includes('insert into vendor_daily_lists')) {
        return {
          rows: [{
            id: 'daglijst-1',
            tenant_id: TENANT,
            vendor_id: VENDOR,
            building_id: (params?.[2] as string | null) ?? null,
            service_type: params?.[3],
            list_date: params?.[4],
            version: params?.[5],
            payload: JSON.parse(params?.[6] as string),
            generated_by_user_id: params?.[7] ?? null,
            recipient_email: params?.[8] ?? null,
            email_status: 'never_sent',
            generated_at: new Date().toISOString(),
            sent_at: null,
            email_message_id: null,
            email_error: null,
            pdf_storage_path: null,
            pdf_url_expires_at: null,
            created_at: new Date().toISOString(),
          }],
          rowCount: 1,
        };
      }
      // line-locking update
      if (sql.includes('update order_line_items')) {
        return { rows: [], rowCount: 0 };
      }
      // audit_outbox insert (from emitTx)
      if (sql.includes('insert into audit_outbox')) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };

  return {
    captured,
    txClient,
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }),
    queryOne: jest.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('from vendors')) return vendor;
      if (sql.includes('from spaces')) return { id: BUILDING, name: 'HQ Tower' };
      return null;
    }),
    queryMany: jest.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('from order_line_items')) return lines;
      return [];
    }),
    rpc: jest.fn(),
    tx: jest.fn(async (fn: (c: typeof txClient) => Promise<unknown>) => fn(txClient)),
  };
}

describe('DaglijstService.assemble', () => {
  it('throws NotFoundException when vendor missing', async () => {
    const db = makeFakeDb({ vendor: null });
    const svc = buildSvc(db);
    await expect(
      svc.assemble({ tenantId: TENANT, vendorId: VENDOR, buildingId: BUILDING, serviceType: 'catering', listDate: LIST_DATE }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects portal-only vendor', async () => {
    const db = makeFakeDb({ vendor: { fulfillment_mode: 'portal' } });
    const svc = buildSvc(db);
    await expect(
      svc.assemble({ tenantId: TENANT, vendorId: VENDOR, buildingId: BUILDING, serviceType: 'catering', listDate: LIST_DATE }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('produces a payload with first-name-only requester (privacy)', async () => {
    const db = makeFakeDb({
      lines: [{ line_id: 'L1', catalog_item_name: 'Sandwiches', quantity: 12, requester_first_name: 'Jan' }],
    });
    const svc = buildSvc(db);
    const payload = await svc.assemble({
      tenantId: TENANT, vendorId: VENDOR, buildingId: BUILDING,
      serviceType: 'catering', listDate: LIST_DATE,
    });
    expect(payload.total_lines).toBe(1);
    expect(payload.lines[0].requester_first_name).toBe('Jan');
    expect(payload.lines[0]).not.toHaveProperty('requester_last_name');
    expect(payload.lines[0]).not.toHaveProperty('requester_email');
  });

  it('aggregates total_quantity across lines', async () => {
    const db = makeFakeDb({
      lines: [
        { line_id: 'L1', quantity: 12 },
        { line_id: 'L2', quantity: 5 },
        { line_id: 'L3', quantity: 7 },
      ],
    });
    const svc = buildSvc(db);
    const payload = await svc.assemble({
      tenantId: TENANT, vendorId: VENDOR, buildingId: BUILDING,
      serviceType: 'catering', listDate: LIST_DATE,
    });
    expect(payload.total_quantity).toBe(24);
    expect(payload.total_lines).toBe(3);
  });
});

describe('DaglijstService.record', () => {
  it('writes a v1 row when no prior version exists', async () => {
    const db = makeFakeDb({ existingVersion: 0 });
    const svc = buildSvc(db);
    const payload = {
      tenant_id: TENANT,
      vendor: { id: VENDOR, name: 'Acme', language: 'nl' },
      building: { id: BUILDING, name: 'HQ' },
      service_type: 'catering',
      list_date: LIST_DATE,
      assembled_at: new Date().toISOString(),
      total_lines: 2,
      total_quantity: 14,
      lines: [
        { line_id: 'L1', order_id: 'O1', catalog_item_id: 'C1', catalog_item_name: 'Sandwich', quantity: 12, dietary_notes: null, delivery_time: '12:00', delivery_window: null, delivery_location_name: 'BR4', requester_first_name: 'Jan', headcount: null },
        { line_id: 'L2', order_id: 'O1', catalog_item_id: 'C2', catalog_item_name: 'Coffee', quantity: 2, dietary_notes: null, delivery_time: '12:00', delivery_window: null, delivery_location_name: 'BR4', requester_first_name: 'Jan', headcount: null },
      ],
    };
    const r = await svc.record({
      tenantId: TENANT, vendorId: VENDOR, buildingId: BUILDING,
      serviceType: 'catering', listDate: LIST_DATE,
      payload, triggeredBy: 'auto',
    });
    expect(r.version).toBe(1);
    expect(r.email_status).toBe('never_sent');

    // Verify the tx contained: advisory lock, version lookup, recipient lookup,
    // insert, audit emit. Line-locking is INTENTIONALLY NOT in record() — it
    // happens on the send path in Sprint 2 ("lock on send" per spec).
    const txSqls = db.captured.filter((c) => c.tx).map((c) => c.sql);
    expect(txSqls.some((s) => s.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(txSqls.some((s) => s.includes('select max(version)'))).toBe(true);
    expect(txSqls.some((s) => s.includes('insert into vendor_daily_lists'))).toBe(true);
    expect(txSqls.some((s) => s.includes('insert into audit_outbox'))).toBe(true);
    // Critical: NO line lock on record — that's Sprint 2 send-path territory.
    expect(txSqls.some((s) => s.includes('update order_line_items'))).toBe(false);
  });

  it('bumps to v2 when a prior version exists, and the audit event reflects regenerate', async () => {
    const db = makeFakeDb({ existingVersion: 1 });
    const svc = buildSvc(db);
    const payload = {
      tenant_id: TENANT,
      vendor: { id: VENDOR, name: 'Acme', language: 'nl' },
      building: null,
      service_type: 'catering',
      list_date: LIST_DATE,
      assembled_at: new Date().toISOString(),
      total_lines: 1,
      total_quantity: 1,
      lines: [{ line_id: 'L1', order_id: 'O1', catalog_item_id: 'C1', catalog_item_name: 'X', quantity: 1, dietary_notes: null, delivery_time: null, delivery_window: null, delivery_location_name: null, requester_first_name: null, headcount: null }],
    };
    const r = await svc.record({
      tenantId: TENANT, vendorId: VENDOR, buildingId: null,
      serviceType: 'catering', listDate: LIST_DATE,
      payload, triggeredBy: 'admin_manual', generatedByUserId: USER,
    });
    expect(r.version).toBe(2);

    const auditEmit = db.captured.find((c) => c.tx && c.sql.includes('insert into audit_outbox'));
    expect(auditEmit).toBeDefined();
    // event_type is the second parameter of the outbox insert.
    expect(auditEmit?.params?.[1]).toBe('daglijst.regenerated');
  });
});

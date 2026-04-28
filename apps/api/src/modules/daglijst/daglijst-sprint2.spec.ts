import { BadRequestException } from '@nestjs/common';
import { AuditOutboxService } from '../privacy-compliance/audit-outbox.service';
import {
  DaglijstService,
  type VendorDailyListRow,
} from './daglijst.service';

const TENANT = 'a1b2c3d4-e5f6-4789-9abc-def012345678';
const VENDOR = 'b2c3d4e5-f6a7-4b89-8cde-f0123456789a';
const DAGLIJST = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function makeRow(overrides: Partial<VendorDailyListRow> = {}): VendorDailyListRow {
  return {
    id: DAGLIJST,
    tenant_id: TENANT,
    vendor_id: VENDOR,
    building_id: 'cafeteria-id',
    service_type: 'catering',
    list_date: '2026-05-01',
    version: 1,
    payload: {
      tenant_id: TENANT,
      vendor: { id: VENDOR, name: 'Acme Catering', language: 'nl' },
      building: { id: 'cafeteria-id', name: 'HQ Tower' },
      service_type: 'catering',
      list_date: '2026-05-01',
      assembled_at: '2026-04-30T18:00:00Z',
      total_lines: 2,
      total_quantity: 14,
      lines: [
        { line_id: 'L1', order_id: 'O1', catalog_item_id: 'C1', catalog_item_name: 'Sandwich', quantity: 12, dietary_notes: null, delivery_time: '12:00', delivery_window: null, delivery_location_name: 'Boardroom 4', requester_first_name: 'Jan', headcount: 12 },
        { line_id: 'L2', order_id: 'O1', catalog_item_id: 'C2', catalog_item_name: 'Coffee', quantity: 2, dietary_notes: null, delivery_time: '12:00', delivery_window: null, delivery_location_name: 'Boardroom 4', requester_first_name: 'Jan', headcount: 12 },
      ],
    },
    pdf_storage_path: null,
    pdf_url_expires_at: null,
    generated_at: '2026-04-30T18:00:00Z',
    generated_by_user_id: null,
    sent_at: null,
    recipient_email: 'orders@acme.example',
    email_message_id: null,
    email_status: 'never_sent',
    email_error: null,
    created_at: '2026-04-30T18:00:00Z',
    ...overrides,
  };
}

interface FakeOptions {
  row?: VendorDailyListRow | null;
  /** When true, mailer.sendDaglijst throws. */
  mailerFails?: boolean;
  /** Storage upload returns an error (string = error message). */
  uploadError?: string | null;
  /** createSignedUrl returns an error (string = error message). */
  signedUrlError?: string | null;
}

function makeFakeDb(opts: FakeOptions = {}) {
  const captured: Array<{ sql: string; params?: unknown[]; tx?: boolean }> = [];

  const txClient = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params, tx: true });
      if (sql.includes('update vendor_daily_lists')) {
        return { rows: [makeRow({ sent_at: new Date().toISOString(), email_status: 'sent', email_message_id: params?.[2] as string })], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };

  return {
    captured,
    txClient,
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      // renderAndUpload UPDATE
      if (sql.includes('update vendor_daily_lists') && sql.includes('pdf_storage_path = $3')) {
        return { rows: [makeRow({ pdf_storage_path: params?.[2] as string, ...opts.row })], rowCount: 1 };
      }
      // failure UPDATE (no returning)
      if (sql.includes('update vendor_daily_lists') && sql.includes("'failed'")) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    queryOne: jest.fn(async (sql: string, params?: unknown[]) => {
      const base = opts.row ?? makeRow();
      // getById path
      if (sql.includes('select * from vendor_daily_lists')) {
        return base;
      }
      // renderAndUpload UPDATE-returning. The service passes the computed
      // path as $3 — read it back so assertions about pdfStoragePath()
      // (tenant/vendor/date/...) shape pass.
      if (sql.includes('update vendor_daily_lists') && sql.includes('pdf_storage_path = $3')) {
        return { ...base, pdf_storage_path: (params?.[2] as string) ?? 'fallback.pdf' };
      }
      return null;
    }),
    queryMany: jest.fn(async () => []),
    rpc: jest.fn(),
    tx: jest.fn(async (fn: (c: typeof txClient) => Promise<unknown>) => fn(txClient)),
  };
}

function makeFakePdfRenderer() {
  return {
    renderDaglijst: jest.fn(async () => ({
      buffer: Buffer.from('%PDF-1.4 stub', 'utf8'),
      mimeType: 'application/pdf' as const,
      sizeBytes: 13,
      renderMs: 5,
    })),
  };
}

function makeFakeMailer(opts: { fails?: boolean } = {}) {
  const calls: unknown[] = [];
  return {
    calls,
    sendDaglijst: jest.fn(async (input: unknown) => {
      calls.push(input);
      if (opts.fails) throw new Error('SMTP unreachable');
      return { messageId: 'msg-test', acceptedAt: new Date().toISOString() };
    }),
  };
}

function makeFakeSupabase(opts: { uploadError?: string | null; signedUrlError?: string | null } = {}) {
  return {
    admin: {
      storage: {
        from: () => ({
          upload: jest.fn(async () => ({
            error: opts.uploadError ? { message: opts.uploadError } : null,
          })),
          createSignedUrl: jest.fn(async () => ({
            data: opts.signedUrlError ? null : { signedUrl: 'https://example.com/signed' },
            error: opts.signedUrlError ? { message: opts.signedUrlError } : null,
          })),
        }),
      },
    },
  };
}

function buildSvc(opts: FakeOptions = {}) {
  const db = makeFakeDb(opts);
  const supabase = makeFakeSupabase({
    uploadError: opts.uploadError,
    signedUrlError: opts.signedUrlError,
  });
  const pdfRenderer = makeFakePdfRenderer();
  const mailer = makeFakeMailer({ fails: opts.mailerFails });
  const svc = new DaglijstService(
    db as never,
    supabase as never,
    new AuditOutboxService(db as never),
    pdfRenderer as never,
    mailer as never,
  );
  return { db, supabase, pdfRenderer, mailer, svc };
}

// =====================================================================
// renderAndUpload
// =====================================================================

describe('DaglijstService.renderAndUpload', () => {
  it('renders the PDF + uploads to Storage + persists pdf_storage_path', async () => {
    const { svc, pdfRenderer } = buildSvc();
    const r = await svc.renderAndUpload({ tenantId: TENANT, daglijstId: DAGLIJST });
    expect(pdfRenderer.renderDaglijst).toHaveBeenCalledTimes(1);
    expect(r.pdf_storage_path).toContain(TENANT);
    expect(r.pdf_storage_path).toContain(VENDOR);
    expect(r.pdf_storage_path).toMatch(/-v\d+\.pdf$/);
  });

  it('skips re-render when pdf_storage_path is already set (idempotent)', async () => {
    const { svc, pdfRenderer } = buildSvc({
      row: makeRow({ pdf_storage_path: 'tenant/vendor/2026-05-01/cafeteria/catering-v1.pdf' }),
    });
    await svc.renderAndUpload({ tenantId: TENANT, daglijstId: DAGLIJST });
    expect(pdfRenderer.renderDaglijst).not.toHaveBeenCalled();
  });

  it('forces a re-render when force=true', async () => {
    const { svc, pdfRenderer } = buildSvc({
      row: makeRow({ pdf_storage_path: 'existing/path.pdf' }),
    });
    await svc.renderAndUpload({ tenantId: TENANT, daglijstId: DAGLIJST, force: true });
    expect(pdfRenderer.renderDaglijst).toHaveBeenCalledTimes(1);
  });

  it('throws BadRequest on Storage upload failure', async () => {
    const { svc } = buildSvc({ uploadError: 'bucket missing' });
    await expect(
      svc.renderAndUpload({ tenantId: TENANT, daglijstId: DAGLIJST }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// =====================================================================
// getDownloadUrl — TTL choice
// =====================================================================

describe('DaglijstService.getDownloadUrl', () => {
  it('mints a short admin-TTL signed URL by default (~1h)', async () => {
    const { svc } = buildSvc({
      row: makeRow({ pdf_storage_path: 'tenant/vendor/.../catering-v1.pdf' }),
    });
    const r = await svc.getDownloadUrl({ tenantId: TENANT, daglijstId: DAGLIJST });
    const expiresAt = new Date(r.expiresAt).getTime();
    const now = Date.now();
    // Approx 1 hour window — generous slack for test runtime.
    expect(expiresAt - now).toBeGreaterThan(50 * 60 * 1000);
    expect(expiresAt - now).toBeLessThan(70 * 60 * 1000);
  });

  it('mints a long email-TTL signed URL when ttl=email (~7d)', async () => {
    const { svc } = buildSvc({
      row: makeRow({ pdf_storage_path: 'tenant/vendor/.../catering-v1.pdf' }),
    });
    const r = await svc.getDownloadUrl({ tenantId: TENANT, daglijstId: DAGLIJST, ttl: 'email' });
    const expiresAt = new Date(r.expiresAt).getTime();
    const now = Date.now();
    expect(expiresAt - now).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    expect(expiresAt - now).toBeLessThan(8 * 24 * 60 * 60 * 1000);
  });

  it('auto-renders + uploads when pdf_storage_path is null', async () => {
    const { svc, pdfRenderer } = buildSvc({ row: makeRow({ pdf_storage_path: null }) });
    await svc.getDownloadUrl({ tenantId: TENANT, daglijstId: DAGLIJST });
    expect(pdfRenderer.renderDaglijst).toHaveBeenCalledTimes(1);
  });
});

// =====================================================================
// send
// =====================================================================

describe('DaglijstService.send', () => {
  it('renders + sends + locks lines + audits on success', async () => {
    const { svc, db, mailer } = buildSvc();
    await svc.send({ tenantId: TENANT, daglijstId: DAGLIJST });
    expect(mailer.calls).toHaveLength(1);
    const txSqls = db.captured.filter((c) => c.tx).map((c) => c.sql);
    // line lock + status update + audit emit
    expect(txSqls.some((s) => s.includes('update order_line_items') && s.includes('daglijst_locked_at'))).toBe(true);
    expect(txSqls.some((s) => s.includes('update vendor_daily_lists') && s.includes("email_status         = 'sent'"))).toBe(true);
    expect(txSqls.some((s) => s.includes('insert into audit_outbox'))).toBe(true);
  });

  it('captures email_error + emits SendFailed on mailer failure', async () => {
    const { svc, db } = buildSvc({ mailerFails: true });
    await expect(svc.send({ tenantId: TENANT, daglijstId: DAGLIJST })).rejects.toThrow(/send failed/);
    const failureUpdate = db.captured.find((c) =>
      c.sql.includes('update vendor_daily_lists') && c.sql.includes("'failed'"),
    );
    expect(failureUpdate).toBeDefined();
    const failureAudit = db.captured.find((c) =>
      c.sql.includes('insert into audit_outbox') && (c.params?.[1] === 'daglijst.send_failed'),
    );
    expect(failureAudit).toBeDefined();
  });

  it('throws BadRequest when vendor has no daglijst_email', async () => {
    const { svc } = buildSvc({ row: makeRow({ recipient_email: null }) });
    await expect(svc.send({ tenantId: TENANT, daglijstId: DAGLIJST })).rejects.toThrow(/no daglijst_email/);
  });

  it('skips already-sent daglijst unless force=true', async () => {
    const { svc, mailer } = buildSvc({
      row: makeRow({ sent_at: '2026-04-30T19:00:00Z', email_status: 'sent', pdf_storage_path: 'tenant/.../v1.pdf' }),
    });
    await svc.send({ tenantId: TENANT, daglijstId: DAGLIJST });
    expect(mailer.calls).toHaveLength(0);
  });

  it('resends when force=true', async () => {
    const { svc, mailer } = buildSvc({
      row: makeRow({ sent_at: '2026-04-30T19:00:00Z', email_status: 'sent', pdf_storage_path: 'tenant/.../v1.pdf' }),
    });
    await svc.send({ tenantId: TENANT, daglijstId: DAGLIJST, force: true });
    expect(mailer.calls).toHaveLength(1);
  });
});

import { BadRequestException } from '@nestjs/common';
import { AuditOutboxService } from '../privacy-compliance/audit-outbox.service';
import {
  DailyListService,
  type VendorDailyListRow,
} from './daily-list.service';

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
  /** When true, mailer.sendDailyList throws. */
  mailerFails?: boolean;
  /** Storage upload returns an error (string = error message). */
  uploadError?: string | null;
  /** createSignedUrl returns an error (string = error message). */
  signedUrlError?: string | null;
  /** Pre-canned reclaimed rows the sweeper UPDATE should return. */
  reclaimedRows?: Array<{ id: string; tenant_id: string; sending_acquired_at: string }>;
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
      captured.push({ sql, params });
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
      // Sprint 2 codex fix #1 — CAS state machine: only succeeds when the
      // current row's email_status is in the from-list ($3 = string[]).
      // Codex round-3 fix: CAS UPDATE now also returns sending_acquired_at
      // as a lease token; subsequent UPDATEs fence on it.
      if (
        sql.includes('update vendor_daily_lists')
        && /email_status\s*=\s*'sending'/.test(sql)
        && sql.includes('email_status = any($3::text[])')
      ) {
        const fromStatuses = (params?.[2] as string[]) ?? [];
        if (fromStatuses.includes(base.email_status ?? 'never_sent')) {
          // Stable lease ts so later fenced UPDATEs can match it.
          return { id: base.id, sending_acquired_at: '2026-04-30T20:00:00Z' };
        }
        return null;
      }
      // Codex round-3 — fenced failure rollback: matches when the lease
      // ts ($4) equals our captured CAS lease. In the mock we always
      // succeed (no concurrent worker / sweeper).
      if (
        sql.includes('update vendor_daily_lists')
        && sql.includes("'failed'")
        && sql.includes('sending_acquired_at = $4')
      ) {
        return { id: base.id };
      }
      return null;
    }),
    queryMany: jest.fn(async (sql: string, _params?: unknown[]) => {
      captured.push({ sql, params: _params });
      // Sweeper UPDATE returns reclaimed rows. Default empty (no stuck rows).
      if (sql.includes("update vendor_daily_lists") && sql.includes("'reclaimed: stuck in sending past sweep threshold'")) {
        return opts.reclaimedRows ?? [];
      }
      return [];
    }),
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
    sendDailyList: jest.fn(async (input: unknown) => {
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
  const svc = new DailyListService(
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

describe('DailyListService.renderAndUpload', () => {
  it('renders the PDF + uploads to Storage + persists pdf_storage_path', async () => {
    const { svc, pdfRenderer } = buildSvc();
    const r = await svc.renderAndUpload({ tenantId: TENANT, dailyListId: DAGLIJST });
    expect(pdfRenderer.renderDaglijst).toHaveBeenCalledTimes(1);
    expect(r.pdf_storage_path).toContain(TENANT);
    expect(r.pdf_storage_path).toContain(VENDOR);
    expect(r.pdf_storage_path).toMatch(/-v\d+\.pdf$/);
  });

  it('skips re-render when pdf_storage_path is already set (idempotent)', async () => {
    const { svc, pdfRenderer } = buildSvc({
      row: makeRow({ pdf_storage_path: 'tenant/vendor/2026-05-01/cafeteria/catering-v1.pdf' }),
    });
    await svc.renderAndUpload({ tenantId: TENANT, dailyListId: DAGLIJST });
    expect(pdfRenderer.renderDaglijst).not.toHaveBeenCalled();
  });

  it('forces a re-render when force=true', async () => {
    const { svc, pdfRenderer } = buildSvc({
      row: makeRow({ pdf_storage_path: 'existing/path.pdf' }),
    });
    await svc.renderAndUpload({ tenantId: TENANT, dailyListId: DAGLIJST, force: true });
    expect(pdfRenderer.renderDaglijst).toHaveBeenCalledTimes(1);
  });

  it('throws BadRequest on Storage upload failure', async () => {
    const { svc } = buildSvc({ uploadError: 'bucket missing' });
    await expect(
      svc.renderAndUpload({ tenantId: TENANT, dailyListId: DAGLIJST }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// =====================================================================
// getDownloadUrl — TTL choice
// =====================================================================

describe('DailyListService.getDownloadUrl', () => {
  it('mints a short admin-TTL signed URL by default (~1h)', async () => {
    const { svc } = buildSvc({
      row: makeRow({ pdf_storage_path: 'tenant/vendor/.../catering-v1.pdf' }),
    });
    const r = await svc.getDownloadUrl({ tenantId: TENANT, dailyListId: DAGLIJST });
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
    const r = await svc.getDownloadUrl({ tenantId: TENANT, dailyListId: DAGLIJST, ttl: 'email' });
    const expiresAt = new Date(r.expiresAt).getTime();
    const now = Date.now();
    expect(expiresAt - now).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    expect(expiresAt - now).toBeLessThan(8 * 24 * 60 * 60 * 1000);
  });

  it('auto-renders + uploads when pdf_storage_path is null', async () => {
    const { svc, pdfRenderer } = buildSvc({ row: makeRow({ pdf_storage_path: null }) });
    await svc.getDownloadUrl({ tenantId: TENANT, dailyListId: DAGLIJST });
    expect(pdfRenderer.renderDaglijst).toHaveBeenCalledTimes(1);
  });
});

// =====================================================================
// send
// =====================================================================

describe('DailyListService.send', () => {
  it('renders + sends + locks lines + audits + returns status=sent on success', async () => {
    const { svc, db, mailer } = buildSvc();
    const outcome = await svc.send({ tenantId: TENANT, dailyListId: DAGLIJST });
    expect(outcome.status).toBe('sent');
    expect(mailer.calls).toHaveLength(1);
    const txSqls = db.captured.filter((c) => c.tx).map((c) => c.sql);
    // line lock + status update + audit emit
    expect(txSqls.some((s) => s.includes('update order_line_items') && s.includes('daglijst_locked_at'))).toBe(true);
    expect(txSqls.some((s) => /email_status\s*=\s*'sent'/.test(s))).toBe(true);
    expect(txSqls.some((s) => s.includes('insert into audit_outbox'))).toBe(true);
    // success path clears sending_acquired_at
    expect(txSqls.some((s) => /sending_acquired_at\s*=\s*null/.test(s))).toBe(true);
  });

  it('captures email_error + emits SendFailed + clears sending_acquired_at on mailer failure', async () => {
    const { svc, db } = buildSvc({ mailerFails: true });
    await expect(svc.send({ tenantId: TENANT, dailyListId: DAGLIJST })).rejects.toThrow(/send failed/);
    const failureUpdate = db.captured.find((c) =>
      c.sql.includes('update vendor_daily_lists') && c.sql.includes("'failed'"),
    );
    expect(failureUpdate).toBeDefined();
    // Codex round-2 fix: failure rollback clears sending_acquired_at so the
    // sweeper doesn't re-process the row.
    expect(/sending_acquired_at\s*=\s*null/.test(failureUpdate!.sql)).toBe(true);
    const failureAudit = db.captured.find((c) =>
      c.sql.includes('insert into audit_outbox') && (c.params?.[1] === 'daily_list.send_failed'),
    );
    expect(failureAudit).toBeDefined();
  });

  it('throws BadRequest when vendor has no daglijst_email', async () => {
    const { svc } = buildSvc({ row: makeRow({ recipient_email: null }) });
    await expect(svc.send({ tenantId: TENANT, dailyListId: DAGLIJST })).rejects.toThrow(/no daglijst_email/);
  });

  it('returns status=already_sent without dispatching when row is sent + !force', async () => {
    const { svc, mailer } = buildSvc({
      row: makeRow({ sent_at: '2026-04-30T19:00:00Z', email_status: 'sent', pdf_storage_path: 'tenant/.../v1.pdf' }),
    });
    const outcome = await svc.send({ tenantId: TENANT, dailyListId: DAGLIJST });
    expect(outcome.status).toBe('already_sent');
    expect(mailer.calls).toHaveLength(0);
  });

  it('resends + returns status=sent when force=true', async () => {
    const { svc, mailer } = buildSvc({
      row: makeRow({ sent_at: '2026-04-30T19:00:00Z', email_status: 'sent', pdf_storage_path: 'tenant/.../v1.pdf' }),
    });
    const outcome = await svc.send({ tenantId: TENANT, dailyListId: DAGLIJST, force: true });
    expect(outcome.status).toBe('sent');
    expect(mailer.calls).toHaveLength(1);
  });

  it('CAS skip path returns status=skipped_in_flight when row is already sending', async () => {
    // Codex round-2 fix #1: scheduler must distinguish "we just sent it"
    // from "another worker holds the CAS / row is mid-send". The mock's
    // CAS check returns null when current email_status isn't in the
    // from-list; 'sending' is never in that list (without force).
    const { svc, mailer } = buildSvc({
      row: makeRow({ email_status: 'sending', pdf_storage_path: 'tenant/.../v1.pdf' }),
    });
    const outcome = await svc.send({ tenantId: TENANT, dailyListId: DAGLIJST });
    expect(outcome.status).toBe('skipped_in_flight');
    expect(mailer.calls).toHaveLength(0);
  });

  it('CAS UPDATE stamps sending_acquired_at = now()', async () => {
    const { svc, db } = buildSvc();
    await svc.send({ tenantId: TENANT, dailyListId: DAGLIJST });
    const casUpdate = db.captured.find((c) =>
      /update vendor_daily_lists/.test(c.sql)
      && /email_status\s*=\s*'sending'/.test(c.sql)
      && /sending_acquired_at\s*=\s*now\(\)/.test(c.sql),
    );
    expect(casUpdate).toBeDefined();
  });

  it('passes a STABLE correlationId per (id, version) on natural sends', async () => {
    // Codex round-3 fix: stable per (id, version) so the mail provider's
    // Idempotency-Key dedupes accidental double-sends across the
    // cross-worker race (worker A's lease revoked by sweeper, worker B
    // retries — same logical email, same key, provider returns cached
    // success). NO per-attempt nonce on natural sends.
    const { svc, mailer } = buildSvc();
    await svc.send({ tenantId: TENANT, dailyListId: DAGLIJST });
    const call = mailer.calls[0] as { correlationId?: string };
    expect(call.correlationId).toBe('daily-list:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee:v1');
  });

  it('correlationId on retry of a failed row stays stable (provider dedupes)', async () => {
    // Codex round-3 fix: retries reuse the same logical key. If the prior
    // attempt actually delivered (provider has the receipt cached),
    // requeueing returns the cached success WITHOUT sending again.
    const { svc, mailer } = buildSvc({
      row: makeRow({ email_status: 'failed', email_error: 'prior smtp blip', pdf_storage_path: 'tenant/.../v1.pdf' }),
    });
    await svc.send({ tenantId: TENANT, dailyListId: DAGLIJST });
    const call = mailer.calls[0] as { correlationId?: string };
    expect(call.correlationId).toBe('daily-list:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee:v1');
  });

  it('force=true correlationId appends a nonce so admins can override cached results', async () => {
    const { svc, mailer } = buildSvc({
      row: makeRow({ sent_at: '2026-04-30T19:00:00Z', email_status: 'sent', pdf_storage_path: 'tenant/.../v1.pdf' }),
    });
    await svc.send({ tenantId: TENANT, dailyListId: DAGLIJST, force: true });
    const call = mailer.calls[0] as { correlationId?: string };
    expect(call.correlationId).toMatch(
      /^daily-list:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee:v1:force:[0-9a-z]+$/,
    );
  });

  it('lease-revoked-after-mail-dispatch: returns status=lease_revoked, audits SendingReclaimed', async () => {
    // Codex round-3 follow-up: simulate the cross-worker race. The
    // success UPDATE matches 0 rows (lease was revoked while mailer was
    // in flight). We must:
    //   - NOT claim 'sent' status (newer worker is the authority)
    //   - NOT lock lines
    //   - emit a SendingReclaimed audit with outcome=lease_revoked_after_mail_dispatch
    //   - return SendOutcome { status: 'lease_revoked', ..., providerMessageId }
    //     so the scheduler counts as 'skipped' not 'sent' (no double-count).
    const db = makeFakeDb();
    // Override the txClient so the success UPDATE returns 0 rows (fence
    // failed). The throw-then-rollback path must trigger.
    db.txClient.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      db.captured.push({ sql, params, tx: true });
      if (sql.includes('update vendor_daily_lists') && sql.includes("'sent'")) {
        return { rows: [], rowCount: 0 };           // lease revoked
      }
      return { rows: [], rowCount: 0 };
    });
    const supabase = makeFakeSupabase();
    const pdfRenderer = makeFakePdfRenderer();
    const mailer = makeFakeMailer();
    const svc = new DailyListService(
      db as never,
      supabase as never,
      new AuditOutboxService(db as never),
      pdfRenderer as never,
      mailer as never,
    );

    const outcome = await svc.send({ tenantId: TENANT, dailyListId: DAGLIJST });
    expect(mailer.calls).toHaveLength(1);                    // mail DID dispatch
    expect(outcome.status).toBe('lease_revoked');
    if (outcome.status === 'lease_revoked') {
      expect(outcome.providerMessageId).toBe('msg-test');
    }
    // Line lock UPDATE must NOT run when the lease is revoked.
    const txSqls = db.captured.filter((c) => c.tx).map((c) => c.sql);
    expect(txSqls.some((s) => s.includes('update order_line_items'))).toBe(false);
    // SendingReclaimed audit emitted OUTSIDE the rolled-back tx (non-tx capture).
    const reclaimAudit = db.captured.find((c) =>
      !c.tx
      && c.sql.includes('insert into audit_outbox')
      && c.params?.[1] === 'daily_list.sending_reclaimed',
    );
    expect(reclaimAudit).toBeDefined();
  });
});

// =====================================================================
// reclaimStuckSendingRows (sweeper)
// =====================================================================

describe('DailyListService.reclaimStuckSendingRows', () => {
  it('emits SendingReclaimed audit per row reclaimed', async () => {
    const { svc, db } = buildSvc({
      reclaimedRows: [
        { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', tenant_id: TENANT, sending_acquired_at: '2026-04-30T18:50:00Z' },
        { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', tenant_id: TENANT, sending_acquired_at: '2026-04-30T18:55:00Z' },
      ],
    });
    const reclaimed = await svc.reclaimStuckSendingRows();
    expect(reclaimed).toHaveLength(2);
    const audits = db.captured.filter((c) =>
      c.sql.includes('insert into audit_outbox') && c.params?.[1] === 'daily_list.sending_reclaimed',
    );
    expect(audits).toHaveLength(2);
  });

  it('returns empty array + emits no audit when no rows are stuck', async () => {
    const { svc, db } = buildSvc();   // no reclaimedRows → mock returns []
    const reclaimed = await svc.reclaimStuckSendingRows();
    expect(reclaimed).toHaveLength(0);
    const audits = db.captured.filter((c) =>
      c.sql.includes('insert into audit_outbox') && c.params?.[1] === 'daily_list.sending_reclaimed',
    );
    expect(audits).toHaveLength(0);
  });
});

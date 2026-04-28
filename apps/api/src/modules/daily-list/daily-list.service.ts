import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DbService } from '../../common/db/db.service';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { AuditOutboxService } from '../privacy-compliance/audit-outbox.service';
import {
  DAILY_LIST_MAILER,
  type DailyListMailer,
} from './daily-list-mailer.service';
import { DailyListEventType } from './event-types';
import { PdfRendererService } from './pdf-renderer.service';

/**
 * Per-(vendor, building, service_type, date) daily-list assembly + record-keeping.
 *
 * Sprint 1 surface:
 *   - assemble()      → builds the structured payload from current order data
 *   - record()        → inserts a vendor_daily_lists row + locks the included
 *                       order_line_items + emits audit events
 *   - generate()      → assemble + record in one shot (used by Sprint 2 worker)
 *   - getHistory()    → admin UI list page for the vendor detail "Fulfillment" tab
 *   - getById()       → individual list lookup
 *
 * Sprint 2 will add: PDF rendering, email delivery, scheduling worker,
 * regenerate(), preview(), getDownloadUrl().
 *
 * Spec: docs/superpowers/specs/2026-04-27-vendor-portal-phase-a-daglijst-design.md §4.
 */
@Injectable()
export class DailyListService {
  private readonly log = new Logger(DailyListService.name);

  /** Storage bucket from migration 00174. */
  private static readonly PDF_BUCKET = 'daglijst-pdfs';
  /** Signed URL TTL for the recipient email — 7 days per spec §6. */
  private static readonly EMAIL_SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60;
  /** Signed URL TTL for admin "regenerate + preview" surface — 1 hour per spec §4. */
  private static readonly ADMIN_SIGNED_URL_TTL_SECONDS = 60 * 60;

  constructor(
    private readonly db: DbService,
    private readonly supabase: SupabaseService,
    private readonly auditOutbox: AuditOutboxService,
    private readonly pdfRenderer: PdfRendererService,
    @Inject(DAILY_LIST_MAILER) private readonly mailer: DailyListMailer,
  ) {}

  /**
   * Build the structured payload for a (vendor × building × service_type ×
   * date) bucket. Pure read operation — no DB writes, no side effects, so
   * it's safe to call from `preview()` (Sprint 2) without locking lines.
   */
  async assemble(args: AssembleArgs): Promise<DailyListPayload> {
    const { tenantId, vendorId, buildingId, serviceType, listDate } = args;

    const vendor = await this.db.queryOne<VendorRow>(
      `select id, name, fulfillment_mode, daglijst_email, daglijst_language,
              daglijst_cutoff_offset_minutes, daglijst_send_clock_time
         from vendors
        where tenant_id = $1 and id = $2`,
      [tenantId, vendorId],
    );
    if (!vendor) throw new NotFoundException(`Vendor ${vendorId} not found`);
    if (vendor.fulfillment_mode === 'portal') {
      throw new BadRequestException(
        `Vendor ${vendor.name} is in portal-only mode  daily list not applicable.`,
      );
    }

    const building = buildingId
      ? await this.db.queryOne<{ id: string; name: string }>(
          `select id, name from spaces where tenant_id = $1 and id = $2`,
          [tenantId, buildingId],
        )
      : null;

    // Pull every active order line for the bucket.
    // First-name only on the requester per privacy guidance + spec §4 step 3.
    //
    // Building filter: resolve descendants via a recursive CTE on
    // spaces.parent_id so a top-level building covers every floor + room
    // beneath it.
    //
    // Service-type filter: order_line_items don't carry service_type
    // directly. The right join is via menu_items → catalog_menus.service_type
    // (catering / av_equipment / supplies / facilities_services). Lines
    // without a menu_item (rare; legacy data) are excluded from the
    // typed bucket — the spec explicitly buckets per service type.
    //
    // Tenant predicates on every joined table — defense-in-depth against a
    // bad FK or stale row leaking across tenants.
    const params: unknown[] = [tenantId, vendorId, listDate];
    let buildingClause = '';
    if (buildingId) {
      params.push(buildingId);
      buildingClause = `
        and ord.delivery_location_id in (
          with recursive descendants(id) as (
            select id from spaces where tenant_id = $1 and id = $${params.length}
            union all
            select s.id from spaces s
              join descendants d on s.parent_id = d.id
             where s.tenant_id = $1
          )
          select id from descendants
        )`;
    }
    let serviceTypeClause = '';
    if (serviceType) {
      params.push(serviceType);
      serviceTypeClause = `and cm.service_type = $${params.length}`;
    }

    const lines = await this.db.queryMany<DaglijstLineRow>(
      `select oli.id                        as line_id,
              oli.order_id                  as order_id,
              oli.catalog_item_id           as catalog_item_id,
              oli.quantity                  as quantity,
              oli.dietary_notes             as dietary_notes,
              oli.fulfillment_status        as fulfillment_status,
              oli.service_window_start_at   as service_window_start_at,
              oli.service_window_end_at     as service_window_end_at,
              oli.menu_item_id              as menu_item_id,
              ci.name                       as catalog_item_name,
              ord.delivery_location_id      as delivery_location_id,
              ord.delivery_date             as delivery_date,
              ord.delivery_time             as delivery_time,
              ord.headcount                 as headcount,
              ord.requested_for_start_at    as requested_for_start_at,
              ord.requested_for_end_at      as requested_for_end_at,
              p.first_name                  as requester_first_name,
              s.name                        as delivery_location_name
         from order_line_items oli
         join orders ord
           on ord.id = oli.order_id
          and ord.tenant_id = $1
         left join catalog_items ci
           on ci.id = oli.catalog_item_id
          and ci.tenant_id = $1
         left join menu_items mi
           on mi.id = oli.menu_item_id
          and mi.tenant_id = $1
         left join catalog_menus cm
           on cm.id = mi.menu_id
          and cm.tenant_id = $1
         left join persons p
           on p.id = ord.requester_person_id
          and p.tenant_id = $1
         left join spaces s
           on s.id = ord.delivery_location_id
          and s.tenant_id = $1
        where oli.tenant_id = $1
          and oli.vendor_id = $2
          and ord.delivery_date = $3
          and ord.status not in ('cancelled')
          and oli.recurrence_skipped is not true
          ${serviceTypeClause}
          ${buildingClause}
        order by ord.delivery_time nulls last, oli.id`,
      params,
    );

    return {
      tenant_id: tenantId,
      vendor: {
        id: vendor.id,
        name: vendor.name,
        language: vendor.daglijst_language,
      },
      building: building ? { id: building.id, name: building.name } : null,
      service_type: serviceType,
      list_date: listDate,
      assembled_at: new Date().toISOString(),
      total_lines: lines.length,
      total_quantity: lines.reduce((sum, l) => sum + (l.quantity ?? 0), 0),
      lines: lines.map((l) => ({
        line_id: l.line_id,
        order_id: l.order_id,
        catalog_item_id: l.catalog_item_id,
        catalog_item_name: l.catalog_item_name,
        quantity: l.quantity,
        dietary_notes: l.dietary_notes,
        delivery_time: l.delivery_time,
        delivery_window: l.service_window_start_at && l.service_window_end_at
          ? { start_at: l.service_window_start_at, end_at: l.service_window_end_at }
          : null,
        delivery_location_name: l.delivery_location_name,
        // First name only — last name omitted per privacy. Vendor sees
        // "Jan • Boardroom 4 • 12:00" not "Jan van der Berg".
        requester_first_name: l.requester_first_name,
        headcount: l.headcount,
      })),
    };
  }

  /**
   * Persist a fresh list version + lock the included lines + emit audits.
   * Caller passes the assembled payload so we don't re-run the join.
   */
  async record(args: RecordArgs): Promise<VendorDailyListRow> {
    const {
      tenantId, vendorId, buildingId, serviceType, listDate,
      payload, triggeredBy, generatedByUserId,
    } = args;

    return this.db.tx(async (client) => {
      // Compute next version atomically. Advisory lock on the bucket key
      // prevents two scheduler ticks racing to v1 simultaneously.
      const lockKey = bucketLockKey(tenantId, vendorId, buildingId, serviceType, listDate);
      await client.query(`select pg_advisory_xact_lock($1, $2)`, [DAGLIJST_LOCK_NS, lockKey]);

      const last = await client.query<{ version: number }>(
        `select max(version) as version from vendor_daily_lists
          where tenant_id = $1 and vendor_id = $2
            and (building_id is not distinct from $3)
            and service_type = $4 and list_date = $5`,
        [tenantId, vendorId, buildingId, serviceType, listDate],
      );
      const nextVersion = (last.rows[0]?.version ?? 0) + 1;

      // Recipient email pulled inside the tx so admin edits to the vendor
      // can take effect before the next regenerate.
      const recipient = await client.query<{ daglijst_email: string | null }>(
        `select daglijst_email from vendors where tenant_id = $1 and id = $2`,
        [tenantId, vendorId],
      );

      const inserted = await client.query<VendorDailyListRow>(
        `insert into vendor_daily_lists
           (tenant_id, vendor_id, building_id, service_type, list_date, version,
            payload, generated_by_user_id, recipient_email, email_status)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 'never_sent')
         returning *`,
        [
          tenantId, vendorId, buildingId, serviceType, listDate, nextVersion,
          JSON.stringify(payload), generatedByUserId ?? null,
          recipient.rows[0]?.daglijst_email ?? null,
        ],
      );
      const inserted_row = inserted.rows[0];

      // NOTE: line-locking deliberately NOT applied here. The spec is
      // "lock on send" — a daily list can be generated (preview, regenerate,
      // post-cutoff retry) without committing the lines into a sent
      // bucket. Sprint 2 will set daglijst_locked_at + daglijst_id atomically
      // with sent_at when DaglijstSendService delivers the email.
      // Locking on record would falsely flag every line as
      // requires_phone_followup the moment Sprint 2 hits a transient bounce.
      const lineIds = payload.lines.map((l) => l.line_id);

      const eventType = nextVersion === 1
        ? DailyListEventType.Generated
        : DailyListEventType.Regenerated;

      await this.auditOutbox.emitTx(client, {
        tenantId,
        eventType,
        entityType: 'vendor_daily_lists',
        entityId: inserted_row.id,
        actorUserId: generatedByUserId ?? null,
        details: {
          vendor_id: vendorId,
          building_id: buildingId,
          service_type: serviceType,
          list_date: listDate,
          version: nextVersion,
          line_count: lineIds.length,
          triggered_by: triggeredBy,
          total_quantity: payload.total_quantity,
        },
      });

      return inserted_row;
    });
  }

  /**
   * Find the most-recent RETRY-ELIGIBLE row for a bucket, if any. Used by
   * the scheduler to retry a 'failed' row instead of minting a new
   * version on every transient outage (codex Sprint 2 fix #2).
   *
   * Codex round-2 fix: explicitly scope to email_status in
   * ('never_sent','failed'). 'sending' rows are NOT eligible for retry —
   * either another worker holds them (CAS denies) or they're stuck and
   * the sweeper will reclaim them to 'failed' first.
   *
   * Returns null when the bucket has either no rows or only sent/in-flight
   * ones — in which case the scheduler proceeds with generate() to mint
   * v_n+1.
   */
  async findUnsentRowForBucket(args: AssembleArgs): Promise<VendorDailyListRow | null> {
    const { tenantId, vendorId, buildingId, serviceType, listDate } = args;
    return this.db.queryOne<VendorDailyListRow>(
      `select * from vendor_daily_lists
        where tenant_id = $1
          and vendor_id = $2
          and (building_id is not distinct from $3)
          and service_type = $4
          and list_date    = $5
          and sent_at is null
          and email_status in ('never_sent','failed')
        order by version desc
        limit 1`,
      [tenantId, vendorId, buildingId, serviceType, listDate],
    );
  }

  /**
   * Sweeper: reclaim rows stuck in 'sending' past a threshold. The CAS
   * state machine in send() can leave a row in 'sending' if the worker
   * crashes or fails post-CAS (e.g. createSignedUrl throw, audit emit DB
   * failure, OOM, pod kill) before the explicit failure rollback.
   * Without this sweeper such rows are unrecoverable — the next CAS is
   * denied because email_status is already 'sending', and the retry path
   * only matches 'never_sent'/'failed'.
   *
   * Strategy: any row with email_status='sending' and sending_acquired_at
   * older than `olderThanMs` (default 5 min — well past p99 send latency)
   * is reset to 'failed' with a descriptive error, so the next scheduler
   * tick + findUnsentRowForBucket picks it up for retry.
   *
   * Called once per scheduler tick BEFORE findDueBuckets.
   *
   * Returns the number of rows reclaimed (caller emits per-row audit).
   */
  async reclaimStuckSendingRows(args: { olderThanMs?: number } = {}): Promise<
    Array<{ id: string; tenant_id: string; sending_acquired_at: string }>
  > {
    const olderThanMs = args.olderThanMs ?? 5 * 60_000;
    // Codex round-3 fix: capture the PRIOR sending_acquired_at via CTE
    // before nullifying it. UPDATE ... RETURNING returns post-update
    // values, so the previous code emitted `stuck_since: null` in audit.
    // CTE pattern: SELECT old, UPDATE by id, RETURNING from CTE.
    const reclaimed = await this.db.queryMany<{
      id: string;
      tenant_id: string;
      sending_acquired_at: string;
    }>(
      `with stuck as (
         select id, tenant_id, sending_acquired_at as prev_acquired_at
           from vendor_daily_lists
          where email_status = 'sending'
            and sending_acquired_at is not null
            and sending_acquired_at < now() - ($1::int || ' milliseconds')::interval
          for update
       ),
       updated as (
         update vendor_daily_lists v
            set email_status        = 'failed',
                email_error         = 'reclaimed: stuck in sending past sweep threshold',
                sending_acquired_at = null
          from stuck
          where v.id = stuck.id
          returning v.id
       )
       select stuck.id, stuck.tenant_id,
              stuck.prev_acquired_at::text as sending_acquired_at
         from stuck
         join updated on updated.id = stuck.id`,
      [olderThanMs],
    );
    if (reclaimed.length > 0) {
      // Audit per row so ops can see exactly which buckets the sweeper
      // recovered and correlate with the SendFailed events that follow
      // on the next tick's retry attempt.
      for (const r of reclaimed) {
        await this.auditOutbox.emit({
          tenantId: r.tenant_id,
          eventType: DailyListEventType.SendingReclaimed,
          entityType: 'vendor_daily_lists',
          entityId: r.id,
          details: {
            stuck_since: r.sending_acquired_at,
            threshold_ms: olderThanMs,
          },
        });
      }
      this.log.warn(
        `sweeper reclaimed ${reclaimed.length} row(s) stuck in 'sending'`,
      );
    }
    return reclaimed;
  }

  /**
   * One-shot: assemble fresh + record. The Sprint 2 scheduler calls this
   * once per bucket per cutoff time; admin manual regenerate calls it via
   * the Sprint 3 admin endpoint.
   *
   * Codex Sprint 2 fix #4: when assemble returns an empty payload (every
   * line cancelled between scan + send), throw a ListCancelled to signal
   * the caller. Spec §4 says "emit a 'list cancelled' notification to
   * vendor instead of empty list." Sprint 4 wires the cancellation
   * mailer; today the scheduler swallows + audits + skips the bucket.
   */
  async generate(args: GenerateArgs): Promise<VendorDailyListRow> {
    const payload = await this.assemble({
      tenantId: args.tenantId,
      vendorId: args.vendorId,
      buildingId: args.buildingId,
      serviceType: args.serviceType,
      listDate: args.listDate,
    });

    // Codex Sprint 2 fix #4: empty-bucket short-circuit. Don't mint a v_n
    // PDF with zero lines when every order got cancelled between the
    // scheduler scan and the send time. Caller (scheduler) treats
    // ListCancelledError as "skip this bucket + audit + don't retry."
    if (payload.lines.length === 0) {
      throw new ListCancelledError(args.tenantId, args.vendorId, args.listDate);
    }

    return this.record({
      tenantId: args.tenantId,
      vendorId: args.vendorId,
      buildingId: args.buildingId,
      serviceType: args.serviceType,
      listDate: args.listDate,
      payload,
      triggeredBy: args.triggeredBy,
      generatedByUserId: args.generatedByUserId,
    });
  }

  /**
   * Render → upload → record pdf_storage_path. Idempotent: if the row already
   * has a pdf_storage_path, no re-render unless `force=true`. Returns the
   * updated daglijst row.
   *
   * Spec §5: render is <3s/PDF; rendered file lands in
   * `<tenant>/<vendor>/<list_date>/<building_or_tenant>/<service>-v<n>.pdf`.
   */
  async renderAndUpload(args: RenderAndUploadArgs): Promise<VendorDailyListRow> {
    const { tenantId, dailyListId, force = false } = args;

    const dl = await this.getById(tenantId, dailyListId);
    if (!dl) throw new NotFoundException('Daily-list not found');
    if (dl.pdf_storage_path && !force) return dl;

    const rendered = await this.pdfRenderer.renderDaglijst({
      payload: dl.payload,
      generation: {
        version: dl.version,
        generated_at: dl.generated_at,
        triggered_by: dl.generated_by_user_id ? 'admin_manual' : 'auto',
      },
    });

    const path = pdfStoragePath(dl);

    const { error: uploadErr } = await this.supabase.admin.storage
      .from(DailyListService.PDF_BUCKET)
      .upload(path, rendered.buffer, {
        contentType: rendered.mimeType,
        upsert: true,                                    // re-render replaces in place
      });
    if (uploadErr) {
      throw new BadRequestException(`PDF upload failed: ${uploadErr.message}`);
    }

    const updated = await this.db.queryOne<VendorDailyListRow>(
      `update vendor_daily_lists
          set pdf_storage_path = $3
        where tenant_id = $1 and id = $2
        returning *`,
      [tenantId, dailyListId, path],
    );
    return updated ?? dl;
  }

  /**
   * Mint a signed download URL for the daily list PDF. Two TTLs available:
   *   - 'admin' (default): 1 hour — used by the admin Fulfillment tab.
   *   - 'email': 7 days — used by the email recipient link.
   *
   * Auto-renders + uploads the PDF if pdf_storage_path is null (typical
   * for legacy rows pre-Sprint-2 backfill).
   */
  async getDownloadUrl(args: GetDownloadUrlArgs): Promise<{ url: string; expiresAt: string }> {
    const { tenantId, dailyListId, ttl = 'admin' } = args;

    let dl = await this.getById(tenantId, dailyListId);
    if (!dl) throw new NotFoundException('Daily-list not found');
    if (!dl.pdf_storage_path) {
      dl = await this.renderAndUpload({ tenantId, dailyListId });
    }

    const ttlSec = ttl === 'email'
      ? DailyListService.EMAIL_SIGNED_URL_TTL_SECONDS
      : DailyListService.ADMIN_SIGNED_URL_TTL_SECONDS;

    const { data, error } = await this.supabase.admin.storage
      .from(DailyListService.PDF_BUCKET)
      .createSignedUrl(dl.pdf_storage_path!, ttlSec);
    if (error || !data) {
      throw new BadRequestException(`Signed URL mint failed: ${error?.message ?? 'unknown'}`);
    }

    const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();
    return { url: data.signedUrl, expiresAt };
  }

  /**
   * Render + upload (if needed) + dispatch via DailyListMailer + record
   * delivery state on the row. Idempotent on already-sent rows unless
   * `force=true` (admin "resend" path).
   *
   * Sets:
   *   - pdf_storage_path (if missing)
   *   - sent_at = now()
   *   - email_message_id, email_status='sent'
   *   - pdf_url_expires_at = now() + 7d
   *
   * Locks the included order_line_items into this version when the send
   * succeeds — that's the spec "lock on send" rule we deferred from
   * record() per the codex Sprint 1 fix.
   *
   * Failure path: email_status='failed', email_error captured, no lock.
   */
  async send(args: SendArgs): Promise<SendOutcome> {
    const { tenantId, dailyListId, force = false } = args;

    const dl = await this.renderAndUpload({ tenantId, dailyListId });

    if (dl.sent_at && !force) {
      this.log.debug(`daily-list ${dailyListId} already sent; skipping (use force=true to resend)`);
      return { status: 'already_sent', row: dl };
    }
    if (!dl.recipient_email) {
      throw new BadRequestException('Vendor has no daglijst_email configured; cannot send');
    }

    // Codex Sprint 2 fix #1: CAS-acquire the row before calling the mailer.
    // Two workers / a stuck retry / a parallel admin "send now" can't both
    // dispatch the same email because only one wins this UPDATE.
    //   - 'never_sent' → 'sending'   normal first try
    //   - 'failed'     → 'sending'   retry path (codex fix #2)
    //   - already 'sending' → cas returns 0 rows → another worker has it → bail
    //   - 'sent' + force → use 'sent' as the CAS-from state on resend.
    //
    // Codex round-2 fix: stamp `sending_acquired_at = now()` so the sweeper
    // can detect rows where the worker crashed post-CAS.
    //
    // Codex round-3 fix: RETURN the acquired_at as a "lease token". Every
    // post-CAS UPDATE conditions on email_status='sending' AND
    // sending_acquired_at=$lease so a stale worker cannot overwrite state
    // after the sweeper or another worker has moved on.
    const fromStatuses = force
      ? ['never_sent', 'failed', 'sent']
      : ['never_sent', 'failed'];
    const cas = await this.db.queryOne<{ id: string; sending_acquired_at: string }>(
      `update vendor_daily_lists
          set email_status        = 'sending',
              email_error         = null,
              sending_acquired_at = now()
        where tenant_id = $1
          and id = $2
          and email_status = any($3::text[])
        returning id, sending_acquired_at`,
      [tenantId, dailyListId, fromStatuses],
    );
    if (!cas) {
      // Another worker is already sending this row, or it's already sent
      // and !force, or the sweeper just reset it. Re-fetch + return a
      // discriminated outcome so the scheduler can count it as
      // "skipped_in_flight" instead of "sent".
      const current = await this.getById(tenantId, dailyListId);
      this.log.debug(
        `daily-list ${dailyListId} CAS skipped — current state ${current?.email_status ?? 'unknown'}`,
      );
      return {
        status: current?.email_status === 'sent' ? 'already_sent' : 'skipped_in_flight',
        row: current ?? dl,
      };
    }

    // Codex round-2 fix: from this point on we own the 'sending' acquisition.
    // ANY thrown exception before the success commit must roll back to
    // 'failed' so the row isn't stuck. Wrap the rest in try/catch with a
    // finally-style rollback.
    //
    // Codex round-3 fix: capture the lease (sending_acquired_at) so every
    // post-mailer UPDATE can fence on it and abandon the write if the
    // sweeper or another worker has revoked our acquisition.
    const leaseTs = cas.sending_acquired_at;
    let pdfUrl: string;
    let expiresAt: string;
    let sendResult: Awaited<ReturnType<DailyListMailer['sendDailyList']>> | undefined;
    let sendError: string | null = null;

    try {
      const url = await this.getDownloadUrl({ tenantId, dailyListId, ttl: 'email' });
      pdfUrl = url.url;
      expiresAt = url.expiresAt;

      const subject = buildSubjectLine(dl);
      const textBody = buildTextBody(dl, pdfUrl);
      // Codex round-3 fix: correlationId is STABLE per (id, version) for
      // the natural retry case so the mail provider's Idempotency-Key
      // dedupes accidental double-sends across the cross-worker race
      // (worker A's lease revoked by sweeper, worker B retries — same
      // logical email, same key, provider returns cached success). Force
      // resends append a nonce so admins can override an already-cached
      // result.
      //
      // (Round-2 used a per-attempt nonce, but that defeated provider
      // dedupe across workers — codex round-3 caught this combined with
      // the missing lease fence.)
      const correlationId = force
        ? `daily-list:${dl.id}:v${dl.version}:force:${Date.now().toString(36)}`
        : `daily-list:${dl.id}:v${dl.version}`;

      try {
        /* Codex Sprint 4 attachment-first rework: the mailer now reads
           the PDF buffer from Storage and sends it as a real
           attachment. pdf_storage_path is set by the renderAndUpload
           call earlier in send(). */
        if (!dl.pdf_storage_path) {
          throw new Error('pdf_storage_path missing after renderAndUpload');
        }
        const filename =
          `daily-list-${dl.payload.list_date}-${dl.service_type}-v${dl.version}.pdf`;
        sendResult = await this.mailer.sendDailyList({
          tenantId,
          vendorId: dl.vendor_id,
          dailyListId: dl.id,
          recipientEmail: dl.recipient_email,
          vendorName: dl.payload.vendor.name,
          subject,
          textBody,
          htmlBody: null,                                  // Sprint 5 templates
          pdfDownloadUrl: pdfUrl,
          pdfStoragePath: dl.pdf_storage_path,
          pdfFilename: filename,
          language: dl.payload.vendor.language ?? 'nl',
          correlationId,
        });
      } catch (err) {
        sendError = err instanceof Error ? err.message : String(err);
      }
    } catch (preMailerErr) {
      // getDownloadUrl threw (signed URL mint failed, storage outage, etc).
      // Treat this as a send failure so the row rolls back + retry runs.
      sendError = preMailerErr instanceof Error
        ? `pre-mailer: ${preMailerErr.message}`
        : `pre-mailer: ${String(preMailerErr)}`;
    }

    if (sendError || !sendResult) {
      const errMsg = sendError ?? 'mailer returned no result';
      // Roll the CAS state back to 'failed' so the next scheduler tick
      // can retry the SAME row (codex Sprint 2 fix #2 — no version-bump-
      // forever spiral). Clear sending_acquired_at so the sweeper doesn't
      // re-process it.
      //
      // Codex round-3 fix: fence on the lease. If the sweeper or another
      // worker already moved this row, our UPDATE matches 0 rows and we
      // log + abandon — the newer worker owns state authority.
      const rollback = await this.db.queryOne<{ id: string }>(
        `update vendor_daily_lists
            set email_status        = 'failed',
                email_error         = $3,
                sending_acquired_at = null
          where tenant_id = $1
            and id = $2
            and email_status = 'sending'
            and sending_acquired_at = $4
          returning id`,
        [tenantId, dailyListId, errMsg.slice(0, 500), leaseTs],
      );
      if (!rollback) {
        this.log.warn(
          `daily-list ${dailyListId} failure rollback skipped — lease revoked ` +
          `(sweeper/another worker has authority); error was: ${errMsg.slice(0, 200)}`,
        );
      } else {
        await this.auditOutbox.emit({
          tenantId,
          eventType: DailyListEventType.SendFailed,
          entityType: 'vendor_daily_lists',
          entityId: dailyListId,
          details: { error: errMsg.slice(0, 500), recipient: dl.recipient_email },
        });
      }
      throw new BadRequestException(`Daily-list send failed: ${errMsg}`);
    }

    // Successful send — lock the lines + update the row + audit.
    //
    // Codex round-2 fix: even success-path post-mailer failures (DB blip
    // during the tx, audit outbox insert error) now leave the row stuck
    // in 'sending' until this tx completes. The success UPDATE clears
    // sending_acquired_at; if the tx itself rolls back the sweeper will
    // recover the row on a later tick. The mail provider's
    // Idempotency-Key (correlationId) prevents duplicate sends on retry.
    //
    // Codex round-3 fix: fence the success UPDATE on the lease too. If
    // our acquisition was revoked while the mailer call was in-flight,
    // we don't claim 'sent' state — another worker is the authority.
    // The provider's idempotency cache already deduped the actual mail
    // dispatch (stable correlationId).
    let finalRow: VendorDailyListRow;
    try {
      finalRow = await this.db.tx(async (client) => {
      const updated = await client.query<VendorDailyListRow>(
        `update vendor_daily_lists
            set sent_at              = now(),
                email_status         = 'sent',
                email_message_id     = $3,
                email_error          = null,
                pdf_url_expires_at   = $4,
                sending_acquired_at  = null
          where tenant_id = $1
            and id = $2
            and email_status = 'sending'
            and sending_acquired_at = $5
          returning *`,
        [tenantId, dailyListId, sendResult.messageId, expiresAt, leaseTs],
      );

      if (updated.rowCount === 0) {
        // Lease revoked between mailer dispatch + state UPDATE. The mail
        // already went out (or was deduped by provider Idempotency-Key);
        // the row's authoritative state is whatever the newer worker /
        // sweeper set it to. Don't claim 'sent', don't lock lines, don't
        // emit Sent audit. Caller (scheduler) will re-poll and either
        // see 'sent' (winner committed) or 'failed' (winner is retrying).
        //
        // Codex round-3 follow-up: throw a typed sentinel so the outer
        // catch translates it into SendOutcome { status: 'lease_revoked' }
        // and emits the SendingReclaimed audit OUTSIDE the rolled-back
        // tx (audits inside this tx would be discarded when the tx
        // aborts on the throw).
        this.log.warn(
          `daily-list ${dailyListId} success update skipped — lease revoked; ` +
          `provider message_id=${sendResult.messageId} (mail already dispatched, ` +
          `state managed by newer worker)`,
        );
        throw new LeaseRevokedAfterDispatchError(dailyListId, sendResult.messageId);
      }

      // Lock-on-send (deferred from record() per codex Sprint 1 fix).
      const lineIds = dl.payload.lines.map((l) => l.line_id);
      if (lineIds.length > 0) {
        await client.query(
          `update order_line_items
              set daglijst_locked_at = now(),
                  daglijst_id        = $2
            where tenant_id = $1
              and id = any($3::uuid[])
              and daglijst_locked_at is null`,
          [tenantId, dailyListId, lineIds],
        );
      }

      await this.auditOutbox.emitTx(client, {
        tenantId,
        eventType: DailyListEventType.Sent,
        entityType: 'vendor_daily_lists',
        entityId: dailyListId,
        details: {
          vendor_id: dl.vendor_id,
          recipient: dl.recipient_email,
          message_id: sendResult.messageId,
          line_count: lineIds.length,
        },
      });

        return updated.rows[0] ?? dl;
      });
    } catch (err) {
      if (err instanceof LeaseRevokedAfterDispatchError) {
        // Emit the SendingReclaimed audit OUTSIDE the rolled-back tx so
        // it actually persists. Use non-tx emit() — the row state was
        // never written, so there's nothing to atomically pair this with.
        await this.auditOutbox.emit({
          tenantId,
          eventType: DailyListEventType.SendingReclaimed,
          entityType: 'vendor_daily_lists',
          entityId: dailyListId,
          details: {
            outcome: 'lease_revoked_after_mail_dispatch',
            provider_message_id: err.providerMessageId,
            recipient: dl.recipient_email,
          },
        });
        return { status: 'lease_revoked', row: dl, providerMessageId: err.providerMessageId };
      }
      throw err;
    }

    return { status: 'sent', row: finalRow };
  }

  async getById(tenantId: string, dailyListId: string): Promise<VendorDailyListRow | null> {
    return this.db.queryOne<VendorDailyListRow>(
      `select * from vendor_daily_lists
        where tenant_id = $1 and id = $2`,
      [tenantId, dailyListId],
    );
  }

  /**
   * Last 30 days of daglijsts for a vendor — populates the admin Fulfillment
   * tab history view (Sprint 3 UI).
   */
  async getHistory(args: HistoryArgs): Promise<VendorDailyListRow[]> {
    const { tenantId, vendorId, since } = args;
    return this.db.queryMany<VendorDailyListRow>(
      `select * from vendor_daily_lists
        where tenant_id = $1
          and vendor_id = $2
          and list_date >= coalesce($3::date, current_date - interval '30 days')
        order by list_date desc, version desc
        limit 200`,
      [tenantId, vendorId, since ?? null],
    );
  }
}

/**
 * Thrown by generate() when the bucket has no live lines at send time
 * (every order_line_item was cancelled between scan + cutoff). Caller
 * decides whether to send a "list cancelled" notification (Sprint 4) or
 * just audit + skip (Sprint 2 scheduler).
 */
export class ListCancelledError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly vendorId: string,
    public readonly listDate: string,
  ) {
    super(`Daily-list bucket has zero live lines (cancelled between scan and send)`);
    this.name = 'ListCancelledError';
  }
}

/**
 * Internal sentinel — thrown from inside the success-path tx closure when
 * the success UPDATE matches 0 rows (lease revoked while mailer was
 * in-flight). Caught one stack frame up to translate into a typed
 * SendOutcome { status: 'lease_revoked', ... } without rolling back the
 * tx artificially. Not exported; not part of the public surface.
 */
class LeaseRevokedAfterDispatchError extends Error {
  constructor(
    public readonly dailyListId: string,
    public readonly providerMessageId: string,
  ) {
    super(`Daily-list ${dailyListId} lease revoked after mail dispatch (provider msg=${providerMessageId})`);
    this.name = 'LeaseRevokedAfterDispatchError';
  }
}

export interface RenderAndUploadArgs {
  tenantId: string;
  dailyListId: string;
  force?: boolean;
}

export interface GetDownloadUrlArgs {
  tenantId: string;
  dailyListId: string;
  /** 'admin' = 1h TTL (default); 'email' = 7d TTL. */
  ttl?: 'admin' | 'email';
}

export interface SendArgs {
  tenantId: string;
  dailyListId: string;
  /** Resend an already-sent daglijst (admin path). */
  force?: boolean;
}

/**
 * Discriminated result of `send()`. The scheduler (and any other caller
 * counting outcomes) MUST branch on `status` instead of treating any
 * non-throwing return as a successful send. CAS-skipped rows return
 * here too — the caller decides whether that counts as success/failure
 * for tick metrics.
 *
 * Codex round-2 fix: previously send() returned a bare row, which made
 * "another worker is already sending this" indistinguishable from "we
 * just sent it". Stuck-sending rows could be reported as sent forever.
 */
export type SendOutcome =
  | { status: 'sent';              row: VendorDailyListRow }
  | { status: 'already_sent';      row: VendorDailyListRow }
  | { status: 'skipped_in_flight'; row: VendorDailyListRow }
  /**
   * Mail dispatched, but our state UPDATE was lease-revoked between the
   * mailer call and the row write. The provider's idempotency cache (or
   * the newer worker, if mail wasn't actually sent) is the authority.
   * Scheduler counts this as 'skipped' not 'sent' so tick metrics don't
   * double-count a single logical delivery.
   *
   * `providerMessageId` is the receipt the lease-stale worker got back —
   * surfaced in audit so ops can correlate with the newer worker's row.
   */
  | { status: 'lease_revoked';     row: VendorDailyListRow; providerMessageId: string };

// =====================================================================
// Helpers
// =====================================================================

/**
 * Storage path layout (per spec §5):
 *   <tenant_id>/<vendor_id>/<list_date>/<building_or_tenant>/<service_type>-v<version>.pdf
 *
 * `building_or_tenant`: building's id slug when scoped, else 'all-buildings'.
 * Version-suffixed so v2 regenerates don't overwrite v1.
 */
function pdfStoragePath(dl: VendorDailyListRow): string {
  const buildingSlug = dl.building_id ?? 'all-buildings';
  return [
    dl.tenant_id,
    dl.vendor_id,
    dl.list_date,
    buildingSlug,
    `${dl.service_type}-v${dl.version}.pdf`,
  ].join('/');
}

function buildSubjectLine(dl: VendorDailyListRow): string {
  // NL only in Sprint 2; FR/EN swap-in via the language switch in Sprint 4.
  const lang = dl.payload.vendor.language ?? 'nl';
  const total = dl.payload.total_quantity;
  const buildingLabel = dl.payload.building?.name ?? 'alle gebouwen';
  if (lang === 'nl') {
    return `Daily-list ${dl.list_date} · ${buildingLabel} · ${total} eenheden`;
  }
  return `Daily-list ${dl.list_date} · ${buildingLabel} · ${total} units`;
}

function buildTextBody(dl: VendorDailyListRow, pdfUrl: string): string {
  const lang = dl.payload.vendor.language ?? 'nl';
  const lines = dl.payload.total_lines;
  const total = dl.payload.total_quantity;
  const buildingLabel = dl.payload.building?.name ?? 'alle gebouwen';
  if (lang === 'nl') {
    return [
      `Beste ${dl.payload.vendor.name},`,
      ``,
      `In de bijlage vind je de daglijst voor ${dl.list_date}.`,
      `Locatie: ${buildingLabel}`,
      `Bestellingen: ${lines}`,
      `Totale hoeveelheid: ${total}`,
      ``,
      `Download de PDF: ${pdfUrl}`,
      `(De link is 7 dagen geldig.)`,
      ``,
      `Met vriendelijke groet,`,
      `Prequest`,
    ].join('\n');
  }
  return [
    `Hi ${dl.payload.vendor.name},`,
    ``,
    `Attached is the daily list for ${dl.list_date}.`,
    `Location: ${buildingLabel}`,
    `Orders: ${lines}`,
    `Total quantity: ${total}`,
    ``,
    `Download PDF: ${pdfUrl}`,
    `(Link valid for 7 days.)`,
    ``,
    `Best regards,`,
    `Prequest`,
  ].join('\n');
}

/** Lock-key namespace: 'DAGL' as 4 ASCII bytes. */
const DAGLIJST_LOCK_NS = 0x4441_474c;

function bucketLockKey(
  tenantId: string,
  vendorId: string,
  buildingId: string | null,
  serviceType: string,
  listDate: string,
): number {
  const composite = `${tenantId}:${vendorId}:${buildingId ?? '_tenant'}:${serviceType}:${listDate}`;
  let h = 0;
  for (let i = 0; i < composite.length; i += 1) {
    h = (h * 31 + composite.charCodeAt(i)) | 0;
  }
  return h;
}

// =====================================================================
// Types
// =====================================================================

export type ServiceType = 'catering' | 'av_equipment' | 'supplies' | string;
export type TriggeredBy = 'auto' | 'admin_manual';

export interface AssembleArgs {
  tenantId: string;
  vendorId: string;
  buildingId: string | null;
  serviceType: ServiceType;
  listDate: string;                                     // YYYY-MM-DD
}

export interface GenerateArgs extends AssembleArgs {
  triggeredBy: TriggeredBy;
  generatedByUserId?: string | null;
}

export interface RecordArgs extends AssembleArgs {
  payload: DailyListPayload;
  triggeredBy: TriggeredBy;
  generatedByUserId?: string | null;
}

export interface HistoryArgs {
  tenantId: string;
  vendorId: string;
  /** ISO date string. Default: 30 days ago. */
  since?: string | null;
}

export interface DailyListPayload {
  tenant_id: string;
  vendor: { id: string; name: string; language: string };
  building: { id: string; name: string } | null;
  service_type: string;
  list_date: string;
  assembled_at: string;
  total_lines: number;
  total_quantity: number;
  lines: Array<{
    line_id: string;
    order_id: string;
    catalog_item_id: string | null;
    catalog_item_name: string | null;
    quantity: number;
    dietary_notes: string | null;
    delivery_time: string | null;
    delivery_window: { start_at: string; end_at: string } | null;
    delivery_location_name: string | null;
    requester_first_name: string | null;
    headcount: number | null;
  }>;
}

export interface VendorDailyListRow {
  id: string;
  tenant_id: string;
  vendor_id: string;
  building_id: string | null;
  service_type: string;
  list_date: string;
  version: number;
  payload: DailyListPayload;
  pdf_storage_path: string | null;
  pdf_url_expires_at: string | null;
  generated_at: string;
  generated_by_user_id: string | null;
  sent_at: string | null;
  recipient_email: string | null;
  email_message_id: string | null;
  email_status: string | null;
  email_error: string | null;
  created_at: string;
}

interface VendorRow {
  id: string;
  name: string;
  fulfillment_mode: 'portal' | 'paper_only' | 'hybrid';
  daglijst_email: string | null;
  daglijst_language: string;
  daglijst_cutoff_offset_minutes: number;
  daglijst_send_clock_time: string | null;
}

interface DaglijstLineRow {
  line_id: string;
  order_id: string;
  catalog_item_id: string | null;
  catalog_item_name: string | null;
  quantity: number;
  dietary_notes: string | null;
  fulfillment_status: string;
  service_window_start_at: string | null;
  service_window_end_at: string | null;
  menu_item_id: string | null;
  delivery_location_id: string | null;
  delivery_date: string;
  delivery_time: string | null;
  headcount: number | null;
  requested_for_start_at: string | null;
  requested_for_end_at: string | null;
  requester_first_name: string | null;
  delivery_location_name: string | null;
}

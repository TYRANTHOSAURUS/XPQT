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
  DAGLIJST_MAILER,
  type DaglijstMailer,
} from './daglijst-mailer.service';
import { DaglijstEventType } from './event-types';
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
export class DaglijstService {
  private readonly log = new Logger(DaglijstService.name);

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
    @Inject(DAGLIJST_MAILER) private readonly mailer: DaglijstMailer,
  ) {}

  /**
   * Build the structured payload for a (vendor × building × service_type ×
   * date) bucket. Pure read operation — no DB writes, no side effects, so
   * it's safe to call from `preview()` (Sprint 2) without locking lines.
   */
  async assemble(args: AssembleArgs): Promise<DaglijstPayload> {
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
        `Vendor ${vendor.name} is in portal-only mode — daglijst not applicable.`,
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
   * Persist a fresh daglijst version + lock the included lines + emit audits.
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
      const daglijst = inserted.rows[0];

      // NOTE: line-locking deliberately NOT applied here. The spec is
      // "lock on send" — a daglijst can be generated (preview, regenerate,
      // post-cutoff retry) without committing the lines into a sent
      // bucket. Sprint 2 will set daglijst_locked_at + daglijst_id atomically
      // with sent_at when DaglijstSendService delivers the email.
      // Locking on record would falsely flag every line as
      // requires_phone_followup the moment Sprint 2 hits a transient bounce.
      const lineIds = payload.lines.map((l) => l.line_id);

      const eventType = nextVersion === 1
        ? DaglijstEventType.Generated
        : DaglijstEventType.Regenerated;

      await this.auditOutbox.emitTx(client, {
        tenantId,
        eventType,
        entityType: 'vendor_daily_lists',
        entityId: daglijst.id,
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

      return daglijst;
    });
  }

  /**
   * One-shot: assemble fresh + record. The Sprint 2 scheduler calls this
   * once per bucket per cutoff time; admin manual regenerate calls it via
   * the Sprint 3 admin endpoint.
   */
  async generate(args: GenerateArgs): Promise<VendorDailyListRow> {
    const payload = await this.assemble({
      tenantId: args.tenantId,
      vendorId: args.vendorId,
      buildingId: args.buildingId,
      serviceType: args.serviceType,
      listDate: args.listDate,
    });
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
    const { tenantId, daglijstId, force = false } = args;

    const dl = await this.getById(tenantId, daglijstId);
    if (!dl) throw new NotFoundException('Daglijst not found');
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
      .from(DaglijstService.PDF_BUCKET)
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
      [tenantId, daglijstId, path],
    );
    return updated ?? dl;
  }

  /**
   * Mint a signed download URL for the daglijst PDF. Two TTLs available:
   *   - 'admin' (default): 1 hour — used by the admin Fulfillment tab.
   *   - 'email': 7 days — used by the email recipient link.
   *
   * Auto-renders + uploads the PDF if pdf_storage_path is null (typical
   * for legacy rows pre-Sprint-2 backfill).
   */
  async getDownloadUrl(args: GetDownloadUrlArgs): Promise<{ url: string; expiresAt: string }> {
    const { tenantId, daglijstId, ttl = 'admin' } = args;

    let dl = await this.getById(tenantId, daglijstId);
    if (!dl) throw new NotFoundException('Daglijst not found');
    if (!dl.pdf_storage_path) {
      dl = await this.renderAndUpload({ tenantId, daglijstId });
    }

    const ttlSec = ttl === 'email'
      ? DaglijstService.EMAIL_SIGNED_URL_TTL_SECONDS
      : DaglijstService.ADMIN_SIGNED_URL_TTL_SECONDS;

    const { data, error } = await this.supabase.admin.storage
      .from(DaglijstService.PDF_BUCKET)
      .createSignedUrl(dl.pdf_storage_path!, ttlSec);
    if (error || !data) {
      throw new BadRequestException(`Signed URL mint failed: ${error?.message ?? 'unknown'}`);
    }

    const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();
    return { url: data.signedUrl, expiresAt };
  }

  /**
   * Render + upload (if needed) + dispatch via DaglijstMailer + record
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
  async send(args: SendArgs): Promise<VendorDailyListRow> {
    const { tenantId, daglijstId, force = false } = args;

    const dl = await this.renderAndUpload({ tenantId, daglijstId });

    if (dl.sent_at && !force) {
      this.log.debug(`daglijst ${daglijstId} already sent; skipping (use force=true to resend)`);
      return dl;
    }
    if (!dl.recipient_email) {
      throw new BadRequestException('Vendor has no daglijst_email configured; cannot send');
    }

    const { url: pdfUrl, expiresAt } = await this.getDownloadUrl({
      tenantId,
      daglijstId,
      ttl: 'email',
    });

    const subject = buildSubjectLine(dl);
    const textBody = buildTextBody(dl, pdfUrl);

    let sendResult;
    let sendError: string | null = null;
    try {
      sendResult = await this.mailer.sendDaglijst({
        tenantId,
        vendorId: dl.vendor_id,
        daglijstId: dl.id,
        recipientEmail: dl.recipient_email,
        vendorName: dl.payload.vendor.name,
        subject,
        textBody,
        pdfDownloadUrl: pdfUrl,
        language: dl.payload.vendor.language ?? 'nl',
      });
    } catch (err) {
      sendError = err instanceof Error ? err.message : String(err);
    }

    if (sendError) {
      await this.db.query(
        `update vendor_daily_lists
            set email_status = 'failed',
                email_error  = $3
          where tenant_id = $1 and id = $2`,
        [tenantId, daglijstId, sendError.slice(0, 500)],
      );
      await this.auditOutbox.emit({
        tenantId,
        eventType: DaglijstEventType.SendFailed,
        entityType: 'vendor_daily_lists',
        entityId: daglijstId,
        details: { error: sendError.slice(0, 500), recipient: dl.recipient_email },
      });
      throw new BadRequestException(`Daglijst send failed: ${sendError}`);
    }

    // Successful send — lock the lines + update the row + audit.
    return this.db.tx(async (client) => {
      const updated = await client.query<VendorDailyListRow>(
        `update vendor_daily_lists
            set sent_at              = now(),
                email_status         = 'sent',
                email_message_id     = $3,
                email_error          = null,
                pdf_url_expires_at   = $4
          where tenant_id = $1 and id = $2
          returning *`,
        [tenantId, daglijstId, sendResult!.messageId, expiresAt],
      );

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
          [tenantId, daglijstId, lineIds],
        );
      }

      await this.auditOutbox.emitTx(client, {
        tenantId,
        eventType: DaglijstEventType.Sent,
        entityType: 'vendor_daily_lists',
        entityId: daglijstId,
        details: {
          vendor_id: dl.vendor_id,
          recipient: dl.recipient_email,
          message_id: sendResult!.messageId,
          line_count: lineIds.length,
        },
      });

      return updated.rows[0] ?? dl;
    });
  }

  async getById(tenantId: string, daglijstId: string): Promise<VendorDailyListRow | null> {
    return this.db.queryOne<VendorDailyListRow>(
      `select * from vendor_daily_lists
        where tenant_id = $1 and id = $2`,
      [tenantId, daglijstId],
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

export interface RenderAndUploadArgs {
  tenantId: string;
  daglijstId: string;
  force?: boolean;
}

export interface GetDownloadUrlArgs {
  tenantId: string;
  daglijstId: string;
  /** 'admin' = 1h TTL (default); 'email' = 7d TTL. */
  ttl?: 'admin' | 'email';
}

export interface SendArgs {
  tenantId: string;
  daglijstId: string;
  /** Resend an already-sent daglijst (admin path). */
  force?: boolean;
}

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
    return `Daglijst ${dl.list_date} · ${buildingLabel} · ${total} eenheden`;
  }
  return `Daglijst ${dl.list_date} · ${buildingLabel} · ${total} units`;
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
  payload: DaglijstPayload;
  triggeredBy: TriggeredBy;
  generatedByUserId?: string | null;
}

export interface HistoryArgs {
  tenantId: string;
  vendorId: string;
  /** ISO date string. Default: 30 days ago. */
  since?: string | null;
}

export interface DaglijstPayload {
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
  payload: DaglijstPayload;
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

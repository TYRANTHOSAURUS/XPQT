import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DbService } from '../../common/db/db.service';
import { AuditOutboxService } from '../privacy-compliance/audit-outbox.service';
import { DaglijstEventType } from './event-types';

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
  constructor(
    private readonly db: DbService,
    private readonly auditOutbox: AuditOutboxService,
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

// =====================================================================
// Helpers
// =====================================================================

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

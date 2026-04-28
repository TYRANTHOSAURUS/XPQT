import { Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../../common/db/db.service';

/**
 * Vendor-side order projections — strict PII minimization per spec §5.
 *
 * What the vendor SEES:
 *   - Order id + short ref + delivery time + delivery location label
 *   - Headcount, line items + quantities + modifiers + allergen flags
 *   - Requester FIRST NAME ONLY (so they can address them on arrival)
 *   - Desk contact (phone + email of the tenant's facilities desk)
 *
 * What the vendor NEVER sees:
 *   - Requester full name / email / phone
 *   - Other attendees / meeting context (subject, organizer)
 *   - Other vendors working the same booking
 *   - Cost / pricing details (the vendor sets prices server-side via
 *     menu_items; the order's `total_estimated_cost` is internal)
 *   - Cross-tenant data
 *
 * The query uses an explicit projection list — never `select *`. Column
 * additions to `orders` / `order_line_items` are opt-in: a new column
 * leaks to the vendor only if we update this service.
 *
 * Spec: docs/superpowers/specs/2026-04-27-vendor-portal-phase-b-design.md §5.
 */
@Injectable()
export class VendorOrderService {
  constructor(private readonly db: DbService) {}

  /**
   * Today + future window, scoped to (tenant, vendor). The window default
   * matches the "VP6 forecast window beyond today: 14-day default" decision
   * from open-questions §VP6.
   */
  async listForVendor(input: ListInput): Promise<VendorOrderListItem[]> {
    const { tenantId, vendorId, fromDate, toDate, statusFilter } = input;

    // Validate the status filter against the closed enum the LATERAL produces
    // — anything else returns an empty filter (no leakage of unknown statuses
    // into the SQL).
    const VALID_STATUSES = new Set([
      'requires_phone_followup', 'delivered', 'preparing', 'ordered',
    ]);
    const safeStatus = statusFilter && VALID_STATUSES.has(statusFilter)
      ? statusFilter
      : null;

    // Aggregate `fulfillment_status` is computed once via LATERAL; the
    // statusFilter then applies to the SAME aggregate (codex Sprint 2 fix
    // — the previous version filtered raw line status, which mismatched the
    // returned aggregate and would mis-route Sprint 3's `received` /
    // `en_route` flow).
    //
    // Every order_line_items correlated lookup adds `oli.tenant_id =
    // ord.tenant_id` (codex fix — order_line_items has no DB-level
    // composite FK to orders.tenant_id, so a drifted row could otherwise
    // satisfy visibility checks across tenants).
    return this.db.queryMany<VendorOrderListItem>(
      `select
         ord.id                                  as id,
         ord.id::text                            as external_ref,
         coalesce(ord.requested_for_start_at, ord.delivery_date::timestamptz + ord.delivery_time::time)
                                                 as delivery_at,
         /* Pre-formatted location label — vendor doesn't need raw FKs. */
         coalesce(
           s_room.name || ' · ' || s_floor.name || ' · ' || s_building.name,
           s_room.name,
           '(no location)'
         )                                       as delivery_location,
         ord.headcount                           as headcount,
         coalesce(
           (ord.policy_snapshot->>'service_type')::text,
           'catering'
         )                                       as service_type,
         agg.fulfillment_status                  as fulfillment_status,
         agg.requires_phone_followup             as requires_phone_followup,
         agg.lines_summary                       as lines_summary
       from orders ord
       left join spaces s_room
         on s_room.id = ord.delivery_location_id
        and s_room.tenant_id = ord.tenant_id
       left join spaces s_floor
         on s_floor.id = s_room.parent_id
        and s_floor.tenant_id = ord.tenant_id
       left join spaces s_building
         on s_building.id = s_floor.parent_id
        and s_building.tenant_id = ord.tenant_id
       cross join lateral (
         select
           case
             when bool_or(oli.requires_phone_followup and oli.desk_confirmed_phoned_at is null)
                  then 'requires_phone_followup'
             when bool_and(oli.fulfillment_status = 'delivered') then 'delivered'
             when bool_or(oli.fulfillment_status = 'preparing') then 'preparing'
             else 'ordered'
           end as fulfillment_status,
           bool_or(oli.requires_phone_followup and oli.desk_confirmed_phoned_at is null)
                  as requires_phone_followup,
           string_agg(
             oli.quantity || '× ' || coalesce(ci.name, 'Item'),
             ' · '
             order by oli.id
           ) as lines_summary,
           count(*) as line_count
         from order_line_items oli
         left join catalog_items ci
           on ci.id = oli.catalog_item_id
          and ci.tenant_id = ord.tenant_id
         where oli.order_id = ord.id
           and oli.tenant_id = ord.tenant_id
           and oli.vendor_id = $2
           and oli.recurrence_skipped is not true
       ) agg
       where ord.tenant_id = $1
         and ord.delivery_date between $3::date and $4::date
         and ord.status not in ('cancelled')
         and agg.line_count > 0
         ${safeStatus ? `and agg.fulfillment_status = $5` : ''}
       order by delivery_at asc
       limit 500`,
      safeStatus
        ? [tenantId, vendorId, fromDate, toDate, safeStatus]
        : [tenantId, vendorId, fromDate, toDate],
    );
  }

  /**
   * Detail projection. Same PII rules. Throws 404 (not 403) when the order
   * isn't visible to this vendor — leaking "exists but you can't see it"
   * is itself information.
   *
   * Returns the public DTO **plus** the internal `audit_subject_person_id`
   * for the access-log writer. The id is NOT exposed in the response shape
   * — controllers extract it for `personal_data_access_logs` then strip it
   * before returning the body.
   */
  async getDetailForVendor(input: DetailInput): Promise<VendorOrderDetailWithAudit> {
    const { tenantId, vendorId, orderId } = input;

    const order = await this.db.queryOne<VendorOrderDetailRow>(
      `select
         ord.id                                  as id,
         ord.id::text                            as external_ref,
         coalesce(ord.requested_for_start_at, ord.delivery_date::timestamptz + ord.delivery_time::time)
                                                 as delivery_at,
         ord.headcount                           as headcount,
         /* Requester FIRST NAME ONLY for the response. requester_person_id
            is selected for the access-log writer ONLY (stripped before the
            controller returns the body). Last name + email + phone never
            selected. */
         p.first_name                            as requester_first_name,
         ord.requester_person_id                 as audit_subject_person_id,
         /* Delivery-location object surfaces three labels; no FK ids. */
         s_room.name                             as room_name,
         s_floor.name                            as floor_label,
         s_building.name                         as building_name,
         /* Service window from the order policy_snapshot or columns. */
         ord.requested_for_start_at              as service_window_start_at,
         ord.requested_for_end_at                as service_window_end_at,
         ord.policy_snapshot                     as policy_snapshot,
         t.name                                  as tenant_name
       from orders ord
       left join persons p
         on p.id = ord.requester_person_id
        and p.tenant_id = ord.tenant_id
       left join spaces s_room
         on s_room.id = ord.delivery_location_id
        and s_room.tenant_id = ord.tenant_id
       left join spaces s_floor
         on s_floor.id = s_room.parent_id
        and s_floor.tenant_id = ord.tenant_id
       left join spaces s_building
         on s_building.id = s_floor.parent_id
        and s_building.tenant_id = ord.tenant_id
       left join tenants t on t.id = ord.tenant_id
       where ord.tenant_id = $1
         and ord.id = $2
         and ord.status not in ('cancelled')
         and exists (
           select 1 from order_line_items oli
            where oli.order_id = ord.id
              and oli.tenant_id = ord.tenant_id   -- codex fix: defense-in-depth tenant scope
              and oli.vendor_id = $3
              and oli.recurrence_skipped is not true
         )`,
      [tenantId, orderId, vendorId],
    );
    if (!order) throw new NotFoundException('Order not found');

    const lines = await this.db.queryMany<VendorOrderLine>(
      `select
         oli.id                                  as id,
         coalesce(ci.name, 'Item')               as name,
         oli.quantity                            as quantity,
         coalesce(
           (oli.policy_snapshot->>'unit')::text,
           'per_item'
         )                                       as unit,
         oli.dietary_notes                       as dietary_notes,
         oli.fulfillment_status                  as fulfillment_status,
         oli.requires_phone_followup             as requires_phone_followup,
         oli.daglijst_locked_at                  as daglijst_locked_at
       from order_line_items oli
       left join catalog_items ci
         on ci.id = oli.catalog_item_id
        and ci.tenant_id = oli.tenant_id
       where oli.order_id = $1
         and oli.tenant_id = $2
         and oli.vendor_id = $3
         and oli.recurrence_skipped is not true
       order by oli.id`,
      [orderId, tenantId, vendorId],
    );

    return {
      detail: {
        id: order.id,
        external_ref: order.external_ref,
        delivery_at: order.delivery_at,
        headcount: order.headcount,
        requester_first_name: order.requester_first_name,
        delivery_location: {
          room_name: order.room_name,
          floor_label: order.floor_label,
          building_name: order.building_name,
          navigation_hint: pickNavigationHint(order.policy_snapshot),
        },
        service_window_start_at: order.service_window_start_at,
        service_window_end_at: order.service_window_end_at,
        lines,
        desk_contact: pickDeskContact(order.policy_snapshot),
        policy: {
          cancellation_cutoff_at: pickPolicyValue(order.policy_snapshot, 'cancellation_cutoff_at'),
        },
        tenant_name: order.tenant_name,
      },
      auditSubjectPersonId: order.audit_subject_person_id,
    };
  }
}

// =====================================================================
// helpers — pull only safe fields from policy_snapshot, never the whole
// jsonb (which contains internal pricing + decision-tree state).
// =====================================================================

function pickPolicyValue(snapshot: unknown, key: string): string | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const v = (snapshot as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : null;
}

function pickDeskContact(snapshot: unknown): { phone: string | null; email: string | null } {
  if (!snapshot || typeof snapshot !== 'object') return { phone: null, email: null };
  const dc = (snapshot as Record<string, unknown>)['desk_contact'];
  if (!dc || typeof dc !== 'object') return { phone: null, email: null };
  const obj = dc as Record<string, unknown>;
  return {
    phone: typeof obj.phone === 'string' ? obj.phone : null,
    email: typeof obj.email === 'string' ? obj.email : null,
  };
}

function pickNavigationHint(snapshot: unknown): string | null {
  return pickPolicyValue(snapshot, 'navigation_hint');
}

// =====================================================================
// types
// =====================================================================

export interface ListInput {
  tenantId: string;
  vendorId: string;
  fromDate: string;     // YYYY-MM-DD
  toDate: string;       // YYYY-MM-DD
  statusFilter?: string;
}

export interface DetailInput {
  tenantId: string;
  vendorId: string;
  orderId: string;
}

export interface VendorOrderListItem {
  id: string;
  external_ref: string;
  delivery_at: string;
  delivery_location: string;
  headcount: number | null;
  service_type: string;
  fulfillment_status: string;
  requires_phone_followup: boolean;
  lines_summary: string | null;
}

export interface VendorOrderLine {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  dietary_notes: string | null;
  fulfillment_status: string;
  requires_phone_followup: boolean;
  daglijst_locked_at: string | null;
}

export interface VendorOrderDetail {
  id: string;
  external_ref: string;
  delivery_at: string;
  headcount: number | null;
  requester_first_name: string | null;
  delivery_location: {
    room_name: string | null;
    floor_label: string | null;
    building_name: string | null;
    navigation_hint: string | null;
  };
  service_window_start_at: string | null;
  service_window_end_at: string | null;
  lines: VendorOrderLine[];
  desk_contact: { phone: string | null; email: string | null };
  policy: { cancellation_cutoff_at: string | null };
  tenant_name: string | null;
}

/**
 * Internal-only return shape from getDetailForVendor: the public DTO + the
 * audit_subject_person_id needed for `personal_data_access_logs`. The
 * controller writes the access log then returns ONLY `.detail` to the
 * vendor — the subject person id is never exposed in the response body.
 */
export interface VendorOrderDetailWithAudit {
  detail: VendorOrderDetail;
  auditSubjectPersonId: string | null;
}

interface VendorOrderDetailRow {
  id: string;
  external_ref: string;
  delivery_at: string;
  headcount: number | null;
  requester_first_name: string | null;
  audit_subject_person_id: string | null;
  room_name: string | null;
  floor_label: string | null;
  building_name: string | null;
  service_window_start_at: string | null;
  service_window_end_at: string | null;
  policy_snapshot: unknown;
  tenant_name: string | null;
}

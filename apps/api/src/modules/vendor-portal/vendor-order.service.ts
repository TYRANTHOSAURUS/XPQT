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
         /* Aggregate fulfillment status — most-blocking line wins. */
         (
           select case
             when bool_or(oli.requires_phone_followup) then 'requires_phone_followup'
             when bool_and(oli.fulfillment_status = 'delivered') then 'delivered'
             when bool_or(oli.fulfillment_status = 'preparing') then 'preparing'
             else 'ordered'
           end
             from order_line_items oli
            where oli.order_id = ord.id
              and oli.vendor_id = $2
              and oli.recurrence_skipped is not true
         )                                       as fulfillment_status,
         exists (
           select 1 from order_line_items oli
            where oli.order_id = ord.id
              and oli.vendor_id = $2
              and oli.requires_phone_followup = true
              and oli.desk_confirmed_phoned_at is null
         )                                       as requires_phone_followup,
         /* lines_summary: human-readable single-line digest (no pricing). */
         (
           select string_agg(
             oli.quantity || '× ' || coalesce(ci.name, 'Item'),
             ' · '
             order by oli.id
           )
             from order_line_items oli
             left join catalog_items ci
               on ci.id = oli.catalog_item_id
              and ci.tenant_id = ord.tenant_id
            where oli.order_id = ord.id
              and oli.vendor_id = $2
              and oli.recurrence_skipped is not true
         )                                       as lines_summary
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
       where ord.tenant_id = $1
         and ord.delivery_date between $3::date and $4::date
         and ord.status not in ('cancelled')
         and exists (
           select 1 from order_line_items oli
            where oli.order_id = ord.id
              and oli.vendor_id = $2
              and oli.recurrence_skipped is not true
         )
         ${statusFilter ? `and exists (
           select 1 from order_line_items oli2
            where oli2.order_id = ord.id
              and oli2.vendor_id = $2
              and oli2.fulfillment_status = $5
              and oli2.recurrence_skipped is not true
         )` : ''}
       order by delivery_at asc
       limit 500`,
      statusFilter
        ? [tenantId, vendorId, fromDate, toDate, statusFilter]
        : [tenantId, vendorId, fromDate, toDate],
    );
  }

  /**
   * Detail projection. Same PII rules. Throws 404 (not 403) when the order
   * isn't visible to this vendor — leaking "exists but you can't see it"
   * is itself information.
   */
  async getDetailForVendor(input: DetailInput): Promise<VendorOrderDetail> {
    const { tenantId, vendorId, orderId } = input;

    const order = await this.db.queryOne<VendorOrderDetailRow>(
      `select
         ord.id                                  as id,
         ord.id::text                            as external_ref,
         coalesce(ord.requested_for_start_at, ord.delivery_date::timestamptz + ord.delivery_time::time)
                                                 as delivery_at,
         ord.headcount                           as headcount,
         /* Requester FIRST NAME ONLY. Last name + email + phone never selected. */
         p.first_name                            as requester_first_name,
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

interface VendorOrderDetailRow {
  id: string;
  external_ref: string;
  delivery_at: string;
  headcount: number | null;
  requester_first_name: string | null;
  room_name: string | null;
  floor_label: string | null;
  building_name: string | null;
  service_window_start_at: string | null;
  service_window_end_at: string | null;
  policy_snapshot: unknown;
  tenant_name: string | null;
}

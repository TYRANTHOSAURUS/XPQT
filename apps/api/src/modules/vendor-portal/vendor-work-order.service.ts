import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/db/db.service';

/**
 * Vendor-side work-order projections — strict PII minimization, mirroring
 * VendorOrderService for the orders/lines half.
 *
 * Source of truth: tickets where ticket_kind = 'work_order' and the vendor
 * is the explicit assignee. Visibility is enforced via the SQL function
 * `tickets_visible_for_vendor(p_vendor_id, p_tenant_id)` (00188), so a
 * misuse of `vendor_id` here can't expose another tenant's tickets.
 *
 * What the vendor SEES (per Wave-2 plan + GDPR baseline minimization):
 *   - Ticket id, due date, location label, title, status, priority
 *
 * What the vendor NEVER sees:
 *   - requester_person_id, watchers, assigned_user_id (operator identity)
 *   - description / form_data — those can carry PII; not in this projection
 *   - cost / satisfaction_rating
 *   - other vendors or sibling tickets sharing the same parent
 */
@Injectable()
export class VendorWorkOrderService {
  constructor(private readonly db: DbService) {}

  /**
   * List vendor work-orders inside the (today + N days) window. Defaults
   * mirror /vendor/orders so a unified inbox can fan in both feeds with
   * the same client-side window.
   */
  async listForVendor(input: ListInput): Promise<VendorWorkOrderListItem[]> {
    const { tenantId, vendorId, fromDate, toDate, statusFilter } = input;

    // Closed enum the SELECT can return; anything else collapses to null
    // so we don't leak unknown statuses through the filter.
    const VALID_STATUSES = new Set([
      'new', 'assigned', 'in_progress', 'waiting', 'resolved', 'closed',
    ]);
    const safeStatus = statusFilter && VALID_STATUSES.has(statusFilter)
      ? statusFilter
      : null;

    return this.db.queryMany<VendorWorkOrderListItem>(
      `select
         t.id                                     as id,
         t.id::text                               as external_ref,
         coalesce(
           t.sla_resolution_due_at,
           t.created_at
         )                                        as due_at,
         coalesce(
           s_room.name || ' · ' || s_floor.name || ' · ' || s_building.name,
           s_room.name,
           '(no location)'
         )                                        as location,
         t.title                                  as title,
         t.status_category                        as status,
         t.priority                               as priority,
         t.sla_at_risk                            as sla_at_risk
       from public.tickets_visible_for_vendor($1::uuid, $2::uuid) t
       left join public.spaces s_room
         on s_room.id = t.location_id
        and s_room.tenant_id = t.tenant_id
       left join public.spaces s_floor
         on s_floor.id = s_room.parent_id
        and s_floor.tenant_id = t.tenant_id
       left join public.spaces s_building
         on s_building.id = s_floor.parent_id
        and s_building.tenant_id = t.tenant_id
       where coalesce(t.sla_resolution_due_at, t.created_at)::date between $3::date and $4::date
         and ($5::text is null or t.status_category = $5)
       order by coalesce(t.sla_resolution_due_at, t.created_at) asc
       limit 500`,
      [vendorId, tenantId, fromDate, toDate, safeStatus],
    );
  }
}

export interface ListInput {
  tenantId: string;
  vendorId: string;
  fromDate: string; // YYYY-MM-DD
  toDate: string;   // YYYY-MM-DD
  statusFilter?: string;
}

export interface VendorWorkOrderListItem {
  id: string;
  external_ref: string;
  due_at: string;
  location: string;
  title: string;
  status: 'new' | 'assigned' | 'in_progress' | 'waiting' | 'resolved' | 'closed';
  priority: string | null;
  sla_at_risk: boolean | null;
}

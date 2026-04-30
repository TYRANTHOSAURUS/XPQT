import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/db/db.service';

/**
 * Vendor-side work-order projections — strict PII minimization, mirroring
 * VendorOrderService for the orders/lines half.
 *
 * Source of truth: `public.work_orders` view (filtered tickets where
 * ticket_kind = 'work_order'; see migration 00204+00205+00208). The vendor
 * predicate is two-part:
 *   1. `t.assigned_vendor_id = $vendor_id AND t.tenant_id = $tenant_id`
 *      — the explicit assignment.
 *   2. `JOIN vendors v ON v.id = t.assigned_vendor_id AND v.tenant_id = $tenant_id`
 *      — cross-tenant self-defence (00191): tickets.assigned_vendor_id is
 *      FK'd to vendors(id) only, not the (id, tenant_id) pair, so a drifted
 *      ticket pointing at a cross-tenant vendor would slip past tenant
 *      filtering without this join.
 *
 * What the vendor SEES (per Wave-2 plan + GDPR baseline minimization):
 *   - Ticket id, due date, location label, request-type label, status, priority
 *
 * Title source: we project `request_types.name` (admin-controlled label,
 * vendor-safe by construction) NOT `tickets.title` (operator-authored free
 * text — codex 2026-04-29 review flagged that operators can put PII into
 * titles). A future wave can add an opt-in `tickets.vendor_safe_title`
 * column for cases where the type label isn't specific enough.
 *
 * What the vendor NEVER sees:
 *   - tickets.title (free text — see above)
 *   - requester_person_id, watchers, assigned_user_id (operator identity)
 *   - description / form_data — those can carry PII; not in this projection
 *   - cost / satisfaction_rating
 *   - other vendors or sibling tickets sharing the same parent
 *
 * Cutover history: was previously sourced from
 * `public.tickets_visible_for_vendor(p_vendor_id, p_tenant_id)` (00188 +
 * 00191). Switched to the work_orders view in step 1b of the data-model
 * redesign (commit 865934e + a5cbbd2 — see docs/data-model-redesign-2026-04-30.md).
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

    // Step 1b cutover (data-model-redesign-2026-04-30.md): read from the
    // public.work_orders view instead of public.tickets_visible_for_vendor.
    // The vendor visibility predicate is inlined here:
    //   - t.tenant_id = $2 AND t.assigned_vendor_id = $1
    //   - JOIN vendors v ON v.id = t.assigned_vendor_id
    //                   AND v.tenant_id = t.tenant_id
    //                   AND v.tenant_id = $2
    // The vendors join is the cross-tenant self-defence from 00191: tickets
    // FK assigned_vendor_id → vendors(id) only, not the (id, tenant_id)
    // pair, so a drifted row pointing at a cross-tenant vendor would be
    // visible without this join. Behavior is identical to the old function.
    // PII protection lives in this SELECT projection, not in the source.
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
         /* Vendor-safe label: admin-controlled request type name, not the
            operator-authored ticket title (which can carry PII). */
         coalesce(rt.name, 'Work order')          as label,
         t.status_category                        as status,
         t.priority                               as priority,
         t.sla_at_risk                            as sla_at_risk
       from public.work_orders t
       join public.vendors v
         on v.id = t.assigned_vendor_id
        and v.tenant_id = t.tenant_id
        and v.tenant_id = $2::uuid
       left join public.request_types rt
         on rt.id = t.ticket_type_id
        and rt.tenant_id = t.tenant_id
       left join public.spaces s_room
         on s_room.id = t.location_id
        and s_room.tenant_id = t.tenant_id
       left join public.spaces s_floor
         on s_floor.id = s_room.parent_id
        and s_floor.tenant_id = t.tenant_id
       left join public.spaces s_building
         on s_building.id = s_floor.parent_id
        and s_building.tenant_id = t.tenant_id
       where t.tenant_id = $2::uuid
         and t.assigned_vendor_id = $1::uuid
         and coalesce(t.sla_resolution_due_at, t.created_at)::date between $3::date and $4::date
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
  /** Admin-controlled request-type name. Vendor-safe (no free-text PII). */
  label: string;
  status: 'new' | 'assigned' | 'in_progress' | 'waiting' | 'resolved' | 'closed';
  priority: string | null;
  sla_at_risk: boolean | null;
}

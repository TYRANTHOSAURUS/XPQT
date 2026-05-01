import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { BundleVisibilityService } from './bundle-visibility.service';
import { BundleCascadeService, type CancelScope } from './bundle-cascade.service';
import { BundleService, type ServiceLineInput } from './bundle.service';

/** Map catalog_items.category → ServiceType for the picker chip path.
 *  Inverse of `SERVICE_TYPE_TO_CATEGORY` in service-catalog.controller.ts. */
function inferServiceTypeFromCategory(category: string | null | undefined): string | null {
  switch (category) {
    case 'food_and_drinks': return 'catering';
    case 'equipment': return 'av_equipment';
    case 'supplies': return 'supplies';
    case 'services': return 'facilities_services';
    default: return null;
  }
}

interface CancelBundleBody {
  keep_line_ids?: string[];
  recurrence_scope?: CancelScope;
  reason?: string;
}

@Controller('booking-bundles')
export class BookingBundlesController {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly visibility: BundleVisibilityService,
    private readonly cascade: BundleCascadeService,
    private readonly bundle: BundleService,
  ) {}

  /**
   * `GET /booking-bundles/recent` — the caller's most-recent service-bearing
   * bundles, returned with a slim line summary so the booking composer's
   * "Your usual" chip row can re-seed the picker in one tap. Powers Phase
   * B's personal templates / "rebook this" affordance without a separate
   * templates table — recency is the template.
   *
   * Filters: at least one line, requester or host = current person, sorted
   * by created_at desc, capped at 5. Private to the caller — no cross-user
   * leak even with read_all because the where-clause restricts to their
   * person_id.
   */
  @Get('recent')
  async listRecentForMe(@Req() request: Request) {
    const authUid = this.getAuthUid(request);
    const tenantId = TenantContext.current().id;
    const ctx = await this.visibility.loadContext(authUid, tenantId);

    if (!ctx.person_id) return { bundles: [] };

    // Pull the 10 most recent bundles touching this person, then trim to 5
    // after filtering out empties. Ten is a safety margin against bundles
    // that lazy-created but never had lines attached.
    const bundlesRes = await this.supabase.admin
      .from('booking_bundles')
      .select('id, primary_reservation_id, start_at, end_at, location_id, created_at')
      .eq('tenant_id', tenantId)
      .or(`requester_person_id.eq.${ctx.person_id},host_person_id.eq.${ctx.person_id}`)
      .order('created_at', { ascending: false })
      .limit(10);
    if (bundlesRes.error) throw bundlesRes.error;
    const bundleRows = (bundlesRes.data ?? []) as Array<{
      id: string;
      primary_reservation_id: string | null;
      start_at: string;
      end_at: string;
      location_id: string;
      created_at: string;
    }>;
    if (bundleRows.length === 0) return { bundles: [] };

    const bundleIds = bundleRows.map((b) => b.id);
    const spaceIds = Array.from(new Set(bundleRows.map((b) => b.location_id)));

    // Fan-out the joins in parallel: orders for these bundles, line items
    // through those orders, catalog item names, and space names.
    const [ordersRes, spacesRes] = await Promise.all([
      this.supabase.admin
        .from('orders')
        .select('id, booking_bundle_id')
        .in('booking_bundle_id', bundleIds),
      this.supabase.admin
        .from('spaces')
        .select('id, name')
        .in('id', spaceIds),
    ]);
    if (ordersRes.error) throw ordersRes.error;
    if (spacesRes.error) throw spacesRes.error;
    const orderRows = (ordersRes.data ?? []) as Array<{ id: string; booking_bundle_id: string }>;
    const spaceById = new Map(
      ((spacesRes.data ?? []) as Array<{ id: string; name: string }>).map((s) => [s.id, s.name]),
    );

    if (orderRows.length === 0) return { bundles: [] };
    const orderIds = orderRows.map((o) => o.id);
    const orderToBundle = new Map(orderRows.map((o) => [o.id, o.booking_bundle_id]));

    const linesRes = await this.supabase.admin
      .from('order_line_items')
      .select(
        'order_id, catalog_item_id, quantity, unit_price, unit, fulfillment_status, catalog_item:catalog_items(name, category, image_url), menu_id, menu_items:menu_items(menu_id, service_type:catalog_menus(service_type))',
      )
      .in('order_id', orderIds)
      .neq('fulfillment_status', 'cancelled');
    if (linesRes.error) throw linesRes.error;

    type LineRow = {
      order_id: string;
      catalog_item_id: string;
      quantity: number;
      unit_price: number | null;
      unit: 'per_item' | 'per_person' | 'flat_rate' | null;
      catalog_item: { name: string; category: string; image_url: string | null } | { name: string }[] | null;
      menu_id: string | null;
      menu_items: unknown;
    };
    const linesByBundle = new Map<string, Array<{
      catalog_item_id: string;
      menu_id: string | null;
      name: string;
      quantity: number;
      unit_price: number | null;
      unit: 'per_item' | 'per_person' | 'flat_rate' | null;
      service_type: string | null;
    }>>();

    for (const row of (linesRes.data ?? []) as LineRow[]) {
      const bundleId = orderToBundle.get(row.order_id);
      if (!bundleId) continue;
      const ci = Array.isArray(row.catalog_item) ? row.catalog_item[0] : row.catalog_item;
      // service_type derives from the menu's parent (catalog_menus.service_type).
      // The nested join's typing is finicky; fall back to category-implied
      // service_type if the path resolves messy.
      const serviceType = inferServiceTypeFromCategory((ci as { category?: string })?.category);
      const list = linesByBundle.get(bundleId) ?? [];
      list.push({
        catalog_item_id: row.catalog_item_id,
        menu_id: row.menu_id,
        name: (ci as { name?: string })?.name ?? 'Service item',
        quantity: row.quantity,
        unit_price: row.unit_price,
        unit: row.unit,
        service_type: serviceType,
      });
      linesByBundle.set(bundleId, list);
    }

    const result = bundleRows
      .map((b) => {
        const lines = linesByBundle.get(b.id) ?? [];
        if (lines.length === 0) return null;
        return {
          id: b.id,
          start_at: b.start_at,
          end_at: b.end_at,
          space_name: spaceById.get(b.location_id) ?? null,
          line_summary: lines,
        };
      })
      .filter((b): b is NonNullable<typeof b> => b !== null)
      .slice(0, 5);

    return { bundles: result };
  }

  /**
   * GET /booking-bundles/:id — full bundle detail with status_rollup from
   * the booking_bundle_status_v view + linked entity ids. Visibility-gated
   * via the three-tier model in `BundleVisibilityService`.
   */
  @Get(':id')
  async findOne(@Req() request: Request, @Param('id') id: string) {
    const authUid = this.getAuthUid(request);
    const tenantId = TenantContext.current().id;
    const ctx = await this.visibility.loadContext(authUid, tenantId);

    const { data, error } = await this.supabase.admin
      .from('booking_bundles')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new NotFoundException({ code: 'bundle_not_found', message: `Bundle ${id} not found.` });

    const bundle = data as {
      id: string;
      requester_person_id: string;
      host_person_id: string | null;
      location_id: string;
    } & Record<string, unknown>;

    await this.visibility.assertVisible(bundle, ctx);

    // Pull the derived status from the view + linked entity ids in parallel.
    const [statusRes, ordersRes, ticketsRes] = await Promise.all([
      this.supabase.admin
        .from('booking_bundle_status_v')
        .select('status_rollup, reservation_statuses, order_statuses, ticket_statuses')
        .eq('bundle_id', id)
        .maybeSingle(),
      this.supabase.admin
        .from('orders')
        .select('id, status, requested_for_start_at, requested_for_end_at')
        .eq('booking_bundle_id', id),
      // Step 1c.10c: tickets is case-only. Booking-origin work orders are
      // in work_orders. ticket_kind column is dropped — every row here is
      // a work_order by construction (it has booking_bundle_id).
      this.supabase.admin
        .from('work_orders')
        .select(
          'id, status_category, assigned_user_id, assigned_team_id, assigned_vendor_id, module_number, ' +
            'assigned_user:users!assigned_user_id(person:persons!person_id(first_name,last_name)), ' +
            'assigned_team:teams!assigned_team_id(name), ' +
            'assigned_vendor:vendors!assigned_vendor_id(name)',
        )
        .eq('booking_bundle_id', id),
    ]);

    if (statusRes.error) throw statusRes.error;
    if (ordersRes.error) throw ordersRes.error;
    if (ticketsRes.error) throw ticketsRes.error;

    const orderIds = ((ordersRes.data ?? []) as Array<{ id: string }>).map((o) => o.id);

    // Lines + their catalog item names — second round-trip; only fires
    // when the bundle has at least one order. Bundle drawers are opened
    // one-at-a-time so the cost of two queries is negligible vs.
    // pre-joining everything at the SQL level.
    let lines: Array<{
      id: string;
      order_id: string;
      catalog_item_id: string;
      catalog_item_name: string | null;
      quantity: number;
      unit_price: number | null;
      line_total: number | null;
      service_window_start_at: string | null;
      service_window_end_at: string | null;
      requester_notes: string | null;
      updated_at: string;
      fulfillment_status: string | null;
      linked_ticket_id: string | null;
      linked_asset_reservation_id: string | null;
    }> = [];
    if (orderIds.length > 0) {
      const linesRes = await this.supabase.admin
        .from('order_line_items')
        .select(
          'id, order_id, catalog_item_id, quantity, unit_price, line_total, service_window_start_at, service_window_end_at, requester_notes, updated_at, fulfillment_status, linked_ticket_id, linked_asset_reservation_id, catalog_item:catalog_items(name)',
        )
        .in('order_id', orderIds);
      if (linesRes.error) throw linesRes.error;
      lines = ((linesRes.data ?? []) as Array<{
        id: string;
        order_id: string;
        catalog_item_id: string;
        quantity: number;
        unit_price: number | null;
        line_total: number | null;
        service_window_start_at: string | null;
        service_window_end_at: string | null;
        requester_notes: string | null;
        updated_at: string;
        fulfillment_status: string | null;
        linked_ticket_id: string | null;
        linked_asset_reservation_id: string | null;
        catalog_item: { name: string } | { name: string }[] | null;
      }>).map((row) => {
        const ci = Array.isArray(row.catalog_item) ? row.catalog_item[0] : row.catalog_item;
        return {
          id: row.id,
          order_id: row.order_id,
          catalog_item_id: row.catalog_item_id,
          catalog_item_name: ci?.name ?? null,
          quantity: row.quantity,
          unit_price: row.unit_price,
          line_total: row.line_total,
          service_window_start_at: row.service_window_start_at,
          service_window_end_at: row.service_window_end_at,
          requester_notes: row.requester_notes,
          updated_at: row.updated_at,
          fulfillment_status: row.fulfillment_status,
          linked_ticket_id: row.linked_ticket_id,
          linked_asset_reservation_id: row.linked_asset_reservation_id,
        };
      });
    }

    const statusRow = statusRes.data as { status_rollup: string } | null;

    // Denormalize an assignee_label per ticket so the frontend renders
    // "Sarah Lim" / "Catering team" / "Acme Catering" instead of a
    // category placeholder. Joins above already pulled the name fields.
    // Step 1c.10c: rows come from work_orders, not tickets. ticket_kind
    // is gone; all rows are work_orders by construction.
    type TicketJoinRow = {
      id: string;
      status_category: string | null;
      assigned_user_id: string | null;
      assigned_team_id: string | null;
      assigned_vendor_id: string | null;
      module_number: number | null;
      assigned_user?:
        | { person?: { first_name: string | null; last_name: string | null } | null }
        | null;
      assigned_team?: { name: string | null } | null;
      assigned_vendor?: { name: string | null } | null;
    };
    const tickets = ((ticketsRes.data ?? []) as unknown as TicketJoinRow[]).map((t) => {
      const userPerson = t.assigned_user?.person ?? null;
      const userName = userPerson
        ? `${userPerson.first_name ?? ''} ${userPerson.last_name ?? ''}`.trim()
        : null;
      const assignee_label = t.assigned_vendor_id
        ? t.assigned_vendor?.name ?? 'Vendor'
        : t.assigned_team_id
          ? t.assigned_team?.name ?? 'Team'
          : t.assigned_user_id
            ? userName || 'User'
            : null;
      return {
        id: t.id,
        // Synthesize ticket_kind for API contract continuity with frontend.
        ticket_kind: 'work_order' as const,
        status_category: t.status_category,
        assigned_user_id: t.assigned_user_id,
        assigned_team_id: t.assigned_team_id,
        assigned_vendor_id: t.assigned_vendor_id,
        module_number: t.module_number,
        assignee_label,
      };
    });

    return {
      ...bundle,
      status_rollup: statusRow?.status_rollup ?? 'pending',
      orders: ordersRes.data ?? [],
      tickets,
      lines,
    };
  }

  /**
   * `POST /booking-bundles/:id/lines` — append service lines to an existing
   * bundle by bundle id. Use this when the caller already has a bundle
   * reference (e.g. an admin tooling path that lists bundles directly,
   * or a future per-bundle add-line surface).
   *
   * Sibling: `POST /reservations/:id/services` is the reservation-id-first
   * entry point used by the post-booking "+ Add service" UI; that one
   * lazy-creates the bundle on first attach. Pick the endpoint whose
   * primary key the caller already holds — they share the same write
   * pipeline and produce identical side-effects.
   *
   * Write gate: requester / host / `rooms.admin` / `rooms.write_all`.
   * `rooms.read_all`-only operators cannot mutate other people's bookings.
   */
  @Post(':id/lines')
  async addLines(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: { services: ServiceLineInput[] },
  ) {
    const authUid = this.getAuthUid(request);
    const tenantId = TenantContext.current().id;
    const ctx = await this.visibility.loadContext(authUid, tenantId);

    const { data: bundleRow, error } = await this.supabase.admin
      .from('booking_bundles')
      .select('id, requester_person_id, host_person_id, location_id')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error) throw error;
    if (!bundleRow) {
      throw new NotFoundException({ code: 'bundle_not_found', message: `Bundle ${id} not found.` });
    }
    const bundle = bundleRow as { id: string; requester_person_id: string; host_person_id: string | null; location_id: string };

    await this.visibility.assertVisible(bundle, ctx);
    this.assertCanWrite(bundle, ctx);

    return this.bundle.addLinesToBundle({
      bundle_id: id,
      requester_person_id: bundle.requester_person_id,
      services: body?.services ?? [],
    });
  }

  /**
   * `PATCH /booking-bundles/lines/:lineId` — edit qty / service window on a
   * line that hasn't yet been picked up by fulfillment. Fulfilled or
   * cancelled lines reject (cancel + re-add is the path).
   */
  @Patch('lines/:lineId')
  async editLine(
    @Req() request: Request,
    @Param('lineId') lineId: string,
    @Body() body: {
      quantity?: number;
      service_window_start_at?: string | null;
      service_window_end_at?: string | null;
      requester_notes?: string | null;
      /** If-Match-style optimistic concurrency token. When provided, the
       *  server rejects with 409 if the line was edited since this read. */
      expected_updated_at?: string | null;
    },
  ) {
    const authUid = this.getAuthUid(request);
    const tenantId = TenantContext.current().id;
    const ctx = await this.visibility.loadContext(authUid, tenantId);

    // Resolve the line → its order → bundle to gate the write.
    const { data: lineRow, error } = await this.supabase.admin
      .from('order_line_items')
      .select('id, order_id')
      .eq('id', lineId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error) throw error;
    if (!lineRow) {
      throw new NotFoundException({ code: 'line_not_found', message: `Line ${lineId} not found.` });
    }
    const orderId = (lineRow as { order_id: string }).order_id;

    const { data: orderRow, error: orderErr } = await this.supabase.admin
      .from('orders')
      .select('booking_bundle_id')
      .eq('id', orderId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (orderErr) throw orderErr;
    const bundleId = (orderRow as { booking_bundle_id: string | null } | null)?.booking_bundle_id;
    if (!bundleId) {
      throw new NotFoundException({ code: 'bundle_not_found', message: `Line ${lineId} is not attached to a bundle.` });
    }

    const { data: bundleRow, error: bundleErr } = await this.supabase.admin
      .from('booking_bundles')
      .select('id, requester_person_id, host_person_id, location_id')
      .eq('id', bundleId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (bundleErr) throw bundleErr;
    if (!bundleRow) {
      throw new NotFoundException({ code: 'bundle_not_found', message: `Bundle ${bundleId} not found.` });
    }
    const bundle = bundleRow as { id: string; requester_person_id: string; host_person_id: string | null; location_id: string };

    await this.visibility.assertVisible(bundle, ctx);
    this.assertCanWrite(bundle, ctx);

    return this.bundle.editLine({
      line_id: lineId,
      patch: {
        quantity: body?.quantity,
        service_window_start_at: body?.service_window_start_at,
        service_window_end_at: body?.service_window_end_at,
        requester_notes: body?.requester_notes,
      },
      expected_updated_at: body?.expected_updated_at ?? null,
    });
  }

  @Post(':id/cancel')
  async cancel(
    @Req() request: Request,
    @Body() body: CancelBundleBody,
    @Param('id') id: string,
  ) {
    const authUid = this.getAuthUid(request);
    const tenantId = TenantContext.current().id;
    const ctx = await this.visibility.loadContext(authUid, tenantId);
    return this.cascade.cancelBundle(
      {
        bundle_id: id,
        keep_line_ids: body?.keep_line_ids,
        recurrence_scope: body?.recurrence_scope,
        reason: body?.reason,
      },
      ctx,
    );
  }

  /**
   * `POST /booking-bundles/lines/:lineId/cancel` — single-line cancel per
   * spec §5.3 entry point #1. Cascades to the line's work-order ticket +
   * asset reservation and rescopes any pending approvals (auto-closing
   * rows whose scope drops to empty).
   */
  @Post('lines/:lineId/cancel')
  async cancelLine(
    @Req() request: Request,
    @Param('lineId') lineId: string,
    @Body() body: { reason?: string },
  ) {
    const authUid = this.getAuthUid(request);
    const tenantId = TenantContext.current().id;
    const ctx = await this.visibility.loadContext(authUid, tenantId);
    return this.cascade.cancelLine({ line_id: lineId, reason: body?.reason }, ctx);
  }

  private getAuthUid(req: Request): string {
    const u = (req as unknown as { user?: { id?: string } }).user;
    if (!u?.id) throw new UnauthorizedException('missing_user');
    return u.id;
  }

  /**
   * Write gate: bundle requester / host, `rooms.admin`, or `rooms.write_all`
   * may mutate. `rooms.read_all` operators stay read-only. Mirrors the
   * tier model in `ReservationVisibilityService.canEdit` so a `write_all`
   * operator who can edit reservations can also edit their bundles.
   */
  private assertCanWrite(
    bundle: { requester_person_id: string; host_person_id: string | null },
    ctx: { has_admin: boolean; has_write_all: boolean; person_id: string | null },
  ): void {
    if (ctx.has_admin || ctx.has_write_all) return;
    if (ctx.person_id && (bundle.requester_person_id === ctx.person_id || bundle.host_person_id === ctx.person_id)) {
      return;
    }
    throw new ForbiddenException({
      code: 'bundle_write_forbidden',
      message: 'Only the requester, host, or an admin can change this booking.',
    });
  }
}

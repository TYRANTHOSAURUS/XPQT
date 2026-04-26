import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { BundleVisibilityService } from './bundle-visibility.service';
import { BundleCascadeService, type CancelScope } from './bundle-cascade.service';

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
  ) {}

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
      this.supabase.admin
        .from('tickets')
        .select('id, ticket_kind, status_category, assigned_user_id, assigned_team_id, assigned_vendor_id, module_number')
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
      fulfillment_status: string | null;
      linked_ticket_id: string | null;
      linked_asset_reservation_id: string | null;
    }> = [];
    if (orderIds.length > 0) {
      const linesRes = await this.supabase.admin
        .from('order_line_items')
        .select(
          'id, order_id, catalog_item_id, quantity, unit_price, line_total, service_window_start_at, service_window_end_at, fulfillment_status, linked_ticket_id, linked_asset_reservation_id, catalog_item:catalog_items(name)',
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
          fulfillment_status: row.fulfillment_status,
          linked_ticket_id: row.linked_ticket_id,
          linked_asset_reservation_id: row.linked_asset_reservation_id,
        };
      });
    }

    const statusRow = statusRes.data as { status_rollup: string } | null;

    return {
      ...bundle,
      status_rollup: statusRow?.status_rollup ?? 'pending',
      orders: ordersRes.data ?? [],
      tickets: ticketsRes.data ?? [],
      lines,
    };
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

  private getAuthUid(req: Request): string {
    const u = (req as unknown as { user?: { id?: string } }).user;
    if (!u?.id) throw new UnauthorizedException('missing_user');
    return u.id;
  }
}

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
        .select('id, status')
        .eq('booking_bundle_id', id),
      this.supabase.admin
        .from('tickets')
        .select('id, ticket_kind, status_category')
        .eq('booking_bundle_id', id),
    ]);

    if (statusRes.error) throw statusRes.error;
    if (ordersRes.error) throw ordersRes.error;
    if (ticketsRes.error) throw ticketsRes.error;

    const statusRow = statusRes.data as { status_rollup: string } | null;

    return {
      ...bundle,
      status_rollup: statusRow?.status_rollup ?? 'pending',
      orders: ordersRes.data ?? [],
      tickets: ticketsRes.data ?? [],
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

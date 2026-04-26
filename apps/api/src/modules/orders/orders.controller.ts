import {
  BadRequestException,
  Body,
  Controller,
  NotImplementedException,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { OrderService, type CreateStandaloneOrderArgs } from './order.service';

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrderService,
    private readonly supabase: SupabaseService,
  ) {}

  @Post()
  create(@Body() _body: unknown) {
    // The composite path goes through POST /reservations with `services`.
    // A separate POST /orders (without reservation) is the standalone shape.
    throw new NotImplementedException(
      'orders.create is reserved for composite flow via POST /reservations',
    );
  }

  /**
   * `POST /orders/standalone` — services-only order, no reservation.
   * Creates a services-only `booking_bundles` row that owns the order +
   * approvals; this matches sub-project 3+ visitor-only / hospitality-only
   * bundle shape so the cancel/audit flows work uniformly.
   */
  @Post('standalone')
  async createStandalone(@Req() request: Request, @Body() body: CreateStandaloneOrderBody) {
    const authUid = this.getAuthUid(request);
    const tenantId = TenantContext.current().id;
    const requesterPersonId = await this.resolveRequesterPersonId(authUid, tenantId);

    if (!body || !Array.isArray(body.lines) || body.lines.length === 0) {
      throw new BadRequestException({ code: 'no_lines', message: 'lines[] is required' });
    }
    if (!body.delivery_space_id) {
      throw new BadRequestException({ code: 'missing_location', message: 'delivery_space_id is required' });
    }
    if (!body.requested_for_start_at || !body.requested_for_end_at) {
      throw new BadRequestException({ code: 'missing_window', message: 'requested_for_start_at and requested_for_end_at are required' });
    }

    const args: CreateStandaloneOrderArgs = {
      requester_person_id: requesterPersonId,
      delivery_space_id: body.delivery_space_id,
      requested_for_start_at: body.requested_for_start_at,
      requested_for_end_at: body.requested_for_end_at,
      cost_center_id: body.cost_center_id ?? null,
      lines: body.lines,
    };

    return this.orders.createStandalone(args);
  }

  /**
   * Per spec §5.2 — per-occurrence overrides + skip + revert. The drawer
   * on /portal/me-bookings sends one of these when the user tweaks a single
   * occurrence's service line. Each call sets `recurrence_overridden=true`
   * (so the materialiser leaves the line alone on series-level edits).
   */
  @Patch('order-line-items/:id/override')
  override(
    @Param('id') id: string,
    @Body()
    body: {
      quantity?: number;
      service_window_start_at?: string | null;
      service_window_end_at?: string | null;
    },
  ) {
    return this.orders.overrideLineForOccurrence(id, body ?? {});
  }

  @Patch('order-line-items/:id/skip')
  skip(@Param('id') id: string, @Body() body: { reason?: string }) {
    return this.orders.skipLineForOccurrence(id, body?.reason);
  }

  @Patch('order-line-items/:id/revert')
  revert(@Param('id') id: string) {
    return this.orders.revertLineForOccurrence(id);
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private getAuthUid(req: Request): string {
    const u = (req as unknown as { user?: { id?: string } }).user;
    if (!u?.id) throw new UnauthorizedException('missing_user');
    return u.id;
  }

  private async resolveRequesterPersonId(authUid: string, tenantId: string): Promise<string> {
    const { data, error } = await this.supabase.admin
      .from('users')
      .select('person_id')
      .eq('auth_uid', authUid)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error) throw error;
    const personId = (data as { person_id: string | null } | null)?.person_id;
    if (!personId) {
      throw new UnauthorizedException({ code: 'no_person', message: 'no person record linked to this user' });
    }
    return personId;
  }
}

interface CreateStandaloneOrderBody {
  delivery_space_id: string;
  requested_for_start_at: string;
  requested_for_end_at: string;
  cost_center_id?: string | null;
  lines: Array<{
    catalog_item_id: string;
    menu_id?: string | null;
    quantity: number;
    service_window_start_at?: string | null;
    service_window_end_at?: string | null;
    linked_asset_id?: string | null;
  }>;
}

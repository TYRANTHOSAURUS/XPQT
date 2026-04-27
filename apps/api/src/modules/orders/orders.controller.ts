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
   *
   * Authorisation: the line's order must be requested by the current user,
   * OR the user must hold rooms.read_all / rooms.admin (operator path).
   * supabase.admin bypasses RLS so this check is mandatory.
   */
  @Patch('order-line-items/:id/override')
  async override(
    @Req() request: Request,
    @Param('id') id: string,
    @Body()
    body: {
      quantity?: number;
      service_window_start_at?: string | null;
      service_window_end_at?: string | null;
    },
  ) {
    await this.assertCanEditLine(request, id);
    return this.orders.overrideLineForOccurrence(id, body ?? {});
  }

  @Patch('order-line-items/:id/skip')
  async skip(@Req() request: Request, @Param('id') id: string, @Body() body: { reason?: string }) {
    await this.assertCanEditLine(request, id);
    return this.orders.skipLineForOccurrence(id, body?.reason);
  }

  @Patch('order-line-items/:id/revert')
  async revert(@Req() request: Request, @Param('id') id: string) {
    await this.assertCanEditLine(request, id);
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

  /**
   * Per-occurrence override / skip / revert authorisation: the line's
   * parent order must belong to the current user, OR the user holds
   * `rooms.read_all` / `rooms.admin` (operator override). Throws 403 on
   * mismatch.
   */
  private async assertCanEditLine(req: Request, lineId: string): Promise<void> {
    const authUid = this.getAuthUid(req);
    const tenantId = TenantContext.current().id;

    // Look up the user + their permissions in parallel with the line.
    const [userRes, lineRes] = await Promise.all([
      this.supabase.admin
        .from('users')
        .select('id, person_id')
        .eq('auth_uid', authUid)
        .eq('tenant_id', tenantId)
        .maybeSingle(),
      this.supabase.admin
        .from('order_line_items')
        .select('id, order_id')
        .eq('id', lineId)
        .eq('tenant_id', tenantId)
        .maybeSingle(),
    ]);
    if (userRes.error) throw userRes.error;
    if (lineRes.error) throw lineRes.error;
    const userRow = userRes.data as { id: string; person_id: string | null } | null;
    const lineRow = lineRes.data as { id: string; order_id: string } | null;
    if (!userRow) {
      throw new UnauthorizedException({ code: 'no_user', message: 'no user record for this auth uid' });
    }
    if (!lineRow) {
      throw new BadRequestException({ code: 'line_not_found', message: 'order line not found' });
    }

    const orderRes = await this.supabase.admin
      .from('orders')
      .select('requester_person_id')
      .eq('id', lineRow.order_id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (orderRes.error) throw orderRes.error;
    const order = orderRes.data as { requester_person_id: string } | null;
    if (!order) {
      throw new BadRequestException({ code: 'order_not_found', message: 'order not found' });
    }

    if (userRow.person_id && order.requester_person_id === userRow.person_id) return;

    // Operator override — same posture as bundle visibility.
    const [readAllRes, adminRes] = await Promise.all([
      this.supabase.admin.rpc('user_has_permission', {
        p_user_id: userRow.id,
        p_tenant_id: tenantId,
        p_permission: 'rooms.read_all',
      }),
      this.supabase.admin.rpc('user_has_permission', {
        p_user_id: userRow.id,
        p_tenant_id: tenantId,
        p_permission: 'rooms.admin',
      }),
    ]);
    if (readAllRes.error) throw readAllRes.error;
    if (adminRes.error) throw adminRes.error;
    if (readAllRes.data || adminRes.data) return;

    throw new UnauthorizedException({
      code: 'line_not_editable',
      message: 'You do not have access to this service line.',
    });
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

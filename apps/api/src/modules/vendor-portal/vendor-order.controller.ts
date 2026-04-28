import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { AuditOutboxService } from '../privacy-compliance/audit-outbox.service';
import { VendorPortalEventType } from './event-types';
import { VendorOrderService } from './vendor-order.service';
import {
  VendorPortalGuard,
  type RequestWithVendorSession,
} from './vendor-portal.guard';

/**
 * Vendor-portal protected routes. Authentication via VendorPortalGuard
 * (HttpOnly session cookie). The global Bearer-token AuthGuard is opted out
 * via @Public() — the portal never sees a tenant Bearer token.
 *
 * Spec: docs/superpowers/specs/2026-04-27-vendor-portal-phase-b-design.md §6.
 */
@Public()
@UseGuards(VendorPortalGuard)
@Controller('vendor/orders')
export class VendorOrderController {
  /** Forecast window default per open-questions §VP6 — 14 days from today. */
  private static readonly DEFAULT_WINDOW_DAYS = 14;

  constructor(
    private readonly orders: VendorOrderService,
    private readonly auditOutbox: AuditOutboxService,
  ) {}

  // -------------------- GET /vendor/orders --------------------

  @Get()
  async list(
    @Req() req: RequestWithVendorSession,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: string,
  ) {
    const session = req.vendorSession!;
    const today = new Date();
    const fromDate = from ?? formatYMD(today);
    const toDate = to ?? formatYMD(addDays(today, VendorOrderController.DEFAULT_WINDOW_DAYS));

    return this.orders.listForVendor({
      tenantId: session.tenant_id,
      vendorId: session.vendor_id,
      fromDate,
      toDate,
      statusFilter: status,
    });
  }

  // -------------------- GET /vendor/orders/:id --------------------

  @Get(':id')
  async getById(
    @Req() req: RequestWithVendorSession,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const session = req.vendorSession!;
    const detail = await this.orders.getDetailForVendor({
      tenantId: session.tenant_id,
      vendorId: session.vendor_id,
      orderId: id,
    });

    // Read-side audit. Per gdpr-baseline-design.md §7 we'd normally use the
    // @LogPersonalDataAccess decorator + the global interceptor, but vendor
    // requests don't go through tenant TenantContext so the decorator's
    // tenant lookup wouldn't fire. We emit explicitly here.
    await this.auditOutbox.emit({
      tenantId: session.tenant_id,
      eventType: VendorPortalEventType.OrderViewed,
      entityType: 'orders',
      entityId: id,
      details: {
        vendor_id: session.vendor_id,
        vendor_user_id: session.vendor_user_id,
      },
    });

    return detail;
  }
}

// =====================================================================
// helpers
// =====================================================================

function formatYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

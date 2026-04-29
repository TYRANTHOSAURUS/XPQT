import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import {
  VendorPortalGuard,
  type RequestWithVendorSession,
} from './vendor-portal.guard';
import { VendorWorkOrderService } from './vendor-work-order.service';

/**
 * Vendor-portal work-order routes — sibling to /vendor/orders. Mounts at
 * /vendor/work-orders so the vendor portal can fan two feeds (orders +
 * work-orders) into one unified inbox client-side.
 *
 * Same auth + Public + VendorPortalGuard pattern as VendorOrderController.
 */
@Public()
@UseGuards(VendorPortalGuard)
@Controller('vendor/work-orders')
export class VendorWorkOrderController {
  /** Default forecast window — matches /vendor/orders. */
  private static readonly DEFAULT_WINDOW_DAYS = 14;

  constructor(private readonly workOrders: VendorWorkOrderService) {}

  // -------------------- GET /vendor/work-orders --------------------

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
    const toDate = to ?? formatYMD(addDays(today, VendorWorkOrderController.DEFAULT_WINDOW_DAYS));

    return this.workOrders.listForVendor({
      tenantId: session.tenant_id,
      vendorId: session.vendor_id,
      fromDate,
      toDate,
      statusFilter: status,
    });
  }
}

function formatYMD(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

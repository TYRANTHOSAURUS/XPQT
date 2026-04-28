import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { AuditOutboxService } from '../privacy-compliance/audit-outbox.service';
import { PersonalDataAccessLogService } from '../privacy-compliance/personal-data-access-log.service';
import { VendorPortalEventType } from './event-types';
import {
  VendorOrderStatusService,
  isVendorTransitionStatus,
} from './vendor-order-status.service';
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
    private readonly status: VendorOrderStatusService,
    private readonly auditOutbox: AuditOutboxService,
    private readonly pdal: PersonalDataAccessLogService,
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
    const { detail, auditSubjectPersonId } = await this.orders.getDetailForVendor({
      tenantId: session.tenant_id,
      vendorId: session.vendor_id,
      orderId: id,
    });

    // Read-side audit goes to TWO sinks per gdpr-baseline-design.md §7:
    //
    //   1. personal_data_access_logs — answers "who accessed Marleen's
    //      data?" queries. Subject person id captured here is the
    //      requester_person_id pulled internally; it is NOT in the
    //      response body the vendor sees. Without this, the §7 acceptance
    //      criterion (admin runs the access-log report) misses every
    //      vendor read.
    //   2. audit_outbox — surfaces the read in the standard event stream
    //      with the `vendor.order_viewed` event type for cross-spec
    //      reporting.
    //
    // Both are fire-and-forget per the GDPR spec batched-writer contract;
    // a PDAL flush failure must not break a successful read.
    this.pdal.enqueue({
      tenantId: session.tenant_id,
      // Vendor users are external — no users.id mapping. We capture the
      // vendor_user_id via a separate channel (audit_outbox below) and set
      // actor_user_id null here. actor_role disambiguates.
      actorAuthUid: null,
      actorRole: 'vendor_user',
      subjectPersonId: auditSubjectPersonId,
      dataCategory: 'past_orders',
      resourceType: 'orders',
      resourceId: id,
      accessMethod: 'detail_view',
    });

    await this.auditOutbox.emit({
      tenantId: session.tenant_id,
      eventType: VendorPortalEventType.OrderViewed,
      entityType: 'orders',
      entityId: id,
      details: {
        vendor_id: session.vendor_id,
        vendor_user_id: session.vendor_user_id,
        subject_person_id: auditSubjectPersonId,
      },
    });

    return detail;
  }

  // -------------------- POST /vendor/orders/:id/status --------------------

  @Post(':id/status')
  async updateStatus(
    @Req() req: RequestWithVendorSession,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { to_status?: string; note?: string },
  ) {
    if (!body?.to_status || typeof body.to_status !== 'string') {
      throw new BadRequestException('to_status is required');
    }
    if (!isVendorTransitionStatus(body.to_status)) {
      throw new BadRequestException(
        `to_status must be one of: confirmed, preparing, en_route, delivered`,
      );
    }
    const session = req.vendorSession!;
    return this.status.updateStatus({
      tenantId: session.tenant_id,
      vendorId: session.vendor_id,
      orderId: id,
      newStatus: body.to_status,
      note: body.note ?? null,
      vendorUserId: session.vendor_user_id,
    });
  }

  // -------------------- POST /vendor/orders/:id/decline --------------------

  @Post(':id/decline')
  async decline(
    @Req() req: RequestWithVendorSession,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { reason?: string },
  ) {
    if (!body?.reason || typeof body.reason !== 'string') {
      throw new BadRequestException('reason is required');
    }
    const session = req.vendorSession!;
    return this.status.decline({
      tenantId: session.tenant_id,
      vendorId: session.vendor_id,
      orderId: id,
      reason: body.reason,
      vendorUserId: session.vendor_user_id,
    });
  }

  // -------------------- GET /vendor/orders/:id/events --------------------

  @Get(':id/events')
  async listEvents(
    @Req() req: RequestWithVendorSession,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const session = req.vendorSession!;
    return this.status.listEventsForOrder({
      tenantId: session.tenant_id,
      vendorId: session.vendor_id,
      orderId: id,
    });
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

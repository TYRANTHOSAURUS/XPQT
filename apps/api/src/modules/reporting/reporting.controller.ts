import { Controller, Get, Query } from '@nestjs/common';
import { ReportingService } from './reporting.service';

@Controller('reports')
export class ReportingController {
  constructor(private readonly reportingService: ReportingService) {}

  @Get('tickets/overview')
  async ticketOverview() {
    return this.reportingService.getTicketOverview();
  }

  @Get('tickets/volume')
  async ticketVolume(@Query('days') days?: string) {
    return this.reportingService.getTicketVolume(days ? parseInt(days, 10) : 30);
  }

  @Get('sla/performance')
  async slaPerformance(@Query('days') days?: string) {
    return this.reportingService.getSlaPerformance(days ? parseInt(days, 10) : 30);
  }

  @Get('tickets/by-team')
  async byTeam() {
    return this.reportingService.getByTeam();
  }

  @Get('tickets/by-location')
  async byLocation() {
    return this.reportingService.getByLocation();
  }

  // Bookings overview — single page report at /admin/room-booking-reports.
  @Get('bookings/overview')
  async bookingsOverview(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('building_id') buildingId?: string,
    @Query('tz') tz?: string,
  ) {
    if (!from || !to) {
      // Default to last 30 days, ending today (UTC). The frontend should
      // always send explicit values; this is a guardrail for direct callers.
      const today = new Date();
      const todayStr = today.toISOString().slice(0, 10);
      const fromDate = new Date(today.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
      from = from || fromDate;
      to = to || todayStr;
    }
    return this.reportingService.getBookingsOverview({
      from,
      to,
      buildingId: buildingId || null,
      tz: tz || 'UTC',
    });
  }
}

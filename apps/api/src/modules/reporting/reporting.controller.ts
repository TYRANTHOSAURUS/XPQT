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
}

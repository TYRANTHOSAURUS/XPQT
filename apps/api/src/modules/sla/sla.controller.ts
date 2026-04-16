import { Controller, Get, Param } from '@nestjs/common';
import { SlaService } from './sla.service';

@Controller('sla')
export class SlaController {
  constructor(private readonly slaService: SlaService) {}

  @Get('tickets/:ticketId/status')
  async getTicketSlaStatus(@Param('ticketId') ticketId: string) {
    return this.slaService.getTicketSlaStatus(ticketId);
  }
}

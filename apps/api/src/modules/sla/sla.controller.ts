import { Controller, Get, Param, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { SlaService } from './sla.service';
import { TicketVisibilityService } from '../ticket/ticket-visibility.service';
import { TenantContext } from '../../common/tenant-context';

@Controller('sla')
export class SlaController {
  constructor(
    private readonly slaService: SlaService,
    private readonly visibility: TicketVisibilityService,
  ) {}

  @Get('tickets/:ticketId/status')
  async getTicketSlaStatus(@Param('ticketId') ticketId: string) {
    return this.slaService.getTicketSlaStatus(ticketId);
  }

  @Get('tickets/:ticketId/crossings')
  async getTicketSlaCrossings(@Req() request: Request, @Param('ticketId') ticketId: string) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw new UnauthorizedException('No auth user');
    const tenant = TenantContext.current();
    const ctx = await this.visibility.loadContext(actorAuthUid, tenant.id);
    await this.visibility.assertVisible(ticketId, ctx, 'read');
    return this.slaService.listCrossingsForTicket(ticketId);
  }
}

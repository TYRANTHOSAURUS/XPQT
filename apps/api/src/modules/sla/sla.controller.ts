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
  async getTicketSlaStatus(@Req() request: Request, @Param('ticketId') ticketId: string) {
    // Pre-fix: this endpoint had NO assertVisible call AND the service read
    // sla_timers by ticket_id only (no tenant filter). Any authenticated
    // user could fetch any ticket's SLA timer data — directly exploitable
    // cross-tenant + cross-actor leak. Mirror the /crossings handler's
    // pattern: load tenant + visibility ctx, assertVisible('read'), then
    // pass tenantId to the service so the supabase.admin read is scoped.
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw new UnauthorizedException('No auth user');
    const tenant = TenantContext.current();
    const ctx = await this.visibility.loadContext(actorAuthUid, tenant.id);
    await this.visibility.assertVisible(ticketId, ctx, 'read');
    return this.slaService.getTicketSlaStatus(ticketId, tenant.id);
  }

  @Get('tickets/:ticketId/crossings')
  async getTicketSlaCrossings(@Req() request: Request, @Param('ticketId') ticketId: string) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw new UnauthorizedException('No auth user');
    const tenant = TenantContext.current();
    const ctx = await this.visibility.loadContext(actorAuthUid, tenant.id);
    await this.visibility.assertVisible(ticketId, ctx, 'read');
    return this.slaService.listCrossingsForTicket(ticketId, tenant.id);
  }
}

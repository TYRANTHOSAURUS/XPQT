import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { CalendarSyncService } from './calendar-sync.service';
import type { OAuthCallbackBody, ResolveConflictBody } from './dto';

@Controller('calendar-sync')
export class CalendarSyncController {
  constructor(private readonly svc: CalendarSyncService) {}

  private authUid(request: Request): string {
    const authUid = (request as { user?: { id: string } }).user?.id;
    if (!authUid) throw new UnauthorizedException('No auth user');
    return authUid;
  }

  @Get('me')
  async getMyLink(@Req() request: Request) {
    return this.svc.getMyLink(this.authUid(request));
  }

  @Post('connect')
  async connect(@Req() request: Request) {
    return this.svc.connect(this.authUid(request));
  }

  @Post('callback')
  async callback(@Req() request: Request, @Body() body: OAuthCallbackBody) {
    return this.svc.finishConnect(this.authUid(request), body.code, body.state);
  }

  @Delete('outlook')
  async disconnect(@Req() request: Request) {
    return this.svc.disconnect(this.authUid(request));
  }

  @Post('outlook/resync')
  async forceResync(@Req() request: Request) {
    return this.svc.forceResync(this.authUid(request));
  }
}

@Controller('admin/calendar-sync')
export class AdminCalendarSyncController {
  constructor(private readonly svc: CalendarSyncService) {}

  private authUid(request: Request): string {
    const authUid = (request as { user?: { id: string } }).user?.id;
    if (!authUid) throw new UnauthorizedException('No auth user');
    return authUid;
  }

  @Get('health')
  async health() {
    // Permission gating (rooms.admin) is enforced at the route level when
    // wiring lands in app.module.ts; for now the controller relies on the
    // tenant-isolation RLS already in place + the service's tenant context.
    return this.svc.health();
  }

  @Get('conflicts')
  async listConflicts(
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.listConflicts({
      status,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post('conflicts/:id/resolve')
  async resolveConflict(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: ResolveConflictBody,
  ) {
    return this.svc.resolveConflict(id, body, {
      authUid: this.authUid(request),
      // userId is resolved inside the service via TenantContext; we pass null
      // here because the audit row writes resolved_by from the service after
      // it resolves the actor. Avoiding double-lookup keeps this controller
      // focused on transport.
      userId: null,
    });
  }
}

import {
  Body, Controller, Get, NotImplementedException, Param, Patch, Post, Query, Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ReservationService } from './reservation.service';
import { CheckInService } from './check-in.service';
import { TenantContext } from '../../common/tenant-context';
import {
  CancelReservationDto, CreateReservationDto, FindTimeDto, MultiRoomBookingDto, PickerDto,
  UpdateReservationDto,
} from './dto/dtos';
import type { ActorContext } from './dto/types';

@Controller('reservations')
export class ReservationController {
  constructor(
    private readonly service: ReservationService,
    private readonly checkInService: CheckInService,
  ) {}

  // ---- Reads ----

  @Get()
  async list(
    @Req() request: Request,
    @Query('scope') scope?: 'upcoming' | 'past' | 'cancelled' | 'all',
    @Query('limit') limitStr?: string,
  ) {
    const authUid = this.getAuthUid(request);
    const limit = limitStr ? parseInt(limitStr, 10) : 20;
    return this.service.listMine(authUid, { scope, limit });
  }

  @Get(':id')
  async findOne(@Req() request: Request, @Param('id') id: string) {
    const authUid = this.getAuthUid(request);
    return this.service.findOne(id, authUid);
  }

  // ---- Mutations ----

  @Post()
  async create(@Req() _request: Request, @Body() _dto: CreateReservationDto) {
    // The full booking pipeline (BookingFlowService.create) integrates the
    // rule resolver from Phase B. Until that lands, this endpoint returns
    // a guard error so the contract is visible but the path is closed.
    throw new NotImplementedException('booking_pipeline_phase_c_pending');
  }

  @Post('dry-run')
  async dryRun(@Req() _request: Request, @Body() _dto: CreateReservationDto) {
    throw new NotImplementedException('booking_pipeline_phase_c_pending');
  }

  @Post('multi-room')
  async createMultiRoom(@Req() _request: Request, @Body() _dto: MultiRoomBookingDto) {
    throw new NotImplementedException('booking_pipeline_phase_c_pending');
  }

  @Post('picker')
  async picker(@Req() _request: Request, @Body() _dto: PickerDto) {
    // The picker (ListBookableRoomsService) integrates rule resolver + ranking.
    throw new NotImplementedException('picker_phase_c_pending');
  }

  @Post('find-time')
  async findTime(@Req() _request: Request, @Body() _dto: FindTimeDto) {
    throw new NotImplementedException('find_time_phase_c_pending');
  }

  @Patch(':id')
  async edit(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: UpdateReservationDto,
  ) {
    const actor = await this.actorFromRequest(request);
    return this.service.editOne(id, actor, dto);
  }

  @Post(':id/cancel')
  async cancel(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: CancelReservationDto,
  ) {
    const actor = await this.actorFromRequest(request);
    if (dto.scope && dto.scope !== 'this') {
      throw new NotImplementedException('cancel_scope_phase_c_pending');
    }
    return this.service.cancelOne(id, actor, {
      reason: dto.reason,
      grace_minutes: dto.grace_minutes,
    });
  }

  @Post(':id/restore')
  async restore(@Req() request: Request, @Param('id') id: string) {
    const actor = await this.actorFromRequest(request);
    return this.service.restore(id, actor);
  }

  @Post(':id/check-in')
  async checkIn(@Req() _request: Request, @Param('id') id: string) {
    const tenantId = TenantContext.current().id;
    // We could load the actor for audit; here we keep it simple.
    return this.checkInService.checkIn(id, tenantId);
  }

  // ---- helpers ----

  private getAuthUid(req: Request): string {
    const u = (req as unknown as { user?: { id?: string } }).user;
    if (!u?.id) throw new UnauthorizedException('missing_user');
    return u.id;
  }

  private async actorFromRequest(req: Request): Promise<ActorContext> {
    const authUid = this.getAuthUid(req);
    // Until we wire ReservationVisibilityService into the controller for
    // actor lookup, we return a minimal actor. This will be enriched in
    // Phase C wiring.
    return {
      user_id: authUid,
      person_id: null,
      is_service_desk: false,
      has_override_rules: false,
    };
  }
}

import {
  Body, Controller, Get, Param, Patch, Post, Query, Req,
  UnauthorizedException, NotImplementedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ReservationService } from './reservation.service';
import { CheckInService } from './check-in.service';
import { BookingFlowService } from './booking-flow.service';
import { ListBookableRoomsService } from './list-bookable-rooms.service';
import { ReservationVisibilityService } from './reservation-visibility.service';
import { TenantContext } from '../../common/tenant-context';
import { SupabaseService } from '../../common/supabase/supabase.service';
import {
  CancelReservationDto, CreateReservationDto, FindTimeDto, MultiRoomBookingDto, PickerDto,
  SchedulerWindowDto, UpdateReservationDto,
} from './dto/dtos';
import type { ActorContext, CreateReservationInput, PickerInput } from './dto/types';

@Controller('reservations')
export class ReservationController {
  constructor(
    private readonly service: ReservationService,
    private readonly checkInService: CheckInService,
    private readonly bookingFlow: BookingFlowService,
    private readonly picker: ListBookableRoomsService,
    private readonly visibility: ReservationVisibilityService,
    private readonly supabase: SupabaseService,
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
  async create(@Req() request: Request, @Body() dto: CreateReservationDto) {
    const actor = await this.actorFromRequest(request);
    const input: CreateReservationInput = {
      reservation_type: dto.reservation_type,
      space_id: dto.space_id,
      requester_person_id: dto.requester_person_id ?? actor.person_id ?? '',
      host_person_id: dto.host_person_id,
      start_at: dto.start_at,
      end_at: dto.end_at,
      attendee_count: dto.attendee_count,
      attendee_person_ids: dto.attendee_person_ids,
      recurrence_rule: dto.recurrence_rule,
      source: (dto.source as CreateReservationInput['source']) ?? 'portal',
    };
    if (dto.override_reason) actor.override_reason = dto.override_reason;
    return this.bookingFlow.create(input, actor);
  }

  @Post('dry-run')
  async dryRun(@Req() request: Request, @Body() dto: CreateReservationDto) {
    const actor = await this.actorFromRequest(request);
    const input: CreateReservationInput = {
      reservation_type: dto.reservation_type,
      space_id: dto.space_id,
      requester_person_id: dto.requester_person_id ?? actor.person_id ?? '',
      host_person_id: dto.host_person_id,
      start_at: dto.start_at,
      end_at: dto.end_at,
      attendee_count: dto.attendee_count,
      attendee_person_ids: dto.attendee_person_ids,
      recurrence_rule: dto.recurrence_rule,
      source: (dto.source as CreateReservationInput['source']) ?? 'portal',
    };
    return this.bookingFlow.dryRun(input, actor);
  }

  @Post('multi-room')
  async createMultiRoom(@Req() _request: Request, @Body() _dto: MultiRoomBookingDto) {
    // TODO(phase-G): atomic create across multiple rooms
    throw new NotImplementedException('multi_room_booking_phase_g_pending');
  }

  @Post('picker')
  async pickerEndpoint(@Req() request: Request, @Body() dto: PickerDto) {
    const actor = await this.actorFromRequest(request);
    const input: PickerInput = {
      start_at: dto.start_at,
      end_at: dto.end_at,
      attendee_count: dto.attendee_count,
      site_id: dto.site_id,
      building_id: dto.building_id,
      floor_id: dto.floor_id,
      criteria: dto.criteria,
      requester_id: dto.requester_id,
      sort: dto.sort,
      limit: dto.limit,
    };
    return this.picker.list(input, actor);
  }

  @Post('find-time')
  async findTime(@Req() _request: Request, @Body() _dto: FindTimeDto) {
    // TODO(phase-G): multi-attendee scheduling
    throw new NotImplementedException('find_time_phase_g_pending');
  }

  /**
   * Desk-scheduler window fetch — one round-trip for every reservation on
   * the visible spaces between the requested range. Operator/admin only;
   * see ReservationService.listForWindow for the visibility gate.
   */
  @Post('scheduler-window')
  async schedulerWindow(@Req() request: Request, @Body() dto: SchedulerWindowDto) {
    const authUid = this.getAuthUid(request);
    return this.service.listForWindow(authUid, {
      space_ids: dto.space_ids,
      start_at: dto.start_at,
      end_at: dto.end_at,
    });
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
      // TODO(phase-G): recurrence-aware cancel (this_and_following / series)
      throw new NotImplementedException('cancel_scope_phase_g_pending');
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
    return this.checkInService.checkIn(id, tenantId);
  }

  // ---- helpers ----

  private getAuthUid(req: Request): string {
    const u = (req as unknown as { user?: { id?: string } }).user;
    if (!u?.id) throw new UnauthorizedException('missing_user');
    return u.id;
  }

  /**
   * Build the ActorContext: user_id (app-side), person_id, override permission.
   * Currently we look up the user row + check rooms.override_rules permission.
   * Phase F may extend this with additional rooms.* permissions.
   */
  private async actorFromRequest(req: Request): Promise<ActorContext> {
    const authUid = this.getAuthUid(req);
    const tenantId = TenantContext.current().id;
    const ctx = await this.visibility.loadContext(authUid, tenantId);

    // Permission lookups
    const [overrideRes, bookOnBehalfRes] = await Promise.all([
      this.supabase.admin.rpc('user_has_permission', {
        p_user_id: ctx.user_id, p_tenant_id: tenantId, p_permission: 'rooms.override_rules',
      }),
      this.supabase.admin.rpc('user_has_permission', {
        p_user_id: ctx.user_id, p_tenant_id: tenantId, p_permission: 'rooms.book_on_behalf',
      }),
    ]);

    return {
      user_id: ctx.user_id,
      person_id: ctx.person_id,
      is_service_desk: !!bookOnBehalfRes.data,
      has_override_rules: !!overrideRes.data,
    };
  }
}

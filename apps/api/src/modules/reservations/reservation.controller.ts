import {
  Body, Controller, Get, Param, Patch, Post, Query, Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ReservationService } from './reservation.service';
import { CheckInService } from './check-in.service';
import { BookingFlowService } from './booking-flow.service';
import { ListBookableRoomsService } from './list-bookable-rooms.service';
import { ReservationVisibilityService } from './reservation-visibility.service';
import { MultiRoomBookingService } from './multi-room-booking.service';
import { MultiAttendeeFinder } from './multi-attendee.service';
import { Public } from '../auth/public.decorator';
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
    private readonly multiRoom: MultiRoomBookingService,
    private readonly findTime: MultiAttendeeFinder,
    private readonly supabase: SupabaseService,
  ) {}

  // ---- Reads ----

  @Get()
  async list(
    @Req() request: Request,
    @Query('scope') scope?: 'upcoming' | 'past' | 'cancelled' | 'all' | 'pending_approval',
    @Query('limit') limitStr?: string,
    @Query('as') as?: 'mine' | 'operator',
    @Query('status') status?: string | string[],
  ) {
    const authUid = this.getAuthUid(request);
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;
    if (as === 'operator') {
      const statusArr = status === undefined
        ? undefined
        : Array.isArray(status) ? status : [status];
      return this.service.listForOperator(authUid, {
        scope, status: statusArr, limit,
      });
    }
    return this.service.listMine(authUid, {
      scope: scope === 'pending_approval' ? 'all' : scope,
      limit: limit ?? 20,
    });
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
  async createMultiRoom(@Req() request: Request, @Body() dto: MultiRoomBookingDto) {
    const actor = await this.actorFromRequest(request);
    return this.multiRoom.createGroup(
      {
        space_ids: dto.space_ids,
        requester_person_id: dto.requester_person_id ?? actor.person_id ?? '',
        start_at: dto.start_at,
        end_at: dto.end_at,
        attendee_count: dto.attendee_count,
        attendee_person_ids: dto.attendee_person_ids,
      },
      actor,
    );
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
  async findTimeEndpoint(@Req() request: Request, @Body() dto: FindTimeDto) {
    const actor = await this.actorFromRequest(request);
    return this.findTime.findFreeSlots(
      {
        person_ids: dto.person_ids,
        duration_minutes: dto.duration_minutes,
        window_start: dto.window_start,
        window_end: dto.window_end,
        criteria: dto.criteria,
      },
      actor,
    );
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
    return this.service.cancelOne(id, actor, {
      reason: dto.reason,
      grace_minutes: dto.grace_minutes,
      scope: dto.scope,
    });
  }

  /**
   * Edit a recurring reservation at series scope ('this_and_following' or
   * 'series'). Single-occurrence edits go through PATCH /:id (the regular
   * edit path).
   */
  @Post(':id/edit-scope')
  async editScope(
    @Req() _request: Request,
    @Param('id') id: string,
    @Body() dto: { scope: 'this_and_following' | 'series' } & UpdateReservationDto,
  ) {
    return this.bookingFlow.editScope(id, dto.scope, {
      space_id: dto.space_id,
      start_at: dto.start_at,
      end_at: dto.end_at,
      attendee_count: dto.attendee_count,
      attendee_person_ids: dto.attendee_person_ids,
      host_person_id: dto.host_person_id,
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

  /**
   * Magic-link check-in. The token authorises by itself (HMAC over
   * reservation_id + requester_person_id + expiry). Public — no Bearer
   * required, per spec §J3. Token comes from the check-in reminder email.
   */
  @Public()
  @Post(':id/check-in/magic')
  async checkInMagic(
    @Param('id') id: string,
    @Query('token') token: string,
  ) {
    return this.checkInService.checkInMagic(id, token ?? '');
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

import {
  BadRequestException, Body, Controller, Delete, Get, Header, Headers, NotFoundException, Param,
  Patch, Post, Query, Req, Res, UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { ReservationService } from './reservation.service';
import { CheckInService } from './check-in.service';
import { BookingFlowService } from './booking-flow.service';
import { ListBookableRoomsService } from './list-bookable-rooms.service';
import { ReservationVisibilityService } from './reservation-visibility.service';
import { MultiRoomBookingService } from './multi-room-booking.service';
import { MultiAttendeeFinder } from './multi-attendee.service';
import { BundleService, type ServiceLineInput } from '../booking-bundles/bundle.service';
import { resolveRequesterForActor } from './book-on-behalf.gate';
import { Public } from '../auth/public.decorator';
import { TenantContext } from '../../common/tenant-context';
import { SupabaseService } from '../../common/supabase/supabase.service';
import {
  CancelReservationDto, CreateReservationDto, FindTimeDto, MultiRoomBookingDto, PickerDto,
  SchedulerDataDto, SchedulerWindowDto, UpdateReservationDto,
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
    private readonly bundle: BundleService,
  ) {}

  // ---- Reads ----

  @Get()
  async list(
    @Req() request: Request,
    @Query('scope') scope?: 'upcoming' | 'past' | 'cancelled' | 'all' | 'pending_approval',
    @Query('limit') limitStr?: string,
    @Query('as') as?: 'mine' | 'operator',
    @Query('status') status?: string | string[],
    @Query('cursor') cursor?: string,
    @Query('has_bundle') hasBundle?: string,
  ) {
    const authUid = this.getAuthUid(request);
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;
    if (as === 'operator') {
      const statusArr = status === undefined
        ? undefined
        : Array.isArray(status) ? status : [status];
      // Coerce to true only on the explicit truthy strings — anything else
      // (including 'false' and missing) is treated as "no filter". Avoids
      // accidentally narrowing the result set when clients pass through
      // an empty query param.
      const has_bundle = hasBundle === 'true' || hasBundle === '1' ? true : undefined;
      return this.service.listForOperator(authUid, {
        scope, status: statusArr, limit, has_bundle,
      });
    }
    return this.service.listMine(authUid, {
      scope: scope === 'pending_approval' ? 'all' : scope,
      limit: limit ?? 20,
      cursor,
    });
  }

  @Get(':id')
  async findOne(@Req() request: Request, @Param('id') id: string) {
    const authUid = this.getAuthUid(request);
    return this.service.findOne(id, authUid);
  }

  /**
   * `GET /reservations/:id/group-siblings` — every reservation in the
   * same multi_room_group_id, with room name + status. Lets the booking
   * detail surface render a clickable chip strip of the sibling rooms
   * so an operator cancelling/rescheduling one room can see the rest of
   * the atomic group at a glance.
   *
   * Visibility-gated through the same context as findOne — if the
   * caller can see this reservation, they can see its siblings (the
   * group is atomic).
   */
  @Get(':id/group-siblings')
  async findGroupSiblings(@Req() request: Request, @Param('id') id: string) {
    const authUid = this.getAuthUid(request);
    return this.service.listGroupSiblings(id, authUid);
  }

  // ---- Mutations ----

  @Post()
  async create(@Req() request: Request, @Body() dto: CreateReservationDto) {
    const actor = await this.actorFromRequest(request);
    const requesterPersonId = this.assertCanRequestForPerson(dto.requester_person_id, actor);
    const input: CreateReservationInput = {
      reservation_type: dto.reservation_type,
      space_id: dto.space_id,
      requester_person_id: requesterPersonId,
      host_person_id: dto.host_person_id,
      start_at: dto.start_at,
      end_at: dto.end_at,
      attendee_count: dto.attendee_count,
      attendee_person_ids: dto.attendee_person_ids,
      recurrence_rule: dto.recurrence_rule,
      source: (dto.source as CreateReservationInput['source']) ?? 'portal',
      services: dto.services,
      bundle: dto.bundle,
    };
    if (dto.override_reason) actor.override_reason = dto.override_reason;
    return this.bookingFlow.create(input, actor);
  }

  @Post('dry-run')
  async dryRun(@Req() request: Request, @Body() dto: CreateReservationDto) {
    const actor = await this.actorFromRequest(request);
    const requesterPersonId = this.assertCanRequestForPerson(dto.requester_person_id, actor);
    const input: CreateReservationInput = {
      reservation_type: dto.reservation_type,
      space_id: dto.space_id,
      requester_person_id: requesterPersonId,
      host_person_id: dto.host_person_id,
      start_at: dto.start_at,
      end_at: dto.end_at,
      attendee_count: dto.attendee_count,
      attendee_person_ids: dto.attendee_person_ids,
      recurrence_rule: dto.recurrence_rule,
      source: (dto.source as CreateReservationInput['source']) ?? 'portal',
      services: dto.services,
      bundle: dto.bundle,
    };
    return this.bookingFlow.dryRun(input, actor);
  }

  @Post('multi-room')
  async createMultiRoom(@Req() request: Request, @Body() dto: MultiRoomBookingDto) {
    const actor = await this.actorFromRequest(request);
    const requesterPersonId = this.assertCanRequestForPerson(dto.requester_person_id, actor);
    // Multi-room + recurrence is an unsupported combination — the conflict-guard
    // semantics for "atomic group across multiple occurrences" need their own
    // design. The portal dialog rejects client-side; this is the server-side
    // gate for direct API callers (codex flagged the gap on the contract-
    // widening review).
    if (
      'recurrence_rule' in dto &&
      (dto as { recurrence_rule?: unknown }).recurrence_rule != null
    ) {
      throw new BadRequestException({
        code: 'multi_room_recurrence_unsupported',
        message: 'Recurrence on multi-room bookings is not supported. Book a single room or turn off recurrence.',
      });
    }
    return this.multiRoom.createGroup(
      {
        space_ids: dto.space_ids,
        requester_person_id: requesterPersonId,
        host_person_id: dto.host_person_id ?? null,
        start_at: dto.start_at,
        end_at: dto.end_at,
        attendee_count: dto.attendee_count,
        attendee_person_ids: dto.attendee_person_ids,
        source: dto.source as 'portal' | 'desk' | 'api' | 'calendar_sync' | 'auto' | undefined,
        services: dto.services,
        bundle: dto.bundle,
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
      include_unavailable: dto.include_unavailable,
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

  /**
   * Unified desk-scheduler load — returns rooms + reservations in ONE
   * round-trip via the `scheduler_data` plpgsql RPC. Replaces the legacy
   * picker → scheduler-window waterfall.
   *
   * Conditional GET: response carries a weak `ETag` derived from a
   * SHA-256 of the JSON payload, plus `Cache-Control: private, no-cache`
   * so the browser revalidates every request. When the client sends a
   * matching `If-None-Match`, we short-circuit to `304 Not Modified`
   * with no body — saves 50–150 KB of wire time on every refetch where
   * nothing actually changed (typical for tab-focus refresh and the
   * realtime debounce). Operator/admin only.
   */
  @Post('scheduler-data')
  @Header('Cache-Control', 'private, no-cache')
  async schedulerData(
    @Req() request: Request,
    @Body() dto: SchedulerDataDto,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const actor = await this.actorFromRequest(request);
    const data = await this.picker.loadSchedulerData(
      {
        start_at: dto.start_at,
        end_at: dto.end_at,
        attendee_count: dto.attendee_count,
        site_id: dto.site_id,
        building_id: dto.building_id,
        floor_id: dto.floor_id,
        must_have_amenities: dto.must_have_amenities,
        requester_id: dto.requester_id,
      },
      actor,
    );

    // Weak ETag — JSON.stringify hash truncated to 16 base64-url chars.
    // Truncation is fine: collisions on this corpus are astronomically
    // rare and a missed 304 just means a normal 200, not data loss.
    const body = JSON.stringify(data);
    const etag = `W/"${createHash('sha256').update(body).digest('base64url').slice(0, 16)}"`;

    if (ifNoneMatch && ifNoneMatch === etag) {
      res.status(304).setHeader('ETag', etag).end();
      return;
    }

    res.setHeader('ETag', etag);
    return data;
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
   *
   * Authorisation: must pass the same `canEdit` visibility check the
   * single-occurrence edit applies. Without this check any authenticated
   * user could mutate any series in their tenant by guessing a UUID
   * because the underlying `BookingFlowService.editScope` uses the admin
   * client (RLS bypass) and only filters by `recurrence_series_id`.
   */
  @Post(':id/edit-scope')
  async editScope(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: { scope: 'this_and_following' | 'series' } & UpdateReservationDto,
  ) {
    const actor = await this.actorFromRequest(request);
    const tenantId = TenantContext.current().id;
    // Loads the pivot reservation (asserts it's visible) and gates write.
    // Resolves visibility against actor.user_id directly — passing it as
    // an authUid would be a category mismatch (loadContext queries by
    // auth_uid, returns an empty context for any user_id, and breaks
    // every gate downstream).
    const pivot = await this.service.findOneForActor(id, actor);
    const ctx = await this.visibility.loadContextByUserId(actor.user_id, tenantId);
    if (!this.visibility.canEdit(pivot, ctx)) {
      throw new UnauthorizedException('reservation_not_editable');
    }
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

  // ---- Services attached to a reservation (post-booking) ----

  /**
   * `POST /reservations/:id/services` — attach (or append) service lines
   * to a reservation. Handles both first-attach (lazy-creates the bundle)
   * and append-to-existing-bundle. Wraps `attachServicesToReservation`,
   * which already handles bundle reuse + per-service-type ordering +
   * approval routing.
   *
   * Use this from the post-booking "+ Add service" UI; for direct
   * bundle-level additions (when callers already have a bundle id), the
   * sibling `POST /booking-bundles/:id/lines` is also available.
   *
   * Write gate: requester / host / `rooms.admin`.
   */
  @Post(':id/services')
  async attachServices(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: { services: ServiceLineInput[] },
  ) {
    const authUid = this.getAuthUid(request);
    // Visibility check + ensures the reservation exists in the caller's
    // tenant before we mutate anything.
    const reservation = await this.service.findOne(id, authUid);
    const tenantId = TenantContext.current().id;
    const ctx = await this.visibility.loadContext(authUid, tenantId);
    const r = reservation as { requester_person_id: string; host_person_id?: string | null; booked_by_user_id?: string | null };
    this.assertReservationWritable(r, ctx);

    // Post-canonicalisation (2026-05-02 + Slice A): the URL `:id` is a
    // BOOKING id (what `findOne` returns now). Call the new canonical
    // `attachServicesToBooking` directly instead of the deprecated
    // reservation-named shim.
    return this.bundle.attachServicesToBooking({
      booking_id: id,
      requester_person_id: r.requester_person_id,
      services: body?.services ?? [],
    });
  }

  // ---- Visitors attached to a reservation ----

  /**
   * `GET /reservations/:id/visitors` — list visitor records attached to
   * this reservation. Visibility-gated through the reservation's
   * predicate; a non-visible reservation 404s rather than returning an
   * empty list, so we don't leak existence.
   */
  @Get(':id/visitors')
  async listVisitors(@Req() request: Request, @Param('id') id: string) {
    const authUid = this.getAuthUid(request);
    // Throws if not visible.
    await this.service.findOne(id, authUid);
    const tenantId = TenantContext.current().id;

    const { data, error } = await this.supabase.admin
      .from('reservation_visitors')
      .select('visitor_id, attached_at, visitor:visitors(id, person_id, host_person_id, visit_date, status, badge_id, person:persons(first_name, last_name, email))')
      .eq('reservation_id', id)
      .eq('tenant_id', tenantId);
    if (error) throw error;

    type Row = {
      visitor_id: string;
      attached_at: string;
      visitor: {
        id: string;
        person_id: string;
        host_person_id: string;
        visit_date: string;
        status: string;
        badge_id: string | null;
        person: { first_name: string; last_name: string; email: string | null } | { first_name: string; last_name: string; email: string | null }[] | null;
      } | { id: string }[] | null;
    };
    return ((data ?? []) as Row[]).map((r) => {
      const v = Array.isArray(r.visitor) ? r.visitor[0] : r.visitor;
      const p = v && 'person' in v && v.person ? (Array.isArray(v.person) ? v.person[0] : v.person) : null;
      return {
        visitor_id: r.visitor_id,
        attached_at: r.attached_at,
        visitor: v ? {
          id: (v as { id: string }).id,
          person_id: (v as { person_id?: string }).person_id ?? null,
          host_person_id: (v as { host_person_id?: string }).host_person_id ?? null,
          visit_date: (v as { visit_date?: string }).visit_date ?? null,
          status: (v as { status?: string }).status ?? null,
          badge_id: (v as { badge_id?: string | null }).badge_id ?? null,
          first_name: p?.first_name ?? null,
          last_name: p?.last_name ?? null,
          email: p?.email ?? null,
        } : null,
      };
    });
  }

  /**
   * `POST /reservations/:id/visitors` — attach an existing visitor record
   * (by `visitor_id`). Visitor creation itself goes through the existing
   * visitors module; this endpoint is the link step. Idempotent on
   * (reservation_id, visitor_id) primary key.
   */
  @Post(':id/visitors')
  async attachVisitor(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: { visitor_id: string },
  ) {
    const authUid = this.getAuthUid(request);
    const reservation = await this.service.findOne(id, authUid);
    const tenantId = TenantContext.current().id;
    const ctx = await this.visibility.loadContext(authUid, tenantId);
    this.assertReservationWritable(
      reservation as { requester_person_id: string; host_person_id?: string | null; booked_by_user_id?: string | null },
      ctx,
    );

    if (!body?.visitor_id) {
      throw new NotFoundException({ code: 'visitor_required', message: 'visitor_id is required' });
    }

    // Verify the visitor belongs to this tenant — else the link would
    // cross tenant boundaries even though RLS would catch the read.
    const { data: visitorRow, error: visitorErr } = await this.supabase.admin
      .from('visitors')
      .select('id')
      .eq('id', body.visitor_id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (visitorErr) throw visitorErr;
    if (!visitorRow) {
      throw new NotFoundException({ code: 'visitor_not_found', message: `Visitor ${body.visitor_id} not found.` });
    }

    const { error } = await this.supabase.admin
      .from('reservation_visitors')
      .upsert({
        reservation_id: id,
        visitor_id: body.visitor_id,
        tenant_id: tenantId,
        attached_by_user_id: ctx.user_id,
      }, { onConflict: 'reservation_id,visitor_id' });
    if (error) throw error;

    return { reservation_id: id, visitor_id: body.visitor_id };
  }

  /**
   * `DELETE /reservations/:id/visitors/:visitorId` — unlink. Doesn't
   * delete the visitor record itself (that has its own lifecycle).
   */
  @Delete(':id/visitors/:visitorId')
  async detachVisitor(
    @Req() request: Request,
    @Param('id') id: string,
    @Param('visitorId') visitorId: string,
  ) {
    const authUid = this.getAuthUid(request);
    const reservation = await this.service.findOne(id, authUid);
    const tenantId = TenantContext.current().id;
    const ctx = await this.visibility.loadContext(authUid, tenantId);
    this.assertReservationWritable(
      reservation as { requester_person_id: string; host_person_id?: string | null; booked_by_user_id?: string | null },
      ctx,
    );

    const { error } = await this.supabase.admin
      .from('reservation_visitors')
      .delete()
      .eq('reservation_id', id)
      .eq('visitor_id', visitorId)
      .eq('tenant_id', tenantId);
    if (error) throw error;

    return { reservation_id: id, visitor_id: visitorId };
  }

  // ---- helpers ----

  /**
   * Write gate for reservation mutations (services, visitors). Mirrors
   * `ReservationVisibilityService.canEdit` so anyone authorised to edit a
   * reservation can also attach services / visitors to it:
   *
   *   - admin / `rooms.write_all` → always allow
   *   - requester (person_id matches reservation.requester_person_id) → allow
   *   - host (person_id matches reservation.host_person_id) → allow
   *   - whoever clicked book (user_id matches reservation.booked_by_user_id)
   *     → allow. Critical for operators who booked on behalf and need to
   *     add services after the fact without being a participant in their
   *     own person record.
   *
   * Read-only operators (`rooms.read_all`) pass `assertVisible` but must
   * NOT pass this — the read-vs-write boundary that codex flagged on the
   * 2026-04-27 review.
   */
  private assertReservationWritable(
    reservation: {
      requester_person_id: string;
      host_person_id?: string | null;
      booked_by_user_id?: string | null;
    },
    ctx: { has_admin: boolean; has_write_all: boolean; person_id: string | null; user_id: string },
  ): void {
    if (ctx.has_admin || ctx.has_write_all) return;
    if (
      ctx.person_id != null &&
      (reservation.requester_person_id === ctx.person_id ||
        reservation.host_person_id === ctx.person_id)
    ) {
      return;
    }
    if (
      ctx.user_id &&
      reservation.booked_by_user_id != null &&
      reservation.booked_by_user_id === ctx.user_id
    ) {
      return;
    }
    throw new UnauthorizedException({
      code: 'reservation_write_forbidden',
      message: 'Only the requester, host, booker, or an admin can change this booking.',
    });
  }

  private getAuthUid(req: Request): string {
    const u = (req as unknown as { user?: { id?: string } }).user;
    if (!u?.id) throw new UnauthorizedException('missing_user');
    return u.id;
  }

  /** Delegates to the pure `resolveRequesterForActor` so the gate logic is
   *  testable in isolation. See `book-on-behalf.gate.ts` for the four-branch
   *  semantics + unit tests. */
  private assertCanRequestForPerson(
    requested: string | null | undefined,
    actor: ActorContext,
  ): string {
    return resolveRequesterForActor(requested, actor);
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

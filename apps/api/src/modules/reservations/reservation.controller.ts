import {
  BadRequestException, Body, Controller, Delete, Get, Header, Headers, Param,
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
import { BundleCascadeService } from '../booking-bundles/bundle-cascade.service';
import { BundleVisibilityService } from '../booking-bundles/bundle-visibility.service';
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
    private readonly bundleCascade: BundleCascadeService,
    private readonly bundleVisibility: BundleVisibilityService,
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
        // 00296 — pass through server-side search + payload caps when
        // the frontend supplies them. Pre-fix all three were undefined
        // and the RPC's defaults applied.
        search: dto.search,
        reservation_limit: dto.reservation_limit,
        room_limit: dto.room_limit,
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

  /**
   * Phase 1.4 — Bug #2 (slot-first scheduler).
   *
   * `PATCH /reservations/:bookingId/slots/:slotId` — edit ONE slot's
   * geometry (space_id / start_at / end_at). The desk scheduler routes
   * drag/resize/move here so a non-primary slot of a multi-room booking
   * actually moves that slot, not the primary (which the legacy
   * `PATCH /reservations/:id` would do).
   *
   * The booking-level `PATCH /reservations/:id` (`editOne`) STAYS for
   * non-geometry edits (host_person_id, attendee_count). Frontend uses:
   *   - `useEditBooking`     → booking-level fields
   *   - `useEditBookingSlot` → drag/resize/move (slot geometry)
   *
   * URL contract (codex 2026-05-04 #16): `slot.booking_id` MUST equal
   * `bookingId` in the URL — enforced inside the service so the
   * controller doesn't double-load the slot. On mismatch the service
   * throws `BadRequestException(booking_slot.url_mismatch)`.
   */
  @Patch(':bookingId/slots/:slotId')
  async editSlot(
    @Req() request: Request,
    @Param('bookingId') bookingId: string,
    @Param('slotId') slotId: string,
    @Body() body: { space_id?: string; start_at?: string; end_at?: string },
  ) {
    const actor = await this.actorFromRequest(request);
    return this.service.editSlot(bookingId, slotId, actor, {
      space_id: body?.space_id,
      start_at: body?.start_at,
      end_at: body?.end_at,
    });
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

  /**
   * `GET /reservations/:id/bundle-detail` — returns the booking's services
   * (order_line_items) + cascaded work_orders + a derived status rollup,
   * for the booking-detail surface's services + fulfillment sections.
   *
   * Replaces the dropped `GET /booking-bundles/:id` endpoint
   * (booking-bundles.controller.ts deleted in commit 2745be0). The booking
   * IS the bundle now (00277:27), so the same id segment that `findOne`
   * accepts is also a valid booking id here. Mounted under `/reservations`
   * (rather than a future `/bookings`) because the live frontend already
   * holds reservation ids and the route ergonomics match the rest of the
   * detail surface (`/reservations/:id/visitors`, `/reservations/:id/services`).
   *
   * Visibility gate: piggy-backs on `service.findOne(id, authUid)`, which
   * already runs `assertVisible` against the same tenant + person/operator
   * context. A non-visible booking 404s there before we hit `getBookingDetail`.
   */
  @Get(':id/bundle-detail')
  async findBundleDetail(@Req() request: Request, @Param('id') id: string) {
    const authUid = this.getAuthUid(request);
    // Throws if not visible — gates the bundle-detail read identically to
    // the booking-detail read above.
    await this.service.findOne(id, authUid);
    return this.bundle.getBookingDetail(id);
  }

  /**
   * `PATCH /reservations/:id/services/:lineId` — edit a single service line
   * on a booking (quantity, service window, requester notes). Wraps
   * `BundleService.editLine`, which already enforces frozen-state protection
   * (preparing/delivered/cancelled), optimistic concurrency via
   * `expected_updated_at`, and SLA-due shift on the linked work order when
   * the service window moves.
   *
   * Replaces the dropped `PATCH /booking-bundles/:bundleId/lines/:lineId`
   * endpoint. The booking IS the bundle now (00277:27) so the URL `:id`
   * segment is the booking id — same as on `findBundleDetail`.
   *
   * Authorisation pattern mirrors `attachServices`: the booking must be
   * visible AND writable to the caller (requester / host / booker / admin).
   * The line itself is then re-validated tenant-side inside `editLine`
   * (line_not_found 404 if it doesn't belong to this tenant).
   *
   * Body shape matches the frontend `EditBundleLinePatch` interface
   * (`apps/web/src/api/booking-bundles/mutations.ts`): all fields optional;
   * a no-op patch returns the current row unchanged.
   */
  @Patch(':id/services/:lineId')
  async editServiceLine(
    @Req() request: Request,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() body: {
      quantity?: number;
      service_window_start_at?: string | null;
      service_window_end_at?: string | null;
      requester_notes?: string | null;
      expected_updated_at?: string | null;
    },
  ) {
    const authUid = this.getAuthUid(request);
    const reservation = await this.service.findOne(id, authUid);
    const tenantId = TenantContext.current().id;
    const ctx = await this.visibility.loadContext(authUid, tenantId);
    const r = reservation as {
      requester_person_id: string;
      host_person_id?: string | null;
      booked_by_user_id?: string | null;
    };
    this.assertReservationWritable(r, ctx);

    return this.bundle.editLine({
      line_id: lineId,
      patch: {
        quantity: body?.quantity,
        service_window_start_at: body?.service_window_start_at,
        service_window_end_at: body?.service_window_end_at,
        requester_notes: body?.requester_notes,
      },
      expected_updated_at: body?.expected_updated_at ?? null,
    });
  }

  /**
   * `DELETE /reservations/:id/services/:lineId` — cancel a single service
   * line. Wraps `BundleCascadeService.cancelLine`, which:
   *   - Cascades to the linked work-order ticket (`work_orders.status_category` → 'closed').
   *   - Cancels any linked `asset_reservation`.
   *   - Re-scopes pending approvals (auto-closes if scope drops to empty).
   *   - Refuses if the line is in a fulfilled state (`preparing`/`delivered`).
   *
   * Replaces the dropped `POST /booking-bundles/:bundleId/lines/:lineId/cancel`.
   *
   * Same write-gate as the edit path. The cascade service then performs its
   * own bundle visibility assert as defence-in-depth (it loads the line's
   * parent bundle and checks `BundleVisibilityService.assertVisible` against
   * the supplied context).
   */
  @Delete(':id/services/:lineId')
  async cancelServiceLine(
    @Req() request: Request,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() body: { reason?: string } | undefined,
  ) {
    const authUid = this.getAuthUid(request);
    const reservation = await this.service.findOne(id, authUid);
    const tenantId = TenantContext.current().id;
    const ctx = await this.visibility.loadContext(authUid, tenantId);
    const r = reservation as {
      requester_person_id: string;
      host_person_id?: string | null;
      booked_by_user_id?: string | null;
    };
    this.assertReservationWritable(r, ctx);

    // Build the bundle visibility context from the same authUid; the
    // cascade service uses `rooms.{read_all,write_all,admin}` permissions
    // off this. We've already passed the reservation write-gate above —
    // this assert is the cascade service's own defence-in-depth.
    const bundleCtx = await this.bundleVisibility.loadContext(authUid, tenantId);
    return this.bundleCascade.cancelLine(
      { line_id: lineId, reason: body?.reason },
      bundleCtx,
    );
  }

  /**
   * `DELETE /reservations/:id/bundle` — cancel every active line on the
   * booking (with optional opt-out via `keep_line_ids`). Wraps
   * `BundleCascadeService.cancelBundle`, which:
   *   - Skips fulfilled lines (returned in `fulfilled_line_ids`).
   *   - Cascade-cancels each non-fulfilled line's work-order + asset reservation.
   *   - Cancels the booking row + its slots when nothing remains alive.
   *   - Cancels all pending approvals on the bundle.
   *
   * Replaces the dropped `POST /booking-bundles/:bundleId/cancel`. The URL
   * `:id` segment is the booking id (= bundle id post-rewrite).
   *
   * Same write-gate as `editServiceLine` / `cancelServiceLine`.
   */
  @Delete(':id/bundle')
  async cancelBundle(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: {
      keep_line_ids?: string[];
      recurrence_scope?: 'this' | 'this_and_following' | 'series';
      reason?: string;
    } | undefined,
  ) {
    const authUid = this.getAuthUid(request);
    const reservation = await this.service.findOne(id, authUid);
    const tenantId = TenantContext.current().id;
    const ctx = await this.visibility.loadContext(authUid, tenantId);
    const r = reservation as {
      requester_person_id: string;
      host_person_id?: string | null;
      booked_by_user_id?: string | null;
    };
    this.assertReservationWritable(r, ctx);

    const bundleCtx = await this.bundleVisibility.loadContext(authUid, tenantId);
    return this.bundleCascade.cancelBundle(
      {
        bundle_id: id,
        keep_line_ids: body?.keep_line_ids,
        recurrence_scope: body?.recurrence_scope,
        reason: body?.reason,
      },
      bundleCtx,
    );
  }

  // ---- Visitors attached to a reservation ----
  //
  // The legacy `/reservations/:id/visitors` GET / POST / DELETE endpoints
  // were removed in the booking-canonicalisation rewrite (2026-05-02,
  // migration 00280). Visitors now link to their booking via the canonical
  // `visitors.booking_id` column (00278:41 — renamed from
  // `visitors.booking_bundle_id`); the `reservation_visitors` junction
  // table is dropped (00280). Visitor management lives in the visitors
  // module — see `apps/api/src/modules/visitors/visitors.controller.ts`
  // for the canonical CRUD surface (`/visitors/*`).

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

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Sse,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import { DbService } from '../../common/db/db.service';
import { PermissionGuard } from '../../common/permission-guard';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import {
  formatZodError,
  PassAssignSchema,
  PassMissingSchema,
  PassReserveSchema,
  ReceptionCheckInSchema,
  ReceptionCheckOutSchema,
  ReceptionWalkupSchema,
} from './dto/schemas';
import { VisitorPassPoolService } from './pass-pool.service';
import { ReceptionService } from './reception.service';
import { VisitorEventBus } from './visitor-event-bus';

/**
 * Reception workspace REST surface — `/reception/*`.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §7
 *
 * Auth: global `AuthGuard` (Bearer JWT) + `requirePermission('visitors.reception')`
 * on every endpoint. The same controller backs the `/desk/visitors` lens
 * that the service desk uses (spec §7.9) — both surfaces require the
 * `visitors.reception` permission key.
 */
@Controller('reception')
export class ReceptionController {
  constructor(
    private readonly reception: ReceptionService,
    private readonly passPool: VisitorPassPoolService,
    private readonly events: VisitorEventBus,
    private readonly supabase: SupabaseService,
    private readonly permissions: PermissionGuard,
    private readonly db: DbService,
  ) {}

  // ─── today / search / daglijst (read) ──────────────────────────────────

  @Get('today')
  async today(
    @Req() req: Request,
    @Query('building_id') buildingId?: string,
  ) {
    await this.permissions.requirePermission(req, 'visitors.reception');
    if (!buildingId) throw new BadRequestException('building_id is required');
    const tenant = TenantContext.current();
    const actor = await this.resolveActor(req);
    return this.reception.today(tenant.id, buildingId, actor.user_id);
  }

  /**
   * Count + urgency for the desk-shell rail badge on Visitors. Per-building
   * (uses the same building_id query param as `today()`).
   */
  @Get('today/count')
  async todayCount(
    @Req() req: Request,
    @Query('building_id') buildingId?: string,
  ) {
    await this.permissions.requirePermission(req, 'visitors.reception');
    if (!buildingId) throw new BadRequestException('building_id is required');
    const tenant = TenantContext.current();
    const actor = await this.resolveActor(req);
    return this.reception.todayCount(tenant.id, buildingId, actor.user_id);
  }

  @Get('search')
  async search(
    @Req() req: Request,
    @Query('building_id') buildingId?: string,
    @Query('q') q?: string,
  ) {
    await this.permissions.requirePermission(req, 'visitors.reception');
    if (!buildingId) throw new BadRequestException('building_id is required');
    const tenant = TenantContext.current();
    const actor = await this.resolveActor(req);
    return this.reception.search(tenant.id, buildingId, actor.user_id, q ?? '');
  }

  @Get('yesterday')
  async yesterday(
    @Req() req: Request,
    @Query('building_id') buildingId?: string,
  ) {
    await this.permissions.requirePermission(req, 'visitors.reception');
    if (!buildingId) throw new BadRequestException('building_id is required');
    const tenant = TenantContext.current();
    const actor = await this.resolveActor(req);
    return this.reception.yesterdayLooseEnds(tenant.id, buildingId, actor.user_id);
  }

  @Get('daglijst')
  async daglijst(
    @Req() req: Request,
    @Query('building_id') buildingId?: string,
  ) {
    await this.permissions.requirePermission(req, 'visitors.reception');
    if (!buildingId) throw new BadRequestException('building_id is required');
    const tenant = TenantContext.current();
    const actor = await this.resolveActor(req);
    return this.reception.dailyListForBuilding(tenant.id, buildingId, actor.user_id);
  }

  /**
   * GET /reception/passes?building_id=…
   *
   * The pass pool resolved for this building (most-specific-wins via
   * `pass_pool_for_space`). Returns the full pass list at the resolved
   * anchor — slice 7's frontend was hitting `/admin/visitors/pools` and
   * filtering client-side, which 403'd for non-admin receptionists.
   *
   * Empty array if the building has no resolved pool (uncovered or opted
   * out of inheritance). The shape matches the existing slice 7 client
   * type so the React Query hook can swap over without a payload change.
   */
  @Get('passes')
  async listPasses(
    @Req() req: Request,
    @Query('building_id') buildingId?: string,
  ) {
    await this.permissions.requirePermission(req, 'visitors.reception');
    if (!buildingId) throw new BadRequestException('building_id is required');
    const tenant = TenantContext.current();
    const anchor = await this.passPool.passPoolForSpace(buildingId, tenant.id);
    if (!anchor) return [];
    return this.db.queryMany(
      `select id, tenant_id, space_id, space_kind, pass_number, pass_type,
              status, current_visitor_id, reserved_for_visitor_id,
              last_assigned_at, notes, created_at, updated_at
         from public.visitor_pass_pool
        where tenant_id = $1 and space_id = $2
        order by pass_number asc`,
      [tenant.id, anchor.space_id],
    );
  }

  /**
   * GET /reception/desk-lens
   *
   * Service desk focused lens (spec §7.9). Three sections:
   *   1. Contractor visitors with an active service ticket.
   *   2. Visitors in `pending_approval`.
   *   3. Today's escalations (host-not-acknowledged > 5min, unreturned
   *      passes from earlier today).
   *
   * Visibility-gated via `visitor_visibility_ids` so a desk agent without
   * the `visitors.read_all` override only sees what their scope allows.
   * Permission gate is `visitors.reception` — same as the reception
   * workspace per spec §7.9.
   */
  @Get('desk-lens')
  async deskLens(@Req() req: Request) {
    await this.permissions.requirePermission(req, 'visitors.reception');
    const tenant = TenantContext.current();
    const actor = await this.resolveActor(req);

    const visibleCte = `
      with visible as (
        select visitor_visibility_ids as id from public.visitor_visibility_ids($1, $2)
      )
    `;

    /* Contractor visitors with an active service ticket — current model
       has no direct visitor↔ticket FK, so we resolve via shared
       booking_bundle_id (the booking-bundle cascade links visitor lines
       to bundles which spawn work_orders). For visitors without a bundle,
       we surface the contractor type alone in section 1. */
    // Column rename: visitors.booking_bundle_id → visitors.booking_id (00278:41).
    const contractorSql = `
      ${visibleCte}
      select v.id, v.first_name, v.last_name, v.company,
             v.expected_at, v.arrived_at, v.status,
             v.building_id, v.visitor_type_id, v.booking_id,
             vt.display_name as visitor_type_name,
             p.first_name || ' ' || coalesce(p.last_name, '') as primary_host_name
        from public.visitors v
        join public.visitor_types vt on vt.id = v.visitor_type_id
        left join public.persons p on p.id = v.primary_host_person_id
       where v.tenant_id = $2
         and v.id in (select id from visible)
         and vt.type_key = 'contractor'
         and v.status in ('expected', 'arrived', 'in_meeting')
         and (v.expected_at is null or v.expected_at >= date_trunc('day', now()))
       order by v.expected_at nulls last
       limit 200
    `;
    const contractors = await this.db.queryMany(contractorSql, [
      actor.user_id,
      tenant.id,
    ]);

    const pendingSql = `
      ${visibleCte}
      select v.id, v.first_name, v.last_name, v.company,
             v.expected_at, v.status,
             v.building_id, v.visitor_type_id,
             vt.display_name as visitor_type_name,
             p.first_name || ' ' || coalesce(p.last_name, '') as primary_host_name
        from public.visitors v
        left join public.visitor_types vt on vt.id = v.visitor_type_id
        left join public.persons p on p.id = v.primary_host_person_id
       where v.tenant_id = $2
         and v.id in (select id from visible)
         and v.status = 'pending_approval'
       order by v.expected_at nulls last
       limit 200
    `;
    const pending = await this.db.queryMany(pendingSql, [
      actor.user_id,
      tenant.id,
    ]);

    /* Escalations — host-not-acknowledged > 5min after arrival and
       unreturned passes from any visitor checked-out today without
       a returned pass. */
    const ackEscalationSql = `
      ${visibleCte}
      select v.id, v.first_name, v.last_name, v.company,
             v.arrived_at, v.status,
             v.building_id, v.visitor_type_id,
             vt.display_name as visitor_type_name,
             p.first_name || ' ' || coalesce(p.last_name, '') as primary_host_name,
             extract(epoch from (now() - v.arrived_at))::int as seconds_since_arrival
        from public.visitors v
        left join public.visitor_types vt on vt.id = v.visitor_type_id
        left join public.persons p on p.id = v.primary_host_person_id
       where v.tenant_id = $2
         and v.id in (select id from visible)
         and v.status = 'arrived'
         and v.arrived_at is not null
         and v.arrived_at < (now() - interval '5 minutes')
         and not exists (
           select 1 from public.visitor_hosts vh
            where vh.visitor_id = v.id
              and vh.tenant_id = v.tenant_id
              and vh.acknowledged_at is not null
         )
       order by v.arrived_at asc
       limit 100
    `;
    const ackEscalations = await this.db.queryMany(ackEscalationSql, [
      actor.user_id,
      tenant.id,
    ]);

    const unreturnedSql = `
      select pp.id, pp.pass_number, pp.status, pp.last_assigned_at,
             pp.current_visitor_id, pp.space_id, pp.space_kind, pp.notes
        from public.visitor_pass_pool pp
       where pp.tenant_id = $1
         and pp.status = 'in_use'
         and pp.last_assigned_at < (now() - interval '8 hours')
       order by pp.last_assigned_at asc
       limit 100
    `;
    const unreturnedPasses = await this.db.queryMany(unreturnedSql, [
      tenant.id,
    ]);

    return {
      contractors,
      pending_approval: pending,
      escalations: {
        host_not_acknowledged: ackEscalations,
        unreturned_passes: unreturnedPasses,
      },
    };
  }

  // ─── walk-up / check-in / out (write) ──────────────────────────────────

  @Post('walk-up')
  async walkup(@Req() req: Request, @Body() body: unknown) {
    await this.permissions.requirePermission(req, 'visitors.reception');
    const parsed = ReceptionWalkupSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(formatZodError(parsed.error));
    }
    const tenant = TenantContext.current();
    const actor = await this.resolveActor(req);

    /* The receptionist's building is implicit from their location-grant
       scope. We require `building_id` only on the bigger reads (today /
       search / daglijst) where there's no other way to scope; for
       walkup the visitor's building IS the receptionist's authorized
       building inferred from the front-end. To keep the contract simple
       we accept it via header + cross-check the actor has scope. */
    const buildingId = (req.headers['x-building-id'] as string | undefined) ?? null;
    if (!buildingId) {
      throw new BadRequestException('X-Building-Id header is required for walk-up');
    }
    return this.reception.quickAddWalkup(
      tenant.id,
      buildingId,
      parsed.data,
      { user_id: actor.user_id, person_id: actor.person_id, tenant_id: tenant.id },
    );
  }

  @Post('visitors/:id/check-in')
  async checkIn(
    @Req() req: Request,
    @Param('id') visitorId: string,
    @Body() body: unknown,
  ) {
    await this.permissions.requirePermission(req, 'visitors.reception');
    const parsed = ReceptionCheckInSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(formatZodError(parsed.error));
    }
    const tenant = TenantContext.current();
    const actor = await this.resolveActor(req);
    await this.reception.markArrived(
      tenant.id,
      visitorId,
      { user_id: actor.user_id, person_id: actor.person_id },
      { arrived_at: parsed.data.arrived_at },
    );
    return { ok: true };
  }

  @Post('visitors/:id/check-out')
  async checkOut(
    @Req() req: Request,
    @Param('id') visitorId: string,
    @Body() body: unknown,
  ) {
    await this.permissions.requirePermission(req, 'visitors.reception');
    const parsed = ReceptionCheckOutSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(formatZodError(parsed.error));
    }
    const tenant = TenantContext.current();
    const actor = await this.resolveActor(req);
    await this.reception.markCheckedOut(
      tenant.id,
      visitorId,
      { user_id: actor.user_id, person_id: actor.person_id },
      {
        checkout_source: parsed.data.checkout_source,
        pass_returned: parsed.data.pass_returned,
      },
    );
    return { ok: true };
  }

  @Post('visitors/:id/no-show')
  async noShow(@Req() req: Request, @Param('id') visitorId: string) {
    await this.permissions.requirePermission(req, 'visitors.reception');
    const tenant = TenantContext.current();
    const actor = await this.resolveActor(req);
    await this.reception.markNoShow(
      tenant.id,
      visitorId,
      { user_id: actor.user_id, person_id: actor.person_id },
    );
    return { ok: true };
  }

  // ─── pass actions ──────────────────────────────────────────────────────

  @Post('passes/:id/assign')
  async assignPass(
    @Req() req: Request,
    @Param('id') passId: string,
    @Body() body: unknown,
  ) {
    await this.permissions.requirePermission(req, 'visitors.reception');
    const parsed = PassAssignSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(formatZodError(parsed.error));
    }
    const tenant = TenantContext.current();
    await this.passPool.assignPass(passId, parsed.data.visitor_id, tenant.id);
    return { ok: true };
  }

  @Post('passes/:id/reserve')
  async reservePass(
    @Req() req: Request,
    @Param('id') passId: string,
    @Body() body: unknown,
  ) {
    await this.permissions.requirePermission(req, 'visitors.reception');
    const parsed = PassReserveSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(formatZodError(parsed.error));
    }
    const tenant = TenantContext.current();
    await this.passPool.reservePass(passId, parsed.data.visitor_id, tenant.id);
    return { ok: true };
  }

  @Post('passes/:id/return')
  async returnPass(@Req() req: Request, @Param('id') passId: string) {
    await this.permissions.requirePermission(req, 'visitors.reception');
    const tenant = TenantContext.current();
    await this.passPool.returnPass(passId, tenant.id);
    return { ok: true };
  }

  @Post('passes/:id/missing')
  async markMissing(
    @Req() req: Request,
    @Param('id') passId: string,
    @Body() body: unknown,
  ) {
    await this.permissions.requirePermission(req, 'visitors.reception');
    const parsed = PassMissingSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(formatZodError(parsed.error));
    }
    const tenant = TenantContext.current();
    await this.passPool.markPassMissing(passId, tenant.id, parsed.data.reason);
    return { ok: true };
  }

  @Post('passes/:id/recovered')
  async markRecovered(@Req() req: Request, @Param('id') passId: string) {
    await this.permissions.requirePermission(req, 'visitors.reception');
    const tenant = TenantContext.current();
    await this.passPool.markPassRecovered(passId, tenant.id);
    return { ok: true };
  }

  // ─── SSE: host arrival stream ──────────────────────────────────────────

  /**
   * GET /reception/host-arrivals — SSE stream for the requesting host's
   * portal Notification API channel.
   *
   * Spec §9.4. The Bearer token is validated by the global AuthGuard at
   * connect time. Once the SSE stream is open it remains until the client
   * disconnects; we don't re-validate per event because the underlying
   * filter is `host_person_id === actor.person_id`, which the JWT
   * subject can't change without reconnecting.
   *
   * **NOT permission-gated.** Every authenticated user may subscribe to
   * arrivals for their OWN person_id. The bus filter is what guarantees
   * that — there's no path here to subscribe to another host's events.
   */
  @Sse('host-arrivals')
  async hostArrivals(
    @Req() req: Request,
  ): Promise<Observable<{ data: unknown }>> {
    const actor = await this.resolveActor(req);
    const tenant = TenantContext.current();

    return this.events.events$.pipe(
      filter((e) =>
        e.tenant_id === tenant.id && e.host_person_id === actor.person_id,
      ),
      map((e) => ({ data: e })),
    );
  }

  // ─── helpers ───────────────────────────────────────────────────────────

  private async resolveActor(
    req: Request,
  ): Promise<{ user_id: string; person_id: string }> {
    const authUid = (req as { user?: { id: string } }).user?.id;
    if (!authUid) throw new UnauthorizedException('No auth user');
    const tenant = TenantContext.current();

    const lookup = await this.supabase.admin
      .from('users')
      .select('id, person_id')
      .eq('tenant_id', tenant.id)
      .eq('auth_uid', authUid)
      .maybeSingle();
    const row = lookup.data as { id: string; person_id: string | null } | null;
    if (!row) throw new UnauthorizedException('No linked user in this tenant');
    if (!row.person_id) {
      throw new UnauthorizedException(
        'Your user account is not linked to a person — contact your admin',
      );
    }
    return { user_id: row.id, person_id: row.person_id };
  }
}

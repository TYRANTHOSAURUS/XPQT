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

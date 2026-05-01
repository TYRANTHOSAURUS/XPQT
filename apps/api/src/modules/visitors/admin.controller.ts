import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { DbService } from '../../common/db/db.service';
import { PermissionGuard } from '../../common/permission-guard';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { AdminGuard } from '../auth/admin.guard';
import {
  formatZodError,
  PassCreateSchema,
  PassPoolCreateSchema,
  PassPoolUpdateSchema,
  PassUpdateSchema,
  VisitorTypeCreateSchema,
  VisitorTypeUpdateSchema,
} from './dto/schemas';
import { KioskService } from './kiosk.service';
import { VisitorPassPoolService } from './pass-pool.service';

/**
 * Tenant-admin surface for visitor management — `/admin/visitors/*`.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §13
 *
 * Auth model:
 *   - Global `AuthGuard` (Bearer JWT, tenant-scoped).
 *   - `AdminGuard` (role.type='admin' inside the tenant) — same key the
 *     other admin surfaces use (portal-announcements, branding). The
 *     permission catalog has no `visitors.admin` action and the spec
 *     §13 explicitly says this surface is gated by tenant-admin role,
 *     not a per-action permission.
 *   - `GET /admin/visitors/all` is the visibility-bypass read; it
 *     additionally requires the `visitors.read_all` override (so a
 *     scoped admin without read_all sees only their authorized set).
 *
 * Mutation endpoints (types + pools + kiosk tokens) all require admin.
 */
@Controller('admin/visitors')
@UseGuards(AdminGuard)
export class VisitorsAdminController {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly db: DbService,
    private readonly passPool: VisitorPassPoolService,
    private readonly kiosk: KioskService,
    private readonly permissions: PermissionGuard,
  ) {}

  // ─── visitor types ─────────────────────────────────────────────────────

  @Get('types')
  async listTypes() {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('visitor_types')
      .select('*')
      .eq('tenant_id', tenant.id)
      .order('display_name', { ascending: true });
    if (error) throw error;
    return data ?? [];
  }

  @Post('types')
  async createType(@Body() body: unknown) {
    const parsed = VisitorTypeCreateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(formatZodError(parsed.error));
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('visitor_types')
      .insert({ ...parsed.data, tenant_id: tenant.id })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  @Patch('types/:id')
  async updateType(@Param('id') id: string, @Body() body: unknown) {
    const parsed = VisitorTypeUpdateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(formatZodError(parsed.error));
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('visitor_types')
      .update(parsed.data)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();
    if (error) throw error;
    if (!data) throw new NotFoundException(`visitor_type ${id} not found`);
    return data;
  }

  @Delete('types/:id')
  async deactivateType(@Param('id') id: string) {
    /* Soft-delete via active=false. Visitor types are referenced from
       the visitors table so a hard delete would orphan historical
       records; we never offer a hard-delete path through the API. */
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('visitor_types')
      .update({ active: false })
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();
    if (error) throw error;
    if (!data) throw new NotFoundException(`visitor_type ${id} not found`);
    return { ok: true };
  }

  // ─── pass pools ────────────────────────────────────────────────────────

  @Get('pools')
  async listPools() {
    const tenant = TenantContext.current();
    return this.db.queryMany(
      `select id, tenant_id, space_id, space_kind, pass_number, pass_type,
              status, current_visitor_id, reserved_for_visitor_id,
              last_assigned_at, notes, created_at, updated_at
         from public.visitor_pass_pool
        where tenant_id = $1
        order by space_id, pass_number asc`,
      [tenant.id],
    );
  }

  /**
   * GET /admin/visitors/pool-anchors
   *
   * Returns one row per anchor space (`space_id`) with aggregated pass
   * counts per status. The admin pools index page renders this directly
   * — without it the page has to fetch every pass and group client-side.
   */
  @Get('pool-anchors')
  async listPoolAnchors() {
    const tenant = TenantContext.current();
    return this.db.queryMany(
      `select
         pool.space_id            as space_id,
         pool.space_kind          as space_kind,
         s.name                   as space_name,
         count(*)                 as pass_count,
         count(*) filter (where pool.status = 'available') as available_count,
         count(*) filter (where pool.status = 'in_use')    as in_use_count,
         count(*) filter (where pool.status = 'reserved')  as reserved_count,
         count(*) filter (where pool.status = 'lost')      as lost_count,
         count(*) filter (where pool.status = 'retired')   as retired_count,
         coalesce(s.uses_visitor_passes, true) as uses_visitor_passes
       from public.visitor_pass_pool pool
       join public.spaces s
         on s.id = pool.space_id and s.tenant_id = pool.tenant_id
       where pool.tenant_id = $1
       group by pool.space_id, pool.space_kind, s.name, s.uses_visitor_passes
       order by s.name asc`,
      [tenant.id],
    );
  }

  /**
   * GET /admin/visitors/pools/by-anchor/:space_id
   *
   * All passes anchored at this space. The detail page shows one anchor
   * (resolved by space_id, not pool row id) with its passes underneath.
   */
  @Get('pools/by-anchor/:space_id')
  async listPassesByAnchor(@Param('space_id') spaceId: string) {
    const tenant = TenantContext.current();
    const anchor = await this.db.queryOne<{
      id: string;
      type: string;
      name: string;
      uses_visitor_passes: boolean | null;
    }>(
      `select id, type, name, uses_visitor_passes
         from public.spaces
        where id = $1 and tenant_id = $2`,
      [spaceId, tenant.id],
    );
    if (!anchor) throw new NotFoundException(`space ${spaceId} not found`);
    if (anchor.type !== 'site' && anchor.type !== 'building') {
      throw new BadRequestException('Pool anchor must be a site or building');
    }
    const passes = await this.db.queryMany(
      `select id, tenant_id, space_id, space_kind, pass_number, pass_type,
              status, current_visitor_id, reserved_for_visitor_id,
              last_assigned_at, notes, created_at, updated_at
         from public.visitor_pass_pool
        where tenant_id = $1 and space_id = $2
        order by pass_number asc`,
      [tenant.id, spaceId],
    );
    return {
      anchor: {
        id: anchor.id,
        space_kind: anchor.type,
        name: anchor.name,
        uses_visitor_passes: anchor.uses_visitor_passes ?? true,
      },
      passes,
    };
  }

  /**
   * GET /admin/visitors/pools/by-anchor/:space_id/inheritance
   *
   * Preview which descendant spaces inherit this pool. Walks the spaces
   * tree from the anchor and for each leaf calls pass_pool_for_space()
   * to confirm whether this anchor is the resolved pool. Used by the
   * pool detail page to show "covers Building A, Building B" + opt-outs.
   *
   * Returns descendant building/site rows with a `covered` boolean +
   * `opted_out` boolean.
   */
  @Get('pools/by-anchor/:space_id/inheritance')
  async poolInheritance(@Param('space_id') spaceId: string) {
    const tenant = TenantContext.current();
    const anchor = await this.db.queryOne<{ id: string; type: string }>(
      `select id, type from public.spaces
        where id = $1 and tenant_id = $2`,
      [spaceId, tenant.id],
    );
    if (!anchor) throw new NotFoundException(`space ${spaceId} not found`);

    // Descendants — buildings/sites under the anchor (or anchor itself).
    const descendants = await this.db.queryMany<{
      id: string;
      name: string;
      type: string;
      uses_visitor_passes: boolean | null;
    }>(
      `with recursive descendants as (
         select id, name, type, parent_id, uses_visitor_passes
           from public.spaces where id = $1 and tenant_id = $2
         union all
         select s.id, s.name, s.type, s.parent_id, s.uses_visitor_passes
           from public.spaces s
           join descendants d on s.parent_id = d.id
          where s.tenant_id = $2
       )
       select id, name, type, uses_visitor_passes from descendants
        where type in ('site', 'building')
        order by name asc`,
      [spaceId, tenant.id],
    );

    const rows: Array<{
      id: string;
      name: string;
      type: string;
      covered: boolean;
      opted_out: boolean;
    }> = [];
    for (const d of descendants) {
      // For each descendant, resolve its pool. If the anchor is the
      // returned pool, this descendant inherits us. If `uses_visitor_passes
      // = false` anywhere up the chain, it's opted out.
      const resolved = await this.db.queryOne<{ space_id: string | null }>(
        `select space_id from public.pass_pool_for_space($1) limit 1`,
        [d.id],
      );
      const optedOut = d.uses_visitor_passes === false;
      const covered = !optedOut && resolved?.space_id === spaceId;
      rows.push({
        id: d.id,
        name: d.name,
        type: d.type,
        covered,
        opted_out: optedOut,
      });
    }
    return rows;
  }

  @Post('pools')
  async createPool(@Body() body: unknown) {
    /* "Pool" is a misnomer in the data model — visitor_pass_pool rows
       ARE individual passes, anchored at a space. The /admin/visitors/pools
       collection endpoint is therefore "create one pass at this space"
       under the hood. We accept a lightweight `{ space_id, pass_number? }`
       and create a placeholder row at status='available' (with a
       generated pass_number if not supplied so the admin can rename it). */
    const parsed = PassPoolCreateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(formatZodError(parsed.error));
    const tenant = TenantContext.current();

    /* Validate the space is a building or site. Composite CHECK on the
       table catches it too, but a clean 400 is friendlier. */
    const space = await this.db.queryOne<{ id: string; type: string }>(
      `select id, type from public.spaces where id = $1 and tenant_id = $2`,
      [parsed.data.space_id, tenant.id],
    );
    if (!space) {
      throw new NotFoundException(`space ${parsed.data.space_id} not found`);
    }
    if (space.type !== 'site' && space.type !== 'building') {
      throw new BadRequestException(
        'Pass pool must be anchored to a site or building',
      );
    }

    return this.db.queryOne(
      `insert into public.visitor_pass_pool
          (tenant_id, space_id, space_kind, pass_number, pass_type, status, notes)
        values ($1, $2, $3, $4, 'standard', 'available', $5)
        returning *`,
      [
        tenant.id,
        parsed.data.space_id,
        space.type,
        // Auto-numbered placeholder; admin can rename via PATCH.
        `pass-${Date.now()}`,
        parsed.data.notes ?? null,
      ],
    );
  }

  @Patch('pools/:id')
  async updatePool(@Param('id') id: string, @Body() body: unknown) {
    const parsed = PassPoolUpdateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(formatZodError(parsed.error));
    const tenant = TenantContext.current();

    /* `retired` is a CHECK-enum value, not a boolean. We translate the
       admin-friendly { retired: true } into status='retired'. The DB
       trigger ensures the visitor's back-reference is unset before we
       allow retirement (a pass in_use cannot be retired without first
       being returned). */
    const updates: Record<string, unknown> = {};
    if (parsed.data.notes !== undefined) updates.notes = parsed.data.notes;
    if (parsed.data.retired === true) updates.status = 'retired';
    if (parsed.data.retired === false) {
      // No-op un-retire — the pass would need to go via admin pass-add
      // again to re-enter the pool. We accept the request silently.
    }
    if (Object.keys(updates).length === 0) return { ok: true };

    const { data, error } = await this.supabase.admin
      .from('visitor_pass_pool')
      .update(updates)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();
    if (error) throw error;
    if (!data) throw new NotFoundException(`pass ${id} not found`);
    return data;
  }

  @Post('pools/:id/passes')
  async addPass(@Param('id') poolId: string, @Body() body: unknown) {
    /* The "pool ID" here is treated as a space_id stand-in — the
       /admin/visitors/pools listing groups passes by space_id, so the
       admin UI sends the space_id back as the pool key. We resolve to
       the space and create a new pass row. */
    const parsed = PassCreateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(formatZodError(parsed.error));
    const tenant = TenantContext.current();

    /* Try resolving poolId as a pass id first (so the admin can call
       /pools/<existing-pass-id>/passes to add a sibling). If that
       doesn't match, treat it as a space_id. */
    const existingPass = await this.db.queryOne<{ space_id: string; space_kind: string }>(
      `select space_id, space_kind from public.visitor_pass_pool
        where id = $1 and tenant_id = $2`,
      [poolId, tenant.id],
    );
    let spaceId: string;
    let spaceKind: string;
    if (existingPass) {
      spaceId = existingPass.space_id;
      spaceKind = existingPass.space_kind;
    } else {
      const space = await this.db.queryOne<{ id: string; type: string }>(
        `select id, type from public.spaces where id = $1 and tenant_id = $2`,
        [poolId, tenant.id],
      );
      if (!space) throw new NotFoundException(`pool/space ${poolId} not found`);
      if (space.type !== 'site' && space.type !== 'building') {
        throw new BadRequestException('Pass pool must be anchored to site or building');
      }
      spaceId = space.id;
      spaceKind = space.type;
    }

    return this.db.queryOne(
      `insert into public.visitor_pass_pool
          (tenant_id, space_id, space_kind, pass_number, pass_type, status, notes)
        values ($1, $2, $3, $4, $5, 'available', $6)
        returning *`,
      [
        tenant.id,
        spaceId,
        spaceKind,
        parsed.data.pass_number,
        parsed.data.pass_type ?? 'standard',
        parsed.data.notes ?? null,
      ],
    );
  }

  @Patch('pools/passes/:id')
  async updatePass(@Param('id') passId: string, @Body() body: unknown) {
    const parsed = PassUpdateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(formatZodError(parsed.error));
    const tenant = TenantContext.current();

    const updates: Record<string, unknown> = {};
    if (parsed.data.notes !== undefined) updates.notes = parsed.data.notes;
    if (parsed.data.retired === true) updates.status = 'retired';
    if (Object.keys(updates).length === 0) return { ok: true };

    const { data, error } = await this.supabase.admin
      .from('visitor_pass_pool')
      .update(updates)
      .eq('id', passId)
      .eq('tenant_id', tenant.id)
      .select()
      .single();
    if (error) throw error;
    if (!data) throw new NotFoundException(`pass ${passId} not found`);
    return data;
  }

  @Post('pools/passes/:id/recovered')
  async passRecovered(@Param('id') passId: string) {
    const tenant = TenantContext.current();
    await this.passPool.markPassRecovered(passId, tenant.id);
    return { ok: true };
  }

  // ─── kiosk tokens ──────────────────────────────────────────────────────

  /**
   * GET /admin/visitors/kiosks?space_id=…
   *
   * List kiosk tokens. When `space_id` is supplied, filter to buildings
   * that resolve to that anchor pool (so the pool detail page shows
   * only the relevant kiosks). Without `space_id`, returns all tokens.
   */
  @Get('kiosks')
  async listKioskTokens(@Query('space_id') spaceId?: string) {
    const tenant = TenantContext.current();
    if (!spaceId) {
      return this.db.queryMany(
        `select kt.id, kt.tenant_id, kt.building_id, kt.active,
                kt.rotated_at, kt.expires_at, kt.created_at,
                s.name as building_name
           from public.kiosk_tokens kt
           join public.spaces s
             on s.id = kt.building_id and s.tenant_id = kt.tenant_id
          where kt.tenant_id = $1
          order by s.name asc, kt.created_at desc`,
        [tenant.id],
      );
    }
    // Walk the descendants of the anchor and find buildings; then list
    // their kiosk tokens.
    return this.db.queryMany(
      `with recursive descendants as (
         select id, type, parent_id from public.spaces
           where id = $1 and tenant_id = $2
         union all
         select s.id, s.type, s.parent_id from public.spaces s
           join descendants d on s.parent_id = d.id
          where s.tenant_id = $2
       )
       select kt.id, kt.tenant_id, kt.building_id, kt.active,
              kt.rotated_at, kt.expires_at, kt.created_at,
              sp.name as building_name
         from public.kiosk_tokens kt
         join descendants d on d.id = kt.building_id
         join public.spaces sp on sp.id = kt.building_id
        where kt.tenant_id = $2
          and d.type = 'building'
        order by sp.name asc, kt.created_at desc`,
      [spaceId, tenant.id],
    );
  }

  @Post('kiosks/:building_id/provision')
  async provisionKiosk(
    @Req() req: Request,
    @Param('building_id') buildingId: string,
  ) {
    const tenant = TenantContext.current();
    const actor = await this.resolveAdminUserId(req);
    return this.kiosk.provisionKioskToken(tenant.id, buildingId, { user_id: actor });
  }

  @Post('kiosks/:kiosk_token_id/rotate')
  async rotateKiosk(
    @Req() req: Request,
    @Param('kiosk_token_id') kioskTokenId: string,
  ) {
    const tenant = TenantContext.current();
    const actor = await this.resolveAdminUserId(req);
    return this.kiosk.rotateKioskToken(kioskTokenId, tenant.id, { user_id: actor });
  }

  @Post('kiosks/:kiosk_token_id/revoke')
  async revokeKiosk(
    @Req() req: Request,
    @Param('kiosk_token_id') kioskTokenId: string,
  ) {
    const tenant = TenantContext.current();
    const actor = await this.resolveAdminUserId(req);
    await this.kiosk.revokeKioskToken(kioskTokenId, tenant.id, { user_id: actor });
    return { ok: true };
  }

  // ─── visibility-bypass read ────────────────────────────────────────────

  /**
   * GET /admin/visitors/all?status=&building_id=&limit=
   *
   * Spec §13.1: bypasses scope. Requires `visitors.read_all` override
   * even though the controller is admin-gated — a scoped admin without
   * the override sees only their authorized set elsewhere; this
   * endpoint is the explicit firehose.
   */
  @Get('all')
  async listAll(
    @Req() req: Request,
    @Query('status') status?: string,
    @Query('building_id') buildingId?: string,
    @Query('limit') limit?: string,
  ) {
    await this.permissions.requirePermission(req, 'visitors.read_all');
    const tenant = TenantContext.current();
    const lim = clamp(parseInt(limit ?? '100', 10), 1, 500);

    const params: unknown[] = [tenant.id, lim];
    let where = `where v.tenant_id = $1`;
    if (status) {
      params.push(status);
      where += ` and v.status = $${params.length}`;
    }
    if (buildingId) {
      params.push(buildingId);
      where += ` and v.building_id = $${params.length}`;
    }
    const sql = `
      select v.id, v.tenant_id, v.status, v.first_name, v.last_name,
             v.company, v.expected_at, v.arrived_at, v.checked_out_at,
             v.building_id, v.visitor_type_id, v.primary_host_person_id
        from public.visitors v
        ${where}
        order by coalesce(v.expected_at, v.arrived_at) desc nulls last
        limit $2
    `;
    return this.db.queryMany(sql, params);
  }

  // ─── helpers ───────────────────────────────────────────────────────────

  /**
   * Resolve auth_uid → users.id for audit tagging on admin actions.
   * AdminGuard already validated this user is an admin in the tenant;
   * we just need their user.id for the audit row.
   */
  private async resolveAdminUserId(req: Request): Promise<string> {
    const authUid = (req as { user?: { id: string } }).user?.id;
    if (!authUid) throw new UnauthorizedException('No auth user');
    const tenant = TenantContext.current();
    const lookup = await this.supabase.admin
      .from('users')
      .select('id')
      .eq('tenant_id', tenant.id)
      .eq('auth_uid', authUid)
      .maybeSingle();
    const row = lookup.data as { id: string } | null;
    if (!row) throw new UnauthorizedException('No linked user in this tenant');
    return row.id;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

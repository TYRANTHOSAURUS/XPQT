import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { DbService } from '../../common/db/db.service';
import {
  formatZodError,
  KioskNameCheckinSchema,
  KioskQrCheckinSchema,
  KioskWalkupSchema,
} from './dto/schemas';
import { KioskAuthGuard, type RequestWithKioskContext } from './kiosk-auth.guard';
import { KioskService } from './kiosk.service';

/**
 * Anonymous kiosk surface — `/kiosk/*`.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §8
 *
 * Auth: `@Public()` opts the global `AuthGuard` out, then
 * `KioskAuthGuard` validates the device's Bearer token against
 * `kiosk_tokens` and attaches a `kioskContext = { tenantId,
 * buildingId, kioskTokenId }` to the request.
 *
 * NO `req.user`. The kiosk is truly anonymous — only the device token
 * proves which building/tenant it belongs to. KioskService methods
 * filter every read on `kioskContext.tenantId` + `kioskContext.buildingId`.
 *
 * Pattern reference: `apps/api/src/modules/vendor-portal/vendor-work-order.controller.ts`
 * uses the same `@Public()` + custom guard shape for vendor-portal
 * routes.
 */
@Public()
@UseGuards(KioskAuthGuard)
@Controller('kiosk')
export class KioskController {
  constructor(
    private readonly kiosk: KioskService,
    private readonly db: DbService,
  ) {}

  /**
   * GET /kiosk/expected/search?q=...
   *
   * Spec §8.4. Privacy-aware fuzzy search on today's expected list at
   * the kiosk's bound building. Returns first_name + last_initial only.
   * Never reveals host names — the host is shown only after the visitor
   * confirms identity.
   */
  @Get('expected/search')
  async expectedSearch(
    @Req() req: RequestWithKioskContext,
    @Query('q') q?: string,
  ) {
    const ctx = req.kioskContext!;
    return this.kiosk.searchExpectedAtKiosk(ctx, q ?? '');
  }

  /**
   * POST /kiosk/check-in/qr — body { token }
   *
   * QR scan. Validates single-use token via SECURITY DEFINER
   * `validate_invitation_token`; SQLSTATEs are mapped to 401/403 by the
   * service.
   */
  @Post('check-in/qr')
  async checkInQr(
    @Req() req: RequestWithKioskContext,
    @Body() body: unknown,
  ) {
    const parsed = KioskQrCheckinSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(formatZodError(parsed.error));
    }
    const ctx = req.kioskContext!;
    return this.kiosk.checkInWithQrToken(ctx, parsed.data.token);
  }

  /**
   * POST /kiosk/check-in/by-name — body { visitor_id, host_first_name_confirmation }
   *
   * Spec §8.4. Visitor selected an entry from /kiosk/expected/search and
   * typed the host's first name. Soft anti-impersonation step.
   */
  @Post('check-in/by-name')
  async checkInByName(
    @Req() req: RequestWithKioskContext,
    @Body() body: unknown,
  ) {
    const parsed = KioskNameCheckinSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(formatZodError(parsed.error));
    }
    const ctx = req.kioskContext!;
    return this.kiosk.checkInByName(
      ctx,
      parsed.data.visitor_id,
      parsed.data.host_first_name_confirmation,
    );
  }

  /**
   * POST /kiosk/walk-up — visitor with no invite. Spec §8.5.
   *
   * Type must have `allow_walk_up=true` AND `requires_approval=false`
   * (kiosk service rejects otherwise; UI hides the button when no such
   * type exists for the tenant).
   */
  @Post('walk-up')
  async walkup(
    @Req() req: RequestWithKioskContext,
    @Body() body: unknown,
  ) {
    const parsed = KioskWalkupSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(formatZodError(parsed.error));
    }
    const ctx = req.kioskContext!;
    return this.kiosk.walkupAtKiosk(ctx, parsed.data);
  }

  /**
   * GET /kiosk/visitor-types
   *
   * Walk-up type picker — only shows types where allow_walk_up=true AND
   * requires_approval=false (so the kiosk never offers a type that
   * would be rejected at submit). Tenant-scoped via kioskContext.
   */
  @Get('visitor-types')
  async visitorTypes(@Req() req: RequestWithKioskContext) {
    const ctx = req.kioskContext!;
    return this.db.queryMany(
      `select id, type_key, display_name, description
         from public.visitor_types
        where tenant_id = $1
          and active = true
          and allow_walk_up = true
          and requires_approval = false
        order by display_name asc`,
      [ctx.tenantId],
    );
  }

  /**
   * GET /kiosk/host-search?q=...
   *
   * Walk-up host picker — searches employees/contractors at the
   * kioskContext.tenantId. Visitor-typed persons + vendor_contact-typed
   * are excluded (can't host visitors). Returns first_name + last_initial
   * only (privacy: visitor at the kiosk shouldn't see full surnames of
   * unrelated employees in autocomplete).
   *
   * Result limit is small (10) — the kiosk UI's autocomplete is meant
   * for "the visitor knows who they're meeting" not browsing.
   */
  @Get('host-search')
  async hostSearch(
    @Req() req: RequestWithKioskContext,
    @Query('q') q?: string,
  ) {
    const ctx = req.kioskContext!;
    const trimmed = (q ?? '').trim();
    if (trimmed.length === 0) return [];

    /* Trigram path. We search persons (not users) because hosts are
       defined by their persons row — vendor_contact + visitor are
       explicitly NOT hostable. building scope cross-check is implicit:
       any tenant employee can be a host at any of the tenant's buildings
       in v1 (spec §8.5 doesn't gate the host's home-building). */
    const sql = `
      select id,
             first_name,
             upper(coalesce(left(last_name, 1), '')) as last_initial,
             greatest(
               similarity(coalesce(first_name, ''), $2),
               similarity(coalesce(last_name, ''),  $2)
             ) as score
        from public.persons
       where tenant_id = $1
         and active = true
         and type not in ('visitor', 'vendor_contact')
         and greatest(
               similarity(coalesce(first_name, ''), $2),
               similarity(coalesce(last_name, ''),  $2)
             ) > 0.2
       order by score desc
       limit 10
    `;
    let rows = await this.db.queryMany<{
      id: string;
      first_name: string | null;
      last_initial: string;
      score: number;
    }>(sql, [ctx.tenantId, trimmed]);

    if (rows.length === 0) {
      // Fallback to ILIKE for very short queries (1-2 chars).
      const pattern = `%${trimmed}%`;
      rows = await this.db.queryMany<{
        id: string;
        first_name: string | null;
        last_initial: string;
        score: number;
      }>(
        `select id,
                first_name,
                upper(coalesce(left(last_name, 1), '')) as last_initial,
                0::float as score
           from public.persons
          where tenant_id = $1
            and active = true
            and type not in ('visitor', 'vendor_contact')
            and (first_name ilike $2 or last_name ilike $2)
          order by first_name asc
          limit 10`,
        [ctx.tenantId, pattern],
      );
    }

    return rows.map((r) => ({
      id: r.id,
      first_name: r.first_name ?? '',
      last_initial: r.last_initial,
    }));
  }
}
